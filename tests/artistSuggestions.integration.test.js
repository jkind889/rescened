// Album suggestions with embedded artist proposals, through the real
// contributor and moderator routers on a disposable replica set. Clerk is
// mocked by header, the MusicBrainz exact-ID adapter is replaced by a fixture,
// and any non-loopback fetch fails the test.
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
const Notification = require("../models/Notification");
const Preview = require("../models/ContributorEditionPreview");
const { Genre, GenreEvent } = require("../models/Genre");
const { validateGenreName } = require("../lib/genres/vocabulary");
const editions = require("../lib/contributorEditions/service");
const discovery = require("../lib/baselines/discovery");
const { hashCandidateTracklist } = require("../lib/baselines/musicBrainz");
const fs = require("node:fs");
const path = require("node:path");
const musicBrainz = require("../lib/musicBrainzSearch");
const { artistMbidOf, newArtistDocument, newCommunityArtistDocument } = require("../lib/artists/identity");
const { searchArtists } = require("../lib/artists/read");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const { applyModerationCommand } = require("../routes/utils/moderationCommands");
const { correctionSnapshot, normalizeCorrectionPayload } = require("../routes/utils/submissions");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: enabled ? false : "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, fn);
const MODERATOR = "artist-moderator";
const ENV = {
  COMMUNITY_SUBMISSIONS_ENABLED: "true",
  COMMUNITY_MODERATION_ENABLED: "true",
  ARTIST_SUGGESTIONS_ENABLED: "true",
  GENRES_ENABLED: "true",
  CONTRIBUTOR_EDITIONS_ENABLED: "true",
  MODERATOR_USER_IDS: MODERATOR,
};
const MBID_REGISTERED = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_NEW = "83096042-3785-481e-8843-dee69f1aad12";
const MBID_OTHER = "e941e097-0f9e-496d-a381-dd74a953682c";
const MBID_MERGED = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const EVIDENCE = "https://example.com/private-evidence-for-new-band";

let replSet;
let server;
let baseUrl;
let previousEnv;
let originalFetch;
let originalLookup;
let userCounter = 0;
let registered;
let localArtist;
const lookups = [];
let lookupBehavior = null;

const observed = {
  [MBID_REGISTERED]: { artistMbid: MBID_REGISTERED, name: "Upstream Wording", sortName: "", disambiguation: "", type: "Group", country: "" },
  [MBID_NEW]: { artistMbid: MBID_NEW, name: "Observed New Artist", sortName: "New Artist, Observed", disambiguation: "UK duo", type: "Group", country: "GB" },
  [MBID_OTHER]: { artistMbid: MBID_OTHER, name: "Other Artist", sortName: "", disambiguation: "", type: "Person", country: "" },
  [MBID_MERGED]: { artistMbid: MBID_OTHER, name: "Merged Into Other", sortName: "", disambiguation: "", type: "Person", country: "" },
};

function contributor() {
  userCounter += 1;
  return `artist-contributor-${userCounter}`;
}

async function call(method, route, userId, body) {
  const response = await originalFetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": userId || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function suggestionBody(title, artistCredits, extra = {}) {
  return {
    proposedMetadata: { title, artistCredits, releaseType: "album", releaseDate: "2026", coverSourceUrl: "https://example.com/cover.jpg" },
    supportingSources: [{ type: "other", url: "https://example.com/release-evidence" }],
    externalReferences: [],
    ...extra,
  };
}

// Mixed credits: an existing Rescened artist, a registered MBID (reuse), a
// new MBID shared by two credits, and two same-name community artists.
function mixedBody(title) {
  return suggestionBody(title, [
    { name: "Local Artist (credited)", role: "main" },
    { name: "Tyler, the Creator", role: "main" },
    { name: "New Artist", role: "featured" },
    { name: "New Artist (as N.A.)", role: "producer" },
    { name: "Same Name", role: "main" },
    { name: "Same Name", role: "remixer" },
    { name: "Unlinked, With Comma", role: "main" },
  ], {
    artistProposals: [
      { proposalKey: "mb-1", kind: "musicbrainz", artistMbid: MBID_REGISTERED },
      { proposalKey: "mb-2", kind: "musicbrainz", artistMbid: MBID_NEW },
      { proposalKey: "new-1", kind: "community", canonicalName: "Same Name", evidence: [{ url: EVIDENCE }] },
      { proposalKey: "new-2", kind: "community", canonicalName: "Same Name", evidence: [{ url: "https://example.com/other-same-name" }] },
    ],
    artistSelections: [
      { position: 0, kind: "existing", artistId: localArtist.artistId },
      { position: 1, kind: "proposal", proposalKey: "mb-1" },
      { position: 2, kind: "proposal", proposalKey: "mb-2" },
      { position: 3, kind: "proposal", proposalKey: "mb-2" },
      { position: 4, kind: "proposal", proposalKey: "new-1" },
      { position: 5, kind: "proposal", proposalKey: "new-2" },
    ],
  });
}

function approveRoute(submissionId, body, moderator = MODERATOR) {
  return call("POST", `/moderation/album-suggestions/${submissionId}/approve`, moderator, body);
}

async function artistCount() {
  return Artist.countDocuments();
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_artist_suggestions" });
  await Promise.all([AlbumCatalog, AlbumSubmission, Artist, Notification, Preview, Genre, GenreEvent].map((model) => model.syncIndexes()));
  registered = await Artist.create(newArtistDocument({ name: "Registry Name", artistMbid: MBID_REGISTERED, source: "import" }));
  localArtist = await Artist.create(newCommunityArtistDocument({ canonicalName: "Local Artist", provenance: { source: "manual" } }));

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
    if (lookupBehavior) return lookupBehavior(mbid);
    return observed[mbid] ? { ...observed[mbid] } : null;
  };

  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: {
      getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }),
      clerkClient: { users: { getUserList: async () => ({ data: [] }) } },
    },
  };
  for (const route of ["../routes/suggestions", "../routes/moderation"]) delete require.cache[require.resolve(route)];
  const app = express();
  app.use(express.json());
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

