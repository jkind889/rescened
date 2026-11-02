#!/usr/bin/env node
// Read-only, bounded snapshot collector for docs/DETERMINISTIC_MAPPING_METRICS_PLAN.md. It reads a
// validated exposure manifest, traverses indexed pages within fixed record/time budgets and prints
// aggregates only: no names, album IDs, case IDs, release IDs, reviewer IDs or internal IDs.
// A section that exhausts a budget is reported as not collected, never as a partial cohort.
const fs = require("node:fs");
const mongoose = require("mongoose");
const { catalogRevisionOf, normalize } = require("../lib/listening/common");
const { DISCOVERY_ATTEMPT_RETENTION_MS, PAIR_OBSERVATION_VERSION, REDISCOVERY_MATCHER_VERSION, attemptJobKey, rediscoveryPairs } = require("../lib/listening/worker");
const {
  COLLECTION_LIMITS, COLLECTOR_VERSION, DAY_MS, MEASUREMENT_SCHEMA_VERSION, BudgetExceeded,
  assertAggregateOnly, cohortWindows, createBudget, manifestChecksum, manifestTemplate, observationIntake, partition, percentiles, ratio, validateManifest,
} = require("../lib/listening/measurement");

const ELIGIBLE_STATUSES = ["pending", "no_catalog_match"];
// Discovery stores provider_evidence_incomplete, then the worker's failure path records the job
// error code discovery_incomplete on the case. Both mean the provider evidence was incomplete.
const PROVIDER_INCOMPLETE = new Set(["provider_evidence_incomplete", "discovery_incomplete"]);

const chunks = (values, size) => {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
};

function createReader(budget, limits = COLLECTION_LIMITS) {
  const counted = (rows) => { budget.take(rows.length); return rows; };
  return {
    limits,
    async counted(rows) { budget.check(); return counted(await rows); },
    // One bounded, projected query. Every query is time-limited on the server.
    async find(Model, filter, fields, { sort, limit = limits.pageSize } = {}) {
      budget.check();
      let query = Model.find(filter).select(fields);
      if (sort) query = query.sort(sort);
      return counted(await query.limit(limit).maxTimeMS(limits.maxTimeMS).lean());
    },
    // Traverses a filter to its declared end by ascending _id pages, never capping the cohort.
    async *pages(Model, filter, fields) {
      let after = null;
      for (;;) {
        const rows = await this.find(Model, after ? { ...filter, _id: { ...filter._id, $gt: after } } : filter, `${fields} _id`, { sort: { _id: 1 } });
        if (rows.length) yield rows;
        if (rows.length < limits.pageSize) return;
        after = rows[rows.length - 1]._id;
      }
    },
    async all(Model, filter, fields) {
      const rows = [];
      for await (const page of this.pages(Model, filter, fields)) rows.push(...page);
      return rows;
    },
    // Lookups by unique keys, one page-sized chunk at a time, so no chunk can exceed its page.
    async inChunks(values, read) {
      const rows = [];
      for (const chunk of chunks(values, limits.pageSize)) rows.push(...await read(chunk));
      return rows;
    },
    // Materializes at most one record past the run's budget, so an oversized result stops the run.
    async aggregate(Model, pipeline) {
      budget.check();
      return counted(await Model.aggregate([...pipeline, { $limit: limits.maxRecords + 1 }]).option({ maxTimeMS: limits.maxTimeMS, allowDiskUse: false }));
    },
  };
}

function discoveryEntry(row) {
  return (row.evidence || []).find((entry) => entry?.source === "candidate_discovery") || null;
}

