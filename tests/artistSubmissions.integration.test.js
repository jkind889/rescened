// Standalone artist suggestions through the real contributor and moderator
// routers on a disposable replica set. Clerk is mocked by header, the
// MusicBrainz exact-ID adapter is a fixture, and any non-loopback fetch
// fails the test.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const Artist = require("../models/Artist");
const ArtistSubmission = require("../models/ArtistSubmission");
const Notification = require("../models/Notification");
const musicBrainz = require("../lib/musicBrainzSearch");
const { artistMbidOf, newArtistDocument } = require("../lib/artists/identity");
const { artistDetail } = require("../lib/artists/read");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: enabled ? false : "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, fn);
const MODERATOR = "artist-suggestion-moderator";
const ENV = {
  COMMUNITY_SUBMISSIONS_ENABLED: "true",
  COMMUNITY_MODERATION_ENABLED: "true",
  ARTIST_SUGGESTIONS_ENABLED: "true",
  MODERATOR_USER_IDS: MODERATOR,
};
const MBID_NEW = "83096042-3785-481e-8843-dee69f1aad12";
const MBID_LATE = "e941e097-0f9e-496d-a381-dd74a953682c";
const MBID_RACE = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const MBID_IMPORTED = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const EVIDENCE = "https://example.com/private-standalone-evidence";
const observed = {
  [MBID_NEW]: { artistMbid: MBID_NEW, name: "Observed Artist", sortName: "", disambiguation: "UK duo", type: "Group", country: "GB" },
  [MBID_LATE]: { artistMbid: MBID_LATE, name: "Late Upstream Name", sortName: "", disambiguation: "", type: "Person", country: "" },
  [MBID_RACE]: { artistMbid: MBID_RACE, name: "Race Artist", sortName: "", disambiguation: "", type: "Person", country: "" },
};

let replSet;
let server;
let baseUrl;
let previousEnv;
let originalFetch;
let originalLookup;
let imported;
let users = 0;
const lookups = [];

function contributor() {
  users += 1;
  return `artist-contributor-${users}`;
}

async function call(method, route, userId, body) {
  const response = await originalFetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": userId || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const community = (canonicalName, url = EVIDENCE) => ({ kind: "community", canonicalName, evidence: [{ url }] });
const musicbrainz = (artistMbid) => ({ kind: "musicbrainz", artistMbid });

async function suggest(userId, artistProposal, extra = {}) {
  return call("POST", "/artist-suggestions", userId, { artistProposal, requestKey: crypto.randomUUID(), ...extra });
}

const moderate = (submissionId, path, body, moderator = MODERATOR) => call("POST", `/moderation/artist-suggestions/${submissionId}/${path}`, moderator, body);

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_artist_submissions" });
  await Promise.all([AlbumCatalog, AlbumSubmission, Artist, ArtistSubmission, Notification].map((model) => model.syncIndexes()));
  imported = await Artist.create(newArtistDocument({ name: "Imported Artist", artistMbid: MBID_IMPORTED, source: "import" }));
  previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ENV);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("http://127.0.0.1:")) throw new Error(`Unexpected external request: ${url}`);
    return originalFetch(url, init);
  };
  originalLookup = musicBrainz.lookupMusicBrainzArtist;
  musicBrainz.lookupMusicBrainzArtist = async (mbid) => {
    lookups.push(mbid);
    return observed[mbid] ? { ...observed[mbid] } : null;
  };
  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: { getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }), clerkClient: { users: { getUserList: async () => ({ data: [] }) } } },
  };
  for (const route of ["../routes/artistSuggestions", "../routes/artistSuggestionModeration", "../routes/suggestions", "../routes/moderation"]) delete require.cache[require.resolve(route)];
  const app = express();
  app.use(express.json());
  app.use("/artist-suggestions", require("../routes/artistSuggestions"));
  app.use("/moderation/artist-suggestions", require("../routes/artistSuggestionModeration"));
  app.use("/suggestions", require("../routes/suggestions"));
  app.use("/moderation/album-suggestions", require("../routes/moderation"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalFetch) globalThis.fetch = originalFetch;
  if (originalLookup) musicBrainz.lookupMusicBrainzArtist = originalLookup;
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
});