integration("a mixed artist-linked suggestion stays private until one atomic approval publishes it", async () => {
  const user = contributor();
  const before = await artistCount();
  lookups.length = 0;
  const title = `Mixed Links ${crypto.randomUUID()}`;
  const created = await call("POST", "/suggestions", user, { ...mixedBody(title), requestKey: crypto.randomUUID() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([...new Set(lookups)].sort(), [MBID_NEW, MBID_REGISTERED].sort(), "only exact selected MBIDs are looked up");
  const submissionId = created.body.submissionId;

  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.deepEqual(stored.proposedMetadata.artistCredits.map(({ name, role }) => [name, role]), mixedBody(title).proposedMetadata.artistCredits.map(({ name, role }) => [name, role]));
  assert.equal(stored.revisions[0].artistProposals.length, 4, "the revision snapshot keeps its proposals");
  const newProposal = stored.revisions[0].artistProposals.find((proposal) => proposal.proposalKey === "mb-2");
  assert.equal(newProposal.observation.name, "Observed New Artist");
  assert.ok(newProposal.observation.observedAt instanceof Date);
  assert.equal(await artistCount(), before, "no artist exists before approval");
  assert.equal((await searchArtists({ q: "Observed New Artist" })).results.length, 0);

  // Privacy: owner and moderators see evidence; outsiders and public lists do not.
  const owner = await call("GET", `/suggestions/${submissionId}`, user);
  assert.equal(owner.status, 200);
  assert.ok(JSON.stringify(owner.body).includes(EVIDENCE));
  assert.equal((await call("GET", `/suggestions/${submissionId}`, "outsider")).status, 404);
  const mine = await call("GET", "/suggestions/mine", user);
  assert.equal(JSON.stringify(mine.body).includes(EVIDENCE), false, "summaries carry no proposals");
  const detail = await call("GET", `/moderation/album-suggestions/${submissionId}`, MODERATOR);
  assert.equal(detail.status, 200);
  assert.ok(JSON.stringify(detail.body.suggestion).includes(EVIDENCE));
  assert.equal(detail.body.artistProposalRegistry[MBID_REGISTERED].artistId, registered.artistId, "moderators see which MBID approval reuses");
  assert.equal(detail.body.artistRegistry[localArtist.artistId].name, "Local Artist");
  const queue = await call("GET", "/moderation/album-suggestions", MODERATOR);
  const row = queue.body.suggestions.find((item) => item.submissionId === submissionId);
  assert.deepEqual(row.bulkApproval, { eligible: false, reason: "artist_links" });
  assert.equal(JSON.stringify(queue.body).includes(EVIDENCE), false);

  // Bulk approval refuses artist links instead of approving them unreviewed.
  const bulk = await call("POST", "/moderation/album-suggestions/bulk-approve", MODERATOR, { items: [{ submissionId, expectedRevision: 1 }] });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.results[0].error.code, "BULK_REVIEW_REQUIRED");
  assert.deepEqual(bulk.body.results[0].error.details, ["artist_links"]);

  const missing = await approveRoute(submissionId, { confirmPossibleDuplicate: true });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "EXPECTED_REVISION_REQUIRED");
  const existingAlbum = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Existing", artistDisplayName: "Someone" });
  const linkExisting = await approveRoute(submissionId, { albumId: existingAlbum.albumId, expectedRevision: 1 });
  assert.equal(linkExisting.status, 400);
  assert.equal(linkExisting.body.code, "ARTIST_LINKS_REQUIRE_NEW_ALBUM");
  assert.equal(await artistCount(), before);

  const approved = await approveRoute(submissionId, { confirmPossibleDuplicate: true, expectedRevision: 1 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const album = await AlbumCatalog.findOne({ albumId: approved.body.album.albumId }).lean();
  assert.deepEqual(album.artistCredits.map(({ name, role }) => [name, role]), mixedBody(title).proposedMetadata.artistCredits.map(({ name, role }) => [name, role]), "wording, roles and order are published unchanged");
  assert.equal(album.artistCredits[0].artistId, localArtist.artistId);
  assert.equal(album.artistCredits[1].artistId, registered.artistId);
  assert.equal(album.artistCredits[1].artistMbid, MBID_REGISTERED);
  assert.equal(album.artistCredits[2].artistId, album.artistCredits[3].artistId, "an explicitly reused proposal is one artist");
  assert.notEqual(album.artistCredits[4].artistId, album.artistCredits[5].artistId, "same-name community proposals stay distinct");
  assert.equal(album.artistCredits[6].artistId, undefined, "an unselected credit stays unlinked");
  assert.equal(await artistCount(), before + 3);

  const reused = await Artist.findOne({ artistId: registered.artistId }).lean();
  assert.equal(reused.name, "Registry Name", "reusing an exact MBID never renames the artist");
  const createdMb = await Artist.findOne({ artistId: album.artistCredits[2].artistId }).lean();
  assert.equal(createdMb.name, "Observed New Artist", "the canonical name comes from the reviewed observation, not the credit");
  assert.equal(artistMbidOf(createdMb), MBID_NEW);
  const community = await Artist.find({ artistId: { $in: [album.artistCredits[4].artistId, album.artistCredits[5].artistId] } }).lean();
  assert.ok(community.every((artist) => artist.externalReferences.length === 0 && artist.artistSource === "community" && artist.name === "Same Name"));
  assert.equal(JSON.stringify(await Artist.find({}).lean()).includes(EVIDENCE), false, "evidence never reaches the registry");
  assert.equal(JSON.stringify(album).includes(EVIDENCE), false, "or the catalog");

  const receipt = (await AlbumSubmission.findOne({ submissionId }).lean()).approvalReceipt;
  assert.deepEqual(receipt.artistResolutions.map(({ position, kind, outcome }) => [position, kind, outcome]), [
    [0, "existing", "linked"], [1, "musicbrainz", "reused"], [2, "musicbrainz", "created"], [3, "musicbrainz", "created"], [4, "community", "created"], [5, "community", "created"],
  ]);
  const ownerAfter = await call("GET", `/suggestions/${submissionId}`, user);
  assert.equal(ownerAfter.body.artistResolutions.length, 6);

  // A response-lost retry returns the original result and creates nothing.
  const retry = await approveRoute(submissionId, { confirmPossibleDuplicate: true, expectedRevision: 1 });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.album.albumId, album.albumId);
  assert.equal(await artistCount(), before + 3);
  const history = (await AlbumSubmission.findOne({ submissionId }).lean()).moderationHistory;
  assert.equal(history.filter((event) => event.action === "approved").length, 1);
});

integration("request keys make an ambiguous create retry return the original suggestion", async () => {
  const user = contributor();
  const requestKey = crypto.randomUUID();
  const body = { ...mixedBody(`Keyed ${crypto.randomUUID()}`), requestKey };
  lookups.length = 0;
  const first = await call("POST", "/suggestions", user, body);
  assert.equal(first.status, 201);
  const replay = await call("POST", "/suggestions", user, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotent, true);
  assert.equal(replay.body.submissionId, first.body.submissionId);
  assert.equal(lookups.length, 2, "a replay never repeats provider validation");
  const changed = await call("POST", "/suggestions", user, { ...body, proposedMetadata: { ...body.proposedMetadata, title: "Changed title" } });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, "REQUEST_KEY_CONFLICT");

  const missingKey = await call("POST", "/suggestions", user, mixedBody(`No key ${crypto.randomUUID()}`));
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.body.code, "INVALID_REQUEST_KEY");

  const burstUser = contributor();
  const burstBody = { ...mixedBody(`Burst ${crypto.randomUUID()}`), requestKey: crypto.randomUUID() };
  const burst = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/suggestions", burstUser, burstBody)));
  assert.ok(burst.every((result) => [200, 201].includes(result.status)), JSON.stringify(burst.map((result) => result.body)));
  assert.equal(new Set(burst.map((result) => result.body.submissionId)).size, 1);
  assert.equal(await AlbumSubmission.countDocuments({ submittedByUserId: burstUser }), 1);
});

