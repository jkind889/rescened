const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { Webhook } = require("standardwebhooks");

const Listening = require("../models/Listening");
const connections = require("../lib/listening/connections");

const originals = {
  authCreate: Listening.AuthAttempt.create,
  authFindOneAndUpdate: Listening.AuthAttempt.findOneAndUpdate,
  connFindOne: Listening.Connection.findOne,
  connCreate: Listening.Connection.create,
  connFindOneAndUpdate: Listening.Connection.findOneAndUpdate,
  jobFindOneAndUpdate: Listening.Job.findOneAndUpdate,
  authDeleteMany: Listening.AuthAttempt.deleteMany,
  connFind: Listening.Connection.find,
  connUpdateOne: Listening.Connection.updateOne,
};

function connection(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    userId: "user_1",
    username: "old-user",
    usernameKey: "old-user",
    state: "active",
    revision: 1,
    connectedAt: new Date("2026-09-25T12:00:00Z"),
    windows: [{ start: new Date("2026-09-25T12:00:00Z"), end: null }],
    ...overrides,
  };
}

function diaryModels() {
  return [
    ["boardListens", require("../models/BoardListen")],
    ["listens", require("../models/Listen")],
    ["listenCreations", require("../models/ListenCreation")],
  ];
}

function sessionFactory() {
  return {
    startTransaction() {},
    async commitTransaction() {},
    async abortTransaction() {},
    async endSession() {},
  };
}

test.afterEach(() => {
  Listening.AuthAttempt.create = originals.authCreate;
  Listening.AuthAttempt.findOneAndUpdate = originals.authFindOneAndUpdate;
  Listening.Connection.findOne = originals.connFindOne;
  Listening.Connection.create = originals.connCreate;
  Listening.Connection.findOneAndUpdate = originals.connFindOneAndUpdate;
  Listening.Job.findOneAndUpdate = originals.jobFindOneAndUpdate;
  Listening.AuthAttempt.deleteMany = originals.authDeleteMany;
  Listening.Connection.find = originals.connFind;
  Listening.Connection.updateOne = originals.connUpdateOne;
  delete process.env.LASTFM_CONNECTION_ENABLED;
  delete process.env.LASTFM_PILOT_USER_IDS;
  delete process.env.LASTFM_CALLBACK_URL;
});

