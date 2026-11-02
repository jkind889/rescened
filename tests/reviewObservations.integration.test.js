const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const Baselines = require("../models/AlbumBaseline");
const Listening = require("../models/Listening");
const ReviewObservation = require("../models/ReviewObservation");
const { mappingKey } = require("../lib/listening/common");
const { moderate } = require("../lib/listening/moderation");
const { hashCandidateTracklist } = require("../lib/baselines/musicBrainz");
const { performCommand, storeCandidate } = require("../lib/baselines/service");
const episodes = require("../lib/reviewObservations/episodes");
const effort = require("../lib/reviewObservations/effort");
const { summarizeLabels } = require("../lib/reviewObservations/adjudication");
const { manifestTemplate } = require("../lib/listening/measurement");
const { collectMeasurement } = require("../scripts/listeningMeasurement");
const { clearReviewEpisodes } = require("../scripts/clearReviewEpisodes");
const { exportPacket } = require("../scripts/reviewAdjudication");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const ENV = { REVIEW_EPISODES_ENABLED: "true", REVIEW_EFFORT_TIMER_ENABLED: "true", MODERATOR_USER_IDS: "moderator,second-moderator", TRACKLIST_BASELINE_MODERATION_ENABLED: "true", COMMUNITY_MODERATION_ENABLED: "true" };
let replSet;

const mbid = () => crypto.randomUUID();
function makeCandidate(releaseGroupMbid) {
  const releaseMbid = mbid();
  const value = {
    releaseMbid, releaseGroupMbid, title: "Pilot", artistDisplayName: "Artist", date: "2026", country: "US", formats: ["Digital Media"], disambiguation: "", status: "Official",
    tracks: [{ discNumber: 1, trackNumber: 1, title: "One", durationMs: 1000, artistDisplayName: "Artist", releaseTrackMbid: mbid(), recordingMbid: mbid() }],
    retrievedAt: new Date(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: "CC0", tracklistHash: "",
  };
  value.tracklistHash = hashCandidateTracklist(value);
  return value;
}
const album = (fields = {}) => {
  const releaseGroupMbid = mbid();
  return AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Pilot", artistDisplayName: "Artist", releaseType: "album", catalogRevision: 1, tracks: [], externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: releaseGroupMbid, url: `https://musicbrainz.org/release-group/${releaseGroupMbid}` }], ...fields });
};
const mappingCase = (title, fields = {}) => Listening.MappingCase.create({ key: mappingKey("Artist", title), artist: "Artist", album: title, artistKey: "artist", albumKey: title.toLowerCase(), status: "pending", ...fields });

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_review_observations" });
  await Promise.all([AlbumCatalog, ...Object.values(Listening), ...Object.values(Baselines), ...Object.values(ReviewObservation)].map((model) => model.syncIndexes()));
  Object.assign(process.env, ENV);
});
test.after(async () => {
  if (!enabled) return;
  for (const key of Object.keys(ENV)) delete process.env[key];
  await mongoose.connection.dropDatabase(); await mongoose.disconnect(); await replSet.stop();
});

