#!/usr/bin/env node
// Read-only aggregate report on the album-mapping and tracklist review queues. It measures queue
// makeup and moderator effort before any automated assistance is built. It emits counts and
// durations only: no names, album IDs, release IDs or reviewer IDs.
const mongoose = require("mongoose");

const MAPPING_DECISIONS = ["approved", "rejected", "no_catalog_match"];
const BASELINE_DECISIONS = ["confirm", "replace", "defer", "revoke"];
const DAY_MS = 86_400_000;

function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (share) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]) : null;
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null };
}
const seconds = (from, to) => (new Date(to) - new Date(from)) / 1000;

// Describes a case by its stored candidates and discovery evidence. Approved cases keep the
// candidates from their last discovery, which may postdate the decision after a refresh.
function caseShape(row) {
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const discovery = (row.evidence || []).find((entry) => entry?.source === "candidate_discovery") || {};
  const topEvidence = candidates[0]?.evidence || [];
  const verifiedTop = topEvidence.some((entry) => entry?.type === "verified_release_group");
  const conflictedTop = topEvidence.some((entry) => entry?.identifierConflicts?.length);
  return {
    candidates: candidates.length === 0 ? "none" : candidates.length === 1 ? "one" : "several",
    topAlbumId: candidates[0]?.albumId || "",
    candidateIds: new Set(candidates.map((item) => item?.albumId)),
    verifiedTop, conflictedTop,
    singleVerified: candidates.length === 1 && verifiedTop && !conflictedTop,
    editionLabel: Boolean(discovery.simplifiedTitle),
    limitReached: discovery.candidateLimitReached === true,
    discoveryIncomplete: Boolean(row.discoveryError),
  };
}

function unmatched(rows) {
  return {
    cases: rows.length,
    listeners: rows.reduce((sum, row) => sum + (row.listenerCount || 0), 0),
    editionLabel: rows.filter((row) => caseShape(row).editionLabel).length,
  };
}

function mappingQueue(pending, now) {
  const shapes = pending.map(caseShape);
  const count = (test) => shapes.filter(test).length;
  return {
    pending: pending.length,
    listeners: pending.reduce((sum, row) => sum + (row.listenerCount || 0), 0),
    encounters: pending.reduce((sum, row) => sum + (row.encounterCount || 0), 0),
    ageSeconds: percentiles(pending.map((row) => seconds(row.createdAt, now))),
    candidates: { none: count((s) => s.candidates === "none"), one: count((s) => s.candidates === "one"), several: count((s) => s.candidates === "several") },
    verifiedTopCandidate: count((s) => s.verifiedTop),
    conflictedTopCandidate: count((s) => s.conflictedTop),
    singleVerifiedCandidate: count((s) => s.singleVerified),
    editionLabel: count((s) => s.editionLabel),
    editionLabelWithoutCandidate: count((s) => s.editionLabel && s.candidates === "none"),
    candidateLimitReached: count((s) => s.limitReached),
    discoveryIncomplete: count((s) => s.discoveryIncomplete),
  };
}

async function mappingDecisions(Listening, since) {
  const recent = await Listening.MappingAudit.find({ createdAt: { $gte: since }, action: { $in: [...MAPPING_DECISIONS, "revoked", "reconfirmed", "approve"] } }).select("caseId action details createdAt").lean();
  const result = { approved: 0, rejected: 0, noCatalogMatch: 0, revoked: 0, reconfirmed: 0, seededApprovals: 0 };
  const keys = { approved: "approved", rejected: "rejected", no_catalog_match: "noCatalogMatch", revoked: "revoked", reconfirmed: "reconfirmed", approve: "seededApprovals" };
  for (const audit of recent) result[keys[audit.action]] += 1;
  const decided = recent.filter((audit) => MAPPING_DECISIONS.includes(audit.action));
  const caseIds = [...new Set(decided.map((audit) => audit.caseId))];
  const cases = caseIds.length ? await Listening.MappingCase.find({ caseId: { $in: caseIds } }).select("caseId createdAt candidates evidence discoveryError").lean() : [];
  const byCase = new Map(cases.map((row) => [row.caseId, row]));
  // Time to decide counts only a case's first decision. Later ones follow a revoke or seed and
  // would overstate the wait if measured from case creation.
  const history = caseIds.length ? await Listening.MappingAudit.find({ caseId: { $in: caseIds }, action: { $in: [...MAPPING_DECISIONS, "approve"] } }).select("caseId createdAt").lean() : [];
  const first = new Map();
  for (const audit of history) if (!first.has(audit.caseId) || new Date(audit.createdAt) < new Date(first.get(audit.caseId))) first.set(audit.caseId, audit.createdAt);
  const waits = decided.filter((audit) => byCase.has(audit.caseId) && +new Date(first.get(audit.caseId)) === +new Date(audit.createdAt)).map((audit) => seconds(byCase.get(audit.caseId).createdAt, audit.createdAt));
  const approvals = { topCandidate: 0, otherCandidate: 0, outsideCandidates: 0, unknownCase: 0, singleVerifiedCandidate: 0, editionLabel: 0 };
  for (const audit of decided.filter((entry) => entry.action === "approved")) {
    const row = byCase.get(audit.caseId);
    if (!row) { approvals.unknownCase += 1; continue; }
    const shape = caseShape(row); const albumId = audit.details?.selected?.albumId || "";
    if (albumId && albumId === shape.topAlbumId) approvals.topCandidate += 1;
    else if (albumId && shape.candidateIds.has(albumId)) approvals.otherCandidate += 1;
    else approvals.outsideCandidates += 1;
    if (shape.singleVerified && albumId === shape.topAlbumId) approvals.singleVerifiedCandidate += 1;
    if (shape.editionLabel) approvals.editionLabel += 1;
  }
  return { ...result, firstDecisionSeconds: percentiles(waits), approvalCandidateBasis: "latest_stored_discovery", approvals };
}