test("authorization stores only a hashed, expiring state and returns provider URL", async () => {
  process.env.LASTFM_CONNECTION_ENABLED = "true";
  process.env.LASTFM_PILOT_USER_IDS = "user_1";
  process.env.LASTFM_CALLBACK_URL = "https://rescened.example/account/lastfm/callback";
  let attempt;
  Listening.Connection.findOne = async () => null;
  Listening.AuthAttempt.create = async (value) => { attempt = value; return value; };
  const result = await connections.startAuthorization({
    userId: "user_1",
    provider: { authorizationUrl: ({ state, callbackUrl }) => `https://www.last.fm/api/auth?token=${state}&cb=${encodeURIComponent(callbackUrl)}` },
    clock: () => new Date("2026-09-25T12:00:00Z"),
  });
  assert.match(result.authorizationUrl, /^https:\/\//);
  assert.match(attempt.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(attempt.userId, "user_1");
  assert.equal(attempt.callbackUrl, process.env.LASTFM_CALLBACK_URL);
  assert.equal("token" in attempt, false);
  assert.equal(attempt.expiresAt.toISOString(), "2026-09-25T12:10:00.000Z");
});

test("completion consumes state once, binds provider username, and never stores the token", async () => {
  process.env.LASTFM_CONNECTION_ENABLED = "true";
  process.env.LASTFM_PILOT_USER_IDS = "user_1";
  const now = new Date("2026-09-25T12:00:00Z");
  let consumed = null;
  Listening.AuthAttempt.findOneAndUpdate = async () => {
    consumed = { userId: "user_1", consumedAt: now };
    return consumed;
  };
  Listening.Connection.findOne = async ({ state, usernameKey, userId }) => {
    if (state?.$in || usernameKey) return null;
    if (userId) return null;
    return null;
  };
  const created = connection({ username: "lastfm-name", usernameKey: "lastfm-name" });
  Listening.Connection.create = async (value) => {
    if (Array.isArray(value)) return [{ ...value[0], ...created }];
    return { ...value, ...created };
  };
  Listening.Job.findOneAndUpdate = async () => null;
  const result = await connections.completeAuthorization({
    userId: "user_1",
    state: crypto.randomBytes(32).toString("base64url"),
    token: "secret-session-token",
    provider: { getSession: async (token) => { assert.equal(token, "secret-session-token"); return { username: "LastFM-Name" }; } },
    ownerExists: async () => true,
    sessionFactory,
    env: { LASTFM_CONNECTION_ENABLED: "true", LASTFM_PILOT_USER_IDS: "user_1" },
    clock: () => now,
  });
  assert.equal(consumed.userId, "user_1");
  assert.equal(result.connection.username, "lastfm-name");
  assert.equal(result.connection.state, "active");
  assert.equal("token" in result.connection, false);
});

test("event serialization exposes owner data without connection or Mongo identifiers", async () => {
  const originalFindOne = Listening.Connection.findOne;
  const originalScrobbleFind = Listening.Scrobble.find;
  const originalMappingFind = Listening.AlbumMapping.find;
  const AlbumCatalog = require("../models/AlbumCatalog");
  const originalCatalogFind = AlbumCatalog.find;
  try {
    const id = "507f1f77bcf86cd799439011";
    Listening.Connection.findOne = async () => ({ _id: id });
    Listening.Scrobble.find = () => ({ sort() { return this; }, limit() { return this; }, exec: async () => [{ _id: id, eventId: crypto.randomUUID(), artist: "Artist", album: "Album", track: "Track", playedAt: new Date("2026-09-25T12:00:00Z"), resolution: "unresolved", albumId: "", baselineAvailable: false }] });
    Listening.AlbumMapping.find = async () => [];
    AlbumCatalog.find = async () => [];
    const result = await connections.listEvents({ baselineLookup: async () => null, userId: "user_1", limit: 1 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].artist, "Artist");
    assert.equal("_id" in result.items[0], false);
    assert.equal("connectionId" in result.items[0], false);
  } finally {
    Listening.Connection.findOne = originalFindOne;
    Listening.Scrobble.find = originalScrobbleFind;
    Listening.AlbumMapping.find = originalMappingFind;
    AlbumCatalog.find = originalCatalogFind;
  }
});

test("event status filters use effective mapping and catalog revisions", async () => {
  const originalFindOne = Listening.Connection.findOne;
  const originalScrobbleFind = Listening.Scrobble.find;
  const originalMappingFind = Listening.AlbumMapping.find;
  const AlbumCatalog = require("../models/AlbumCatalog");
  const originalCatalogFind = AlbumCatalog.find;
  try {
    const id = "507f1f77bcf86cd799439011";
    const mappingId = crypto.randomUUID();
    Listening.Connection.findOne = async () => ({ _id: id });
    Listening.Scrobble.find = () => ({ sort() { return this; }, limit() { return this; }, exec: async () => [{
      _id: id,
      eventId: crypto.randomUUID(),
      artist: "Artist",
      album: "Album",
      track: "Track",
      playedAt: new Date("2026-09-25T12:00:00Z"),
      resolution: "matched",
      albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7",
      mappingId,
      mappingRevision: 1,
      catalogRevision: 2,
      baselineAvailable: false,
    }] });
    Listening.AlbumMapping.find = async () => [{ mappingId, status: "active", revision: 1, albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7" }];
    AlbumCatalog.find = async () => [{ albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7", catalogRevision: 3 }];
    const result = await connections.listEvents({ baselineLookup: async () => null, userId: "user_1", status: "unavailable", limit: 1 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].resolution, "unavailable");
    assert.equal(result.items[0].albumId, null);
    AlbumCatalog.find = async () => [{ albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7", catalogRevision: 2 }];
    const ready = await connections.listEvents({ baselineLookup: async () => ({ baselineId: "reviewed" }), userId: "user_1" });
    assert.equal(ready.items[0].baselineAvailable, true);
    const revoked = await connections.listEvents({ baselineLookup: async () => null, userId: "user_1" });
    assert.equal(revoked.items[0].resolution, "matched");
    assert.equal(revoked.items[0].baselineAvailable, false);
  } finally {
    Listening.Connection.findOne = originalFindOne;
    Listening.Scrobble.find = originalScrobbleFind;
    Listening.AlbumMapping.find = originalMappingFind;
    AlbumCatalog.find = originalCatalogFind;
  }
});

test("expired, wrong-owner, and replayed authorization callbacks are rejected before provider exchange", async () => {
  const previousFlags = { LASTFM_CONNECTION_ENABLED: process.env.LASTFM_CONNECTION_ENABLED, LASTFM_PILOT_USER_IDS: process.env.LASTFM_PILOT_USER_IDS };
  process.env.LASTFM_CONNECTION_ENABLED = "true";
  process.env.LASTFM_PILOT_USER_IDS = "user_1,user_2";
  let providerCalls = 0;
  Listening.AuthAttempt.findOneAndUpdate = async () => null;
  const provider = { getSession: async () => { providerCalls += 1; return { username: "should-not-be-used" }; } };
  for (const userId of ["user_1", "user_2"]) {
    await assert.rejects(
      connections.completeAuthorization({ userId, state: crypto.randomBytes(32).toString("base64url"), token: "token", provider, ownerExists: async () => true, env: { LASTFM_CONNECTION_ENABLED: "true", LASTFM_PILOT_USER_IDS: "user_1,user_2" } }),
      (error) => error.code === "INVALID_AUTH_CALLBACK",
    );
  }
  assert.equal(providerCalls, 0);
  if (previousFlags.LASTFM_CONNECTION_ENABLED === undefined) delete process.env.LASTFM_CONNECTION_ENABLED; else process.env.LASTFM_CONNECTION_ENABLED = previousFlags.LASTFM_CONNECTION_ENABLED;
  if (previousFlags.LASTFM_PILOT_USER_IDS === undefined) delete process.env.LASTFM_PILOT_USER_IDS; else process.env.LASTFM_PILOT_USER_IDS = previousFlags.LASTFM_PILOT_USER_IDS;
});

test("disconnect remains available when the pilot flag is removed", async () => {
  const originalFindOne = Listening.Connection.findOne;
  const originalFindOneAndUpdate = Listening.Connection.findOneAndUpdate;
  try {
    delete process.env.LASTFM_CONNECTION_ENABLED;
    delete process.env.LASTFM_PILOT_USER_IDS;
    const current = connection();
    Listening.Connection.findOne = async () => current;
    Listening.Connection.findOneAndUpdate = async () => ({ ...current, state: "disconnected", revision: 2 });
    Listening.Job.findOneAndUpdate = async () => null;
    const result = await connections.mutateConnection({ userId: "user_1", action: "disconnect", sessionFactory });
    assert.equal(result.connection.state, "disconnected");
  } finally {
    Listening.Connection.findOne = originalFindOne;
    Listening.Connection.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("Clerk user deletion webhook rejects unsigned requests and accepts a valid signed deletion", async () => {
  const webhookRoute = require("../routes/listeningWebhook");
  const originalFind = Listening.Connection.find;
  const originalDeleteMany = Listening.AuthAttempt.deleteMany;
  const automatic = require("../models/AutomaticListen");
  const originalAutomatic = [automatic.AutomaticListenReceipt.deleteMany, automatic.DiaryAlbumFence.deleteMany];
  const diary = diaryModels();
  const originalDiary = diary.map(([, Model]) => Model.deleteMany);
  const automaticCleanup = [];
  automatic.AutomaticListenReceipt.deleteMany = async (filter) => { automaticCleanup.push(["receipts", filter.userId]); return { deletedCount: 0 }; };
  automatic.DiaryAlbumFence.deleteMany = async (filter) => { automaticCleanup.push(["fences", filter.userId]); return { deletedCount: 0 }; };
  for (const [name, Model] of diary) {
    Model.deleteMany = async (filter, options) => { automaticCleanup.push([name, filter.userId, Boolean(options?.session)]); return { deletedCount: 0 }; };
  }
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = `whsec_${Buffer.from("synthetic-webhook-secret").toString("base64")}`;
  const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  try {
    const unsigned = response();
    await webhookRoute.handleWebhook({ method: "POST", url: "/", originalUrl: "/", headers: {}, body: Buffer.from("{}"), connection: {} }, unsigned);
    assert.equal(unsigned.statusCode, 400);

    let cleanupUser = "";
    Listening.Connection.find = async () => [];
    Listening.AuthAttempt.deleteMany = async (filter) => { cleanupUser = filter.userId; return { deletedCount: 0 }; };
    const payload = Buffer.from(JSON.stringify({ type: "user.deleted", data: { id: "user_deleted" } }));
    const id = "msg_synthetic";
    const timestamp = new Date();
    const signature = new Webhook(process.env.CLERK_WEBHOOK_SIGNING_SECRET).sign(id, timestamp, payload);
    const signed = response();
    await webhookRoute.handleWebhook({ method: "POST", url: "/", originalUrl: "/", headers: { "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": signature }, body: payload, connection: {} }, signed, { cleanupOptions: { sessionFactory } });
    assert.equal(signed.statusCode, 200);
    assert.equal(cleanupUser, "user_deleted");
    assert.deepEqual(automaticCleanup, [
      ["receipts", "user_deleted"], ["fences", "user_deleted"],
      ["boardListens", "user_deleted", true], ["listens", "user_deleted", true], ["listenCreations", "user_deleted", true],
    ]);
  } finally {
    Listening.Connection.find = originalFind;
    Listening.AuthAttempt.deleteMany = originalDeleteMany;
    [automatic.AutomaticListenReceipt.deleteMany, automatic.DiaryAlbumFence.deleteMany] = originalAutomatic;
    diary.forEach(([, Model], index) => { Model.deleteMany = originalDiary[index]; });
    delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  }
});

test("account cleanup aborts and reports unavailable when a diary delete cannot run in a transaction", async () => {
  const automatic = require("../models/AutomaticListen");
  const originalAutomatic = [automatic.AutomaticListenReceipt.deleteMany, automatic.DiaryAlbumFence.deleteMany];
  const diary = diaryModels();
  const originalDiary = diary.map(([, Model]) => Model.deleteMany);
  const calls = [];
  const noop = async () => ({ deletedCount: 0 });
  Listening.AuthAttempt.deleteMany = noop;
  automatic.AutomaticListenReceipt.deleteMany = noop;
  automatic.DiaryAlbumFence.deleteMany = noop;
  for (const [name, Model] of diary) {
    Model.deleteMany = async () => {
      calls.push(name);
      if (name === "listens") throw Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), { code: 20 });
      return { deletedCount: 0 };
    };
  }
  Listening.Connection.find = async () => { throw new Error("connections must not be read after a failed diary delete"); };
  const session = { ...sessionFactory(), committed: false, aborted: false };
  session.commitTransaction = async () => { session.committed = true; };
  session.abortTransaction = async () => { session.aborted = true; };
  try {
    await assert.rejects(
      connections.cleanupUserData("user_deleted", { sessionFactory: () => session }),
      (error) => error.status === 503 && error.code === "LASTFM_CLEANUP_UNAVAILABLE",
    );
    assert.deepEqual(calls, ["boardListens", "listens"]);
    assert.equal(session.committed, false);
    assert.equal(session.aborted, true);
  } finally {
    [automatic.AutomaticListenReceipt.deleteMany, automatic.DiaryAlbumFence.deleteMany] = originalAutomatic;
    diary.forEach(([, Model], index) => { Model.deleteMany = originalDiary[index]; });
  }
});