test("mapping decisions write an episode after commit, keyed by the audit entry", { skip: !enabled }, async (t) => {
  const indexes = await ReviewObservation.Episode.collection.indexes();
  assert.ok(indexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0), "episodes expire");
  const [first, second, searched] = await Promise.all([album({ title: "First" }), album({ title: "Second", catalogRevision: 3 }), album({ title: "Searched" })]);
  const approved = await mappingCase("Approve Me", { candidates: [{ albumId: first.albumId, title: "First", artistDisplayName: "Artist", catalogRevision: 1 }, { albumId: second.albumId, title: "Second", artistDisplayName: "Artist", catalogRevision: 2 }], evidence: [{ source: "candidate_discovery", candidateQueryLimitReached: true, candidatesFound: 4, candidatesShown: 2 }] });
  const response = await moderate(approved.caseId, "approve", { expectedRevision: 1, albumId: second.albumId, expectedCatalogRevision: 3 }, "moderator");
  const audit = await Listening.MappingAudit.findOne({ caseId: approved.caseId }).lean();
  const episode = await ReviewObservation.Episode.findOne({ auditId: audit.auditId }).lean();
  assert.equal(episode.outcome, "recorded");
  assert.deepEqual([episode.kind, episode.targetKind, episode.action, episode.decidedRevision], ["mapping", "cases", "approved", 2]);
  assert.deepEqual(episode.evidence.candidates.map(({ id, revision }) => ({ id, revision })), [{ id: first.albumId, revision: 1 }, { id: second.albumId, revision: 3 }], "display order with the current catalog revision");
  assert.equal(episode.evidence.selectedRank, 1);
  assert.equal(episode.evidence.coverage.queryCapReached, true);
  assert.equal(episode.evidence.coverage.candidateCapReached, true);
  assert.equal(episode.evidence.coverage.staleCandidateRevision, true);
  assert.equal(episode.moderatorHash, episodes.moderatorHash("moderator"));
  assert.equal(JSON.stringify(episode).includes("\"moderator\""), false, "the raw moderator ID is not stored");
  assert.ok(episode.expiresAt - episode.recordedAt >= episodes.EPISODE_RETENTION_MS - 1000);
  assert.equal(response.case.status, "approved");

  // A selection from catalog search sits outside the displayed list.
  const offList = await mappingCase("Search Me", { candidates: [{ albumId: first.albumId, title: "First", artistDisplayName: "Artist", catalogRevision: 1 }] });
  await moderate(offList.caseId, "approve", { expectedRevision: 1, albumId: searched.albumId }, "moderator");
  assert.equal((await ReviewObservation.Episode.findOne({ targetId: offList.caseId }).lean()).evidence.selectedRank, -1);

  // Refresh is not a decision, and nothing is written while the flag is off.
  const refreshed = await mappingCase("Refresh Me");
  await moderate(refreshed.caseId, "refresh", { expectedRevision: 1 }, "moderator");
  delete process.env.REVIEW_EPISODES_ENABLED;
  const quiet = await mappingCase("Flag Off");
  await moderate(quiet.caseId, "reject", { expectedRevision: 1 }, "moderator");
  process.env.REVIEW_EPISODES_ENABLED = "true";
  assert.equal(await ReviewObservation.Episode.countDocuments({ targetId: { $in: [refreshed.caseId, quiet.caseId] } }), 0);

  // A failed write never changes the decision or its response, and leaves a marker.
  const failing = await mappingCase("Fail Write");
  const original = ReviewObservation.Episode.updateOne.bind(ReviewObservation.Episode);
  let calls = 0;
  t.mock.method(ReviewObservation.Episode, "updateOne", (...args) => { calls += 1; return calls === 1 ? Promise.reject(Object.assign(new Error("write refused"), { code: 121 })) : original(...args); });
  t.mock.method(console, "warn", () => {});
  const failed = await moderate(failing.caseId, "no-catalog-match", { expectedRevision: 1 }, "moderator");
  assert.equal(failed.case.status, "no_catalog_match");
  // The failure marker is written in the background.
  for (let tries = 0; tries < 50 && !await ReviewObservation.Episode.exists({ targetId: failing.caseId }); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const marker = await ReviewObservation.Episode.findOne({ targetId: failing.caseId }).lean();
  assert.deepEqual([marker.outcome, marker.failureReason, marker.evidence], ["failed", "write_failed", null]);
  t.mock.restoreAll();

  // A conflicting decision commits nothing, so it writes nothing.
  const conflict = await mappingCase("Conflict");
  await assert.rejects(moderate(conflict.caseId, "reject", { expectedRevision: 9 }, "moderator"), (error) => error.code === "REVISION_CONFLICT");
  assert.equal(await ReviewObservation.Episode.countDocuments({ targetId: conflict.caseId }), 0);
});