integration("invalid links, provider failures, and redirects store nothing", async () => {
  const user = contributor();
  const count = async () => AlbumSubmission.countDocuments({ submittedByUserId: user });
  const linkedCredit = suggestionBody(`Linked twice ${crypto.randomUUID()}`, [{ name: "Prefilled", artistMbid: MBID_OTHER }], {
    artistProposals: [{ proposalKey: "c", kind: "community", canonicalName: "X", evidence: [{ url: "https://example.com/x" }] }],
    artistSelections: [{ position: 0, kind: "proposal", proposalKey: "c" }],
    requestKey: crypto.randomUUID(),
  });
  const twice = await call("POST", "/suggestions", user, linkedCredit);
  assert.equal(twice.status, 400);
  assert.equal(twice.body.code, "CREDIT_ALREADY_LINKED");
  const ghost = await call("POST", "/suggestions", user, suggestionBody(`Ghost ${crypto.randomUUID()}`, [{ name: "Ghost" }], {
    artistSelections: [{ position: 0, kind: "existing", artistId: crypto.randomUUID() }], requestKey: crypto.randomUUID(),
  }));
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.code, "ARTIST_NOT_FOUND");
  const unknownField = await call("POST", "/suggestions", user, suggestionBody(`Unknown ${crypto.randomUUID()}`, [{ name: "A" }], {
    artistProposals: [{ proposalKey: "m", kind: "musicbrainz", artistMbid: MBID_NEW, name: "Client name" }],
    artistSelections: [{ position: 0, kind: "proposal", proposalKey: "m" }],
    requestKey: crypto.randomUUID(),
  }));
  assert.equal(unknownField.status, 400);

  const redirect = await call("POST", "/suggestions", user, suggestionBody(`Merged ${crypto.randomUUID()}`, [{ name: "Merged" }], {
    artistProposals: [{ proposalKey: "m", kind: "musicbrainz", artistMbid: MBID_MERGED }],
    artistSelections: [{ position: 0, kind: "proposal", proposalKey: "m" }],
    requestKey: crypto.randomUUID(),
  }));
  assert.equal(redirect.status, 400);
  assert.equal(redirect.body.code, "ARTIST_MBID_REDIRECTED");

  lookupBehavior = () => { throw Object.assign(new Error("slow down"), { code: "MUSICBRAINZ_THROTTLED", retryAfterSeconds: 7 }); };
  try {
    const throttled = await call("POST", "/suggestions", user, suggestionBody(`Throttled ${crypto.randomUUID()}`, [{ name: "T" }], {
      artistProposals: [{ proposalKey: "m", kind: "musicbrainz", artistMbid: MBID_OTHER }],
      artistSelections: [{ position: 0, kind: "proposal", proposalKey: "m" }],
      requestKey: crypto.randomUUID(),
    }));
    assert.equal(throttled.status, 503);
    assert.equal(throttled.body.code, "ARTIST_LOOKUP_UNAVAILABLE");
    assert.equal(throttled.headers.get("retry-after"), "7");
  } finally {
    lookupBehavior = null;
  }
  assert.equal(await count(), 0);
});

integration("with artist suggestions off, links are refused while legacy flows and reads keep working", async () => {
  const user = contributor();
  const linked = await call("POST", "/suggestions", user, { ...mixedBody(`Flag ${crypto.randomUUID()}`), requestKey: crypto.randomUUID() });
  assert.equal(linked.status, 201);
  process.env.ARTIST_SUGGESTIONS_ENABLED = "false";
  try {
    const refused = await call("POST", "/suggestions", user, { ...mixedBody(`Flag off ${crypto.randomUUID()}`), requestKey: crypto.randomUUID() });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "ARTIST_SUGGESTIONS_DISABLED");
    const legacy = await call("POST", "/suggestions", user, suggestionBody(`Legacy ${crypto.randomUUID()}`, [{ name: "Plain, Artist", role: "main" }]));
    assert.equal(legacy.status, 201, "a body without artist links keeps the existing contract");
    assert.equal(legacy.body.artistSelections, undefined);
    const read = await call("GET", `/suggestions/${linked.body.submissionId}`, user);
    assert.equal(read.status, 200);
    assert.equal(read.body.artistSelections.length, 6, "authorized history reads survive flag-off");
    const before = await artistCount();
    const approval = await approveRoute(linked.body.submissionId, { confirmPossibleDuplicate: true, expectedRevision: 1 });
    assert.equal(approval.status, 503);
    assert.equal(approval.body.code, "ARTIST_SUGGESTIONS_DISABLED");
    assert.equal(await artistCount(), before);
    const reject = await call("POST", `/moderation/album-suggestions/${linked.body.submissionId}/reject`, MODERATOR, { reason: "Not now", expectedRevision: 1 });
    assert.equal(reject.status, 200, "rejecting needs no artist work");
    assert.equal(await artistCount(), before, "a rejected suggestion publishes no artists");
    const legacyApproval = await approveRoute(legacy.body.submissionId, { confirmPossibleDuplicate: true, expectedRevision: 1 });
    assert.equal(legacyApproval.status, 200, JSON.stringify(legacyApproval.body));
  } finally {
    process.env.ARTIST_SUGGESTIONS_ENABLED = "true";
  }
});

