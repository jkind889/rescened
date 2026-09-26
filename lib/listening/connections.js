const crypto = require("node:crypto");
const mongoose = require("mongoose");

const {
  flags,
  normalize,
  pilotAllowed,
  safeError,
} = require("./common");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");

const AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENT_LIMIT = 50;
const EVENT_STATUSES = new Set(["matched", "unresolved", "unavailable"]);

function models() {
  // Keep model loading lazy so the API can still be imported by contract tests
  // before the listening model has been initialized.
  return require("../../models/Listening");
}

function providerFactory() {
  const provider = require("./provider");
  return typeof provider === "function" ? provider : provider.createLastfmProvider;
}

function nowDate(clock) {
  return clock ? new Date(clock()) : new Date();
}

function callbackUrl(value = process.env.LASTFM_CALLBACK_URL) {
  if (typeof value !== "string" || !value.trim()) throw safeError("LASTFM_CALLBACK_NOT_CONFIGURED", 503);
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw safeError("INVALID_LASTFM_CALLBACK", 503); }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw safeError("INVALID_LASTFM_CALLBACK", 503);
  }
  return parsed.toString();
}

function enabledFor(userId, env = process.env) {
  const enabled = flags(env).connection;
  return { enabled, pilotAllowed: enabled && pilotAllowed(userId, env) };
}

function assertPilot(userId, env = process.env) {
  const status = enabledFor(userId, env);
  if (!status.enabled) throw safeError("LASTFM_CONNECTION_DISABLED", 503);
  if (!status.pilotAllowed) throw safeError("LASTFM_PILOT_REQUIRED", 403);
}

function stateHash(state) {
  return crypto.createHash("sha256").update(String(state)).digest("hex");
}

function randomState() {
  return crypto.randomBytes(32).toString("base64url");
}

function parseBody(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw safeError("INVALID_REQUEST", 400);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw safeError("INVALID_REQUEST", 400);
}

function asPlain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value || null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function serializeConnection(connection) {
  const source = asPlain(connection);
  if (!source) return null;
  return {
    username: source.username,
    state: source.state,
    lastSuccessfulSync: iso(source.lastSuccessfulSync),
    error: source.error?.code ? { code: source.error.code, at: iso(source.error.at) } : null,
    retentionGap: source.retentionGap
      ? { from: iso(source.retentionGap.from), to: iso(source.retentionGap.to) }
      : null,
  };
}

function connectionQuery(Model, query, session) {
  let result = Model.findOne(query);
  if (session && result && typeof result.session === "function") result = result.session(session);
  return result && typeof result.exec === "function" ? result.exec() : result;
}

function enqueue(Model, type, key, payload, now, session = null) {
  if (!Model?.Job || typeof Model.Job.findOneAndUpdate !== "function") return Promise.resolve(null);
  const options = {
    upsert: true,
    returnDocument: "after",
    setDefaultsOnInsert: true,
    ...(session ? { session } : {}),
  };
  return Model.Job.findOneAndUpdate(
    { key },
    {
      $setOnInsert: {
        key,
        type,
        attempts: 0,
      },
      $set: {
        payload,
        runAt: now,
        status: "pending",
        error: null,
        progress: {},
        leaseUntil: null,
        leaseToken: "",
      },
    },
    options,
  );
}

async function defaultOwnerExists(userId) {
  const { clerkClient } = require("@clerk/express");
  try {
    await clerkClient.users.getUser(userId);
    return true;
  } catch (error) {
    if (error?.status === 404 || error?.statusCode === 404) return false;
    throw safeError("LASTFM_OWNER_CHECK_UNAVAILABLE", 503);
  }
}

async function assertOwnerExists(userId, ownerExists) {
  let exists;
  try {
    exists = await ownerExists(userId);
  } catch (error) {
    if (error?.status || error?.statusCode) throw error;
    throw safeError("LASTFM_OWNER_CHECK_UNAVAILABLE", 503);
  }
  if (!exists) throw safeError("LASTFM_OWNER_NOT_FOUND", 404);
}