test("baseline decisions link the recommendation run the moderator saw; replays add nothing", { skip: !enabled }, async () => {
  const target = await album();
  const releaseGroupMbid = target.externalReferences[0].externalId;
  const recommended = makeCandidate(releaseGroupMbid); const alternative = makeCandidate(releaseGroupMbid);
  const result = { candidate: recommended, items: [{ releaseMbid: recommended.releaseMbid }, { releaseMbid: alternative.releaseMbid }], incomplete: true, ambiguous: false, comparisons: [{ releaseMbid: alternative.releaseMbid, competing: true, equivalent: false }], coverage: { browse: { complete: false, listed: 2, total: 3 }, hydration: { complete: true, competing: 2, failed: [], uninspected: [] } } };
  const runId = await episodes.recordRecommendationRun({ kind: "albums", targetId: target.albumId, targetRevision: 1, startedAt: new Date(), result });
  const run = await ReviewObservation.RecommendationRun.findOne({ runId }).lean();
  assert.deepEqual([run.outcome, run.coverage.browseComplete, run.coverage.browseTotal, run.ranked.length], ["recommended", false, 3, 2]);
  await storeCandidate("albums", target, recommended); await storeCandidate("albums", target, alternative);
  const requestId = crypto.randomUUID();
  const body = { expectedRevision: 0, expectedTargetRevision: 1, requestId, releaseMbid: alternative.releaseMbid, releaseGroupMbid, candidateHash: alternative.tracklistHash };
  const first = await performCommand({ kind: "albums", id: target.albumId, action: "confirm", body, actorUserId: "moderator" });
  const audit = await Baselines.Audit.findOne({ targetId: target.albumId, requestId }).lean();
  const episode = await ReviewObservation.Episode.findOne({ auditId: audit.auditId }).lean();
  assert.deepEqual([episode.kind, episode.targetKind, episode.action, episode.outcome], ["baseline", "albums", "confirm", "recorded"]);
  assert.equal(episode.evidence.recommendationRunId, runId);
  assert.equal(episode.evidence.recommended.id, recommended.releaseMbid);
  assert.equal(episode.evidence.selected.id, alternative.releaseMbid);
  assert.equal(episode.evidence.selectedRank, 1);
  assert.equal(episode.evidence.coverage.browseComplete, false);
  const replay = await performCommand({ kind: "albums", id: target.albumId, action: "confirm", body, actorUserId: "moderator" });
  assert.deepEqual(replay.revision, first.revision);
  assert.equal(await ReviewObservation.Episode.countDocuments({ targetId: target.albumId }), 1, "an idempotent replay commits no new decision");

  // Without a recommendation run the episode still records the decision, with no recommendation.
  const deferred = await album();
  await performCommand({ kind: "albums", id: deferred.albumId, action: "defer", body: { expectedRevision: 0, expectedTargetRevision: 1, requestId: crypto.randomUUID() }, actorUserId: "moderator" });
  const deferEpisode = await ReviewObservation.Episode.findOne({ targetId: deferred.albumId }).lean();
  assert.deepEqual([deferEpisode.action, deferEpisode.evidence.recommendationRunId, deferEpisode.evidence.coverage, deferEpisode.evidence.selected], ["defer", "", null, null]);
});

test("the effort timer requires opt-in, links to the moderator's decision and is idempotent", { skip: !enabled }, async () => {
  const now = new Date();
  const iso = (offset) => new Date(now.getTime() + offset).toISOString();
  const target = await mappingCase("Timed");
  const body = { effortId: crypto.randomUUID(), kind: "mapping", targetKind: "cases", targetId: target.caseId, targetRevision: 1, outcome: "decided", intervals: [{ startedAt: iso(-120_000), endedAt: iso(-60_000) }] };
  await assert.rejects(effort.recordEffort("moderator", body), (error) => error.code === "REVIEW_EFFORT_OPT_IN_REQUIRED" && error.status === 403);
  assert.deepEqual(await effort.status("moderator"), { enabled: true, optedIn: false });
  assert.deepEqual(await effort.setOptIn("moderator", { optedIn: true }), { enabled: true, optedIn: true });
  await assert.rejects(effort.setOptIn("moderator", { optedIn: "yes" }), (error) => error.code === "INVALID_REVIEW_EFFORT_REQUEST");
  await moderate(target.caseId, "reject", { expectedRevision: 1 }, "moderator");
  assert.deepEqual(await effort.recordEffort("moderator", body), { recorded: true, linked: true });
  assert.deepEqual(await effort.recordEffort("moderator", body), { recorded: true, linked: true }, "a retried submission is idempotent");
  assert.equal(await ReviewObservation.Effort.countDocuments({ effortId: body.effortId }), 1);
  assert.deepEqual(await effort.recordEffort("moderator", { ...body, effortId: crypto.randomUUID() }), { recorded: true, linked: false }, "a decision links to at most one timing");
  const stored = await ReviewObservation.Effort.findOne({ effortId: body.effortId }).lean();
  assert.equal(stored.activeMs, 60_000);
  assert.equal(stored.auditId, (await Listening.MappingAudit.findOne({ caseId: target.caseId }).lean()).auditId);
  await effort.setOptIn("second-moderator", { optedIn: true });
  await assert.rejects(effort.recordEffort("second-moderator", body), (error) => error.code === "REVIEW_EFFORT_CONFLICT" && error.status === 409);
  // Another moderator's decision is never linked to this moderator's timing.
  assert.deepEqual(await effort.recordEffort("second-moderator", { ...body, effortId: crypto.randomUUID() }), { recorded: true, linked: false });
  assert.deepEqual(await effort.recordEffort("moderator", { ...body, effortId: crypto.randomUUID(), outcome: "abandoned" }), { recorded: true, linked: false });
  delete process.env.REVIEW_EFFORT_TIMER_ENABLED;
  await assert.rejects(effort.recordEffort("moderator", { ...body, effortId: crypto.randomUUID() }), (error) => error.code === "REVIEW_EFFORT_TIMER_DISABLED" && error.status === 503);
  assert.deepEqual(await effort.status("moderator"), { enabled: false, optedIn: false });
  process.env.REVIEW_EFFORT_TIMER_ENABLED = "true";
});

