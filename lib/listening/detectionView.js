const mongoose = require("mongoose");
const { catalogRevisionOf, flags, pilotAllowed, safeError } = require("./common");

const MAX_DETECTION_LIMIT = 50;
const COVERAGE_FILTERS = new Set(["qualified", "below_threshold"]);
const IANA_ZONE = /^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*$/u;

function models() { return require("../../models/Listening"); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function now(clock) { return clock ? clock() : new Date(); }

// Accepts only IANA zone names, stored in their canonical spelling.
function normalizeTimeZone(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw safeError("INVALID_TIME_ZONE", 400);
  let resolved;
  try { resolved = new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).resolvedOptions().timeZone; }
  catch { throw safeError("INVALID_TIME_ZONE", 400); }
  if (!IANA_ZONE.test(resolved)) throw safeError("INVALID_TIME_ZONE", 400);
  return resolved;
}

function detectionEnabledFor(userId, env = process.env) {
  const enabled = flags(env).detection;
  return { enabled, pilotAllowed: enabled && pilotAllowed(userId, env) };
}

function assertDetection(userId, env = process.env) {
  const status = detectionEnabledFor(userId, env);
  if (!status.enabled) throw safeError("LISTENING_DETECTION_DISABLED", 503);
  if (!status.pilotAllowed) throw safeError("LASTFM_PILOT_REQUIRED", 403);
}

// The saved zone dates later sessions only. Detection is queued so sessions
// that had no zone yet can adopt it.
async function setTimeZone({ userId, body, clock, env = process.env } = {}) {
  assertDetection(userId, env);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "timeZone")) throw safeError("INVALID_REQUEST", 400);
  const timeZone = normalizeTimeZone(body.timeZone);
  const Model = models();
  const connection = await Model.Connection.findOneAndUpdate(
    { userId, state: { $in: ["active", "paused"] } },
    { $set: { timeZone } },
    { returnDocument: "after", runValidators: true },
  ).lean();
  if (!connection) throw safeError("LASTFM_NOT_CONNECTED", 404);
  await Model.Job.findOneAndUpdate(
    { key: `detect:${connection._id}` },
    { $setOnInsert: { key: `detect:${connection._id}`, type: "detect", attempts: 0 }, $set: { payload: { connectionId: String(connection._id) }, runAt: now(clock), status: "pending" } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  return { timeZone };
}

function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const startedAt = new Date(decoded.startedAt);
    if (!mongoose.isValidObjectId(decoded.id) || Number.isNaN(startedAt.getTime())) throw new Error("invalid");
    return { startedAt, id: decoded.id };
  } catch { throw safeError("INVALID_CURSOR", 400); }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ startedAt: new Date(row.startedAt).toISOString(), id: String(row._id) })).toString("base64url");
}

// Stored holds are refreshed by the worker; reads recheck the parts that can go
// stale in between, without persisting anything.
function readHolds(row, { current, mappingById, album, baseline }) {
  const holds = new Set(row.holds || []);
  const mappingsValid = album && (row.mappings || []).every(({ mappingId }) => {
    const mapping = mappingById.get(mappingId);
    return mapping?.status === "active" && mapping.albumId === row.albumId && mapping.catalogRevision === catalogRevisionOf(album);
  });
  if (!mappingsValid) holds.add("stale_mapping");
  if (!baseline || baseline.baselineId !== row.baseline?.baselineId || (baseline.version ?? null) !== (row.baseline?.version ?? null)) holds.add("stale_baseline");
  const lapsed = (row.plays || []).some((play) => play.qualifiedAt && play.evidenceExpiresAt && new Date(play.evidenceExpiresAt) <= current);
  if (lapsed) holds.add("evidence_expired");
  return [...holds].sort();
}

function serializeDetection(row, { holds, album }) {
  return {
    sessionId: row.sessionId,
    album: album ? { albumId: album.albumId, title: album.title || "", artistDisplayName: album.artistDisplayName || "", cover: album.cover || "" } : { albumId: row.albumId, title: "", artistDisplayName: "", cover: "" },
    lifecycle: row.lifecycle,
    coverage: row.coverage,
    holds,
    timeZone: row.timeZone || null,
    countable: {
      total: Number(row.countable?.total || 0),
      countable: Number(row.countable?.countable || 0),
      required: Number(row.countable?.required || 0),
      excluded: Array.isArray(row.countable?.excluded) ? row.countable.excluded.length : 0,
    },
    // Owner-facing summary only: no event IDs, evidence, or exact play times.
    plays: (row.plays || []).map((play) => ({
      playId: play.playId,
      ordinal: play.ordinal,
      distinct: play.distinct,
      required: play.required,
      coverage: play.coverage,
      proposedDate: play.proposedDate || null,
      evidenceExpiresAt: iso(play.evidenceExpiresAt),
      published: Boolean(play.publishedAt),
    })),
  };
}

async function listDetections({ userId, cursor, coverage, limit = 20, clock, env = process.env, baselineLookup = (album) => require("../baselines/service").baselineForAlbum(album) } = {}) {
  assertDetection(userId, env);
  const parsedLimit = Number(limit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_DETECTION_LIMIT) throw safeError("INVALID_LIMIT", 400);
  if (coverage && !COVERAGE_FILTERS.has(coverage)) throw safeError("INVALID_STATUS", 400);
  const Model = models();
  const connection = await Model.Connection.findOne({ userId, state: { $in: ["active", "paused"] } }).select("_id").lean();
  if (!connection) return { items: [], nextCursor: null };
  const current = now(clock);
  const query = { connectionId: connection._id, expiresAt: { $gt: current }, ...(coverage ? { coverage } : {}) };
  const decoded = parseCursor(cursor);
  if (decoded) query.$or = [{ startedAt: { $lt: decoded.startedAt } }, { startedAt: decoded.startedAt, _id: { $lt: decoded.id } }];
  const rows = await Model.Detection.find(query).select("-eventIds").sort({ startedAt: -1, _id: -1 }).limit(parsedLimit + 1).lean();
  const page = rows.slice(0, parsedLimit);

  const AlbumCatalog = require("../../models/AlbumCatalog");
  const albums = await AlbumCatalog.find({ albumId: { $in: [...new Set(page.map((row) => row.albumId))] } }).lean();
  const albumById = new Map(albums.map((album) => [album.albumId, album]));
  const mappingIds = [...new Set(page.flatMap((row) => (row.mappings || []).map((mapping) => mapping.mappingId)))];
  const mappings = mappingIds.length ? await Model.AlbumMapping.find({ mappingId: { $in: mappingIds } }).lean() : [];
  const mappingById = new Map(mappings.map((mapping) => [mapping.mappingId, mapping]));
  const baselineByAlbum = new Map();
  for (const album of albums) baselineByAlbum.set(album.albumId, await baselineLookup(album));

  return {
    items: page.map((row) => {
      const album = albumById.get(row.albumId) || null;
      const holds = readHolds(row, { current, mappingById, album, baseline: baselineByAlbum.get(row.albumId) });
      return serializeDetection(row, { holds, album });
    }),
    nextCursor: rows.length > parsedLimit ? encodeCursor(page[page.length - 1]) : null,
  };
}

module.exports = { MAX_DETECTION_LIMIT, assertDetection, detectionEnabledFor, listDetections, normalizeTimeZone, readHolds, setTimeZone };