async function baselineDecisions(Baselines, since) {
  const recent = await Baselines.Audit.find({ createdAt: { $gte: since }, action: { $in: BASELINE_DECISIONS } }).select("targetKind targetId action details createdAt").lean();
  const empty = () => Object.fromEntries(BASELINE_DECISIONS.map((action) => [action, 0]));
  const result = { albums: empty(), submissions: empty() };
  for (const audit of recent) if (result[audit.targetKind]) result[audit.targetKind][audit.action] += 1;
  // Enrichment applies record the recommended release in a queue audit. A later confirm shows
  // whether moderators kept it; that is the only stored record of a recommendation.
  const albumDecisions = recent.filter((audit) => audit.targetKind === "albums" && ["confirm", "defer"].includes(audit.action));
  const targets = [...new Set(albumDecisions.map((audit) => audit.targetId))];
  const history = targets.length ? await Baselines.Audit.find({ targetKind: "albums", targetId: { $in: targets }, action: { $in: ["queue", ...BASELINE_DECISIONS] } }).select("targetId action details createdAt").lean() : [];
  const queue = { confirmedQueuedRelease: 0, confirmedOtherRelease: 0, deferred: 0 };
  const waits = [];
  for (const audit of albumDecisions) {
    // Only the first decision after a queue entry answers its recommendation.
    const earlier = history.filter((entry) => entry.targetId === audit.targetId && new Date(entry.createdAt) < new Date(audit.createdAt))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const prior = earlier[0];
    if (prior?.action !== "queue") continue;
    waits.push(seconds(prior.createdAt, audit.createdAt));
    if (audit.action === "defer") queue.deferred += 1;
    else if (audit.details?.releaseMbid && audit.details.releaseMbid === prior.details?.releaseMbid) queue.confirmedQueuedRelease += 1;
    else queue.confirmedOtherRelease += 1;
  }
  return { ...result, queued: { ...queue, decisionSeconds: percentiles(waits) } };
}

async function catalogRediscoveryJobs(Job) {
  const rows = await Job.aggregate([
    { $match: { type: "discovery", "payload.catalogAlbumId": { $exists: true } } },
    { $group: { _id: { status: "$status", failed: { $ne: ["$error", ""] } }, count: { $sum: 1 } } },
  ]);
  const result = { pending: 0, running: 0, completed: 0, failed: 0 };
  for (const row of rows) {
    const key = row._id.status === "done" ? (row._id.failed ? "failed" : "completed") : row._id.status;
    if (Object.hasOwn(result, key)) result[key] += row.count;
  }
  return result;
}

async function collectQueueReport({ now = new Date(), days = 30, Listening = require("../models/Listening"), Baselines = require("../models/AlbumBaseline"), reviewStatusCounts = () => require("../lib/baselines/service").reviewStatusCounts() } = {}) {
  const since = new Date(now.getTime() - days * DAY_MS);
  const fields = "createdAt listenerCount encounterCount candidates evidence discoveryError";
  const pending = await Listening.MappingCase.find({ status: "pending" }).select(fields).lean();
  // The worker closes cases with no candidates without an audit, so they are read by status.
  const noCatalogMatch = await Listening.MappingCase.find({ status: "no_catalog_match" }).select(fields).lean();
  return {
    observedAt: now.toISOString(),
    window: { days, since: since.toISOString() },
    mappingQueue: mappingQueue(pending, now),
    noCatalogMatch: unmatched(noCatalogMatch),
    mappingDecisions: await mappingDecisions(Listening, since),
    catalogRediscoveryJobs: await catalogRediscoveryJobs(Listening.Job),
    baselineQueue: await reviewStatusCounts(),
    baselineDecisions: await baselineDecisions(Baselines, since),
  };
}

function parseArgs(argv) {
  const usage = "Usage: listeningQueueReport.js --environment NAME [--days N]";
  const args = {}; const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift(); const value = rest.shift();
    if (flag === "--environment" && /^[\w-]{1,80}$/.test(value || "") && !args.environment) args.environment = value;
    else if (flag === "--days" && /^\d{1,3}$/.test(value || "") && Number(value) >= 1 && Number(value) <= 365 && !args.days) args.days = Number(value);
    else throw new Error(usage);
  }
  if (!args.environment) throw new Error(usage);
  return { environment: args.environment, days: args.days || 30 };
}

async function main() {
  const { environment, days } = parseArgs(process.argv.slice(2));
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try { console.log(JSON.stringify({ environment, ...await collectQueueReport({ days }) }, null, 2)); }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch((error) => { console.error(error?.message?.startsWith("Usage:") || error?.message === "MONGO_URI_REQUIRED" ? error.message : "LISTENING_QUEUE_REPORT_FAILED"); process.exitCode = 1; });
module.exports = { collectQueueReport, caseShape, percentiles, parseArgs };
