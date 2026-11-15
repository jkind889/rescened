const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const Artist = require("../models/Artist");
const Notification = require("../models/Notification");
const { Genre, GenreEvent } = require("../models/Genre");
const { validateGenreName } = require("../lib/genres/vocabulary");
const { genreSuggestionFields, genreSuggestionSnapshot, normalizeGenreSuggestion } = require("../lib/genres/suggestions");
const { artistMbidOf } = require("../lib/artists/identity");
const { resolveArtistSelections } = require("../lib/artists/proposals");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const { applyModerationCommand } = require("../routes/utils/moderationCommands");
const { createWithRequestKey, payloadDigest, requestKeyFields } = require("../routes/utils/requestKeys");
const {
  correctionSnapshot,
  findDuplicateSignals,
  normalizeCorrectionPayload,
  normalizeSubmissionPayload,
  snapshotForSubmission,
} = require("../routes/utils/submissions");

const integrationEnabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const DB_NAME = "rescened_artist_proposals";
const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "83096042-3785-481e-8843-dee69f1aad12";
const OBSERVED_AT = new Date("2026-11-15T12:00:00.000Z");
let replSet;

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: DB_NAME });
  await Promise.all([AlbumCatalog, AlbumSubmission, Artist, Notification, Genre, GenreEvent].map((model) => model.syncIndexes()));
}

async function teardown() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
}

function mbProposal(proposalKey, mbid, name) {
  return {
    proposalKey,
    kind: "musicbrainz",
    artistMbid: mbid,
    observation: { artistMbid: mbid, name, sortName: "", disambiguation: "", type: "", observedAt: OBSERVED_AT },
  };
}

function communityProposal(proposalKey, canonicalName) {
  return { proposalKey, kind: "community", canonicalName, evidence: [{ url: `https://example.com/${proposalKey}`, description: "" }] };
}

function select(position, proposalKey) {
  return { position, kind: "proposal", proposalKey };
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function communityArtistsWithoutReferencesTest() {
  const result = await inTransaction((session) => resolveArtistSelections({
    credits: [{ name: "Nova", role: "main" }, { name: "Nova", role: "featured" }, { name: "Echo" }],
    proposals: [communityProposal("nova-1", "Nova"), communityProposal("nova-2", "Nova"), communityProposal("echo", "Echo")],
    selections: [select(0, "nova-1"), select(1, "nova-2"), select(2, "echo")],
  }, { Artist, session, provenance: { source: "community", submissionId: "integration" } }));

  const stored = await Artist.find({ artistId: { $in: result.credits.map((credit) => credit.artistId) } }).lean();
  assert.equal(stored.length, 3, "artists without external references do not collide on the MBID index");
  assert.ok(stored.every((artist) => artist.externalReferences.length === 0 && artist.artistSource === "community"));
  assert.equal(stored.filter((artist) => artist.name === "Nova").length, 2, "same-name community artists stay distinct");
  assert.ok(stored.every((artist) => artist.fieldProvenance.name.nameSource === "community-proposal"));
  assert.deepEqual(result.credits.map(({ name, role }) => ({ name, role })), [
    { name: "Nova", role: "main" }, { name: "Nova", role: "featured" }, { name: "Echo", role: undefined },
  ]);
}

async function rollbackAfterArtistCreationTest() {
  const before = await Artist.countDocuments();
  const failure = new Error("a later approval write failed");
  await assert.rejects(inTransaction(async (session) => {
    const resolved = await resolveArtistSelections({
      credits: [{ name: "Rolled Back MB" }, { name: "Rolled Back Community" }],
      proposals: [mbProposal("mb", MBID_B, "Rolled Back MB"), communityProposal("c", "Rolled Back Community")],
      selections: [select(0, "mb"), select(1, "c")],
    }, { Artist, session });
    assert.equal(resolved.createdArtists.length, 2);
    assert.equal(await Artist.countDocuments({ name: /^Rolled Back/ }).session(session), 2, "visible inside the transaction");
    throw failure;
  }), (error) => error === failure);
  assert.equal(await Artist.countDocuments(), before, "no artist survives the aborted transaction");
  assert.equal(await Artist.countDocuments({ "externalReferences.externalId": MBID_B }), 0);
}

// Transaction A registers an MBID but has not committed. Transaction B
// attempts the same registration, hits a transient write conflict, and is
// retried by withTransaction after A commits; the retry reuses A's artist.
async function exactMbidRegistrationRaceTest() {
  const sessionA = await mongoose.startSession();
  const sessionB = await mongoose.startSession();
  try {
    sessionA.startTransaction();
    const first = await resolveArtistSelections({
      credits: [{ name: "Racer (A)" }],
      proposals: [mbProposal("mb", MBID_A, "Racer")],
      selections: [select(0, "mb")],
    }, { Artist, session: sessionA });
    assert.equal(first.resolutions[0].outcome, "created");

    let signalFirstAttempt;
    const firstAttemptFailed = new Promise((resolve) => { signalFirstAttempt = resolve; });
    let attempts = 0;
    let second;
    const runB = sessionB.withTransaction(async () => {
      attempts += 1;
      try {
        second = await resolveArtistSelections({
          credits: [{ name: "Racer (B)" }],
          proposals: [mbProposal("mb", MBID_A, "Racer")],
          selections: [select(0, "mb")],
        }, { Artist, session: sessionB });
      } catch (error) {
        if (attempts === 1) signalFirstAttempt(error);
        throw error;
      }
    });
    const conflict = await firstAttemptFailed;
    assert.ok(conflict.hasErrorLabel?.("TransientTransactionError"), `expected a transient conflict, got ${conflict.code} ${conflict.message}`);
    await sessionA.commitTransaction();
    await runB;

    assert.ok(attempts >= 2);
    assert.equal(second.resolutions[0].outcome, "reused");
    assert.equal(second.credits[0].artistId, first.credits[0].artistId);
    assert.equal(second.credits[0].name, "Racer (B)");
    const registered = await Artist.find({ "externalReferences.externalId": MBID_A }).lean();
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "Racer");
  } finally {
    if (sessionA.inTransaction()) await sessionA.abortTransaction();
    await sessionA.endSession();
    await sessionB.endSession();
  }
}