integration("a community artist suggestion is private until approval creates a zero-album public artist", async () => {
  const user = contributor();
  const created = await suggest(user, community("Brand New Band"), { note: "  Local band, two releases on Bandcamp  " });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { submissionId } = created.body;
  assert.equal(created.body.note, "Local band, two releases on Bandcamp");
  assert.equal(await Artist.countDocuments({ name: "Brand New Band" }), 0, "nothing is registered before approval");

  assert.equal((await call("GET", `/artist-suggestions/${submissionId}`, "outsider")).status, 404);
  assert.ok(JSON.stringify((await call("GET", `/artist-suggestions/${submissionId}`, user)).body).includes(EVIDENCE));
  const mine = await call("GET", "/artist-suggestions/mine", user);
  assert.equal(mine.body.suggestions[0].submissionId, submissionId);
  assert.equal(JSON.stringify(mine.body).includes(EVIDENCE), false, "summaries carry no evidence");
  const queue = await call("GET", "/moderation/artist-suggestions", MODERATOR);
  assert.ok(queue.body.suggestions.some((row) => row.submissionId === submissionId));
  assert.equal(JSON.stringify(queue.body).includes(EVIDENCE), false);
  assert.equal((await call("GET", "/moderation/artist-suggestions", user)).status, 403);
  assert.equal((await call("GET", "/moderation/artist-suggestions", "")).status, 401);

  const missing = await moderate(submissionId, "approve", {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "EXPECTED_REVISION_REQUIRED");
  const stale = await moderate(submissionId, "approve", { expectedRevision: 2 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STATE_CONFLICT");

  const approved = await moderate(submissionId, "approve", { expectedRevision: 1, reason: "Evidence checks out" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const { approvedArtistId } = approved.body.suggestion;
  assert.equal(approved.body.suggestion.approvalOutcome, "created");
  const artist = await Artist.findOne({ artistId: approvedArtistId }).lean();
  assert.equal(artist.name, "Brand New Band");
  assert.deepEqual(artist.externalReferences, []);
  assert.equal(artist.artistSource, "community");
  assert.equal(artist.fieldProvenance.name.artistSubmissionId, submissionId);
  assert.equal(JSON.stringify(artist).includes(EVIDENCE), false, "evidence never reaches the registry");
  const page = await artistDetail(approvedArtistId);
  assert.equal(page.artist.artistId, approvedArtistId, "a zero-album artist has a public artist record");
  assert.equal(page.artist.name, "Brand New Band");
  assert.equal(page.releaseCounts.all, 0);
  assert.equal(page.artist.musicBrainzUrl || "", "", "a community artist has no MusicBrainz link");

  const retry = await moderate(submissionId, "approve", { expectedRevision: 1 });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.suggestion.approvedArtistId, approvedArtistId);
  const wrongRetry = await moderate(submissionId, "approve", { expectedRevision: 2 });
  assert.equal(wrongRetry.status, 409);
  assert.equal(wrongRetry.body.code, "APPROVAL_CONFLICT");
  assert.equal(await Artist.countDocuments({ name: "Brand New Band" }), 1);
  const stored = await ArtistSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.moderationHistory.filter((event) => event.action === "approved").length, 1);
});

integration("every suggestion, including an older one needing changes, stays reachable through owner-scoped pages", async () => {
  const user = contributor();
  // Seeded directly (the create rate limit allows ten per window), oldest
  // first, with distinct creation times and two sharing one timestamp.
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const rows = Array.from({ length: 21 }, (_, index) => {
    const createdAt = new Date(base + (index === 6 ? 5 : index) * 1000);
    const proposal = { proposalKey: "artist", kind: "community", canonicalName: `Paged Band ${index}`, evidence: [{ url: `https://example.com/paged-${index}`, description: "" }] };
    return {
      submissionId: crypto.randomUUID(), submittedByUserId: user, status: "pending", currentRevision: 1, proposal, note: "",
      revisions: [{ revision: 1, submittedAt: createdAt, proposal, note: "" }],
      moderationHistory: [{ actorUserId: user, action: "submitted", reason: "", revision: 1, createdAt }],
      approvedArtistId: null, duplicateOfArtistId: null, approvedAt: null, createdAt, updatedAt: createdAt,
    };
  });
  await ArtistSubmission.collection.insertMany(rows);
  const ids = rows.map((row) => row.submissionId);
  const oldest = ids[0];
  await moderate(oldest, "request-changes", { expectedRevision: 1, reason: "Add a label page" });
  const other = contributor();
  await suggest(other, community("Someone Else's Band"));

  const first = await call("GET", "/artist-suggestions/mine", user);
  assert.equal(first.status, 200);
  assert.equal(first.body.suggestions.length, 20);
  assert.equal(first.body.suggestions.some((row) => row.submissionId === oldest), false, "the oldest is past the first page");
  assert.ok(first.body.nextCursor, "a cursor continues the list");
  const second = await call("GET", `/artist-suggestions/mine?cursor=${encodeURIComponent(first.body.nextCursor)}`, user);
  assert.deepEqual(second.body.suggestions.map((row) => [row.submissionId, row.status]), [[oldest, "needs_changes"]]);
  assert.equal(second.body.nextCursor, null);
  const all = [...first.body.suggestions, ...second.body.suggestions].map((row) => row.submissionId);
  assert.equal(new Set(all).size, 21, "no suggestion is repeated or skipped");
  assert.deepEqual(new Set(all), new Set(ids));

  const borrowed = await call("GET", `/artist-suggestions/mine?cursor=${encodeURIComponent(first.body.nextCursor)}`, other);
  assert.equal(borrowed.body.suggestions.some((row) => ids.includes(row.submissionId)), false, "a cursor never reveals another contributor's suggestions");
  const small = await call("GET", "/artist-suggestions/mine?limit=5", user);
  assert.equal(small.body.suggestions.length, 5);
  assert.equal((await call("GET", "/artist-suggestions/mine?limit=500", user)).body.suggestions.length, 21, "the limit is capped at 50");
  assert.equal((await call("GET", "/artist-suggestions/mine?cursor=not-a-cursor", user)).body.code, "INVALID_CURSOR");
  assert.equal((await call("GET", "/artist-suggestions/mine?status=pending", user)).status, 400);
});

integration("MusicBrainz suggestions keep a server observation; an exact MBID already on Rescened points to that artist", async () => {
  const user = contributor();
  lookups.length = 0;
  const already = await suggest(user, musicbrainz(MBID_IMPORTED));
  assert.equal(already.status, 409);
  assert.equal(already.body.code, "ARTIST_ALREADY_EXISTS");
  assert.equal(already.body.details[0].artistId, imported.artistId);
  assert.deepEqual(already.body.existingArtist, { artistId: imported.artistId, name: "Imported Artist" }, "the page can link to the existing artist");
  assert.deepEqual(lookups, [], "no provider call for a registered MBID");

  const clientName = await call("POST", "/artist-suggestions", user, { artistProposal: { ...musicbrainz(MBID_NEW), name: "Client name" }, requestKey: crypto.randomUUID() });
  assert.equal(clientName.status, 400, "clients cannot send MusicBrainz names");
  const created = await suggest(user, musicbrainz(MBID_NEW));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.proposal.observation.name, "Observed Artist");
  assert.ok(created.body.proposal.observation.observedAt);

  // The same MBID registered by someone else before approval is reused, not renamed.
  const late = await suggest(user, musicbrainz(MBID_LATE));
  assert.equal(late.status, 201);
  const preexisting = await Artist.create(newArtistDocument({ name: "Registry Wording", artistMbid: MBID_LATE, source: "import" }));
  const approved = await moderate(late.body.submissionId, "approve", { expectedRevision: 1 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.suggestion.approvedArtistId, preexisting.artistId);
  assert.equal(approved.body.suggestion.approvalOutcome, "reused");
  assert.equal((await Artist.findOne({ artistId: preexisting.artistId }).lean()).name, "Registry Wording");
  assert.equal(await Artist.countDocuments({ "externalReferences.externalId": MBID_LATE }), 1);

  const context = await call("GET", `/moderation/artist-suggestions/${created.body.submissionId}`, MODERATOR);
  assert.equal(context.body.context.registeredArtist, null);
  const fresh = await moderate(created.body.submissionId, "approve", { expectedRevision: 1 });
  const createdArtist = await Artist.findOne({ artistId: fresh.body.suggestion.approvedArtistId }).lean();
  assert.equal(createdArtist.name, "Observed Artist");
  assert.equal(artistMbidOf(createdArtist), MBID_NEW);
});

integration("request keys make create retries return the original suggestion", async () => {
  const user = contributor();
  const body = { artistProposal: community("Keyed Band"), note: "note", requestKey: crypto.randomUUID() };
  const first = await call("POST", "/artist-suggestions", user, body);
  assert.equal(first.status, 201);
  const replay = await call("POST", "/artist-suggestions", user, { ...body, note: "  note " });
  assert.equal(replay.status, 200, "the digest compares normalized client input");
  assert.equal(replay.body.submissionId, first.body.submissionId);
  const changed = await call("POST", "/artist-suggestions", user, { ...body, note: "different" });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, "REQUEST_KEY_CONFLICT");
  assert.equal((await call("POST", "/artist-suggestions", user, { artistProposal: community("No key") })).status, 400);
  const burstUser = contributor();
  const burstBody = { artistProposal: community("Burst Band"), requestKey: crypto.randomUUID() };
  const burst = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/artist-suggestions", burstUser, burstBody)));
  assert.equal(new Set(burst.map((result) => result.body.submissionId)).size, 1);
  assert.equal(await ArtistSubmission.countDocuments({ submittedByUserId: burstUser }), 1);
});

integration("transitions follow the reviewed revision and the allowed state matrix", async () => {
  const user = contributor();
  const created = await suggest(user, community("Matrix Band"));
  const { submissionId } = created.body;
  const revise = (body, asUser = user) => call("POST", `/artist-suggestions/${submissionId}/revise`, asUser, body);
  const withdraw = (body, asUser = user) => call("POST", `/artist-suggestions/${submissionId}/withdraw`, asUser, body);

  assert.equal((await revise({ artistProposal: community("Matrix Band"), expectedRevision: 1 })).body.code, "INVALID_SUBMISSION_STATE", "pending cannot be revised");
  assert.equal((await moderate(submissionId, "request-changes", { expectedRevision: 1 })).status, 400, "a reason is required");
  assert.equal((await moderate(submissionId, "request-changes", { reason: "More evidence" })).body.code, "EXPECTED_REVISION_REQUIRED");
  assert.equal((await moderate(submissionId, "request-changes", { reason: "More evidence", expectedRevision: 1 })).status, 200);
  assert.equal((await revise({ artistProposal: community("Matrix Band") })).body.code, "EXPECTED_REVISION_REQUIRED");
  assert.equal((await revise({ artistProposal: community("Matrix Band"), expectedRevision: 1 }, "outsider")).status, 404);
  assert.equal((await revise({ artistProposal: community("Matrix Band"), expectedRevision: 2 })).body.code, "REVISION_CONFLICT");
  const revised = await revise({ artistProposal: community("Matrix Band", "https://example.com/more-evidence"), note: "Added a label page", expectedRevision: 1 });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.currentRevision, 2);
  assert.equal(revised.body.revisions.length, 2);
  assert.equal(revised.body.revisions[0].proposal.evidence[0].url, EVIDENCE, "the first revision stays as it was");

  assert.equal((await withdraw({})).body.code, "EXPECTED_REVISION_REQUIRED");
  assert.equal((await withdraw({ expectedRevision: 1 })).body.code, "STATE_CONFLICT");
  assert.equal((await withdraw({ expectedRevision: 2 }, "outsider")).status, 404);
  const withdrawn = await withdraw({ expectedRevision: 2 });
  assert.equal(withdrawn.body.status, "withdrawn");
  for (const [path, body] of [["approve", { expectedRevision: 2 }], ["reject", { expectedRevision: 2, reason: "x" }], ["request-changes", { expectedRevision: 2, reason: "x" }], ["mark-duplicate", { expectedRevision: 2, duplicateOfArtistId: imported.artistId }]]) {
    const result = await moderate(submissionId, path, body);
    assert.equal(result.status, 409, `${path} on a withdrawn suggestion`);
    assert.equal(result.body.code, "INVALID_SUBMISSION_STATE");
  }
  assert.equal((await withdraw({ expectedRevision: 2 })).body.code, "INVALID_SUBMISSION_STATE");
  const history = (await ArtistSubmission.findOne({ submissionId }).lean()).moderationHistory.map((event) => event.action);
  assert.deepEqual(history, ["submitted", "request_changes", "revised", "withdrawn"], "one audit event per accepted command");

  const rejected = await suggest(user, community("Rejected Band"));
  const reject = await moderate(rejected.body.submissionId, "reject", { expectedRevision: 1, reason: "No evidence" });
  assert.equal(reject.body.suggestion.status, "rejected");
  assert.equal(await Artist.countDocuments({ name: "Rejected Band" }), 0);
});

integration("a duplicate decision names an existing public artist, including an imported one", async () => {
  const user = contributor();
  const created = await suggest(user, community("Imported Artist"));
  const { submissionId } = created.body;
  const context = await call("GET", `/moderation/artist-suggestions/${submissionId}`, MODERATOR);
  assert.deepEqual(context.body.context.sameNameArtists.map((artist) => artist.artistId), [imported.artistId], "same-name registry artists are offered as advisory duplicate targets");
  const unknown = await moderate(submissionId, "mark-duplicate", { expectedRevision: 1, duplicateOfArtistId: crypto.randomUUID() });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.code, "INVALID_DUPLICATE_TARGET");
  const marked = await moderate(submissionId, "mark-duplicate", { expectedRevision: 1, duplicateOfArtistId: imported.artistId });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  assert.equal(marked.body.suggestion.status, "duplicate");
  assert.equal(marked.body.suggestion.duplicateOfArtistId, imported.artistId);
  assert.equal(await Artist.countDocuments({ name: "Imported Artist" }), 1, "no artist is created for a duplicate");

  // Same-name community suggestions approved separately stay distinct.
  const one = await suggest(contributor(), community("Same Name Band", "https://example.com/one"));
  const two = await suggest(contributor(), community("Same Name Band", "https://example.com/two"));
  const firstArtist = (await moderate(one.body.submissionId, "approve", { expectedRevision: 1 })).body.suggestion.approvedArtistId;
  const secondArtist = (await moderate(two.body.submissionId, "approve", { expectedRevision: 1 })).body.suggestion.approvedArtistId;
  assert.notEqual(firstArtist, secondArtist);
});

