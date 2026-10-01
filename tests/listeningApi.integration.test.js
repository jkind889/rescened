const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const Listening = require("../models/Listening");
const AlbumCatalog = require("../models/AlbumCatalog");
const Listen = require("../models/Listen");
const { startAuthorization, completeAuthorization, mutateConnection } = require("../lib/listening/connections");
const { moderate } = require("../lib/listening/moderation");

let replSet;

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_lastfm_api" });
  await Promise.all([
    Listening.Connection.syncIndexes(), Listening.AuthAttempt.syncIndexes(), Listening.Scrobble.syncIndexes(),
    Listening.MappingCase.syncIndexes(), Listening.AlbumMapping.syncIndexes(), Listening.MappingAudit.syncIndexes(),
    Listening.Job.syncIndexes(), AlbumCatalog.syncIndexes(),
  ]);
  process.env.LASTFM_CONNECTION_ENABLED = "true";
  process.env.LASTFM_PILOT_USER_IDS = "integration-user";
  process.env.ALBUM_MAPPING_MODERATION_ENABLED = "true";
  process.env.MODERATOR_USER_IDS = "integration-moderator";
});

test.after(async () => {
  if (!enabled) return;
  await mongoose.disconnect();
  await replSet?.stop();
  ["LASTFM_CONNECTION_ENABLED", "LASTFM_PILOT_USER_IDS", "ALBUM_MAPPING_MODERATION_ENABLED", "MODERATOR_USER_IDS"].forEach((key) => delete process.env[key]);
});

test("connection lifecycle is revisioned and moderator mapping approval is transactional", { skip: !enabled }, async () => {
  await Promise.all([
    Listening.Connection.deleteMany({}), Listening.AuthAttempt.deleteMany({}), Listening.Scrobble.deleteMany({}),
    Listening.MappingCase.deleteMany({}), Listening.AlbumMapping.deleteMany({}), Listening.MappingAudit.deleteMany({}),
    Listening.Job.deleteMany({}), AlbumCatalog.deleteMany({}),
  ]);
  let authorizationState = "";
  const provider = {
    authorizationUrl: ({ state }) => { authorizationState = state; return "https://www.last.fm/api/auth?token=provider"; },
    getSession: async (token) => { assert.equal(token, "one-time-token"); return { username: "integration-listener" }; },
  };
  await startAuthorization({ userId: "integration-user", provider, env: { LASTFM_CONNECTION_ENABLED: "true", LASTFM_PILOT_USER_IDS: "integration-user", LASTFM_CALLBACK_URL: "https://rescened.example/account/lastfm/callback" } });
  const connected = await completeAuthorization({ userId: "integration-user", state: authorizationState, token: "one-time-token", provider, ownerExists: async () => true, env: { LASTFM_CONNECTION_ENABLED: "true", LASTFM_PILOT_USER_IDS: "integration-user" } });
  assert.equal(connected.connection.state, "active");
  const paused = await mutateConnection({ userId: "integration-user", action: "pause" });
  assert.equal(paused.connection.state, "paused");
  const resumed = await mutateConnection({ userId: "integration-user", action: "resume" });
  assert.equal(resumed.connection.state, "active");

  const albumId = "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7";
  await AlbumCatalog.create({ albumId, title: "Integration Album", artistDisplayName: "Integration Artist", catalogRevision: 3 });
  const caseId = crypto.randomUUID();
  await Listening.MappingCase.create({ caseId, key: JSON.stringify(["lastfm", "integration artist", "integration album (deluxe)"]), provider: "lastfm", artist: "Integration Artist", album: "Integration Album (Deluxe)", artistKey: "integration artist", albumKey: "integration album (deluxe)", status: "pending", revision: 1, encounterCount: 2, evidence: [{ provider: "lastfm", sharedTracks: 10 }] });
  const approved = await moderate(caseId, "approve", { expectedRevision: 1, albumId, reason: "Verified against local catalog" }, "integration-moderator");
  assert.equal(approved.case.status, "approved");
  assert.equal(approved.mapping.albumId, albumId);
  assert.equal(await Listening.MappingAudit.countDocuments({ caseId }), 1);
  assert.equal(await Listening.Job.countDocuments({ type: "reprocess" }), 1);
  assert.equal(await Listen.countDocuments({}), 0);
});