async function withConnectionTransaction(work, { sessionFactory } = {}) {
  // A live API process must use a transaction so an auth completion cannot
  // race with account-deletion cleanup on a standalone MongoDB deployment.
  // Tests may inject a session factory; production never receives a fallback.
  const factory = sessionFactory || (() => mongoose.startSession());
  let session;
  try {
    session = await factory();
    if (!session || typeof session.startTransaction !== "function" || typeof session.commitTransaction !== "function") {
      throw safeError("LASTFM_CONNECTION_UNAVAILABLE", 503);
    }
    session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    try { await session?.abortTransaction?.(); } catch { /* noop */ }
    if (isTransactionUnavailable(error) || error?.name === "MongoNotConnectedError") throw safeError("LASTFM_CONNECTION_UNAVAILABLE", 503);
    throw error;
  } finally {
    try { await session?.endSession?.(); } catch { /* noop */ }
  }
}

async function startAuthorization({ userId, provider, env = process.env, clock } = {}) {
  assertPilot(userId, env);
  const Model = models();
  const now = nowDate(clock);
  const current = await connectionQuery(Model.Connection, { userId });
  if (current && ["active", "paused"].includes(current.state)) throw safeError("LASTFM_ALREADY_CONNECTED", 409);
  const state = randomState();
  const expiresAt = new Date(now.getTime() + AUTH_ATTEMPT_TTL_MS);
  await Model.AuthAttempt.create({
    stateHash: stateHash(state),
    userId,
    expiresAt,
    callbackUrl: callbackUrl(env.LASTFM_CALLBACK_URL),
  });
  const adapter = provider || providerFactory()({ env });
  let authorizationUrl;
  try {
    authorizationUrl = await adapter.authorizationUrl({
      state,
      callbackUrl: callbackUrl(env.LASTFM_CALLBACK_URL),
    });
  } catch {
    await Model.AuthAttempt.deleteOne({ stateHash: stateHash(state) });
    throw safeError("LASTFM_PROVIDER_UNAVAILABLE", 503);
  }
  if (typeof authorizationUrl !== "string" || !/^https:\/\//i.test(authorizationUrl)) {
    await Model.AuthAttempt.deleteOne({ stateHash: stateHash(state) });
    throw safeError("LASTFM_PROVIDER_UNAVAILABLE", 503);
  }
  return { authorizationUrl };
}

