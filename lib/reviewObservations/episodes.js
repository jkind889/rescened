// Decision-time review episodes and baseline recommendation runs (docs/DETERMINISTIC_MAPPING_METRICS_PLAN.md).
// Evidence is captured before a moderator command's transaction and written after it commits, keyed
// by the audit entry. Nothing here may change a decision's outcome or its HTTP contract: every
// function resolves instead of throwing, and a write that cannot finish is logged with a reason code.
// Episodes missing without a logged failure are counted as unknown by the measurement report.
const crypto = require("node:crypto");

const EVIDENCE_VERSION = 1;
const RECOMMENDER_VERSION = 1;
const EPISODE_RETENTION_MS = 180 * 86_400_000;
const RECOMMENDATION_RUN_RETENTION_MS = 90 * 86_400_000;
// A recommendation older than this is not treated as the one the moderator was looking at.
const RECOMMENDATION_LOOKBACK_MS = 86_400_000;
// The decision response waits at most this long for the episode write; failure markers are
// written in the background. Each evidence read before the transaction is limited separately.
const WRITE_TIMEOUT_MS = 2_000;
const READ_TIMEOUT_MS = 1_000;
const MAX_MAPPING_REFS = 100;
const MAX_BASELINE_REFS = 1_020;
const MAX_BROWSE_PAGES = 50;
const MAX_COMPARISONS = 25;
const MAPPING_DECISIONS = Object.freeze({ approve: "approved", reject: "rejected", "no-catalog-match": "no_catalog_match" });
const BASELINE_DECISIONS = new Set(["confirm", "replace", "defer", "revoke"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/iu;

function models() { return require("../../models/ReviewObservation"); }
function episodesEnabled(env = process.env) { return String(env.REVIEW_EPISODES_ENABLED || "").trim().toLowerCase() === "true"; }
// Pseudonymous, not anonymous: with a small moderator allowlist a known ID can be re-hashed and matched.
function moderatorHash(userId) { return crypto.createHash("sha256").update(`rescened-review-observation:v1:${String(userId)}`).digest("hex"); }
function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value || null; }
function evidenceHash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
const positive = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined);
const count = (value) => (value !== null && value !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : undefined);
const bool = (value) => (typeof value === "boolean" ? value : undefined);
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

function log(event, fields) {
  try { console.warn(JSON.stringify({ event, ...fields })); } catch { /* logging must not fail a decision */ }
}

// Resolves after the write or the timeout, whichever comes first. A timed-out write may still land.
async function bounded(work, ms = WRITE_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); timer.unref?.(); });
  try { return await Promise.race([Promise.resolve(work).then(() => "done"), timeout]); }
  finally { clearTimeout(timer); }
}

function finishEvidence(fields) {
  const evidence = { ...fields, candidatesTruncated: Boolean(fields.candidatesTruncated) };
  const { capturedAt, ...hashed } = evidence;
  return { ...evidence, evidenceHash: evidenceHash(hashed) };
}

// Validates a capture before the transaction starts, so a write after commit cannot fail on its shape.
function validated(fields) {
  const { Episode } = models();
  const probe = new Episode({ auditId: crypto.randomUUID(), decidedRevision: 1, decidedAt: new Date(), recordedAt: new Date(), expiresAt: new Date(), moderatorHash: "0".repeat(64), outcome: "recorded", ...fields });
  return probe.validateSync() ? null : fields;
}

function discoveryEntry(evidence) {
  return (Array.isArray(evidence) ? evidence : []).find((entry) => entry?.source === "candidate_discovery") || null;
}

