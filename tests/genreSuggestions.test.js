const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const AlbumSubmission = require("../models/AlbumSubmission");
const { normalizeGenreSuggestion, parseRequest } = require("../lib/genres/suggestions");
const { serializeSubmission } = require("../routes/utils/submissions");
const { validateGenreName } = require("../lib/genres/vocabulary");

function genre(name, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    genreId: crypto.randomUUID(),
    ...validateGenreName(name),
    aliases: [],
    parent: null,
    status: "active",
    ...overrides,
  };
}

const hipHop = genre("Hip hop", { aliases: [{ name: "Rap", ...validateGenreName("Rap") }] });
const jazz = genre("Jazz");
const jazzRap = genre("Jazz rap", { parent: hipHop._id });
const soul = genre("Soul");
const funk = genre("Funk");
const disco = genre("Disco");
const vaporwave = genre("Vaporwave", { status: "retired" });
const ALL = [hipHop, jazz, jazzRap, soul, funk, disco, vaporwave];

// Answers the three query shapes the normalizer issues.
const GenreModel = {
  find(query) {
    let rows;
    if (query._id) rows = ALL.filter((row) => query._id.$in.map(String).includes(String(row._id)));
    else if (query.genreId) rows = ALL.filter((row) => query.genreId.$in.includes(row.genreId));
    else {
      const keys = query.$or[0].normalizedName.$in;
      rows = ALL.filter((row) => keys.includes(row.normalizedName) || row.aliases.some((alias) => keys.includes(alias.normalizedName)));
    }
    return { lean: async () => rows };
  },
};

function album(genres = [], overrides = {}) {
  return { _id: new mongoose.Types.ObjectId(), albumId: crypto.randomUUID(), genres: genres.map((row) => row._id), ...overrides };
}

function normalize(body, target) {
  return normalizeGenreSuggestion({ albumId: target.albumId, ...body }, target, { GenreModel });
}