integration("flags gate mutations while reads keep working", async () => {
  const user = contributor();
  const created = await suggest(user, community("Flag Band"));
  for (const flag of ["ARTIST_SUGGESTIONS_ENABLED", "COMMUNITY_SUBMISSIONS_ENABLED"]) {
    process.env[flag] = "false";
    try {
      const refused = await suggest(user, community("Flag Band 2"));
      assert.equal(refused.status, 503, flag);
      assert.equal((await call("POST", `/artist-suggestions/${created.body.submissionId}/withdraw`, user, { expectedRevision: 1 })).status, 503);
      assert.equal((await call("GET", `/artist-suggestions/${created.body.submissionId}`, user)).status, 200);
      assert.equal((await call("GET", "/artist-suggestions/mine", user)).status, 200);
    } finally {
      process.env[flag] = "true";
    }
  }
  for (const flag of ["ARTIST_SUGGESTIONS_ENABLED", "COMMUNITY_MODERATION_ENABLED"]) {
    process.env[flag] = "false";
    try {
      assert.equal((await moderate(created.body.submissionId, "approve", { expectedRevision: 1 })).status, 503, flag);
      assert.equal((await call("GET", `/moderation/artist-suggestions/${created.body.submissionId}`, MODERATOR)).status, 200);
    } finally {
      process.env[flag] = "true";
    }
  }
  assert.equal(await Artist.countDocuments({ name: "Flag Band" }), 0);
});