// The candidate list a mapping moderator sees: stored order, with each album's current catalog
// revision (as the detail response shows it) and the case's discovery coverage.
async function captureMapping({ caseId, action, command, env = process.env, clock = () => new Date() }) {
  if (!episodesEnabled(env) || !MAPPING_DECISIONS[action]) return null;
  const base = { evidenceVersion: EVIDENCE_VERSION, kind: "mapping", targetKind: "cases", targetId: caseId, action: MAPPING_DECISIONS[action] };
  try {
    const { MappingCase } = require("../../models/Listening");
    const AlbumCatalog = require("../../models/AlbumCatalog");
    const { catalogRevisionOf } = require("../listening/common");
    const found = plain(await MappingCase.findOne({ caseId }).select("revision candidates.albumId candidates.catalogRevision evidence discoveryError").maxTimeMS(READ_TIMEOUT_MS).lean());
    if (!found) return { ...base, failure: "capture_failed" };
    const stored = (found.candidates || []).filter((item) => UUID.test(String(item?.albumId || "")));
    const albums = stored.length ? await AlbumCatalog.find({ albumId: { $in: stored.map((item) => item.albumId) } }).select("albumId catalogRevision").maxTimeMS(READ_TIMEOUT_MS).lean() : [];
    const revisions = new Map(albums.map((album) => [album.albumId, catalogRevisionOf(album)]));
    const candidates = stored.slice(0, MAX_MAPPING_REFS).map((item) => compact({ id: item.albumId, revision: positive(revisions.get(item.albumId) ?? item.catalogRevision) }));
    const entry = discoveryEntry(found.evidence);
    const coverage = compact({
      discoveryError: found.discoveryError ? String(found.discoveryError).slice(0, 100) : undefined,
      providerIncomplete: found.discoveryError ? ["provider_evidence_incomplete", "discovery_incomplete"].includes(found.discoveryError) : false,
      queryCapReached: bool(entry?.candidateQueryLimitReached),
      candidatesFound: count(entry?.candidatesFound),
      candidatesShown: count(entry?.candidatesShown),
      candidateCapReached: entry && count(entry.candidatesFound) !== undefined && count(entry.candidatesShown) !== undefined ? entry.candidatesFound > entry.candidatesShown : undefined,
      retainedAfterFailedRefresh: Boolean(found.discoveryError) && stored.length > 0,
      staleCandidateRevision: stored.some((item) => revisions.has(item.albumId) && revisions.get(item.albumId) !== Number(item.catalogRevision)),
    });
    let selected = null; let selectedRank = null;
    if (action === "approve") {
      const rank = stored.findIndex((item) => item.albumId === command.albumId);
      selected = compact({ id: command.albumId, revision: positive(command.expectedCatalogRevision) ?? positive(revisions.get(command.albumId) ?? stored[rank]?.catalogRevision) });
      selectedRank = rank;
    }
    const evidence = finishEvidence({ capturedAt: clock(), targetRevision: Number(found.revision) || 1, expectedRevision: command.expectedRevision, candidates, candidatesTruncated: stored.length > MAX_MAPPING_REFS, coverage, recommendationRunId: "", recommended: null, selected, selectedRank });
    return validated({ ...base, evidence }) ? { ...base, evidence } : { ...base, failure: "capture_invalid" };
  } catch (error) {
    log("review_episode_capture_failed", { kind: "mapping", code: error?.code || error?.name || "ERROR" });
    return { ...base, failure: "capture_failed" };
  }
}

function runCoverage(result) {
  const browse = result?.coverage?.browse || {};
  const hydration = result?.coverage?.hydration || {};
  return compact({
    browseComplete: bool(browse.complete),
    browseListed: count(browse.listed),
    browseTotal: count(browse.total),
    hydrationComplete: bool(hydration.complete),
    hydrationFailed: Array.isArray(hydration.failed) ? hydration.failed.length : undefined,
    uninspectedCompeting: Array.isArray(hydration.uninspected) ? hydration.uninspected.length : undefined,
    competing: count(hydration.competing),
    ambiguous: bool(result?.ambiguous),
    incomplete: bool(result?.incomplete),
  });
}
const runRef = (item) => (MBID.test(String(item?.releaseMbid || "")) ? compact({ releaseMbid: String(item.releaseMbid).toLowerCase(), tracklistHash: HASH.test(String(item.tracklistHash || "")) ? String(item.tracklistHash).toLowerCase() : undefined }) : null);