async function concurrentRegistrationBurstTest() {
  const mbid = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => inTransaction((session) => resolveArtistSelections({
    credits: [{ name: `Burst ${index}` }],
    proposals: [mbProposal("mb", mbid, "Burst")],
    selections: [select(0, "mb")],
  }, { Artist, session }))));
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
  const rejected = attempts.filter((attempt) => attempt.status === "rejected").map((attempt) => attempt.reason);
  assert.ok(fulfilled.length >= 1);
  rejected.forEach((error) => assert.equal(error.details?.[0]?.code, "ARTIST_REGISTRATION_RACE", error.message));
  const registered = await Artist.find({ "externalReferences.externalId": mbid }).lean();
  assert.equal(registered.length, 1, "one registry artist per exact MBID");
  assert.ok(fulfilled.every((value) => value.credits[0].artistId === registered[0].artistId));
  assert.equal(artistMbidOf(registered[0]), mbid);
}

async function createSubmission(title) {
  const payload = normalizeSubmissionPayload({
    proposedMetadata: { title, artistCredits: [{ name: "Receipt Artist" }], releaseType: "album", releaseDate: "2026", coverSourceUrl: "https://example.com/cover.jpg" },
    supportingSources: [{ type: "other", url: "https://example.com/evidence" }],
    externalReferences: [],
  });
  const duplicate = await findDuplicateSignals(payload);
  const submittedAt = new Date();
  return AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "receipt-user",
    proposedMetadata: payload.proposedMetadata,
    supportingSources: payload.supportingSources,
    externalReferences: payload.externalReferences,
    normalizedFingerprint: duplicate.fingerprint,
    candidateAlbumCatalogId: duplicate.candidateAlbumCatalogId,
    candidateSubmissionIds: duplicate.candidateSubmissionIds,
    duplicateSignals: duplicate.duplicateSignals,
    status: "pending",
    currentRevision: 1,
    revisions: [snapshotForSubmission(payload, duplicate, submittedAt, 1)],
    moderationHistory: [{ actorUserId: "receipt-user", action: "submitted", reason: "", createdAt: submittedAt }],
  });
}