integration("approval rolls back the artist when a later write fails, and concurrent commands publish once", async () => {
  const created = await suggest(contributor(), community("Rollback Band"));
  const { submissionId } = created.body;
  const original = ArtistSubmission.findOneAndUpdate;
  ArtistSubmission.findOneAndUpdate = function failOnce() {
    ArtistSubmission.findOneAndUpdate = original;
    return { session() { return this; }, then: (resolve, reject) => reject(new Error("forced transition failure")) };
  };
  try {
    const failed = await moderate(submissionId, "approve", { expectedRevision: 1 });
    assert.equal(failed.status, 500);
  } finally {
    ArtistSubmission.findOneAndUpdate = original;
  }
  assert.equal(await Artist.countDocuments({ name: "Rollback Band" }), 0, "the artist created inside the transaction rolled back");
  assert.equal((await ArtistSubmission.findOne({ submissionId }).lean()).status, "pending");

  const originalCreate = Artist.create;
  Artist.create = function failCreate() {
    Artist.create = originalCreate;
    return Promise.reject(new Error("forced artist failure"));
  };
  try {
    assert.equal((await moderate(submissionId, "approve", { expectedRevision: 1 })).status, 500);
  } finally {
    Artist.create = originalCreate;
  }
  assert.equal((await ArtistSubmission.findOne({ submissionId }).lean()).moderationHistory.length, 1, "no audit event for a failed approval");

  const results = await Promise.all([
    moderate(submissionId, "approve", { expectedRevision: 1 }),
    moderate(submissionId, "approve", { expectedRevision: 1 }),
    moderate(submissionId, "reject", { expectedRevision: 1, reason: "Raced" }),
  ]);
  const statuses = results.map((result) => result.status);
  assert.ok(statuses.includes(200), JSON.stringify(results.map((result) => result.body)));
  results.filter((result) => result.status !== 200).forEach((result) => assert.equal(result.status, 409, JSON.stringify(result.body)));
  const stored = await ArtistSubmission.findOne({ submissionId }).lean();
  assert.ok(["approved", "rejected"].includes(stored.status));
  assert.equal(await Artist.countDocuments({ name: "Rollback Band" }), stored.status === "approved" ? 1 : 0);
  assert.equal(stored.moderationHistory.filter((event) => ["approved", "rejected"].includes(event.action)).length, 1);

  // Withdrawal racing approval: exactly one wins.
  const raced = await suggest(contributor(), community("Withdraw Race Band"));
  const owner = (await ArtistSubmission.findOne({ submissionId: raced.body.submissionId }).lean()).submittedByUserId;
  const [withdrawal, approval] = await Promise.all([
    call("POST", `/artist-suggestions/${raced.body.submissionId}/withdraw`, owner, { expectedRevision: 1 }),
    moderate(raced.body.submissionId, "approve", { expectedRevision: 1 }),
  ]);
  assert.equal([withdrawal.status, approval.status].filter((status) => status === 200).length, 1, JSON.stringify([withdrawal.body, approval.body]));
  const final = await ArtistSubmission.findOne({ submissionId: raced.body.submissionId }).lean();
  assert.equal(await Artist.countDocuments({ name: "Withdraw Race Band" }), final.status === "approved" ? 1 : 0);
});