// PR32, mapping side: a fixed case-level snapshot of the evidence moderators see now. Run-level
// rates need per-attempt records, which do not exist yet. Reasons overlap and are not summed.
async function mappingEvidence(reader, { Listening, AlbumCatalog }) {
  const cases = await reader.all(Listening.MappingCase, { status: "pending" }, "candidates.albumId candidates.catalogRevision evidence discoveryError");
  const candidateIds = [...new Set(cases.flatMap((row) => (row.candidates || []).map((item) => item?.albumId)).filter(Boolean))];
  const albums = await reader.inChunks(candidateIds, (chunk) => reader.find(AlbumCatalog, { albumId: { $in: chunk } }, "albumId catalogRevision"));
  const revisions = new Map(albums.map((album) => [album.albumId, catalogRevisionOf(album)]));
  const reasons = { providerIncomplete: 0, otherDiscoveryFailure: 0, retainedAfterFailedRefresh: 0, queryCapReached: 0, candidateCapReached: 0, staleCandidateRevision: 0 };
  let known = 0; let withProblem = 0; let failedWithoutResult = 0;
  for (const row of cases) {
    const entry = discoveryEntry(row);
    // A first discovery that failed keeps no evidence; it is a failure without a result.
    if (!entry && row.discoveryError) { failedWithoutResult += 1; continue; }
    // PR32 added candidateQueryLimitReached; its absence means coverage is unknown, not complete.
    if (typeof entry?.candidateQueryLimitReached !== "boolean") continue;
    known += 1;
    const candidates = row.candidates || [];
    const found = {
      providerIncomplete: PROVIDER_INCOMPLETE.has(row.discoveryError),
      otherDiscoveryFailure: Boolean(row.discoveryError) && !PROVIDER_INCOMPLETE.has(row.discoveryError),
      retainedAfterFailedRefresh: Boolean(row.discoveryError) && candidates.length > 0,
      queryCapReached: entry.candidateQueryLimitReached === true,
      candidateCapReached: Number(entry.candidatesFound) > Number(entry.candidatesShown),
      staleCandidateRevision: candidates.some((item) => revisions.get(item?.albumId) !== item?.catalogRevision),
    };
    for (const [reason, present] of Object.entries(found)) if (present) reasons[reason] += 1;
    if (Object.values(found).some(Boolean)) withProblem += 1;
  }
  return {
    collected: true,
    unit: "pending mapping case (current snapshot)",
    cases: cases.length,
    coverageFieldsKnown: ratio(known, cases.length, "case"),
    failedWithoutResult,
    unknownCoverage: cases.length - known - failedWithoutResult,
    reasonsAmongKnown: reasons,
    reasonsOverlap: true,
    problemRate: ratio(withProblem, known, "case"),
  };
}