async function rejects(promise, pattern, code = "INVALID_SUBMISSION") {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("the request shape rejects unknown fields and ambiguous entries", () => {
  assert.throws(() => parseRequest({ albumId: "x", tags: [] }), /request body.tags is not allowed/);
  assert.throws(() => parseRequest({ add: [{ genreId: jazz.genreId, newGenre: { name: "X" } }] }), /exactly one/);
  assert.throws(() => parseRequest({ add: [{}] }), /exactly one/);
  assert.throws(() => parseRequest({ add: [{ newGenre: { name: "Lo-fi", colour: "red" } }] }), /newGenre.colour is not allowed/);
  assert.throws(() => parseRequest({ add: [{ newGenre: { name: "<b>" } }] }), /may contain/);
  assert.throws(() => parseRequest({ remove: [jazz.genreId, jazz.genreId] }), /more than once/);
  assert.throws(() => parseRequest({ add: Array.from({ length: 6 }, () => ({ genreId: jazz.genreId })) }), /at most 5/);
  assert.throws(() => parseRequest({ note: "x".repeat(501) }), /500 characters/);
  assert.throws(() => parseRequest({ primaryGenreId: jazz.genreId, add: [{ genreId: soul.genreId, primary: true }] }), /not both/);
});

test("additions, removals, and a new genre build the stored suggestion and baseline", async () => {
  const target = album([hipHop, soul], { genresRevision: 4 });
  const payload = await normalize({
    add: [{ genreId: jazzRap.genreId, primary: true }, { newGenre: { name: " Lo-fi  hip hop ", parentGenreId: hipHop.genreId } }],
    remove: [soul.genreId],
    note: "  Sample-heavy  ",
  }, target);

  assert.deepEqual(payload.genreBaseline, {
    genres: [{ genreId: hipHop.genreId, slug: "hip-hop", name: "Hip hop" }, { genreId: soul.genreId, slug: "soul", name: "Soul" }],
    genresRevision: 4,
  });
  assert.deepEqual(payload.genreChanges, {
    additions: [
      { genre: { genreId: jazzRap.genreId, slug: "jazz-rap", name: "Jazz rap" }, newGenre: null },
      { genre: null, newGenre: { name: "Lo-fi hip hop", normalizedName: "lo fi hip hop", slug: "lo-fi-hip-hop", parent: { genreId: hipHop.genreId, slug: "hip-hop", name: "Hip hop" } } },
    ],
    removals: [{ genreId: soul.genreId, slug: "soul", name: "Soul" }],
    primary: { genre: null, addIndex: 0 },
    note: "Sample-heavy",
  });
  assert.deepEqual(payload.resolvedNewGenres, []);
  assert.equal(payload.targetAlbumCatalogId, target._id);
  assert.match(payload.normalizedFingerprint, /^[0-9a-f]{64}$/);

  // The stored shape validates against the submission model.
  const submission = new AlbumSubmission({
    submittedByUserId: "user-1",
    submissionType: "genre_suggestion",
    targetAlbumCatalogId: payload.targetAlbumCatalogId,
    genreBaseline: payload.genreBaseline,
    genreChanges: payload.genreChanges,
    normalizedFingerprint: payload.normalizedFingerprint,
    openGenreSuggestionKey: `user-1:${target._id}`,
  });
  assert.equal(submission.validateSync(), undefined);
  // ...and serializes with the API's add/remove names and no internal ids.
  const serialized = serializeSubmission(submission);
  assert.equal(serialized.submissionType, "genre_suggestion");
  assert.deepEqual(serialized.genreChanges.add[1], { newGenre: { name: "Lo-fi hip hop", slug: "lo-fi-hip-hop", parent: { genreId: hipHop.genreId, slug: "hip-hop", name: "Hip hop" } } });
  assert.deepEqual(serialized.genreChanges.remove.map((row) => row.slug), ["soul"]);
  assert.deepEqual(serialized.genreChanges.primary, { addIndex: 0 });
  assert.equal(JSON.stringify(serialized).includes(String(hipHop._id)), false);
  assert.equal("openGenreSuggestionKey" in serialized, false);
});

test("a proposed name that already exists becomes a reference to that genre", async () => {
  const payload = await normalize({ add: [{ newGenre: { name: "rap" } }, { newGenre: { name: "JAZZ" } }] }, album());
  assert.deepEqual(payload.genreChanges.additions.map((entry) => entry.genre?.slug), ["hip-hop", "jazz"]);
  assert.deepEqual(payload.resolvedNewGenres.map(({ name, matchedBy, genre: match }) => [name, matchedBy, match.slug]), [
    ["rap", "alias", "hip-hop"],
    ["JAZZ", "name", "jazz"],
  ]);
  await rejects(normalize({ add: [{ newGenre: { name: "Vaporwave" } }] }, album()), /retired genre "Vaporwave"/, "GENRE_RETIRED");
  // Resolution can reveal a repeat the contributor didn't type twice.
  await rejects(normalize({ add: [{ genreId: hipHop.genreId }, { newGenre: { name: "Rap" } }] }, album()), /repeats another addition/);
});

test("references must be active, fit the album, and change something", async () => {
  const target = album([hipHop, soul]);
  await rejects(normalize({ add: [{ genreId: crypto.randomUUID() }] }, target), /does not match a genre/);
  await rejects(normalize({ add: [{ genreId: vaporwave.genreId }] }, target), /retired genre/, "GENRE_RETIRED");
  await rejects(normalize({ add: [{ genreId: hipHop.genreId }] }, target), /already on this album/);
  await rejects(normalize({ add: [{ genreId: jazz.genreId }], remove: [jazz.genreId] }, target), /also in remove/);
  await rejects(normalize({ remove: [jazz.genreId] }, target), /not one of this album's genres/);
  await rejects(normalize({ add: [{ newGenre: { name: "Lo-fi", parentGenreId: jazzRap.genreId } }] }, target), /top-level genre/);
  await rejects(normalize({}, target), /does not change/);
  await rejects(normalize({ primaryGenreId: hipHop.genreId }, target), /does not change/);
  await rejects(normalize({ primaryGenreId: jazz.genreId }, target), /keeps or gains/);
  await rejects(normalize({ primaryGenreId: soul.genreId, remove: [soul.genreId] }, target), /keeps or gains/);
  await rejects(normalize({ add: [{ newGenre: { name: "Aa" } }, { newGenre: { name: "Bb" } }, { newGenre: { name: "Cc" } }] }, target), /at most 2 new genres/);
  await rejects(normalizeGenreSuggestion({ albumId: crypto.randomUUID(), add: [{ genreId: jazz.genreId }] }, target, { GenreModel }), /does not match the target/);
});

test("promotions, retired removals, and the five-genre cap", async () => {
  const target = album([hipHop, soul, vaporwave]);
  const promoted = await normalize({ primaryGenreId: soul.genreId }, target);
  assert.deepEqual(promoted.genreChanges.primary, { genre: { genreId: soul.genreId, slug: "soul", name: "Soul" }, addIndex: null });
  assert.equal(promoted.genreBaseline.genresRevision, 0);

  const promotedAddition = await normalize({ add: [{ genreId: jazz.genreId }], primaryGenreId: jazz.genreId }, target);
  assert.deepEqual(promotedAddition.genreChanges.primary, { genre: null, addIndex: 0 });

  // A retired genre can be removed even though it can't be added.
  const cleaned = await normalize({ remove: [vaporwave.genreId] }, target);
  assert.deepEqual(cleaned.genreChanges.removals.map((row) => row.slug), ["vaporwave"]);

  // The retired genre is hidden from the album, so it doesn't count toward the cap.
  const filled = await normalize({ add: [{ genreId: jazz.genreId }, { genreId: funk.genreId }, { genreId: disco.genreId }] }, target);
  assert.equal(filled.genreChanges.additions.length, 3);
  const fourMore = { add: [{ genreId: jazz.genreId }, { genreId: funk.genreId }, { genreId: disco.genreId }, { genreId: jazzRap.genreId }] };
  await rejects(normalize(fourMore, target), /at most 5 genres; this would leave 6/, "GENRE_LIMIT_EXCEEDED");
  await rejects(normalize({ ...fourMore, remove: [vaporwave.genreId] }, target), /this would leave 6/, "GENRE_LIMIT_EXCEEDED");
  const swapped = await normalize({ ...fourMore, remove: [soul.genreId] }, target);
  assert.equal(swapped.genreChanges.additions.length, 4);

  // The primary is the first active genre, so promoting it past a retired one changes nothing.
  await rejects(normalize({ primaryGenreId: soul.genreId }, album([vaporwave, soul])), /does not change/);
});

// The type rules live in a pre("validate") hook, which validateSync skips.
async function validationErrors(document) {
  try {
    await document.validate();
    return {};
  } catch (error) {
    return error.errors;
  }
}

test("the submission model requires genre fields and keeps sources optional only for genres", async () => {
  const base = { submittedByUserId: "user-1", normalizedFingerprint: "f".repeat(64) };
  const genreErrors = await validationErrors(new AlbumSubmission({ ...base, submissionType: "genre_suggestion" }));
  assert.ok(genreErrors.targetAlbumCatalogId && genreErrors.genreChanges && genreErrors.genreBaseline);
  assert.equal(genreErrors.supportingSources, undefined);
  const correctionErrors = await validationErrors(new AlbumSubmission({ ...base, submissionType: "catalog_correction" }));
  assert.match(correctionErrors.supportingSources.message, /One to ten sources/);
});

test("album proposals validate optional genres with the shared vocabulary rules", async (t) => {
  const { normalizeAlbumGenreProposal } = require("../lib/genres/albumSuggestions");
  const previous = process.env.GENRES_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.GENRES_ENABLED; else process.env.GENRES_ENABLED = previous; });
  process.env.GENRES_ENABLED = "true";
  const normalize = (body) => normalizeAlbumGenreProposal(body, { GenreModel });
  assert.equal(await normalize(undefined), null);
  const changes = await normalize({ add: [{ newGenre: { name: "Rap" } }, { newGenre: { name: "Cloud jazz", parentGenreId: jazz.genreId }, primary: true }], note: " Private context " });
  assert.equal(changes.additions[0].genre.genreId, hipHop.genreId);
  assert.equal(changes.additions[1].newGenre.parent.genreId, jazz.genreId);
  assert.deepEqual(changes.primary, { genre: null, addIndex: 1 });
  assert.equal(changes.note, "Private context");
  for (const key of ["albumId", "remove", "primaryGenreId", "status", "targetAlbumCatalogId"]) {
    await rejects(normalize({ add: [{ genreId: jazz.genreId }], [key]: "forged" }), /not allowed/);
  }
  await rejects(normalize({ add: [] }), /does not change/);
  await rejects(normalize({ add: [{ genreId: jazz.genreId }, { newGenre: { name: "Jazz" } }] }), /repeats/);
  await rejects(normalize({ add: [{ genreId: vaporwave.genreId }] }), /retired/, "GENRE_RETIRED");
  await rejects(normalize({ add: [{ newGenre: { name: "<script>" } }] }), /name/);
  await rejects(normalize({ add: ["Cloud jazz", "Space funk", "Moon disco"].map((name) => ({ newGenre: { name } })) }), /at most 2/);
  await rejects(normalize({ add: Array(6).fill({ genreId: jazz.genreId }) }), /at most 5/);
  await rejects(normalize({ add: [{ genreId: jazz.genreId }], note: "x".repeat(501) }), /500/);
  process.env.GENRES_ENABLED = "false";
  await rejects(normalize({ add: [{ genreId: jazz.genreId }] }), /disabled/, "GENRES_DISABLED");
  assert.equal(await normalize(undefined), null);
});

