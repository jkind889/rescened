const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const Listen = require("../../models/Listen");
const { AutomaticListenReceipt } = require("../../models/AutomaticListen");
const { Connection, Detection, Job } = require("../../models/Listening");
const { flags, pilotAllowed, safeError } = require("./common");
const { RULES } = require("./detection");
const { createAutomaticListen, fenceAlbumDiary } = require("../../routes/utils/listeningDiary");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");

const DAY_MS = 24 * 60 * 60 * 1_000;
// Evidence cannot be re-ingested 30 days after playback; keep receipts a further 30.
const RECEIPT_RETENTION_MS = 60 * DAY_MS;
const OWNER_STATES = new Set(["needs_confirmation", "manual_duplicate"]);

function time(value) { return value ? new Date(value).getTime() : null; }

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function receiptExpiry(play) {
  const day = new Date(time(play.lastEventAt) + RECEIPT_RETENTION_MS);
  day.setUTCHours(0, 0, 0, 0);
  return new Date(day.getTime() + DAY_MS);
}

function autoDiaryAllowed(connection, env) {
  return Boolean(flags(env).autoDiary && pilotAllowed(connection?.userId, env) && connection?.autoDiaryEnabledAt);
}

async function priorReceipt(userId, play, session) {
  return AutomaticListenReceipt.findOne({
    userId, $or: [{ playId: play.playId }, { firstEventId: play.firstEventId }, { qualifyingEventId: play.qualifyingEventId }],
  }).session(session).lean();
}

// Manual entries within one day either side hold automatic publication; the
// fence is written first so a concurrent manual creation conflicts.
async function manualNearby(userId, album, date, session) {
  await fenceAlbumDiary(userId, album._id, session);
  return Listen.exists({
    userId, albumCatalogId: album._id, source: { $ne: "automatic" },
    listenedOn: { $gte: shiftDate(date, -1), $lte: shiftDate(date, 1) },
  }).session(session);
}

async function publishPlay({ connection, album, play, session, now }) {
  const listen = await createAutomaticListen({ userId: connection.userId, album, listenedOn: play.proposedDate, session });
  await AutomaticListenReceipt.create([{
    userId: connection.userId, playId: play.playId, firstEventId: play.firstEventId, qualifyingEventId: play.qualifyingEventId,
    outcome: "published", listenId: listen.listenId, expiresAt: receiptExpiry(play),
  }], { session });
  return { ...play, publication: "published", publishedAt: now, listenId: listen.listenId };
}

// Decides one unpublished play during an automatic pass.
async function nextPlayState({ connection, detection, play, album, session, now, rules }) {
  if (play.publishedAt) return play;
  const cleared = { ...play, publication: null, listenId: null };
  if (play.coverage !== "qualified") return cleared;
  const receipt = await priorReceipt(connection.userId, play, session);
  if (receipt) return { ...cleared, publication: receipt.outcome === "dismissed" ? "dismissed" : "suppressed" };
  if ((detection.holds || []).length || !album || !play.proposedDate) return cleared;
  if (play.evidenceExpiresAt && time(play.evidenceExpiresAt) <= time(now)) return cleared;
  // Plays that qualified before the owner opted in are not a historical import.
  if (time(play.qualifiedAt) < time(connection.autoDiaryEnabledAt)) return cleared;
  if (time(now) - time(play.qualifiedAt) > rules.publishRecencyMs) return { ...cleared, publication: "needs_confirmation" };
  if (await manualNearby(connection.userId, album, play.proposedDate, session)) return { ...cleared, publication: "manual_duplicate" };
  // Pause and disconnect stop new automatic publication.
  if (connection.state !== "active") return cleared;
  return publishPlay({ connection, album, play, session, now });
}

function playsChanged(before, after) {
  return after.some((play, index) => ["publication", "publishedAt", "listenId"].some((field) => String(play[field] ?? "") !== String(before[index][field] ?? "")));
}

// Runs inside the detect transaction after reconciliation has written detections.
async function publishConnection({ connectionId, session, now, env = process.env, rules = RULES }) {
  const connection = await Connection.findOne({ _id: connectionId, state: { $in: ["active", "paused"] } }).session(session).lean();
  if (!connection) return { published: 0 };
  const enabled = autoDiaryAllowed(connection, env);
  const detections = await Detection.find({ connectionId }).session(session).lean();
  const albums = new Map();
  let published = 0;
  for (const detection of detections) {
    if (!albums.has(detection.albumId)) albums.set(detection.albumId, await AlbumCatalog.findOne({ albumId: detection.albumId }).session(session).lean());
    const album = albums.get(detection.albumId);
    const plays = [];
    for (const play of detection.plays || []) {
      const next = enabled
        ? await nextPlayState({ connection, detection, play, album, session, now, rules })
        : (play.publishedAt ? play : { ...play, publication: null, listenId: null });
      if (next.publication === "published" && !play.publishedAt) published += 1;
      plays.push(next);
    }
    if (!playsChanged(detection.plays || [], plays)) continue;
    const updated = await Detection.updateOne(
      { sessionId: detection.sessionId, processingRevision: detection.processingRevision },
      { $set: { plays }, $inc: { processingRevision: 1 } }, { session },
    );
    if (updated.matchedCount !== 1) throw safeError("DETECTION_REVISION_CHANGED", 409);
  }
  return { published };
}
function assertAutoDiary(userId, env) {
  if (!flags(env).autoDiary) throw safeError("LISTENING_AUTO_DIARY_DISABLED", 503);
  if (!pilotAllowed(userId, env)) throw safeError("LASTFM_PILOT_REQUIRED", 403);
}