// Demand-linked readiness (plan: "Moderator effort and baseline readiness"). N, C and B follow
// listening:metrics; D is the distinct catalog albums reached by names in C, partitioned by status.
async function demandReadiness(reader, { Listening, AlbumCatalog, reviewStatusForAlbums }, now) {
  const active = await reader.all(Listening.Connection, { state: "active" }, "_id");
  const names = active.length ? await reader.aggregate(Listening.Scrobble, [
    { $match: { connectionId: { $in: active.map((row) => row._id) }, expiresAt: { $gt: now }, artistKey: { $ne: "" }, albumKey: { $ne: "" } } },
    { $group: { _id: { artist: "$artistKey", album: "$albumKey" } } },
  ]) : [];
  const keys = names.map(({ _id }) => JSON.stringify(["lastfm", _id.artist, _id.album]));
  const mappings = await reader.inChunks(keys, (chunk) => reader.find(Listening.AlbumMapping, { status: "active", key: { $in: chunk } }, "key albumId catalogRevision"));
  const mappedIds = [...new Set(mappings.map((row) => row.albumId))];
  const albums = await reader.inChunks(mappedIds, (chunk) => reader.find(AlbumCatalog, { albumId: { $in: chunk } }, "albumId catalogRevision"));
  const revisions = new Map(albums.map((album) => [album.albumId, catalogRevisionOf(album)]));
  const current = mappings.filter((row) => revisions.get(row.albumId) === row.catalogRevision);
  const demanded = [...new Set(current.map((row) => row.albumId))];
  const statuses = await reader.inChunks(demanded, (chunk) => reader.counted(reviewStatusForAlbums(chunk, { maxTimeMS: reader.limits.maxTimeMS })));
  const byAlbum = new Map(statuses.map((row) => [row.id, row]));
  const categories = { readyPending: 0, unpreparedPending: 0, reviewed: 0, stale: 0, deferred: 0, revoked: 0, unknown: 0 };
  let usable = 0; let outsideBaselineQueue = 0;
  for (const albumId of demanded) {
    const row = byAlbum.get(albumId);
    if (row?.usableBaseline) usable += 1;
    if (row && !row.inBaselineQueue) outsideBaselineQueue += 1;
    if (!row) categories.unknown += 1;
    else if (row.status === "pending") categories[row.readyForReview ? "readyPending" : "unpreparedPending"] += 1;
    // A reviewed head without an active baseline is inconsistent, so it is not counted as reviewed.
    else if (row.status === "reviewed") categories[row.usableBaseline ? "reviewed" : "unknown"] += 1;
    else if (Object.hasOwn(categories, row.status)) categories[row.status] += 1;
    else categories.unknown += 1;
  }
  const withBaseline = current.filter((row) => byAlbum.get(row.albumId)?.usableBaseline).length;
  return {
    collected: true,
    names: {
      unit: "distinct normalized name in unexpired evidence of active connections",
      observed: names.length,
      mapped: current.length,
      mappedToStaleOrMissingAlbum: mappings.length - current.length,
      unmapped: names.length - mappings.length,
      withUsableBaseline: withBaseline,
      mappingCoverage: ratio(current.length, names.length, "name"),
      baselineReadiness: ratio(withBaseline, current.length, "name"),
      mappedWithoutBaseline: current.length - withBaseline,
    },
    albums: {
      unit: "distinct catalog album reached by mapped names",
      status: partition(categories, demanded.length),
      usableBaseline: ratio(usable, demanded.length, "album"),
      outsideBaselineQueue,
    },
  };
}

function jobState(job) {
  if (!job) return "notEnqueued";
  if (job.status === "running") return "running";
  if (job.status === "pending") return job.attempts > 0 ? "retrying" : "queued";
  return job.error ? "terminalError" : "doneWithoutError";
}