integration("while artist linking is off, a suggestion with stored links cannot be revised and keeps them", async () => {
  const user = contributor();
  const linked = await call("POST", "/suggestions", user, { ...mixedBody(`Off revise ${crypto.randomUUID()}`), requestKey: crypto.randomUUID() });
  assert.equal(linked.status, 201);
  const plain = await call("POST", "/suggestions", user, suggestionBody(`Off plain ${crypto.randomUUID()}`, [{ name: "Plain" }]));
  for (const { submissionId } of [linked.body, plain.body]) {
    await applyModerationCommand({ submissionId, actorUserId: MODERATOR, action: "request_changes", body: { reason: "Fix the title", expectedRevision: 1 } });
  }
  const detail = (await call("GET", `/suggestions/${linked.body.submissionId}`, user)).body;
  // Exactly what the form would send with links omitted.
  const withoutLinks = { proposedMetadata: { ...detail.proposedMetadata, title: `${detail.proposedMetadata.title} (fixed)` }, supportingSources: detail.supportingSources, externalReferences: detail.externalReferences };
  process.env.ARTIST_SUGGESTIONS_ENABLED = "false";
  try {
    const refused = await call("POST", `/suggestions/${linked.body.submissionId}/revise`, user, withoutLinks);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "ARTIST_SUGGESTIONS_DISABLED");
    const stored = await AlbumSubmission.findOne({ submissionId: linked.body.submissionId }).lean();
    assert.equal(stored.status, "needs_changes");
    assert.equal(stored.currentRevision, 1);
    assert.equal(stored.artistSelections.length, 6, "the stored links are untouched");
    assert.equal(stored.artistProposals.length, 4);
    const withLinks = await call("POST", `/suggestions/${linked.body.submissionId}/revise`, user, { ...withoutLinks, artistProposals: detail.artistProposals.map(({ observation, ...proposal }) => proposal), artistSelections: detail.artistSelections });
    assert.equal(withLinks.status, 503, "resending the links is refused while off as well");

    const plainDetail = (await call("GET", `/suggestions/${plain.body.submissionId}`, user)).body;
    const plainRevision = await call("POST", `/suggestions/${plain.body.submissionId}/revise`, user, {
      proposedMetadata: { ...plainDetail.proposedMetadata, title: `${plainDetail.proposedMetadata.title} (fixed)` },
      supportingSources: plainDetail.supportingSources,
      externalReferences: plainDetail.externalReferences,
    });
    assert.equal(plainRevision.status, 200, "a suggestion without links revises normally while off");
  } finally {
    process.env.ARTIST_SUGGESTIONS_ENABLED = "true";
  }
  // With linking on, a revision is a complete snapshot: omitting the links is
  // the contributor removing them (the form only does so after explicit
  // Remove link actions).
  const removed = await call("POST", `/suggestions/${linked.body.submissionId}/revise`, user, withoutLinks);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const after = await AlbumSubmission.findOne({ submissionId: linked.body.submissionId }).lean();
  assert.deepEqual(after.artistSelections, []);
  assert.equal(after.revisions[0].artistSelections.length, 6, "revision history keeps the earlier links");
});

integration("a revision keeps observations for unchanged MBIDs and appends a new snapshot", async () => {
  const user = contributor();
  const created = await call("POST", "/suggestions", user, { ...mixedBody(`Revise ${crypto.randomUUID()}`), requestKey: crypto.randomUUID() });
  const { submissionId } = created.body;
  await applyModerationCommand({ submissionId, actorUserId: MODERATOR, action: "request_changes", body: { reason: "Add another credit", expectedRevision: 1 } });
  const firstObservation = (await AlbumSubmission.findOne({ submissionId }).lean()).artistProposals.find((proposal) => proposal.artistMbid === MBID_NEW).observation;
  lookups.length = 0;
  const body = mixedBody("ignored");
  body.proposedMetadata = { ...created.body.proposedMetadata, artistCredits: [...body.proposedMetadata.artistCredits, { name: "Other", role: "main" }] };
  body.artistProposals = [...body.artistProposals, { proposalKey: "mb-3", kind: "musicbrainz", artistMbid: MBID_OTHER }];
  body.artistSelections = [...body.artistSelections, { position: 7, kind: "proposal", proposalKey: "mb-3" }];
  const revised = await call("POST", `/suggestions/${submissionId}/revise`, user, body);
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.deepEqual(lookups, [MBID_OTHER], "only the newly selected MBID is looked up");
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.currentRevision, 2);
  assert.equal(stored.revisions.length, 2);
  assert.equal(stored.revisions[0].artistSelections.length, 6, "the first snapshot is unchanged");
  assert.equal(stored.revisions[1].artistSelections.length, 7);
  assert.deepEqual(stored.artistProposals.find((proposal) => proposal.artistMbid === MBID_NEW).observation.observedAt, firstObservation.observedAt);
  const withKey = await call("POST", `/suggestions/${submissionId}/revise`, user, { ...body, requestKey: crypto.randomUUID() });
  assert.equal(withKey.status, 409, "a pending suggestion cannot be revised again");
});