async function approvalReceiptAndRevisionGuardTest() {
  const submission = await createSubmission(`Receipt Album ${crypto.randomUUID()}`);
  const { submissionId } = submission;

  await assert.rejects(
    approveAlbumSubmission({ submissionId, actorUserId: "moderator", expectedRevision: 2, coverResolver: null }),
    (error) => error.code === "STATE_CONFLICT",
  );
  let stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.status, "pending");
  assert.equal(stored.approvalReceipt, undefined);

  const approved = await approveAlbumSubmission({ submissionId, actorUserId: "moderator", expectedRevision: 1, coverResolver: null });
  assert.equal(approved.idempotent, false);
  stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.approvalReceipt.revision, 1);
  assert.equal(stored.approvalReceipt.publicationType, "catalog_created");
  assert.equal(stored.approvalReceipt.targetAlbumId, approved.album.albumId);
  assert.deepEqual(stored.approvalReceipt.artistResolutions, []);
  assert.equal("approvalReceipt" in approved.suggestion, false, "receipts stay internal");

  const retry = await approveAlbumSubmission({ submissionId, actorUserId: "moderator", expectedRevision: 1 });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.album.albumId, approved.album.albumId);
  await assert.rejects(
    approveAlbumSubmission({ submissionId, actorUserId: "moderator", expectedRevision: 2 }),
    (error) => error.code === "APPROVAL_CONFLICT",
  );
  stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.moderationHistory.filter((event) => event.action === "approved").length, 1);
  assert.equal(await AlbumCatalog.countDocuments({ title: stored.proposedMetadata.title }), 1);
}

async function correctionReceiptTest() {
  const target = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Receipt Correction Target",
    artistDisplayName: "Receipt Artist",
    artistCredits: [{ name: "Receipt Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2020",
    releaseDatePrecision: "year",
    releaseYear: 2020,
    tracks: [],
    label: "Original label",
    externalReferences: [],
    fieldProvenance: {},
    catalogSource: "import",
    catalogRevision: 1,
  });
  const payload = normalizeCorrectionPayload({
    albumId: target.albumId,
    proposedChanges: { title: "Receipt Corrected", label: "Corrected label" },
    supportingSources: [{ type: "official_label", url: "https://example.com/correction" }],
  }, target);
  const submittedAt = new Date();
  const correction = await AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "receipt-user",
    submissionType: "catalog_correction",
    targetAlbumCatalogId: payload.targetAlbumCatalogId,
    baseCatalogRevision: payload.baseCatalogRevision,
    baseValues: payload.baseValues,
    baseProvenance: payload.baseProvenance,
    proposedChanges: payload.proposedChanges,
    supportingSources: payload.supportingSources,
    externalReferences: [],
    normalizedFingerprint: payload.normalizedFingerprint,
    status: "pending",
    currentRevision: 1,
    revisions: [correctionSnapshot(payload, submittedAt, 1)],
    moderationHistory: [{ actorUserId: "receipt-user", action: "submitted", reason: "", createdAt: submittedAt }],
  });
  const { submissionId } = correction;
  await approveAlbumSubmission({ submissionId, actorUserId: "moderator", applyFields: ["title"], expectedRevision: 1 });
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.deepEqual(stored.approvalReceipt.appliedFields, ["title"]);
  assert.equal(stored.approvalReceipt.publicationType, "catalog_corrected");
  assert.equal(stored.approvalReceipt.targetAlbumId, target.albumId);

  const retry = await approveAlbumSubmission({ submissionId, actorUserId: "moderator", applyFields: ["title"], expectedRevision: 1 });
  assert.equal(retry.idempotent, true);
  await assert.rejects(
    approveAlbumSubmission({ submissionId, actorUserId: "moderator", applyFields: ["title", "label"] }),
    (error) => error.code === "APPROVAL_CONFLICT",
  );
  const album = await AlbumCatalog.findById(target._id).lean();
  assert.equal(album.label, "Original label");
  assert.equal(album.catalogRevision, 2);
}

async function staleModerationCommandTest() {
  const submission = await createSubmission(`Stale Command ${crypto.randomUUID()}`);
  const { submissionId } = submission;
  await assert.rejects(
    applyModerationCommand({ submissionId, actorUserId: "moderator", action: "request_changes", body: { reason: "Fix", expectedRevision: 2 } }),
    (error) => error.code === "STATE_CONFLICT",
  );
  let stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.status, "pending");
  assert.equal(stored.moderationHistory.length, 1);
  const updated = await applyModerationCommand({ submissionId, actorUserId: "moderator", action: "request_changes", body: { reason: "Fix", expectedRevision: 1 } });
  assert.equal(updated.status, "needs_changes");
  stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.moderationHistory.length, 2);
}

// Holds an approval between its preliminary read and its transaction: every
// approval path reads the submission first, then calls mongoose.startSession.
// Returns { entered, release, restore } for a deterministic interleaving.
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

function settle(promise) {
  return promise.then((result) => ({ result }), (error) => ({ error }));
}