// PR33 census: every currently eligible case/album pair under the versioned matcher, found by
// traversing the whole catalog in pages rather than applying the worker's per-pass caps. This is
// a snapshot. Windowed reach, gain and delay need eligibility and attempt clocks that are not
// recorded yet, so they are not estimated here.
async function rediscoveryCensus(reader, { Listening, AlbumCatalog }) {
  const pairs = []; let albumsScanned = 0;
  for await (const page of reader.pages(AlbumCatalog, {}, "albumId title artistDisplayName artistCredits.name catalogRevision")) {
    albumsScanned += page.length;
    const albums = page.map((row) => ({ ...row, artists: [row.artistDisplayName, ...(row.artistCredits || []).map((credit) => credit.name)] }));
    const artistKeys = [...new Set(albums.flatMap((album) => album.artists.map(normalize)).filter(Boolean))];
    const cases = await reader.inChunks(artistKeys, (chunk) => reader.all(Listening.MappingCase, { status: { $in: ELIGIBLE_STATUSES }, artistKey: { $in: chunk } }, "caseId artistKey album albumKey listenerCount candidates.albumId candidates.catalogRevision"));
    pairs.push(...rediscoveryPairs(cases, albums));
  }
  const jobKey = ({ row, album }) => `discovery:catalog:${row.caseId}:${String(album._id)}`;
  const keys = pairs.map(jobKey);
  const jobs = await reader.inChunks(keys, (chunk) => reader.find(Listening.Job, { key: { $in: chunk } }, "key status attempts error"));
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  const states = { notEnqueued: 0, queued: 0, retrying: 0, running: 0, doneWithoutError: 0, terminalError: 0 };
  const candidates = { usable: 0, presentNotUsable: 0, absent: 0 };
  let notEnqueuedWithoutUsable = 0;
  const cases = new Set(); const casesWithUsable = new Set();
  for (const pair of pairs) {
    const state = jobState(byKey.get(jobKey(pair)));
    states[state] += 1;
    cases.add(pair.row.caseId);
    const candidate = (pair.row.candidates || []).find((item) => item?.albumId === pair.album.albumId);
    // Usable: the album is in the stored result, which only provider-complete runs replace, bound to its current revision.
    const usable = Boolean(candidate) && candidate.catalogRevision === catalogRevisionOf(pair.album);
    candidates[usable ? "usable" : candidate ? "presentNotUsable" : "absent"] += 1;
    if (usable) casesWithUsable.add(pair.row.caseId);
    else if (state === "notEnqueued") notEnqueuedWithoutUsable += 1;
  }
  return {
    collected: true,
    matcherVersion: REDISCOVERY_MATCHER_VERSION,
    unit: "eligible case/album pair (current snapshot)",
    albumsScanned,
    pairs: pairs.length,
    distinctCases: cases.size,
    jobState: partition(states, pairs.length),
    doneWithoutErrorMeaning: "discovery ran or was safely skipped; indistinguishable without attempt records",
    matchingCandidate: partition(candidates, pairs.length),
    notEnqueuedWithoutUsableCandidate: notEnqueuedWithoutUsable,
    casesWithUsableMatchingCandidate: ratio(casesWithUsable.size, cases.size, "case"),
    outsideCohort: await jobsOutsideCohort(reader, { Listening, AlbumCatalog }, new Set(keys)),
  };
}

// Catalog jobs whose pair is no longer eligible stay visible as competing exits.
async function jobsOutsideCohort(reader, { Listening, AlbumCatalog }, cohortKeys) {
  const jobs = (await reader.all(Listening.Job, { type: "discovery", "payload.catalogAlbumId": { $exists: true } }, "key payload.caseId payload.catalogAlbumId"))
    .filter((job) => !cohortKeys.has(job.key));
  const caseIds = [...new Set(jobs.map((job) => job.payload?.caseId).filter(Boolean))];
  const albumIds = [...new Set(jobs.map((job) => job.payload?.catalogAlbumId).filter((id) => mongoose.isValidObjectId(id)))];
  const caseStatus = new Map((await reader.inChunks(caseIds, (chunk) => reader.find(Listening.MappingCase, { caseId: { $in: chunk } }, "caseId status"))).map((row) => [row.caseId, row.status]));
  const albums = new Set((await reader.inChunks(albumIds, (chunk) => reader.find(AlbumCatalog, { _id: { $in: chunk } }, "_id"))).map((row) => String(row._id)));
  const exits = { caseApproved: 0, caseRejected: 0, caseMissing: 0, albumMissing: 0, noLongerMatching: 0 };
  for (const job of jobs) {
    const status = caseStatus.get(job.payload?.caseId);
    if (!status) exits.caseMissing += 1;
    else if (status === "approved") exits.caseApproved += 1;
    else if (status === "rejected") exits.caseRejected += 1;
    else if (!albums.has(String(job.payload?.catalogAlbumId))) exits.albumMissing += 1;
    else exits.noLongerMatching += 1;
  }
  return { unit: "catalog rediscovery job outside the current pair cohort", exits: partition(exits, jobs.length) };
}

const seconds = (from, to) => (new Date(to) - new Date(from)) / 1000;
const iso = (value) => value ? new Date(value).toISOString() : null;
// Job and attempt IDs are generated at insert, so a day of margin bounds an indexed _id range
// around the intake; exact membership is then decided by the recorded clocks.
const idRange = (from, to) => ({ $gte: mongoose.Types.ObjectId.createFromTime(Math.floor((from.getTime() - DAY_MS) / 1000)), $lt: mongoose.Types.ObjectId.createFromTime(Math.ceil((to.getTime() + DAY_MS) / 1000)) });
const usableResult = (attempt, albumId) => attempt.outcome === "committed" && attempt.providerComplete === true && (attempt.candidatesAfter || []).some((item) => item?.albumId === albumId);