async function completeAuthorization({ userId, state, token, provider, ownerExists = defaultOwnerExists, sessionFactory, env = process.env, clock } = {}) {
  assertPilot(userId, env);
  if (typeof state !== "string" || state.length < 16 || state.length > 256 || typeof token !== "string" || token.length < 1 || token.length > 512) {
    throw safeError("INVALID_AUTH_CALLBACK", 400);
  }
  const Model = models();
  const now = nowDate(clock);
  await assertOwnerExists(userId, ownerExists);
  const attempt = await Model.AuthAttempt.findOneAndUpdate(
    { stateHash: stateHash(state), userId, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now } },
    { returnDocument: "after" },
  );
  if (!attempt) throw safeError("INVALID_AUTH_CALLBACK", 400);
  const adapter = provider || providerFactory()({ env });
  let session;
  try {
    session = await adapter.getSession(token);
  } catch {
    throw safeError("LASTFM_AUTH_FAILED", 400);
  }
  // A Clerk deletion can happen while Last.fm exchanges the one-use token.
  // Re-check immediately after the exchange before entering the fenced write.
  await assertOwnerExists(userId, ownerExists);
  const username = typeof session?.username === "string" ? session.username.trim() : "";
  if (!username || username.length > 128) throw safeError("LASTFM_AUTH_FAILED", 400);
  const usernameKey = normalize(username);
  const connection = await withConnectionTransaction(async (dbSession) => {
    // The cleanup transaction deletes this document before it inspects
    // connections. If it won the race, the callback must stop here.
    const fencedAttempt = await Model.AuthAttempt.findOneAndUpdate(
      { stateHash: stateHash(state), userId, consumedAt: { $ne: null } },
      { $set: { consumedAt: now } },
      { returnDocument: "after", ...(dbSession ? { session: dbSession } : {}) },
    );
    if (!fencedAttempt) throw safeError("INVALID_AUTH_CALLBACK", 400);

    const fencedExisting = await connectionQuery(Model.Connection, { usernameKey, state: { $in: ["active", "paused"] } }, dbSession);
    if (fencedExisting) {
      if (String(fencedExisting.userId) === String(userId)) throw safeError("LASTFM_ALREADY_CONNECTED", 409);
      throw safeError("LASTFM_ACCOUNT_ALREADY_CONNECTED", 409);
    }
    const fencedUserExisting = await connectionQuery(Model.Connection, { userId }, dbSession);
    if (fencedUserExisting && ["active", "paused"].includes(fencedUserExisting.state)) throw safeError("LASTFM_ALREADY_CONNECTED", 409);
    try {
      let result;
      if (fencedUserExisting?.state === "disconnected") {
        const nextRevision = Number(fencedUserExisting.revision || 0) + 1;
        if (Model.Scrobble?.deleteMany) await Model.Scrobble.deleteMany(
          { connectionId: fencedUserExisting._id },
          dbSession ? { session: dbSession } : undefined,
        );
        result = await Model.Connection.findOneAndUpdate(
          { userId, state: "disconnected", revision: fencedUserExisting.revision },
          {
            $set: {
              username,
              usernameKey,
              state: "active",
              revision: nextRevision,
              connectedAt: now,
              windows: [{ start: now, end: null }],
              completedThrough: now,
              progress: {},
              lastSuccessfulSync: null,
              nextSyncAt: null,
              error: null,
              retentionGap: null,
            },
          },
          { returnDocument: "after", runValidators: true, ...(dbSession ? { session: dbSession } : {}) },
        );
        if (!result) throw safeError("CONNECTION_CONFLICT", 409);
      } else {
        const created = dbSession
          ? await Model.Connection.create([{
            userId,
            username,
            usernameKey,
            state: "active",
            revision: 1,
            connectedAt: now,
            windows: [{ start: now, end: null }],
            completedThrough: now,
            progress: {},
            lastSuccessfulSync: null,
            error: null,
          }], { session: dbSession })
          : await Model.Connection.create({
            userId,
            username,
            usernameKey,
            state: "active",
            revision: 1,
            connectedAt: now,
            windows: [{ start: now, end: null }],
            completedThrough: now,
            progress: {},
            lastSuccessfulSync: null,
            error: null,
          });
        result = Array.isArray(created) ? created[0] : created;
      }
      await enqueue(Model, "sync", `sync:${String(result._id)}`, { connectionId: String(result._id), connectionRevision: result.revision }, now, dbSession);
      return result;
    } catch (error) {
      if (error?.code === 11000) {
        const key = Object.keys(error.keyPattern || {})[0] || "";
        throw safeError(key.includes("username") ? "LASTFM_ACCOUNT_ALREADY_CONNECTED" : "LASTFM_ALREADY_CONNECTED", 409);
      }
      throw error;
    }
  }, { sessionFactory });
  return { connection: serializeConnection(connection) };
}