// Moderator A reviews revision 1 and pauses after the preliminary read.
// Moderator B requests changes, the contributor revises, and B approves
// revision 2. A must get APPROVAL_CONFLICT, not idempotent success.
async function staleGenreApprovalRaceTest() {
  const jazz = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName("Race Jazz"), origin: { source: "seed" } });
  const soul = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName("Race Soul"), origin: { source: "seed" } });
  const album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Genre Race Album", artistDisplayName: "Artist" });
  const firstPayload = await normalizeGenreSuggestion({ albumId: album.albumId, add: [{ genreId: jazz.genreId }] }, album);
  const createdAt = new Date();
  const submission = await AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "genre-race-contributor",
    ...genreSuggestionFields(firstPayload, 1, "pending"),
    revisions: [genreSuggestionSnapshot(firstPayload, createdAt, 1)],
    moderationHistory: [{ actorUserId: "genre-race-contributor", action: "submitted", reason: "", createdAt }],
  });
  const { submissionId } = submission;
  const genreDecisions = { add: [{ decision: "apply" }] };

  const pause = pauseNextSessionStart();
  try {
    const stale = settle(approveAlbumSubmission({ submissionId, actorUserId: "moderator-a", expectedRevision: 1, genreDecisions }));
    await pause.entered;
    await applyModerationCommand({ submissionId, actorUserId: "moderator-b", action: "request_changes", body: { reason: "Wrong genre", expectedRevision: 1 } });
    const nextPayload = await normalizeGenreSuggestion({ albumId: album.albumId, add: [{ genreId: soul.genreId }] }, album);
    const revisedAt = new Date();
    await AlbumSubmission.findOneAndUpdate(
      { submissionId, status: "needs_changes", currentRevision: 1 },
      {
        $set: genreSuggestionFields(nextPayload, 2, "pending"),
        $push: {
          revisions: genreSuggestionSnapshot(nextPayload, revisedAt, 2),
          moderationHistory: { actorUserId: "genre-race-contributor", action: "revised", reason: "", createdAt: revisedAt },
        },
      },
      { runValidators: true },
    );
    const winner = await approveAlbumSubmission({ submissionId, actorUserId: "moderator-b", expectedRevision: 2, genreDecisions });
    assert.equal(winner.idempotent, false);
    pause.release();

    const outcome = await stale;
    assert.equal(outcome.result, undefined, `stale approval must not succeed: ${JSON.stringify(outcome.result?.suggestion?.currentRevision)}`);
    assert.equal(outcome.error.code, "APPROVAL_CONFLICT");
  } finally {
    pause.restore();
  }
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.currentRevision, 2);
  assert.equal(stored.moderationHistory.filter((event) => event.action === "approved").length, 1);
  const finalAlbum = await AlbumCatalog.findById(album._id).populate("genres").lean();
  assert.deepEqual(finalAlbum.genres.map((genre) => genre.name), ["Race Soul"]);
}

// The same interleaving for a new-album suggestion.
async function staleNewAlbumApprovalRaceTest() {
  const submission = await createSubmission(`Album Race ${crypto.randomUUID()}`);
  const { submissionId } = submission;
  const pause = pauseNextSessionStart();
  try {
    const stale = settle(approveAlbumSubmission({ submissionId, actorUserId: "moderator-a", expectedRevision: 1, coverResolver: null }));
    await pause.entered;
    await applyModerationCommand({ submissionId, actorUserId: "moderator-b", action: "request_changes", body: { reason: "Fix title", expectedRevision: 1 } });
    const current = await AlbumSubmission.findOne({ submissionId }).lean();
    const revisedAt = new Date();
    const revised = { ...current.revisions[0], revision: 2, submittedAt: revisedAt };
    await AlbumSubmission.findOneAndUpdate(
      { submissionId, status: "needs_changes", currentRevision: 1 },
      {
        $set: { status: "pending", currentRevision: 2 },
        $push: { revisions: revised, moderationHistory: { actorUserId: "receipt-user", action: "revised", reason: "", createdAt: revisedAt } },
      },
      { runValidators: true },
    );
    const winner = await approveAlbumSubmission({ submissionId, actorUserId: "moderator-b", expectedRevision: 2, coverResolver: null });
    assert.equal(winner.idempotent, false);
    pause.release();

    const outcome = await stale;
    assert.equal(outcome.result, undefined, "stale approval must not succeed");
    assert.equal(outcome.error.code, "APPROVAL_CONFLICT");
  } finally {
    pause.restore();
  }
  const stored = await AlbumSubmission.findOne({ submissionId }).lean();
  assert.equal(stored.approvalReceipt.revision, 2);
  assert.equal(stored.moderationHistory.filter((event) => event.action === "approved").length, 1);
}