// Records one recommender execution, or its failure, for the target revision it ran against.
async function recordRecommendationRun({ kind, targetId, targetRevision, startedAt, result, error, env = process.env, clock = () => new Date() }) {
  if (!episodesEnabled(env)) return null;
  try {
    const { RecommendationRun } = models();
    const items = Array.isArray(result?.items) ? result.items : [];
    const ranked = items.map(runRef).filter(Boolean);
    // If an item could not be recorded, do not issue a run ID that claims a complete display.
    if (ranked.length !== items.length || ranked.length > MAX_BASELINE_REFS) return null;
    const completedAt = clock();
    const run = {
      runId: crypto.randomUUID(), evidenceVersion: EVIDENCE_VERSION, recommenderVersion: RECOMMENDER_VERSION,
      targetKind: kind, targetId, targetRevision,
      outcome: error ? "failed" : result?.candidate ? "recommended" : "no_candidate",
      errorCode: error ? String(error.code || "RECOMMENDATION_FAILED").slice(0, 100) : "",
      coverage: error ? null : runCoverage(result),
      ranked, rankedTruncated: false,
      recommended: error ? null : runRef(result?.candidate),
      comparisons: (Array.isArray(result?.comparisons) ? result.comparisons : []).map((item) => (MBID.test(String(item?.releaseMbid || "")) ? { releaseMbid: String(item.releaseMbid).toLowerCase(), competing: Boolean(item.competing), equivalent: typeof item.equivalent === "boolean" ? item.equivalent : null } : null)).filter(Boolean).slice(0, MAX_COMPARISONS),
      startedAt, completedAt, expiresAt: new Date(completedAt.getTime() + RECOMMENDATION_RUN_RETENTION_MS),
    };
    if (await bounded(RecommendationRun.create(run)) === "timeout") { log("recommendation_run_failed", { reason: "write_timeout" }); return null; }
    return run.runId;
  } catch (failure) {
    log("recommendation_run_failed", { reason: "write_failed", code: failure?.code || failure?.name || "ERROR" });
    return null;
  }
}

// A later browse page is attached to the specific run returned to this review panel. Its ID
// identifies exactly the page displayed, including a repeated offset with changed provider data.
async function recordRecommendationPage({ runId, kind, targetId, targetRevision, offset, result, env = process.env }) {
  if (!episodesEnabled(env) || !UUID.test(String(runId || ""))) return null;
  try {
    const { RecommendationRun } = models();
    const items = Array.isArray(result?.items) ? result.items : [];
    const ranked = items.map(runRef).filter(Boolean);
    if (ranked.length !== items.length || ranked.length > MAX_BASELINE_REFS) return null;
    const pageId = crypto.randomUUID();
    const page = { pageId, offset, ranked, incomplete: bool(result?.incomplete) ?? null };
    const write = RecommendationRun.updateOne(
      { runId, targetKind: kind, targetId, targetRevision, "pages.49": { $exists: false } },
      { $push: { pages: page } }, { runValidators: true },
    );
    let writeResult;
    const saved = await bounded(Promise.resolve(write).then((result) => { writeResult = result; }));
    if (saved === "timeout") { log("recommendation_page_failed", { reason: "write_timeout" }); return null; }
    return writeResult?.matchedCount === 1 ? pageId : null;
  } catch (error) {
    log("recommendation_page_failed", { reason: "write_failed", code: error?.code || error?.name || "ERROR" });
    return null;
  }
}