// Attempts count toward follow-up by when they were written (the commit time for committed runs).
const doneBy = (attempt, horizon) => new Date(attempt.completedAt) <= horizon;

function pairOutcome(job, own, ownAll, horizon) {
  const last = own[own.length - 1];
  // Lease acquisitions without any record are executions the observation records missed.
  if (!last) return !ownAll.length && job.attempts > 0 ? "unrecordedExecution" : "notExecuted";
  if (last.outcome === "skipped") return "skippedIneligible";
  if (last.outcome === "committed" && last.providerComplete === true) return usableResult(last, job.payload.observation.albumId) ? "executedWithMatching" : "executedWithoutMatching";
  // Terminal at H only when the job ended with an error and made no later attempt.
  const later = ownAll.some((attempt) => !doneBy(attempt, horizon));
  return job.status === "done" && job.error && !later ? "terminalError" : "failedAwaitingRetry";
}

// PR33 windowed outcomes (plan: "PR33: availability and reliability") for pairs the scanner newly
// observed during the intake. Observation is the entry clock; eligibility is bounded below by the
// last completed full sweep's start when known. Pairs without a full follow-up by the cutoff are
// censored. Attempts are read through the snapshot time so terminal outcomes reflect the job now.
async function rediscoveryOutcomes(reader, { Listening }, intake, cutoff, now) {
  const followUp = intake.followUpMs;
  const jobs = (await reader.all(Listening.Job, { _id: idRange(intake.from, intake.to), type: "discovery", "payload.observation.version": PAIR_OBSERVATION_VERSION }, "key status error attempts payload.caseId payload.observation"))
    .filter((job) => { const at = new Date(job.payload.observation.observedAt); return at >= intake.from && at < intake.to; });
  const mature = jobs.filter((job) => new Date(job.payload.observation.observedAt).getTime() + followUp <= cutoff.getTime());
  const caseIds = [...new Set(mature.map((job) => job.payload.caseId))];
  const attempts = await reader.inChunks(caseIds, (chunk) => reader.all(Listening.DiscoveryAttempt, { caseId: { $in: chunk }, startedAt: { $gte: intake.from, $lte: now } }, "caseId jobKeyHash outcome providerComplete candidatesAfter.albumId pairCandidateBefore startedAt completedAt"));
  const byCase = new Map();
  for (const attempt of attempts.sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))) {
    if (!byCase.has(attempt.caseId)) byCase.set(attempt.caseId, []);
    byCase.get(attempt.caseId).push(attempt);
  }
  const outcomes = { notExecuted: 0, unrecordedExecution: 0, skippedIneligible: 0, executedWithMatching: 0, executedWithoutMatching: 0, failedAwaitingRetry: 0, terminalError: 0 };
  const attribution = { pr33Observed: 0, ownJobAlreadyPresent: 0, otherTrigger: 0 };
  const delays = { entry: [], execution: [], candidate: [] };
  let unknownEntry = 0; let notExecuted = 0; let notGained = 0; let gained = 0; let gainEligible = 0; let ownRuns = 0;
  const gainCases = new Set(); const gainedCases = new Set();
  for (const job of mature) {
    const { observation } = job.payload;
    const ownKey = attemptJobKey(job.key);
    const start = new Date(observation.observedAt); const horizon = new Date(start.getTime() + followUp);
    const caseAttempts = (byCase.get(job.payload.caseId) || []).filter((attempt) => new Date(attempt.startedAt) >= start);
    const inWindow = caseAttempts.filter((attempt) => doneBy(attempt, horizon));
    const ownAll = caseAttempts.filter((attempt) => attempt.jobKeyHash === ownKey);
    const own = inWindow.filter((attempt) => attempt.jobKeyHash === ownKey);
    outcomes[pairOutcome(job, own, ownAll, horizon)] += 1;
    ownRuns += own.filter((attempt) => attempt.outcome !== "skipped").length;
    if (observation.eligibleAfter) delays.entry.push(seconds(observation.eligibleAfter, start)); else unknownEntry += 1;
    const firstRun = own.find((attempt) => attempt.outcome !== "skipped");
    if (firstRun) delays.execution.push(seconds(start, firstRun.startedAt)); else notExecuted += 1;
    if (observation.usableCandidateAtEntry) continue;
    // Candidate gain is tracked across every trigger; only the pair's own job can earn PR33 credit.
    gainEligible += 1; gainCases.add(job.payload.caseId);
    const gain = inWindow.find((attempt) => usableResult(attempt, observation.albumId));
    if (!gain) { notGained += 1; continue; }
    gained += 1; gainedCases.add(job.payload.caseId);
    delays.candidate.push(seconds(start, gain.completedAt));
    if (gain.jobKeyHash !== ownKey) attribution.otherTrigger += 1;
    else attribution[gain.pairCandidateBefore === false ? "pr33Observed" : "ownJobAlreadyPresent"] += 1;
  }
  return {
    collected: true,
    unit: "newly observed eligible case/album pair",
    intake: { basis: intake.basis, from: iso(intake.from), to: iso(intake.to), followUpDays: followUp / DAY_MS, cutoff: iso(cutoff), baseline: intake.baseline, pr33RollbackInsideFollowUp: intake.pr33RollbackInsideFollowUp },
    entryClock: "scanner_observation",
    entered: jobs.length, followUpComplete: mature.length, censored: jobs.length - mature.length,
    enqueueReach: { measurable: false, reason: "pairs enter when the scanner observes and enqueues them; use the daily census notEnqueued count for scan lag" },
    usableCandidateAtEntry: mature.length - gainEligible,
    candidateGain: ratio(gained, gainEligible, "pair"),
    candidateGainCases: ratio(gainedCases.size, gainCases.size, "case"),
    pr33ObservedGain: ratio(attribution.pr33Observed, gainEligible, "pair"),
    gainAttribution: partition(attribution, gained),
    outcomeAtFollowUp: partition(outcomes, mature.length),
    terminalErrorIncidence: ratio(outcomes.terminalError, mature.length, "pair"),
    retryLoad: { unit: "own non-skipped runs per pair; not an error probability", runs: ownRuns, pairs: mature.length, value: mature.length ? ownRuns / mature.length : null },
    delaySeconds: {
      eligibilityToObservationUpperBound: { ...percentiles(delays.entry), unknownEntry },
      observationToFirstRun: { ...percentiles(delays.execution), notRunByFollowUp: notExecuted },
      observationToFirstUsableCandidate: { ...percentiles(delays.candidate), notGainedByFollowUp: notGained },
    },
  };
}