function keyedSubmission(userId, requestKey, digest, title) {
  return AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: userId,
    proposedMetadata: {
      title, artistDisplayName: "Key Artist", artistCredits: [{ name: "Key Artist" }], releaseType: "album", releaseDate: "2026", releaseDatePrecision: "year", releaseYear: 2026,
    },
    supportingSources: [{ type: "other", url: "https://example.com/key" }],
    normalizedFingerprint: "e".repeat(64),
    status: "pending",
    currentRevision: 1,
    moderationHistory: [{ actorUserId: userId, action: "submitted", reason: "", createdAt: new Date() }],
    ...requestKeyFields(requestKey, digest),
  });
}

async function duplicateRequestKeyTest() {
  const requestKey = crypto.randomUUID();
  const digest = payloadDigest({ title: "Keyed" });
  const attempt = (userId, attemptDigest, title) => createWithRequestKey({
    Model: AlbumSubmission,
    userId,
    requestKey,
    digest: attemptDigest,
    create: () => keyedSubmission(userId, requestKey, attemptDigest, title),
  });

  const burst = await Promise.all(Array.from({ length: 5 }, () => attempt("key-user", digest, "Keyed")));
  const ids = new Set(burst.map((result) => result.document.submissionId));
  assert.equal(ids.size, 1, "concurrent retries with one key return one record");
  assert.equal(burst.filter((result) => !result.idempotent).length, 1);
  assert.equal(await AlbumSubmission.countDocuments({ submittedByUserId: "key-user", creationRequestKey: requestKey }), 1);

  await assert.rejects(attempt("key-user", payloadDigest({ title: "Changed" }), "Changed"), (error) => error.code === "REQUEST_KEY_CONFLICT");
  const otherUser = await attempt("other-key-user", digest, "Keyed");
  assert.equal(otherUser.idempotent, false, "request keys are scoped to the contributor");
  assert.equal(await AlbumSubmission.countDocuments({ creationRequestKey: requestKey }), 2);

  // Records without a key are unaffected by the partial unique index.
  await keyedSubmission("key-user", "", "", "Unkeyed 1");
  await keyedSubmission("key-user", "", "", "Unkeyed 2");
  assert.equal(await AlbumSubmission.countDocuments({ submittedByUserId: "key-user", creationRequestKey: { $exists: false } }), 2);

  // Mongoose strips updates to immutable paths, so the stored key survives.
  await AlbumSubmission.updateOne(
    { submittedByUserId: "key-user", creationRequestKey: requestKey },
    { $set: { creationRequestKey: crypto.randomUUID() } },
  ).catch(() => {});
  assert.equal(await AlbumSubmission.countDocuments({ submittedByUserId: "key-user", creationRequestKey: requestKey }), 1, "the stored key is immutable");
}

if (integrationEnabled) {
  test.before(setup);
  test.after(teardown);
  test("community artists persist without external references and same names stay distinct", communityArtistsWithoutReferencesTest);
  test("artists registered inside an aborted transaction roll back", rollbackAfterArtistCreationTest);
  test("an exact-MBID registration race retries and reuses the committed artist", exactMbidRegistrationRaceTest);
  test("a burst of concurrent registrations leaves one artist per MBID", concurrentRegistrationBurstTest);
  test("approval writes a receipt and enforces the reviewed revision on first approval and retries", approvalReceiptAndRevisionGuardTest);
  test("correction receipts bind the applied fields", correctionReceiptTest);
  test("moderation commands refuse a stale reviewed revision", staleModerationCommandTest);
  test("a stale genre approval conflicts when another moderator approved a later revision", staleGenreApprovalRaceTest);
  test("a stale new-album approval conflicts when another moderator approved a later revision", staleNewAlbumApprovalRaceTest);
  test("request keys deduplicate ambiguous create retries per contributor", duplicateRequestKeyTest);
} else {
  const skip = { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" };
  test("community artists persist without external references and same names stay distinct", skip, () => {});
  test("artists registered inside an aborted transaction roll back", skip, () => {});
  test("an exact-MBID registration race retries and reuses the committed artist", skip, () => {});
  test("a burst of concurrent registrations leaves one artist per MBID", skip, () => {});
  test("approval writes a receipt and enforces the reviewed revision on first approval and retries", skip, () => {});
  test("correction receipts bind the applied fields", skip, () => {});
  test("moderation commands refuse a stale reviewed revision", skip, () => {});
  test("a stale genre approval conflicts when another moderator approved a later revision", skip, () => {});
  test("a stale new-album approval conflicts when another moderator approved a later revision", skip, () => {});
  test("request keys deduplicate ambiguous create retries per contributor", skip, () => {});
}