integration("an exact MBID approved through a standalone and an album suggestion at once registers one artist", async () => {
  const standalone = await suggest(contributor(), musicbrainz(MBID_RACE));
  assert.equal(standalone.status, 201);
  const albumUser = contributor();
  const album = await call("POST", "/suggestions", albumUser, {
    proposedMetadata: { title: `Race Album ${crypto.randomUUID()}`, artistCredits: [{ name: "Race Artist", role: "main" }], releaseType: "album", releaseDate: "2026", coverSourceUrl: "https://example.com/cover.jpg" },
    supportingSources: [{ type: "other", url: "https://example.com/release" }],
    externalReferences: [],
    artistProposals: [{ proposalKey: "mb-1", kind: "musicbrainz", artistMbid: MBID_RACE }],
    artistSelections: [{ position: 0, kind: "proposal", proposalKey: "mb-1" }],
    requestKey: crypto.randomUUID(),
  });
  assert.equal(album.status, 201, JSON.stringify(album.body));
  const [one, two] = await Promise.all([
    moderate(standalone.body.submissionId, "approve", { expectedRevision: 1 }),
    call("POST", `/moderation/album-suggestions/${album.body.submissionId}/approve`, MODERATOR, { expectedRevision: 1, confirmPossibleDuplicate: true }),
  ]);
  const okCount = [one, two].filter((result) => result.status === 200).length;
  assert.ok(okCount >= 1, JSON.stringify([one.body, two.body]));
  [one, two].filter((result) => result.status !== 200).forEach((result) => assert.equal(result.body.code, "ARTIST_IDENTITY_CONFLICT", JSON.stringify(result.body)));
  assert.equal(await Artist.countDocuments({ "externalReferences.externalId": MBID_RACE }), 1, "one registry artist per exact MBID");
  // A loser can be retried and then reuses the winner's artist.
  if (one.status !== 200) assert.equal((await moderate(standalone.body.submissionId, "approve", { expectedRevision: 1 })).body.suggestion.approvalOutcome, "reused");
  if (two.status !== 200) assert.equal((await call("POST", `/moderation/album-suggestions/${album.body.submissionId}/approve`, MODERATOR, { expectedRevision: 1, confirmPossibleDuplicate: true })).status, 200);
  const artistId = (await Artist.findOne({ "externalReferences.externalId": MBID_RACE }).lean()).artistId;
  assert.equal((await ArtistSubmission.findOne({ submissionId: standalone.body.submissionId }).lean()).approvedArtistId, artistId);
  const catalog = await AlbumCatalog.findOne({ title: /^Race Album/ }).lean();
  assert.equal(catalog.artistCredits[0].artistId, artistId);
});