// PR32 run-level coverage (plan: "PR32: evidence and presentation") over every discovery run that
// started in the intake, whatever its trigger. Skips are not runs. Reasons overlap.
async function discoveryRuns(reader, { Listening }, intake) {
  const attempts = (await reader.all(Listening.DiscoveryAttempt, { _id: idRange(intake.from, intake.to), startedAt: { $gte: intake.from, $lt: intake.to } }, "caseId trigger outcome providerComplete queryCapReached candidateCapReached"));
  const runs = attempts.filter((attempt) => attempt.outcome !== "skipped");
  const results = runs.filter((attempt) => attempt.outcome === "committed" || attempt.outcome === "conflict");
  const result = { completeResult: 0, incompleteResult: 0, failedWithoutResult: 0, revisionConflict: 0 };
  const byTrigger = { catalog: 0, moderator_refresh: 0, case_revision: 0 };
  const reasons = { providerIncomplete: 0, queryCapReached: 0, candidateCapReached: 0 };
  let coverageKnown = 0;
  for (const run of runs) {
    if (Object.hasOwn(byTrigger, run.trigger)) byTrigger[run.trigger] += 1;
    if (run.outcome === "failed") result.failedWithoutResult += 1;
    else if (run.outcome === "conflict") result.revisionConflict += 1;
    else result[run.providerComplete ? "completeResult" : "incompleteResult"] += 1;
  }
  for (const run of results) {
    if (run.providerComplete === false) reasons.providerIncomplete += 1;
    if (typeof run.queryCapReached === "boolean") coverageKnown += 1;
    if (run.queryCapReached === true) reasons.queryCapReached += 1;
    if (run.candidateCapReached === true) reasons.candidateCapReached += 1;
  }
  return {
    collected: true,
    unit: "discovery run",
    intake: { basis: intake.basis, from: iso(intake.from), to: iso(intake.to) },
    runs: runs.length, skips: attempts.length - runs.length, distinctCases: new Set(runs.map((run) => run.caseId)).size,
    result: partition(result, runs.length),
    byTrigger: partition(byTrigger, runs.length),
    coverageKnown: ratio(coverageKnown, results.length, "run with a result"),
    reasonsAmongResults: reasons,
    reasonsOverlap: true,
    unrecordedRuns: "unknown: a run whose best-effort record failed to write is absent from every count",
  };
}