test("album proposal serialization preserves private genre snapshots and public linked IDs", () => {
  const { snapshotForSubmission, serializeApprovedFeedItem } = require("../routes/utils/submissions");
  const genreChanges = { additions: [{ genre: { genreId: jazz.genreId, name: jazz.name, slug: jazz.slug, _id: jazz._id } }], removals: [], primary: null, note: "Private moderator note" };
  const source = { submissionType: "new_album", genreChanges, sourceAlbumSubmissionId: crypto.randomUUID(), linkedGenreSubmissionId: crypto.randomUUID() };
  const snapshot = snapshotForSubmission(source, { fingerprint: "f".repeat(64), duplicateSignals: [] }, new Date(), 1);
  assert.deepEqual(snapshot.genreChanges, genreChanges);
  const serialized = serializeSubmission({ ...source, revisions: [snapshot] }, { detail: true });
  assert.equal(serialized.proposedGenres.note, genreChanges.note);
  assert.equal(serialized.revisions[0].proposedGenres.add[0].genre.genreId, jazz.genreId);
  assert.equal(serialized.linkedGenreSubmissionId, source.linkedGenreSubmissionId);
  assert.equal("_id" in serialized.proposedGenres.add[0].genre, false);
  const feed = serializeApprovedFeedItem({ ...source, submissionId: crypto.randomUUID(), status: "approved", approvedAt: new Date(), approvalPublicationType: "catalog_created", approvedAlbumCatalogId: { albumId: crypto.randomUUID(), title: "Album", artistDisplayName: "Artist" } });
  assert.equal("proposedGenres" in feed, false);
  assert.equal("linkedGenreSubmissionId" in feed, false);
  assert.equal(JSON.stringify(feed).includes("Private moderator note"), false);
});

test("new-name quota persistence fails closed without transactions but leaves existing-genre writes lightweight", async (t) => {
  const AccountFence = require("../models/AccountFence");
  const { withNewGenreAllowance } = require("../lib/genres/suggestions");
  let writes = 0;
  const operation = async (session) => { assert.equal(session, null); writes += 1; return "saved"; };
  assert.equal(await withNewGenreAllowance("user", { genreChanges: { additions: [{ genre: { genreId: jazz.genreId } }] } }, operation), "saved");
  t.mock.method(AccountFence, "init", async () => {});
  t.mock.method(mongoose, "startSession", async () => ({
    withTransaction: async () => { throw Object.assign(new Error("Transaction numbers are only allowed on a replica set"), { code: 20 }); },
    endSession: async () => {},
  }));
  await assert.rejects(withNewGenreAllowance("user", { genreChanges: { additions: [{ newGenre: { name: "Cloud scene" } }] } }, operation), (error) => error.status === 503 && error.code === "GENRE_SUBMISSION_UNAVAILABLE");
  assert.equal(writes, 1, "the new-name proposal has no non-transactional write fallback");
});
