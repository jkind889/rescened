// Opt-in active-effort timer for moderator reviews (docs/DETERMINISTIC_MAPPING_METRICS_PLAN.md,
// "Moderator effort"). Moderators time their own active work; tab-open time is never inferred.
// Records store a pseudonymous moderator hash, expire after 90 days and are reported only in totals.
const { moderatorHash } = require("./episodes");

const EFFORT_RETENTION_MS = 90 * 86_400_000;
const MAX_INTERVALS = 100;
const MAX_INTERVAL_MS = 4 * 3_600_000;
const MAX_SPAN_MS = 12 * 3_600_000;
const CLOCK_SKEW_MS = 60_000;
// A decision committed shortly after the last timed interval still belongs to it.
const LINK_GRACE_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const TARGET_KINDS = Object.freeze({ mapping: ["cases"], baseline: ["albums", "submissions"] });
const DECISION_ACTIONS = Object.freeze({ mapping: ["approved", "rejected", "no_catalog_match"], baseline: ["confirm", "replace", "defer", "revoke"] });

class EffortError extends Error {
  constructor(code, status = 400) { super(code); this.name = "EffortError"; this.code = code; this.status = status; }
}
function fail(code, status) { throw new EffortError(code, status); }
function models() { return require("../../models/ReviewObservation"); }
function effortTimerEnabled(env = process.env) { return String(env.REVIEW_EFFORT_TIMER_ENABLED || "").trim().toLowerCase() === "true"; }

async function status(userId, { env = process.env } = {}) {
  const enabled = effortTimerEnabled(env);
  if (!enabled) return { enabled, optedIn: false };
  const row = await models().EffortOptIn.findOne({ moderatorHash: moderatorHash(userId) }).select("optedIn").lean();
  return { enabled, optedIn: row?.optedIn === true };
}

async function setOptIn(userId, body, { env = process.env } = {}) {
  if (!effortTimerEnabled(env)) fail("REVIEW_EFFORT_TIMER_DISABLED", 503);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "optedIn") || typeof body.optedIn !== "boolean") fail("INVALID_REVIEW_EFFORT_REQUEST");
  const key = moderatorHash(userId);
  await models().EffortOptIn.updateOne({ moderatorHash: key }, { $set: { optedIn: body.optedIn }, $setOnInsert: { moderatorHash: key } }, { upsert: true, runValidators: true });
  return { enabled: true, optedIn: body.optedIn };
}

function instant(value) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) fail("INVALID_REVIEW_EFFORT_REQUEST");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) fail("INVALID_REVIEW_EFFORT_REQUEST");
  return parsed;
}

// Rejects unknown fields and impossible timings before anything is stored.
function normalizeEffort(body, now) {
  const allowed = ["effortId", "kind", "targetKind", "targetId", "targetRevision", "outcome", "intervals"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) fail("INVALID_REVIEW_EFFORT_REQUEST");
  const { effortId, kind, targetKind, targetId, targetRevision, outcome, intervals } = body;
  if (typeof effortId !== "string" || !UUID.test(effortId)) fail("INVALID_REVIEW_EFFORT_REQUEST");
  if (!Object.hasOwn(TARGET_KINDS, kind) || !TARGET_KINDS[kind].includes(targetKind)) fail("INVALID_REVIEW_EFFORT_REQUEST");
  if (typeof targetId !== "string" || !UUID.test(targetId)) fail("INVALID_REVIEW_EFFORT_REQUEST");
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 0) fail("INVALID_REVIEW_EFFORT_REQUEST");
  if (!["decided", "abandoned"].includes(outcome)) fail("INVALID_REVIEW_EFFORT_REQUEST");
  if (!Array.isArray(intervals) || !intervals.length || intervals.length > MAX_INTERVALS) fail("INVALID_REVIEW_EFFORT_REQUEST");
  let previousEnd = null; let activeMs = 0;
  const parsed = intervals.map((interval) => {
    if (!interval || typeof interval !== "object" || Array.isArray(interval) || Object.keys(interval).some((key) => !["startedAt", "endedAt"].includes(key))) fail("INVALID_REVIEW_EFFORT_REQUEST");
    const startedAt = instant(interval.startedAt); const endedAt = instant(interval.endedAt);
    const length = endedAt - startedAt;
    if (length <= 0 || length > MAX_INTERVAL_MS || (previousEnd && startedAt < previousEnd)) fail("INVALID_REVIEW_EFFORT_INTERVALS");
    previousEnd = endedAt; activeMs += length;
    return { startedAt, endedAt };
  });
  const first = parsed[0].startedAt; const last = parsed[parsed.length - 1].endedAt;
  if (last - first > MAX_SPAN_MS || last.getTime() > now.getTime() + CLOCK_SKEW_MS || first.getTime() < now.getTime() - MAX_SPAN_MS - CLOCK_SKEW_MS) fail("INVALID_REVIEW_EFFORT_INTERVALS");
  return { effortId: effortId.toLowerCase(), kind, targetKind, targetId: targetId.toLowerCase(), targetRevision, outcome, intervals: parsed, activeMs };
}