const LIMITATIONS = [
  "Snapshot sections describe the database at collection time; they are not windowed cohort outcomes.",
  "Windowed sections cover only runs and pairs recorded after the observation worker started; enqueue reach is not measurable because pairs enter when enqueued.",
  "Pair entry is the scanner observation; eligibility is bounded below by the last completed full sweep's start, and publication commit time is not recorded.",
  "doneWithoutError catalog jobs include safe skips; attempts count lease acquisitions, not provider calls.",
  "Baseline recommendation coverage and comparisons are returned in API responses but not persisted, so they are not measured.",
  "Decision-time candidate order, coverage and active review time are not recorded; approvals are not correctness labels.",
  "Names, cases, pairs and albums are distinct units and must not be added together or treated as people.",
  "Multi-query collection is not an atomic snapshot; see collection.startedAt and finishedAt.",
];

// Attempt records expire, so an intake older than their retention can no longer be read in full.
const windowed = (collect) => (reader, models, context) => {
  if (context.intake.status !== "defined") return { collected: false, reason: context.intake.status };
  if (context.now.getTime() - context.intake.from.getTime() >= DISCOVERY_ATTEMPT_RETENTION_MS) return { collected: false, reason: "observation_records_expired" };
  return collect(reader, models, context);
};
const SECTIONS = [
  ["mappingEvidence", (reader, models) => mappingEvidence(reader, models)],
  ["demandReadiness", (reader, models, { now }) => demandReadiness(reader, models, now)],
  ["rediscoveryCensus", (reader, models) => rediscoveryCensus(reader, models)],
  ["rediscoveryOutcomes", windowed((reader, models, { intake, cutoff, now }) => rediscoveryOutcomes(reader, models, intake, cutoff, now))],
  ["discoveryRuns", windowed((reader, models, { intake }) => discoveryRuns(reader, models, intake))],
];