// The frontend's own restore-and-resubmit mapping, loaded as plain ESM.
function frontendLinkPayload() {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/features/artists/artistLinkPayload.js"), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

integration("an explicitly shared community proposal is still one artist after a revision round trip", async () => {
  const user = contributor();
  const credits = [{ name: "Shared Band", role: "main" }, { name: "Shared Band (remix)", role: "remixer" }, { name: "Shared Band", role: "featured" }];
  const created = await call("POST", "/suggestions", user, suggestionBody(`Shared ${crypto.randomUUID()}`, credits, {
    artistProposals: [
      { proposalKey: "shared", kind: "community", canonicalName: "Shared Band", evidence: [{ url: "https://example.com/shared-band" }] },
      { proposalKey: "separate", kind: "community", canonicalName: "Shared Band", evidence: [{ url: "https://example.com/other-shared-band" }] },
    ],
    artistSelections: [
      { position: 0, kind: "proposal", proposalKey: "shared" },
      { position: 1, kind: "proposal", proposalKey: "shared" },
      { position: 2, kind: "proposal", proposalKey: "separate" },
    ],
    requestKey: crypto.randomUUID(),
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { submissionId } = created.body;
  await applyModerationCommand({ submissionId, actorUserId: MODERATOR, action: "request_changes", body: { reason: "Fix the title", expectedRevision: 1 } });

  // Revise exactly as the form would: restore links from the owner's detail
  // and map them back to request fields.
  const detail = (await call("GET", `/suggestions/${submissionId}`, user)).body;
  const { artistRequestFields, linksFromSubmission } = await frontendLinkPayload();
  const fields = artistRequestFields(linksFromSubmission(detail));
  assert.deepEqual(fields.artistProposals.map((proposal) => proposal.proposalKey), ["shared", "separate"]);
  const revised = await call("POST", `/suggestions/${submissionId}/revise`, user, {
    proposedMetadata: { ...detail.proposedMetadata, title: `${detail.proposedMetadata.title} (fixed)` },
    supportingSources: detail.supportingSources,
    externalReferences: detail.externalReferences,
    ...fields,
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  const before = await artistCount();
  const approved = await approveRoute(submissionId, { confirmPossibleDuplicate: true, expectedRevision: 2 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const album = await AlbumCatalog.findOne({ albumId: approved.body.album.albumId }).lean();
  assert.equal(album.artistCredits[0].artistId, album.artistCredits[1].artistId, "the shared proposal is one artist");
  assert.notEqual(album.artistCredits[0].artistId, album.artistCredits[2].artistId, "the separate same-name proposal stays its own artist");
  assert.equal(await artistCount(), before + 2);
});

integration("a request-key replay ignores later genre renames and expired edition previews", async () => {
  // Genres: the digest covers the client's genre choice, not the registry
  // name the server resolved it to.
  const genre = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName(`Replay Genre ${crypto.randomUUID().slice(0, 6)}`), origin: { source: "seed" } });
  const user = contributor();
  const body = {
    ...mixedBody(`Genre replay ${crypto.randomUUID()}`),
    proposedGenres: { add: [{ genreId: genre.genreId }], note: "  Context  " },
    requestKey: crypto.randomUUID(),
  };
  const first = await call("POST", "/suggestions", user, body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await Genre.updateOne({ _id: genre._id }, { $set: validateGenreName(`Renamed ${crypto.randomUUID().slice(0, 6)}`) });
  lookups.length = 0;
  const replay = await call("POST", "/suggestions", user, body);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.submissionId, first.body.submissionId);
  assert.equal(lookups.length, 0, "a replay never calls the provider");
  const changedGenre = await call("POST", "/suggestions", user, { ...body, proposedGenres: { add: [{ genreId: genre.genreId }], note: "Different" } });
  assert.equal(changedGenre.status, 409, "a different client genre choice is a different request");
  assert.equal(changedGenre.body.code, "REQUEST_KEY_CONFLICT");

  // Edition previews expire; a saved request must still replay.
  const releaseMbid = crypto.randomUUID();
  const value = {
    releaseMbid, releaseGroupMbid: crypto.randomUUID(), title: `Edition ${crypto.randomUUID()}`, artistDisplayName: "Artist", date: "2026", country: "US", formats: ["CD"],
    disambiguation: "", status: "Official", retrievedAt: new Date(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: "CC0",
    tracks: [{ discNumber: 1, trackNumber: 1, title: "One", durationMs: 1000, artistDisplayName: "Artist", releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID() }],
  };
  const candidate = { ...value, tracklistHash: hashCandidateTracklist(value) };
  const editionUser = contributor();
  const originalPreview = discovery.preview;
  discovery.preview = async () => candidate;
  let preview;
  try {
    preview = await editions.preview({ releaseGroupMbid: candidate.releaseGroupMbid, releaseMbid: candidate.releaseMbid }, editionUser);
  } finally {
    discovery.preview = originalPreview;
  }
  const editionBody = {
    editionPreviewId: preview.previewId,
    proposedMetadata: { title: candidate.title, artistCredits: [{ name: "Artist, Edition" }], releaseType: "album", releaseDate: "2026", coverSourceUrl: "https://example.com/cover.jpg" },
    supportingSources: [{ type: "musicbrainz", url: candidate.sourceUrl }],
    externalReferences: [],
    requestKey: crypto.randomUUID(),
  };
  const editionFirst = await call("POST", "/suggestions", editionUser, editionBody);
  assert.equal(editionFirst.status, 201, JSON.stringify(editionFirst.body));
  await Preview.deleteMany({ previewId: preview.previewId });
  const editionReplay = await call("POST", "/suggestions", editionUser, editionBody);
  assert.equal(editionReplay.status, 200, JSON.stringify(editionReplay.body));
  assert.equal(editionReplay.body.submissionId, editionFirst.body.submissionId);

  // A replay still requires the owner and a valid body shape.
  const otherUser = await call("POST", "/suggestions", contributor(), editionBody);
  assert.equal(otherUser.status, 409, "another contributor's key is not shared; the expired preview blocks a new create");
  assert.equal(otherUser.body.code, "EDITION_PREVIEW_UNAVAILABLE");
  const badShape = await call("POST", "/suggestions", editionUser, { ...editionBody, unexpected: true });
  assert.equal(badShape.status, 400, "the body shape is validated before any replay");
  assert.equal(await AlbumSubmission.countDocuments({ submittedByUserId: editionUser }), 1);
});

// A legacy album written raw, so its credits keep wording a schema write
// would change: a missing role, trailing join text, repeated names, and
// punctuation. 25 credits, past the 20-credit edit limit.
async function rawLegacyAlbum() {
  const credits = Array.from({ length: 25 }, (_, index) => ({ name: `Session Player ${index + 1}`, role: "performer" }));
  credits[0] = { name: "Tyler, the Creator", role: "main" };
  credits[1] = { name: "Alpha & " };
  credits[2] = { name: "Repeat", role: "main" };
  credits[3] = { role: "producer", name: "Repeat" };
  credits[4] = { name: "Already Linked", role: "main", artistId: localArtist.artistId };
  credits[24] = { name: "Last, Credit!", role: "remixer" };
  const albumId = crypto.randomUUID();
  const { insertedId } = await AlbumCatalog.collection.insertOne({
    albumId, title: "Legacy Credits", artistDisplayName: "Tyler, the Creator & Many", artistCredits: credits, releaseType: "album",
    releaseDate: "2020", releaseDatePrecision: "year", releaseYear: 2020, tracks: [], externalReferences: [], catalogSource: "import",
    fieldProvenance: { artistCredits: { source: "import" }, artistDisplayName: { source: "import" } }, catalogRevision: 3,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { _id: insertedId, albumId, credits };
}

function linksBody(albumId, artistLinks, extra = {}) {
  return { albumId, proposedChanges: { artistLinks, ...extra }, supportingSources: [{ type: "other", url: "https://example.com/credits" }] };
}

const LEGACY_LINKS = {
  artistProposals: [
    { proposalKey: "repeat", kind: "community", canonicalName: "Repeat", evidence: [{ url: EVIDENCE }] },
    { proposalKey: "mb-1", kind: "musicbrainz", artistMbid: MBID_NEW },
  ],
  artistSelections: [
    { position: 0, kind: "existing", artistId: localArtist?.artistId },
    { position: 2, kind: "proposal", proposalKey: "repeat" },
    { position: 3, kind: "proposal", proposalKey: "repeat" },
    { position: 24, kind: "proposal", proposalKey: "mb-1" },
  ],
};

integration("identity-only correction links add artists without touching credit wording, roles, order, or display name", async () => {
  LEGACY_LINKS.artistSelections[0].artistId = localArtist.artistId;
  const album = await rawLegacyAlbum();
  const user = contributor();
  // Fresh contributors for refused attempts keep the per-user creation limit free.
  const correct = (body, asUser = contributor()) => call("POST", "/suggestions/corrections", asUser, body);

  // Strict contract.
  const invalid = [
    [{ artistSelections: [{ position: 25, kind: "existing", artistId: localArtist.artistId }] }, "ARTIST_SELECTION_OUT_OF_RANGE"],
    [{ artistSelections: [{ position: 0, kind: "existing", artistId: localArtist.artistId }, { position: 0, kind: "existing", artistId: localArtist.artistId }] }, "DUPLICATE_ARTIST_SELECTION"],
    [{ artistSelections: [{ position: 4, kind: "existing", artistId: localArtist.artistId }] }, "CREDIT_ALREADY_LINKED"],
    [{ artistSelections: Array.from({ length: 21 }, (_, position) => ({ position: position < 4 ? position : position + 1, kind: "existing", artistId: localArtist.artistId })) }, "INVALID_ARTIST_PROPOSAL"],
    [{ artistSelections: [{ position: 0, kind: "existing", artistId: localArtist.artistId, name: "Rewritten" }] }, "INVALID_ARTIST_PROPOSAL"],
  ];
  for (const [links, code] of invalid) {
    const result = await correct(linksBody(album.albumId, links));
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, code, JSON.stringify(result.body));
  }
  const both = await correct(linksBody(album.albumId, LEGACY_LINKS, { artists: { artistDisplayName: "X", artistCredits: [{ name: "X" }] } }));
  assert.equal(both.status, 400);
  assert.match(both.body.error, /cannot replace artists and add artistLinks/);

  // Two corrections: one with links and a title, one title-only partial approval.
  const created = await correct(linksBody(album.albumId, LEGACY_LINKS, { title: "Legacy Credits (Deluxe)" }), user);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { submissionId } = created.body;
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.deepEqual(stored.baseValues.artistLinks.artistCredits, album.credits, "the baseline is the raw stored credits, all 25");
  assert.equal(stored.proposedChanges.artistLinks.artistProposals.find((proposal) => proposal.kind === "musicbrainz").observation.name, "Observed New Artist");
  const mine = await call("GET", "/suggestions/mine", user);
  assert.equal(JSON.stringify(mine.body).includes(EVIDENCE), false, "summaries carry no evidence");
  assert.ok(JSON.stringify((await call("GET", `/suggestions/${submissionId}`, user)).body).includes(EVIDENCE));
  assert.equal((await call("GET", `/suggestions/${submissionId}`, "outsider")).status, 404);
  const detail = await call("GET", `/moderation/album-suggestions/${submissionId}`, MODERATOR);
  assert.equal(detail.body.artistRegistry[localArtist.artistId].name, "Local Artist");
  const queue = await call("GET", "/moderation/album-suggestions?submissionType=catalog_correction", MODERATOR);
  assert.deepEqual(queue.body.suggestions.find((item) => item.submissionId === submissionId).bulkApproval, { eligible: false, reason: "artist_links" });

  const missing = await approveRoute(submissionId, { applyFields: ["artistLinks", "title"] });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "EXPECTED_REVISION_REQUIRED");
  const stale = await approveRoute(submissionId, { applyFields: ["artistLinks", "title"], expectedRevision: 2 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STATE_CONFLICT");

  const before = await artistCount();
  const approved = await approveRoute(submissionId, { applyFields: ["artistLinks", "title"], expectedRevision: 1 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const raw = await AlbumCatalog.collection.findOne({ _id: album._id });
  assert.equal(raw.title, "Legacy Credits (Deluxe)");
  assert.equal(raw.catalogRevision, 4);
  assert.equal(raw.artistDisplayName, "Tyler, the Creator & Many", "the display name is not touched");
  assert.equal(raw.artistCredits.length, 25);
  const selected = new Set([0, 2, 3, 24]);
  raw.artistCredits.forEach((credit, index) => {
    const { artistId, artistMbid, ...wording } = credit;
    if (!selected.has(index)) {
      assert.deepEqual(credit, album.credits[index], `credit ${index} is byte-for-byte unchanged`);
      return;
    }
    assert.deepEqual(wording, album.credits[index], `credit ${index} keeps its wording, role and key order`);
    assert.deepEqual(Object.keys(credit).slice(0, Object.keys(album.credits[index]).length), Object.keys(album.credits[index]));
    assert.ok(artistId);
  });
  assert.equal(raw.artistCredits[0].artistId, localArtist.artistId);
  assert.equal(raw.artistCredits[2].artistId, raw.artistCredits[3].artistId, "an explicitly shared proposal is one artist at both positions");
  assert.equal(raw.artistCredits[24].artistMbid, MBID_NEW);
  assert.equal(await artistCount(), before + await createdArtistCount(submissionId), "only the receipt's created artists were added");
  assert.ok(await createdArtistCount(submissionId) >= 1, "the shared community proposal registered one artist");
  assert.deepEqual(raw.fieldProvenance.artistCredits, { source: "import" }, "credit wording ownership is unchanged");
  assert.deepEqual(raw.fieldProvenance.artistDisplayName, { source: "import" });
  assert.equal(raw.fieldProvenance.artistIdentity.source, "community");
  assert.equal(raw.fieldProvenance.artistIdentity.method, "artist-link-correction");
  assert.deepEqual(raw.fieldProvenance.artistIdentity.positions, [0, 2, 3, 24]);
  assert.equal(raw.fieldProvenance.title.source, "community");
  const receipt = (await AlbumSubmission.findOne({ submissionId }).lean()).approvalReceipt;
  assert.deepEqual(receipt.appliedFields, ["title", "artistLinks"]);
  assert.deepEqual(receipt.artistResolutions.map(({ position }) => position), [0, 2, 3, 24]);
  assert.deepEqual(receipt.artistResolutions.map(({ kind }) => kind), ["existing", "community", "community", "musicbrainz"]);
  assert.equal(JSON.stringify(await Artist.find({}).lean()).includes(EVIDENCE), false, "evidence never reaches the registry");

  const retry = await approveRoute(submissionId, { applyFields: ["title", "artistLinks"], expectedRevision: 1 });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal((await AlbumCatalog.collection.findOne({ _id: album._id })).catalogRevision, 4);
});

integration("a partial correction approval applies only the selected groups and registers no artists", async () => {
  const album = await rawLegacyAlbum();
  const user = contributor();
  const created = await call("POST", "/suggestions/corrections", user, linksBody(album.albumId, {
    artistProposals: [{ proposalKey: "new-1", kind: "community", canonicalName: "Only If Applied", evidence: [{ url: "https://example.com/only" }] }],
    artistSelections: [{ position: 1, kind: "proposal", proposalKey: "new-1" }],
  }, { title: "Partial Title" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const before = await artistCount();
  const approved = await approveRoute(created.body.submissionId, { applyFields: ["title"], expectedRevision: 1 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(await artistCount(), before, "unapplied links publish no artist");
  const raw = await AlbumCatalog.collection.findOne({ _id: album._id });
  assert.deepEqual(raw.artistCredits, album.credits);
  assert.equal(raw.fieldProvenance.artistIdentity, undefined);
  const receipt = (await AlbumSubmission.findOne({ submissionId: created.body.submissionId }).lean()).approvalReceipt;
  assert.deepEqual(receipt.appliedFields, ["title"]);
  assert.deepEqual(receipt.artistResolutions, []);
});

integration("correction links are gated, fail closed while off, and roll back with a stale baseline", async () => {
  const album = await rawLegacyAlbum();
  const user = contributor();
  const links = { artistSelections: [{ position: 1, kind: "existing", artistId: localArtist.artistId }] };
  const created = await call("POST", "/suggestions/corrections", user, linksBody(album.albumId, links));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { submissionId } = created.body;
  process.env.ARTIST_SUGGESTIONS_ENABLED = "false";
  try {
    const refused = await call("POST", "/suggestions/corrections", user, linksBody(album.albumId, links));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "ARTIST_SUGGESTIONS_DISABLED");
    const approval = await approveRoute(submissionId, { applyFields: ["artistLinks"], expectedRevision: 1 });
    assert.equal(approval.status, 503);
    await applyModerationCommand({ submissionId, actorUserId: MODERATOR, action: "request_changes", body: { reason: "Add a source", expectedRevision: 1 } });
    const revise = await call("POST", `/suggestions/${submissionId}/revise`, user, { proposedChanges: { title: "Only a title now" }, supportingSources: [{ type: "other", url: "https://example.com/c" }] });
    assert.equal(revise.status, 503, "a correction with links cannot be revised while linking is off");
    assert.equal((await AlbumSubmission.findOne({ submissionId }).lean()).proposedChanges.artistLinks.artistSelections.length, 1);
  } finally {
    process.env.ARTIST_SUGGESTIONS_ENABLED = "true";
  }
  const revised = await call("POST", `/suggestions/${submissionId}/revise`, user, { proposedChanges: { artistLinks: links }, supportingSources: [{ type: "other", url: "https://example.com/c" }] });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));

  // Someone else writes the credits without changing the revision; the raw
  // baseline still catches it.
  await AlbumCatalog.collection.updateOne({ _id: album._id }, { $set: { "artistCredits.1.name": "Alpha &" } });
  const before = await artistCount();
  const conflict = await approveRoute(submissionId, { applyFields: ["artistLinks"], expectedRevision: 2 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "CATALOG_CHANGED");
  assert.equal(await artistCount(), before);
  assert.equal((await AlbumSubmission.findOne({ submissionId }).lean()).status, "pending");
});

async function pendingLinked(title) {
  const created = await call("POST", "/suggestions", contributor(), { ...mixedBody(title), requestKey: crypto.randomUUID() });
  assert.equal(created.status, 201);
  return created.body.submissionId;
}

// Artists an approval registered, from its receipt (an MBID registered by an
// earlier test is reused, not created).
async function createdArtistCount(submissionId) {
  const receipt = (await AlbumSubmission.findOne({ submissionId }).lean()).approvalReceipt;
  return new Set(receipt.artistResolutions.filter((entry) => entry.outcome === "created").map((entry) => entry.artistId)).size;
}

async function assertUntouched(submissionId, artistsBefore) {
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.status, "pending");
  assert.equal(stored.approvalReceipt, undefined);
  assert.equal(stored.moderationHistory.length, 1);
  assert.equal(await artistCount(), artistsBefore, "no artist survives the failed approval");
  assert.equal(await AlbumCatalog.countDocuments({ title: stored.proposedMetadata.title }), 0);
}

integration("a failure at every write boundary rolls back artists, album, transition, and audit together", async () => {
  const boundaries = [
    ["artist registration", Artist, "create"],
    ["album publication", AlbumCatalog, "create"],
    ["submission transition", AlbumSubmission, "findOneAndUpdate"],
    ["notification", Notification, "updateOne"],
  ];
  for (const [name, Model, method] of boundaries) {
    const submissionId = await pendingLinked(`Boundary ${name} ${crypto.randomUUID()}`);
    const before = await artistCount();
    const original = Model[method];
    let armed = true;
    Model[method] = function failingWrite(...args) {
      if (armed) {
        armed = false;
        return Promise.reject(new Error(`forced ${name} failure`));
      }
      return original.apply(this, args);
    };
    try {
      await assert.rejects(
        approveAlbumSubmission({ submissionId, actorUserId: MODERATOR, expectedRevision: 1, confirmPossibleDuplicate: true }),
        new RegExp(`forced ${name} failure`),
      );
    } finally {
      Model[method] = original;
    }
    assert.equal(armed, false, `${name} was reached`);
    await assertUntouched(submissionId, before);
    const recovered = await approveAlbumSubmission({ submissionId, actorUserId: MODERATOR, expectedRevision: 1, confirmPossibleDuplicate: true });
    assert.equal(recovered.idempotent, false, `${name}: the same approval succeeds afterwards`);
    assert.equal(await artistCount(), before + await createdArtistCount(submissionId));
  }
});

integration("concurrent approvals of one artist-linked suggestion publish once", async () => {
  const submissionId = await pendingLinked(`Concurrent ${crypto.randomUUID()}`);
  const before = await artistCount();
  const results = await Promise.allSettled([
    approveAlbumSubmission({ submissionId, actorUserId: MODERATOR, expectedRevision: 1, confirmPossibleDuplicate: true }),
    approveAlbumSubmission({ submissionId, actorUserId: "second-moderator", expectedRevision: 1, confirmPossibleDuplicate: true }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  results.filter((result) => result.status === "rejected").forEach((result) => assert.equal(result.reason.status, 409, result.reason.message));
  assert.ok(fulfilled.length >= 1);
  assert.equal(new Set(fulfilled.map((result) => result.album.albumId)).size, 1);
  assert.equal(fulfilled.filter((result) => !result.idempotent).length, 1);
  assert.equal(await artistCount(), before + await createdArtistCount(submissionId), "artists are registered once");
  assert.equal(await createdArtistCount(submissionId), 2, "two community artists; the MusicBrainz artists are reused");
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.moderationHistory.filter((event) => event.action === "approved").length, 1);
  assert.equal(await AlbumCatalog.countDocuments({ title: stored.proposedMetadata.title }), 1);
});

// Pauses an approval between its preliminary read and its transaction.
function pauseNextSessionStart() {
  const original = mongoose.startSession;
  let signalEntered;
  let release;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  mongoose.startSession = async function pausedStartSession(...args) {
    mongoose.startSession = original;
    signalEntered();
    await released;
    return original.apply(mongoose, args);
  };
  return { entered, release, restore: () => { mongoose.startSession = original; } };
}

// Moderator A reviews correction revision 1 and pauses after the preliminary
// read. Moderator B requests changes, the contributor revises, and B approves
// revision 2. A must get APPROVAL_CONFLICT, not idempotent success.
integration("a stale correction approval conflicts when another moderator approved a later revision", async () => {
  const target = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Correction Race", artistDisplayName: "Artist", artistCredits: [{ name: "Artist", role: "main" }],
    releaseType: "album", releaseDate: "2020", releaseDatePrecision: "year", releaseYear: 2020, label: "Old label", catalogRevision: 1,
  });
  const payload = normalizeCorrectionPayload({ albumId: target.albumId, proposedChanges: { title: "Race Title" }, supportingSources: [{ type: "official_label", url: "https://example.com/c" }] }, target);
  const submittedAt = new Date();
  const correction = await AlbumSubmission.create({
    submissionId: crypto.randomUUID(), submittedByUserId: "correction-contributor", submissionType: "catalog_correction",
    targetAlbumCatalogId: payload.targetAlbumCatalogId, baseCatalogRevision: payload.baseCatalogRevision, baseValues: payload.baseValues,
    baseProvenance: payload.baseProvenance, proposedChanges: payload.proposedChanges, supportingSources: payload.supportingSources,
    externalReferences: [], normalizedFingerprint: payload.normalizedFingerprint, status: "pending", currentRevision: 1,
    revisions: [correctionSnapshot(payload, submittedAt, 1)],
    moderationHistory: [{ actorUserId: "correction-contributor", action: "submitted", reason: "", createdAt: submittedAt }],
  });
  const { submissionId } = correction;
  const pause = pauseNextSessionStart();
  let outcome;
  try {
    const stale = approveAlbumSubmission({ submissionId, actorUserId: "moderator-a", expectedRevision: 1, applyFields: ["title"] })
      .then((result) => ({ result }), (error) => ({ error }));
    await pause.entered;
    await applyModerationCommand({ submissionId, actorUserId: "moderator-b", action: "request_changes", body: { reason: "Also fix the label", expectedRevision: 1 } });
    const next = normalizeCorrectionPayload({ albumId: target.albumId, proposedChanges: { title: "Race Title", label: "New label" }, supportingSources: [{ type: "official_label", url: "https://example.com/c" }] }, target);
    const revisedAt = new Date();
    await AlbumSubmission.findOneAndUpdate(
      { submissionId, status: "needs_changes", currentRevision: 1 },
      {
        $set: { status: "pending", currentRevision: 2, proposedChanges: next.proposedChanges, baseValues: next.baseValues, baseProvenance: next.baseProvenance, normalizedFingerprint: next.normalizedFingerprint },
        $push: { revisions: correctionSnapshot(next, revisedAt, 2), moderationHistory: { actorUserId: "correction-contributor", action: "revised", reason: "", createdAt: revisedAt } },
      },
      { runValidators: true },
    );
    const winner = await approveAlbumSubmission({ submissionId, actorUserId: "moderator-b", expectedRevision: 2, applyFields: ["title", "label"] });
    assert.equal(winner.idempotent, false);
    pause.release();
    outcome = await stale;
  } finally {
    pause.restore();
  }
  assert.equal(outcome.result, undefined, "the stale approval must not report success");
  assert.equal(outcome.error.code, "APPROVAL_CONFLICT");
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.approvalReceipt.revision, 2);
  assert.deepEqual(stored.approvalReceipt.appliedFields, ["title", "label"]);
  assert.equal(stored.moderationHistory.filter((event) => event.action === "approved").length, 1);
  const album = await AlbumCatalog.findById(target._id).lean();
  assert.equal(album.label, "New label");
  assert.equal(album.catalogRevision, 2);
});