async function mutateConnection({ userId, action, clock, sessionFactory } = {}) {
  if (action === "resume") assertPilot(userId);
  const Model = models();
  const now = nowDate(clock);
  const current = await connectionQuery(Model.Connection, { userId });
  if (!current || current.state === "disconnected") throw safeError("LASTFM_NOT_CONNECTED", 404);
  if (!["pause", "resume", "disconnect"].includes(action)) throw safeError("INVALID_REQUEST", 400);
  return { connection: serializeConnection(await withConnectionTransaction(async (dbSession) => {
    const fenced = await connectionQuery(Model.Connection, { userId }, dbSession);
    if (!fenced || fenced.state === "disconnected") throw safeError("LASTFM_NOT_CONNECTED", 404);
    const expectedState = action === "pause" ? "active" : action === "resume" ? "paused" : { $in: ["active", "paused"] };
    if (action === "pause" && fenced.state !== "active") throw safeError("LASTFM_INVALID_STATE", 409);
    if (action === "resume" && fenced.state !== "paused") throw safeError("LASTFM_INVALID_STATE", 409);
    const update = action === "pause"
      ? { $set: { state: "paused", revision: fenced.revision + 1, "windows.$[window].end": now }, $unset: { error: 1 }, $inc: { __v: 0 } }
      : action === "resume"
        ? { $set: { state: "active", revision: fenced.revision + 1, error: null }, $push: { windows: { start: now, end: null } } }
        : { $set: { state: "disconnected", revision: fenced.revision + 1, "windows.$[window].end": now }, $unset: { error: 1 } };
    const options = {
      arrayFilters: action === "resume" ? undefined : [{ "window.end": null }],
      returnDocument: "after",
      runValidators: true,
      ...(dbSession ? { session: dbSession } : {}),
    };
    const updated = await Model.Connection.findOneAndUpdate(
      { userId, state: expectedState, revision: fenced.revision },
      update,
      options,
    );
    if (!updated) throw safeError("CONNECTION_CONFLICT", 409);
    if (action === "resume") await enqueue(Model, "sync", `sync:${String(updated._id)}`, { connectionId: String(updated._id), connectionRevision: updated.revision }, now, dbSession);
    if (action === "disconnect") await enqueue(Model, "cleanup", `cleanup:${String(updated._id)}:${updated.revision}`, { connectionId: String(updated._id), connectionRevision: updated.revision, userId }, now, dbSession);
    return updated;
  }, { sessionFactory })) };
}

function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const playedAt = new Date(decoded.playedAt);
    if (!mongoose.isValidObjectId(decoded.id) || Number.isNaN(playedAt.getTime())) throw new Error("invalid");
    return { playedAt, id: decoded.id };
  } catch { throw safeError("INVALID_CURSOR", 400); }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ playedAt: new Date(row.playedAt).toISOString(), id: String(row._id) })).toString("base64url");
}

function serializeEvent(row, resolutionOverride = null) {
  const source = asPlain(row);
  return {
    eventId: source.eventId,
    artist: source.artist,
    album: source.album,
    track: source.track,
    playedAt: iso(source.playedAt),
    resolution: resolutionOverride || source.resolution,
    albumId: resolutionOverride ? null : (source.albumId || null),
    baselineAvailable: resolutionOverride ? false : source.baselineAvailable === true,
  };
}