// The decision this moderator committed for the target while, or shortly after, the timer ran,
// unless another timing already claims it. A decision is linked to at most one timing.
async function linkedAudit(userId, effort) {
  const audit = await candidateAudit(userId, effort);
  if (!audit) return null;
  const claimed = await models().Effort.exists({ auditId: audit.auditId, effortId: { $ne: effort.effortId } });
  return claimed ? null : audit;
}

async function candidateAudit(userId, effort) {
  const from = effort.intervals[0].startedAt;
  const to = new Date(effort.intervals[effort.intervals.length - 1].endedAt.getTime() + LINK_GRACE_MS);
  const createdAt = { $gte: from, $lte: to };
  if (effort.kind === "mapping") {
    const { MappingAudit } = require("../../models/Listening");
    return MappingAudit.findOne({ caseId: effort.targetId, reviewer: userId, action: { $in: DECISION_ACTIONS.mapping }, createdAt }).sort({ createdAt: -1 }).select("auditId").lean();
  }
  const { Audit } = require("../../models/AlbumBaseline");
  return Audit.findOne({ targetKind: effort.targetKind, targetId: effort.targetId, actorUserId: userId, action: { $in: DECISION_ACTIONS.baseline }, createdAt }).sort({ createdAt: -1 }).select("auditId").lean();
}

// Idempotent on effortId, so a retried submission never duplicates the timing.
async function recordEffort(userId, body, { env = process.env, clock = () => new Date() } = {}) {
  if (!effortTimerEnabled(env)) fail("REVIEW_EFFORT_TIMER_DISABLED", 503);
  const now = clock();
  const effort = normalizeEffort(body, now);
  const key = moderatorHash(userId);
  const optIn = await models().EffortOptIn.findOne({ moderatorHash: key }).select("optedIn").lean();
  if (optIn?.optedIn !== true) fail("REVIEW_EFFORT_OPT_IN_REQUIRED", 403);
  const audit = effort.outcome === "decided" ? await linkedAudit(userId, effort) : null;
  try {
    await models().Effort.updateOne(
      { effortId: effort.effortId, moderatorHash: key },
      { $setOnInsert: { ...effort, moderatorHash: key, auditId: audit?.auditId || "", recordedAt: now, expiresAt: new Date(now.getTime() + EFFORT_RETENTION_MS) } },
      { upsert: true, runValidators: true },
    );
  } catch (error) {
    if (error?.code === 11000) fail("REVIEW_EFFORT_CONFLICT", 409);
    throw error;
  }
  return { recorded: true, linked: Boolean(audit) };
}

module.exports = { EFFORT_RETENTION_MS, EffortError, effortTimerEnabled, normalizeEffort, recordEffort, setOptIn, status };