// The baseline evidence a moderator decides on: the exact recommendation run and browse pages
// returned to this review panel, plus the release it selected.
async function captureBaseline({ kind, id, action, body, env = process.env, clock = () => new Date() }) {
  if (!episodesEnabled(env) || !BASELINE_DECISIONS.has(action) || !["albums", "submissions"].includes(kind)) return null;
  const targetId = String(id || "").trim().toLowerCase();
  const base = { evidenceVersion: EVIDENCE_VERSION, kind: "baseline", targetKind: kind, targetId, action };
  if (!UUID.test(targetId)) return null;
  try {
    const AlbumCatalog = require("../../models/AlbumCatalog");
    const AlbumSubmission = require("../../models/AlbumSubmission");
    const Baselines = require("../../models/AlbumBaseline");
    const { RecommendationRun } = models();
    const target = kind === "albums"
      ? await AlbumCatalog.findOne({ albumId: targetId }).select("catalogRevision").maxTimeMS(READ_TIMEOUT_MS).lean()
      : await AlbumSubmission.findOne({ submissionId: targetId }).select("currentRevision").maxTimeMS(READ_TIMEOUT_MS).lean();
    if (!target) return { ...base, failure: "capture_failed" };
    const targetRevision = kind === "albums" ? positive(target.catalogRevision) || 1 : positive(target.currentRevision) || 1;
    const head = await Baselines.Head.findOne({ targetKind: kind, targetId }).select("revision").maxTimeMS(READ_TIMEOUT_MS).lean();
    const now = clock();
    const runId = UUID.test(String(body?.recommendationRunId || "")) ? String(body.recommendationRunId).toLowerCase() : "";
    const pageIds = Array.isArray(body?.recommendationPageIds) ? body.recommendationPageIds : [];
    const run = runId ? await RecommendationRun.findOne({ runId, targetKind: kind, targetId, targetRevision, completedAt: { $gte: new Date(now.getTime() - RECOMMENDATION_LOOKBACK_MS), $lte: now } }).maxTimeMS(READ_TIMEOUT_MS).lean() : null;
    const pages = pageIds.map((pageId) => (run?.pages || []).find((page) => page.pageId === pageId));
    // A missing run or page means the display cannot be reconstructed. Never substitute a
    // different moderator's latest run or silently omit a page the moderator saw.
    const completeRun = run && pages.every(Boolean) && pageIds.length <= MAX_BROWSE_PAGES ? run : null;
    const displayed = completeRun ? [...(run.ranked || []), ...pages.flatMap((page) => page.ranked || [])] : [];
    const candidates = displayed.slice(0, MAX_BASELINE_REFS).map((item) => compact({ id: item.releaseMbid, tracklistHash: item.tracklistHash }));
    const listed = (completeRun?.coverage?.browseListed || 0) + pages.reduce((sum, page) => sum + (page?.ranked?.length || 0), 0);
    const lastPage = pages.at(-1);
    const browseComplete = lastPage && completeRun?.coverage?.browseListed !== undefined
      ? lastPage.incomplete === false && (completeRun.coverage.browseTotal === undefined || listed >= completeRun.coverage.browseTotal)
      : completeRun?.coverage?.browseComplete;
    let selected = null; let selectedRank = null;
    if ((action === "confirm" || action === "replace") && MBID.test(String(body?.releaseMbid || ""))) {
      const releaseMbid = String(body.releaseMbid).toLowerCase();
      selected = compact({ id: releaseMbid, tracklistHash: HASH.test(String(body.candidateHash || "")) ? String(body.candidateHash).toLowerCase() : undefined });
      selectedRank = candidates.findIndex((item) => item.id === releaseMbid);
    }
    const recommended = completeRun?.recommended ? compact({ id: completeRun.recommended.releaseMbid, tracklistHash: completeRun.recommended.tracklistHash }) : null;
    const evidence = finishEvidence({
      capturedAt: now, targetRevision, expectedRevision: Number.isSafeInteger(body?.expectedRevision) && body.expectedRevision >= 0 ? body.expectedRevision : 0,
      headRevision: count(head?.revision) ?? 0, candidates, candidatesTruncated: displayed.length > MAX_BASELINE_REFS || Boolean(completeRun?.rankedTruncated),
      coverage: completeRun ? compact({ ...(completeRun.coverage || {}), ...(lastPage && completeRun.coverage?.browseListed !== undefined ? { browseListed: listed, browseComplete } : {}) }) : null,
      recommendationRunId: completeRun?.runId || "", recommended, selected, selectedRank,
    });
    return validated({ ...base, evidence }) ? { ...base, evidence } : { ...base, failure: "capture_invalid" };
  } catch (error) {
    log("review_episode_capture_failed", { kind: "baseline", code: error?.code || error?.name || "ERROR" });
    return { ...base, failure: "capture_failed" };
  }
}