async function listEvents({ userId, cursor, status, limit = 20 } = {}) {
  const Model = models();
  const connection = await connectionQuery(Model.Connection, { userId });
  if (!connection) return { items: [], nextCursor: null };
  const parsedLimit = Number(limit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_EVENT_LIMIT) throw safeError("INVALID_LIMIT", 400);
  if (status && !EVENT_STATUSES.has(status)) throw safeError("INVALID_STATUS", 400);
  // A matched row can become effectively unavailable when its mapping is
  // revoked or its reviewed catalog revision changes. Do not filter by the
  // stored resolution before that validation, or status=unavailable would
  // hide stale matched rows from the owner.
  const query = { connectionId: connection._id };
  const decoded = parseCursor(cursor);
  if (decoded) query.$or = [{ playedAt: { $lt: decoded.playedAt } }, { playedAt: decoded.playedAt, _id: { $lt: decoded.id } }];
  let find = Model.Scrobble.find(query);
  if (find.sort) find = find.sort({ playedAt: -1, _id: -1 });
  const scanLimit = status ? Math.min(500, Math.max(parsedLimit + 1, parsedLimit * 4)) : parsedLimit + 1;
  if (find.limit) find = find.limit(scanLimit);
  const rows = await (find.exec ? find.exec() : find);
  const page = rows.length > scanLimit ? rows.slice(0, scanLimit) : rows;
  const mappingIds = page.map((row) => asPlain(row).mappingId).filter(Boolean);
  const mappingById = new Map();
  if (mappingIds.length && Model.AlbumMapping?.find) {
    const mappings = await Model.AlbumMapping.find({ mappingId: { $in: [...new Set(mappingIds)] } });
    (mappings || []).forEach((mapping) => mappingById.set(String(asPlain(mapping).mappingId), asPlain(mapping)));
  }
  const catalogIds = [...new Set([...mappingById.values()].map((mapping) => mapping.albumId).filter(Boolean))];
  const catalogById = new Map();
  if (catalogIds.length) {
    const AlbumCatalog = require("../../models/AlbumCatalog");
    const catalogs = await AlbumCatalog.find({ albumId: { $in: catalogIds } });
    (catalogs || []).forEach((catalog) => catalogById.set(String(asPlain(catalog).albumId), asPlain(catalog)));
  }
  const resolved = page.map((row) => {
    const source = asPlain(row);
    if (source.resolution !== "matched") return { source, event: serializeEvent(source) };
    const mapping = mappingById.get(String(source.mappingId));
    const catalog = mapping ? catalogById.get(String(mapping.albumId)) : null;
    const valid = mapping?.status === "active"
      && Number(mapping.revision) === Number(source.mappingRevision)
      && catalog
      && Number(catalog.catalogRevision) === Number(source.catalogRevision);
    return { source, event: serializeEvent(source, valid ? null : "unavailable") };
  });
  const selected = status ? resolved.filter((row) => row.event.resolution === status).slice(0, parsedLimit) : resolved.slice(0, parsedLimit);
  let nextCursor = null;
  if (status) {
    const lastSelected = selected[selected.length - 1];
    const lastIndex = lastSelected ? resolved.indexOf(lastSelected) : -1;
    if ((lastIndex >= 0 && lastIndex < page.length - 1) || rows.length > scanLimit) {
      nextCursor = encodeCursor(lastSelected ? lastSelected.source : page[page.length - 1]);
    }
  } else if (rows.length > scanLimit) {
    nextCursor = encodeCursor(page[page.length - 1]);
  }
  return { items: selected.map((row) => row.event), nextCursor };
}

async function cleanupUserData(userId, { clock, sessionFactory } = {}) {
  const Model = models();
  const now = nowDate(clock);
  const work = async (dbSession) => {
    // Take the auth-attempt write lock before reading connections. A callback
    // that has passed provider exchange must fence against this delete before
    // it can create a new connection.
    if (Model.AuthAttempt?.deleteMany) await Model.AuthAttempt.deleteMany({ userId }, dbSession ? { session: dbSession } : undefined);
    let query = Model.Connection.find({ userId });
    if (dbSession && query?.session) query = query.session(dbSession);
    const connections = await (query?.exec ? query.exec() : query);
    for (const connection of connections || []) {
      const revision = Number(connection.revision || 0) + 1;
      await Model.Connection.updateOne(
        { _id: connection._id },
        { $set: { state: "disconnected", revision, "windows.$[window].end": now }, $unset: { error: 1 } },
        { arrayFilters: [{ "window.end": null }], ...(dbSession ? { session: dbSession } : {}) },
      );
      await enqueue(Model, "cleanup", `cleanup:${String(connection._id)}:deleted`, { connectionId: String(connection._id), connectionRevision: revision, userId }, now, dbSession);
    }
    return { queued: connections?.length || 0 };
  };
  const factory = sessionFactory || (() => mongoose.startSession());
  let session;
  try {
    session = await factory();
    if (!session || typeof session.startTransaction !== "function" || typeof session.commitTransaction !== "function") throw safeError("LASTFM_CLEANUP_UNAVAILABLE", 503);
    session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    try { await session?.abortTransaction?.(); } catch { /* noop */ }
    if (isTransactionUnavailable(error) || error?.name === "MongoNotConnectedError") throw safeError("LASTFM_CLEANUP_UNAVAILABLE", 503);
    throw error;
  } finally {
    try { await session?.endSession?.(); } catch { /* noop */ }
  }
}

module.exports = {
  AUTH_ATTEMPT_TTL_MS,
  RETENTION_MS,
  assertPilot,
  callbackUrl,
  cleanupUserData,
  completeAuthorization,
  defaultOwnerExists,
  enabledFor,
  listEvents,
  mutateConnection,
  serializeConnection,
  startAuthorization,
};