async function collectMeasurement({
  manifest, checksum, now = new Date(), clock = () => Date.now(), limits = COLLECTION_LIMITS,
  Listening = require("../models/Listening"), AlbumCatalog = require("../models/AlbumCatalog"),
  reviewStatusForAlbums = (...args) => require("../lib/baselines/service").reviewStatusForAlbums(...args),
}) {
  const validated = validateManifest(manifest);
  const budget = createBudget({ maxRecords: limits.maxRecords, wallMs: limits.wallMs, clock });
  const reader = createReader(budget, limits);
  const models = { Listening, AlbumCatalog, reviewStatusForAlbums };
  // Follow-up is complete only for data already observed: the snapshot time, capped at the planned end.
  const endAt = validated.parsed.collection.endAt;
  const cutoff = endAt && endAt < now ? endAt : now;
  const context = { now, cutoff, intake: observationIntake(validated.parsed.exposures, validated.windows) };
  const sections = {}; let stopReason = null;
  for (const [name, collect] of SECTIONS) {
    if (stopReason) { sections[name] = { collected: false, reason: "collection_stopped" }; continue; }
    try { sections[name] = await collect(reader, models, context); }
    catch (error) {
      const timeout = error?.code === 50 || error?.codeName === "MaxTimeMSExpired";
      const memory = error?.code === 292 || error?.codeName === "QueryExceededMemoryLimitNoDiskUseAllowed";
      if (!(error instanceof BudgetExceeded) && !timeout && !memory) throw error;
      stopReason = timeout ? "query_time_budget_exhausted" : memory ? "query_memory_budget_exhausted" : error.reason;
      sections[name] = { collected: false, reason: stopReason };
    }
  }
  const report = {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
    environment: validated.environment,
    manifest: {
      checksum: checksum || null, study: validated.study, sourceCommit: validated.sourceCommit, deployments: validated.deployments,
      allowlistScopeVersion: validated.allowlistScopeVersion, windows: validated.windows,
    },
    cohortWindows: { pr32: cohortWindows(validated.parsed.exposures.pr32, validated.windows, cutoff), pr33: cohortWindows(validated.parsed.exposures.pr33, validated.windows, cutoff) },
    observedAt: now.toISOString(),
    collection: {
      startedAt: now.toISOString(), finishedAt: new Date(now.getTime() + budget.elapsed()).toISOString(),
      complete: !stopReason, stopReason, recordsRead: budget.records, limits: { ...limits },
    },
    ...sections,
    baselineRecommendations: { collected: false, reason: "coverage_not_persisted" },
    limitations: LIMITATIONS,
  };
  return assertAggregateOnly(report);
}

function parseArgs(argv) {
  const usage = "Usage: listeningMeasurement.js (--template | --manifest PATH [--validate-only])";
  if (argv.length === 1 && argv[0] === "--template") return { template: true };
  const args = {}; const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--manifest" && rest.length && !args.manifest && !rest[0].startsWith("--")) args.manifest = rest.shift();
    else if (flag === "--validate-only" && !args.validateOnly) args.validateOnly = true;
    else throw new Error(usage);
  }
  if (!args.manifest) throw new Error(usage);
  return args;
}

function readManifest(path) {
  const bytes = fs.readFileSync(path);
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("MANIFEST_NOT_JSON"); }
  return { manifest, checksum: manifestChecksum(bytes) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.template) { console.log(JSON.stringify(manifestTemplate(), null, 2)); return; }
  const { manifest, checksum } = readManifest(args.manifest);
  const validated = validateManifest(manifest);
  if (args.validateOnly) {
    // Nothing is observed offline, so follow-up is never reported complete here.
    console.log(JSON.stringify({ valid: true, environment: validated.environment, checksum, cohortWindows: { pr32: cohortWindows(validated.parsed.exposures.pr32, validated.windows, null), pr33: cohortWindows(validated.parsed.exposures.pr33, validated.windows, null) } }, null, 2));
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try { console.log(JSON.stringify(await collectMeasurement({ manifest, checksum }), null, 2)); }
  finally { await mongoose.disconnect(); }
}
const PRINTABLE = /^(?:Usage:|Invalid measurement manifest:|MONGO_URI_REQUIRED$|MANIFEST_NOT_JSON$|MEASUREMENT_OUTPUT_CONTAINS_\w+$)/u;
if (require.main === module) main().catch((error) => { console.error(PRINTABLE.test(error?.message || "") ? error.message : "LISTENING_MEASUREMENT_FAILED"); process.exitCode = 1; });
module.exports = { collectMeasurement, createReader, jobState, parseArgs, readManifest };