// Writes the episode for a committed decision. Idempotent on auditId, so a retried write never
// duplicates it. A failed write leaves a failure marker when the database still accepts one.
async function recordEpisode(capture, { auditId, decidedRevision, reviewer, decidedAt, clock = () => new Date() }) {
  if (!capture || !UUID.test(String(auditId || ""))) return null;
  try { return await writeEpisode(capture, { auditId, decidedRevision, reviewer, decidedAt, clock }); } catch (error) {
    log("review_episode_failed", { kind: capture.kind, reason: "write_failed", code: error?.code || error?.name || "ERROR" });
    return "failed";
  }
}

async function writeEpisode(capture, { auditId, decidedRevision, reviewer, decidedAt, clock }) {
  const { Episode } = models();
  const recordedAt = clock();
  const { failure, evidence, ...base } = capture;
  const common = { ...base, auditId, decidedRevision, moderatorHash: moderatorHash(reviewer), decidedAt: decidedAt || recordedAt, recordedAt, expiresAt: new Date(recordedAt.getTime() + EPISODE_RETENTION_MS) };
  const upsert = (fields) => Episode.updateOne({ auditId }, { $setOnInsert: { ...common, ...fields } }, { upsert: true, runValidators: true });
  // A marker is written in the background only after a confirmed failure. A timed-out write
  // remains in flight; letting a marker race it could replace valid evidence permanently.
  const marker = (reason) => { Promise.resolve().then(() => upsert({ outcome: "failed", failureReason: reason, evidence: null })).catch(() => { /* counted as unknown */ }); };
  const document = failure ? { outcome: "failed", failureReason: failure, evidence: null } : { outcome: "recorded", failureReason: "", evidence };
  try {
    // Normalize Mongoose's single-use Query to a real Promise before the timeout path
    // observes it again; re-assimilating a Query would execute it twice.
    const write = Promise.resolve().then(() => upsert(document));
    if (await bounded(write) === "timeout") {
      log("review_episode_failed", { kind: base.kind, reason: "write_timeout" });
      Promise.resolve(write).catch((error) => {
        if (error?.code === 11000) return;
        log("review_episode_failed", { kind: base.kind, reason: "write_failed", code: error?.code || error?.name || "ERROR" });
        marker("write_failed");
      });
      return "timeout";
    }
    if (failure) log("review_episode_failed", { kind: base.kind, reason: failure });
    return document.outcome;
  } catch (error) {
    // A concurrent write of the same audit entry already inserted it.
    if (error?.code === 11000) return "duplicate";
    log("review_episode_failed", { kind: base.kind, reason: "write_failed", code: error?.code || error?.name || "ERROR" });
    marker("write_failed");
    return "failed";
  }
}

module.exports = {
  BASELINE_DECISIONS, EPISODE_RETENTION_MS, READ_TIMEOUT_MS, EVIDENCE_VERSION, MAPPING_DECISIONS, RECOMMENDATION_LOOKBACK_MS, RECOMMENDATION_RUN_RETENTION_MS, RECOMMENDER_VERSION,
  captureBaseline, captureMapping, episodesEnabled, moderatorHash, recordEpisode, recordRecommendationPage, recordRecommendationRun,
};