async function withTransaction(work, sessionFactory = () => mongoose.startSession()) {
  let session;
  try {
    session = await sessionFactory();
    let result;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } catch (error) {
    if (isTransactionUnavailable(error)) throw safeError("LISTENING_WRITE_UNAVAILABLE", 503);
    throw error;
  } finally {
    await session?.endSession();
  }
}

function queueDetection(connection, now, session) {
  const key = `detect:${connection._id}`;
  return Job.findOneAndUpdate(
    { key },
    { $setOnInsert: { key, type: "detect", attempts: 0 }, $set: { payload: { connectionId: String(connection._id) }, runAt: now, status: "pending" } },
    { upsert: true, setDefaultsOnInsert: true, session },
  );
}

// Owner opt-in. Re-enabling starts a new effective window; nothing earlier imports.
async function setAutoDiary({ userId, body, clock = () => new Date(), env = process.env, sessionFactory } = {}) {
  assertAutoDiary(userId, env);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "enabled") || typeof body.enabled !== "boolean") {
    throw safeError("INVALID_REQUEST", 400);
  }
  return withTransaction(async (session) => {
    const now = clock();
    const connection = await Connection.findOne({ userId, state: { $in: ["active", "paused"] } }).session(session).lean();
    if (!connection) throw safeError("LASTFM_NOT_CONNECTED", 404);
    if (body.enabled && !connection.timeZone) throw safeError("TIME_ZONE_REQUIRED", 409);
    const enabledAt = body.enabled ? connection.autoDiaryEnabledAt || now : null;
    await Connection.updateOne({ _id: connection._id }, { $set: { autoDiaryEnabledAt: enabledAt } }, { session });
    await queueDetection(connection, now, session);
    return { autoDiary: { enabled: Boolean(enabledAt), enabledAt: enabledAt ? new Date(enabledAt).toISOString() : null } };
  }, sessionFactory);
}

// Owner confirmation or dismissal of a suggested or held play.
async function resolvePlay({ userId, sessionId, playId, action, body, clock = () => new Date(), env = process.env, sessionFactory, revalidate } = {}) {
  assertAutoDiary(userId, env);
  if (!["confirm", "dismiss"].includes(action)) throw safeError("INVALID_REQUEST", 400);
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) throw safeError("INVALID_REQUEST", 400);
  return withTransaction(async (session) => {
    const now = clock();
    const connection = await Connection.findOne({ userId, state: { $in: ["active", "paused"] } }).session(session).lean();
    if (!connection) throw safeError("LASTFM_NOT_CONNECTED", 404);
    const detection = await Detection.findOne({ connectionId: connection._id, sessionId, expiresAt: { $gt: now } }).session(session).lean();
    const index = (detection?.plays || []).findIndex((play) => play.playId === playId);
    if (index < 0) throw safeError("DETECTION_NOT_FOUND", 404);
    const play = detection.plays[index];
    if (play.publishedAt && action === "confirm") return { publication: "published", listenId: play.listenId };
    if (!OWNER_STATES.has(play.publication)) throw safeError("PLAY_NOT_RESOLVABLE", 409);
    if (await priorReceipt(userId, play, session)) throw safeError("PLAY_ALREADY_RESOLVED", 409);
    let next;
    if (action === "dismiss") {
      await AutomaticListenReceipt.create([{
        userId, playId, firstEventId: play.firstEventId, qualifyingEventId: play.qualifyingEventId, outcome: "dismissed", expiresAt: receiptExpiry(play),
      }], { session });
      next = { ...play, publication: "dismissed" };
    } else {
      if (play.evidenceExpiresAt && time(play.evidenceExpiresAt) <= time(now)) throw safeError("EVIDENCE_EXPIRED", 409);
      const holds = revalidate ? await revalidate(detection, now) : detection.holds || [];
      if (holds.length) throw safeError("DETECTION_HELD", 409);
      const album = await AlbumCatalog.findOne({ albumId: detection.albumId }).session(session).lean();
      if (!album || !play.proposedDate) throw safeError("DETECTION_HELD", 409);
      await fenceAlbumDiary(userId, album._id, session);
      next = await publishPlay({ connection, album, play, session, now });
    }
    const plays = detection.plays.map((item, position) => (position === index ? next : item));
    const updated = await Detection.updateOne(
      { sessionId, processingRevision: detection.processingRevision },
      { $set: { plays }, $inc: { processingRevision: 1 } }, { session },
    );
    if (updated.matchedCount !== 1) throw safeError("DETECTION_REVISION_CHANGED", 409);
    return { publication: next.publication, listenId: next.listenId || null };
  }, sessionFactory);
}

module.exports = { RECEIPT_RETENTION_MS, autoDiaryAllowed, publishConnection, receiptExpiry, resolvePlay, setAutoDiary, shiftDate };