test("the report, adjudication export and clear command work on real collections", { skip: !enabled }, async () => {
  const decidedAt = await Listening.MappingAudit.findOne().sort({ createdAt: 1 }).lean();
  const activatedAt = new Date(Math.floor((decidedAt.createdAt.getTime() - 60_000) / 60_000) * 60_000);
  const exposure = { activatedAt: activatedAt.toISOString(), deployedRevision: null, rollbackAt: null, verification: "integration fixture" };
  const manifest = { ...manifestTemplate(), environment: "integration", exposures: { ...manifestTemplate().exposures, reviewEpisodes: exposure, effortTimer: exposure } };
  const before = await Promise.all([Listening.MappingAudit.countDocuments(), Baselines.Audit.countDocuments(), ReviewObservation.Episode.countDocuments()]);
  const report = await collectMeasurement({ manifest, now: new Date() });
  assert.equal(report.collection.complete, true);
  const { mapping, baseline } = report.reviewEpisodes;
  assert.equal(mapping.decisions, mapping.episodes.total);
  assert.equal(mapping.episodes.reconciles, true);
  assert.ok(mapping.episodes.recorded >= 2);
  assert.equal(mapping.failedByReason.write_failed, 1);
  assert.equal(mapping.episodes.missingUnknown, 1, "without a recorded flag change, the decision made while the flag was off is unknown");
  assert.deepEqual([baseline.episodes.recorded, baseline.selection.differsFromRecommendation], [2, 1]);
  assert.equal(report.recommendationRuns.runs, 1);
  assert.deepEqual(report.reviewEffort.timings, { decidedLinked: 1, decidedUnlinked: 2, abandoned: 1, total: 4, reconciles: true });
  assert.deepEqual(await Promise.all([Listening.MappingAudit.countDocuments(), Baselines.Audit.countDocuments(), ReviewObservation.Episode.countDocuments()]), before, "collection is read-only");

  // Every decision is too recent for adjudication until seven days have passed.
  const directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rescened-adjudication-")), "packet");
  const exported = await exportPacket({ manifest, out: directory, seed: "integration", now: new Date(Date.now() + 8 * 86_400_000) });
  assert.ok(exported.sampled >= 3);
  assert.equal((fs.statSync(path.join(directory, "key.json")).mode & 0o777).toString(8), "600");
  const packet = fs.readFileSync(path.join(directory, "packet.json"), "utf8");
  assert.equal(packet.includes("\"moderator\""), false, "no moderator ID");
  assert.equal(packet.includes("moderatorChoice"), false, "no decision");
  assert.ok(packet.includes("Approve Me"), "the packet shows the observed name to the adjudicator");
  const labels = JSON.parse(fs.readFileSync(path.join(directory, "labels.json"), "utf8"));
  const key = JSON.parse(fs.readFileSync(path.join(directory, "key.json"), "utf8"));
  labels.adjudicator = "same_moderator";
  for (const item of key.items) labels.labels[item.itemId] = item.moderatorChoice;
  fs.writeFileSync(path.join(directory, "labels.json"), JSON.stringify(labels));
  const summary = summarizeLabels({ packetBytes: fs.readFileSync(path.join(directory, "packet.json")), keyBytes: fs.readFileSync(path.join(directory, "key.json")), labelsBytes: fs.readFileSync(path.join(directory, "labels.json")) });
  assert.deepEqual([summary.adjudication, summary.outcome.supported, summary.outcome.unsupported], ["delayed_self_review", exported.sampled, 0]);
  await assert.rejects(exportPacket({ manifest, out: directory, seed: "again", now: new Date() }), /ADJUDICATION_OUTPUT_NOT_EMPTY/u);
  fs.rmSync(path.dirname(directory), { recursive: true });

  const cutoff = new Date();
  const dry = await clearReviewEpisodes({ now: cutoff });
  assert.deepEqual([dry.mode, dry.episodes], ["dry-run", before[2]]);
  assert.equal(await ReviewObservation.Episode.countDocuments(), before[2], "a dry run removes nothing");
  await assert.rejects(clearReviewEpisodes({ apply: true, cutoff, count: dry.episodes, database: "rescened_prod" }), /CLEAR_DATABASE_MISMATCH/u);
  const applied = await clearReviewEpisodes({ apply: true, cutoff, count: dry.episodes, database: "rescened_review_observations" });
  assert.deepEqual([applied.deleted, applied.auditEntriesNotReduced], [before[2], true]);
  assert.equal(await ReviewObservation.Episode.countDocuments(), 0);
  assert.deepEqual(await Promise.all([Listening.MappingAudit.countDocuments(), Baselines.Audit.countDocuments()]), before.slice(0, 2), "audit history is untouched");
});
