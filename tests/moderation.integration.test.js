const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const { createCoverArtResolver } = require("../lib/coverArtArchive");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const {
  findDuplicateSignals,
  normalizeCorrectionPayload,
  normalizeSubmissionPayload,
  correctionSnapshot,
  snapshotForSubmission,
} = require("../routes/utils/submissions");

let replSet;
const integrationEnabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";

function body(title = "Integration Album") {
  return normalizeSubmissionPayload({
    proposedMetadata: {
      title,
      artistCredits: [{ name: "Integration Artist" }],
      releaseType: "album",
      releaseDate: "2026",
    },
    supportingSources: [{ type: "other", url: "https://example.com/evidence" }],
    externalReferences: [],
  });
}

async function createSubmission(title, customize = (payload) => payload) {
  const payload = customize(body(title));
  const duplicate = await findDuplicateSignals(payload);
  const submittedAt = new Date();
  const submission = await AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "integration-user",
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
    moderationHistory: [{ actorUserId: "integration-user", action: "submitted", reason: "", createdAt: submittedAt }],
  });
  return submission;
}

async function createCorrection(target, proposedChanges) {
  const payload = normalizeCorrectionPayload({
    albumId: target.albumId,
    proposedChanges,
    supportingSources: [{ type: "official_label", url: "https://example.com/correction-evidence" }],
  }, target);
  const submittedAt = new Date();
  return AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "integration-correction-user",
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
    moderationHistory: [{ actorUserId: "integration-correction-user", action: "submitted", reason: "", createdAt: submittedAt }],
  });
}

function providerResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    async json() { return data; },
  };
}

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_phase2b" });
  await Promise.all([AlbumCatalog.syncIndexes(), AlbumSubmission.syncIndexes()]);
}

async function teardown() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
}

async function transactionalApprovalTest() {
  const submission = await createSubmission("Transaction Album");
  assert.equal(await AlbumCatalog.countDocuments({ title: "Transaction Album" }), 0);

  const result = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "moderator-user",
    confirmPossibleDuplicate: true,
    reason: "Verified integration evidence",
    coverResolver: null,
  });

  assert.equal(result.suggestion.status, "approved");
  assert.match(result.album.albumId, /^[0-9a-f-]{36}$/);
  assert.equal(await AlbumCatalog.countDocuments({ title: "Transaction Album" }), 1);
  const catalog = await AlbumCatalog.findOne({ albumId: result.album.albumId });
  assert.equal(catalog.cover, "");
  assert.equal(catalog.catalogSource, "community");
  assert.equal(catalog.fieldProvenance.title.source, "community");
  assert.equal(catalog.fieldProvenance.title.submissionId, submission.submissionId);
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId });
  assert.equal(persisted.status, "approved");
  assert.ok(persisted.approvedAlbumCatalogId);
  assert.equal(persisted.moderationHistory.filter((event) => event.action === "approved").length, 1);
}

async function concurrentApprovalTest() {
  const submission = await createSubmission("Concurrent Album");
  const results = await Promise.all([
    approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-a", confirmPossibleDuplicate: true, coverResolver: null }),
    approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-b", confirmPossibleDuplicate: true, coverResolver: null }),
  ]);
  assert.equal(results[0].album.albumId, results[1].album.albumId);
  assert.equal(await AlbumCatalog.countDocuments({ title: "Concurrent Album" }), 1);
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId });
  assert.equal(persisted.moderationHistory.filter((event) => event.action === "approved").length, 1);
}

async function automaticCoverApprovalTest() {
  const groupMbid = "11111111-1111-4111-8111-111111111111";
  const releaseMbid = "22222222-2222-4222-8222-222222222222";
  const submission = await createSubmission("CAA Transaction Album", (payload) => ({
    ...payload,
    supportingSources: [{
      type: "musicbrainz",
      url: `https://musicbrainz.org/release-group/${groupMbid}`,
      description: "Canonical release group",
    }],
  }));
  const calls = [];
  const resolver = createCoverArtResolver({
    clock: () => new Date("2026-08-26T12:00:00.000Z"),
    fetchFn: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "GET" && url === `https://coverartarchive.org/release-group/${groupMbid}`) {
        return providerResponse({
          release: `https://musicbrainz.org/release/${releaseMbid}`,
          images: [{
            approved: true,
            front: true,
            id: "12345",
            thumbnails: { "500": `https://coverartarchive.org/release/${releaseMbid}/12345-500.jpg` },
          }],
        });
      }
      if (options.method === "HEAD" && url === `https://coverartarchive.org/release/${releaseMbid}/front-500`) {
        return providerResponse(null, 200, { "content-type": "image/jpeg" });
      }
      throw new Error(`Unexpected provider request: ${options.method} ${url}`);
    },
  });

  const first = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "moderator-user",
    confirmPossibleDuplicate: true,
    coverResolver: resolver.resolve,
  });
  const persisted = await AlbumCatalog.findOne({ albumId: first.album.albumId }).lean();
  assert.equal(persisted.cover, `https://coverartarchive.org/release/${releaseMbid}/front-500`);
  assert.equal(persisted.fieldProvenance.cover.source, "cover-art-archive");
  assert.equal(persisted.fieldProvenance.cover.releaseGroupMbid, groupMbid);
  assert.equal(persisted.fieldProvenance.cover.releaseMbid, releaseMbid);
  assert.equal(persisted.externalReferences.some((reference) => reference.externalId === groupMbid), true);
  assert.equal(persisted.externalReferences.some((reference) => reference.externalId === releaseMbid), true);

  const retry = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "moderator-user",
    coverResolver: async () => { throw new Error("idempotent retries must not resolve artwork"); },
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.album.albumId, first.album.albumId);
  assert.equal(calls.length, 2);
}

async function rollbackTest() {
  const submission = await createSubmission("Rollback Album");
  const originalUpdate = AlbumSubmission.findOneAndUpdate;
  AlbumSubmission.findOneAndUpdate = async () => {
    throw new Error("forced approval failure");
  };
  try {
    await assert.rejects(
      approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-user", confirmPossibleDuplicate: true, coverResolver: null }),
      /forced approval failure/,
    );
  } finally {
    AlbumSubmission.findOneAndUpdate = originalUpdate;
  }
  assert.equal(await AlbumCatalog.countDocuments({ title: "Rollback Album" }), 0);
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId });
  assert.equal(persisted.status, "pending");
}

async function modelInvariantTest() {
  const submission = await createSubmission("Invariant Album");
  await assert.rejects(
    AlbumSubmission.findOneAndUpdate(
      { _id: submission._id },
      { $set: { status: "approved" } },
      { runValidators: true },
    ),
    /Approved submissions must reference/,
  );
  await assert.rejects(
    AlbumSubmission.findOneAndUpdate(
      { _id: submission._id },
      { $set: { revisions: [] } },
      { runValidators: true },
    ),
    /append-only/,
  );
}

async function correctionApprovalTest() {
  const target = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Correction Target",
    artistDisplayName: "Correction Artist",
    artistCredits: [{ name: "Correction Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2020",
    releaseDatePrecision: "year",
    releaseYear: 2020,
    tracks: [{ trackId: crypto.randomUUID(), discNumber: 1, trackNumber: 1, title: "Original track", durationMs: 1000, artistDisplayName: "Correction Artist" }],
    label: "Original label",
    cover: "https://example.com/original.jpg",
    externalReferences: [],
    fieldProvenance: { title: { source: "import" }, label: { source: "import" } },
    catalogSource: "import",
    catalogRevision: 1,
  });
  const submission = await createCorrection(target, { title: "Corrected target", label: "Corrected label" });
  const result = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "integration-moderator",
    applyFields: ["title"],
    reason: "Verified the title against the cited source",
  });

  const updatedTarget = await AlbumCatalog.findById(target._id).lean();
  const updatedSubmission = await AlbumSubmission.findOne({ submissionId: submission.submissionId }).lean();
  assert.equal(result.suggestion.publicationType, "catalog_corrected");
  assert.equal(updatedTarget.title, "Corrected target");
  assert.equal(updatedTarget.label, "Original label");
  assert.equal(updatedTarget.catalogRevision, 2);
  assert.equal(updatedTarget.fieldProvenance.title.source, "community");
  assert.equal(updatedTarget.fieldProvenance.label.source, "import");
  assert.equal(updatedSubmission.moderationHistory.filter((event) => event.action === "approved").length, 1);
  assert.deepEqual(updatedSubmission.moderationHistory.at(-1).application.unappliedFields, ["label"]);
}

async function staleCorrectionTest() {
  const target = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Stale Target",
    artistDisplayName: "Stale Artist",
    artistCredits: [{ name: "Stale Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2021",
    releaseDatePrecision: "year",
    releaseYear: 2021,
    tracks: [],
    label: "Label",
    cover: "",
    externalReferences: [],
    fieldProvenance: {},
    catalogSource: "import",
    catalogRevision: 1,
  });
  const submission = await createCorrection(target, { title: "Stale proposal" });
  await AlbumCatalog.updateOne({ _id: target._id }, { $set: { label: "Intervening edit" }, $inc: { catalogRevision: 1 } });
  await assert.rejects(
    approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "integration-moderator", applyFields: ["title"] }),
    (error) => error.code === "CATALOG_CHANGED",
  );
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId }).lean();
  assert.equal(persisted.status, "pending");
  assert.equal(await AlbumCatalog.countDocuments({ title: "Stale proposal" }), 0);
}

async function legacyRevisionCorrectionTest() {
  // Most imported albums predate revision tracking and store no catalogRevision.
  const target = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Legacy Target",
    artistDisplayName: "Legacy Artist",
    artistCredits: [{ name: "Legacy Artist", role: "main" }],
    releaseType: "single",
    releaseDate: "2018",
    releaseDatePrecision: "year",
    releaseYear: 2018,
    tracks: [],
    label: "Label",
    cover: "",
    externalReferences: [],
    fieldProvenance: {},
    catalogSource: "import",
  });
  await AlbumCatalog.collection.updateOne({ _id: target._id }, { $unset: { catalogRevision: "" } });
  const submission = await createCorrection(await AlbumCatalog.findById(target._id), { releaseType: "ep" });
  assert.equal(submission.baseCatalogRevision, 1);
  await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "integration-moderator",
    applyFields: ["releaseType"],
    reason: "Verified the release type",
  });
  const updatedTarget = await AlbumCatalog.findById(target._id).lean();
  assert.equal(updatedTarget.releaseType, "ep");
  assert.equal(updatedTarget.catalogRevision, 2);
}

if (integrationEnabled) {
  test.before(setup);
  test.after(teardown);
  test("transactional approval publishes a usable catalog album and keeps pending data private", transactionalApprovalTest);
  test("concurrent approval retries are idempotent and create one album", concurrentApprovalTest);
  test("approval persists mocked Cover Art Archive resolution and exact references", automaticCoverApprovalTest);
  test("approval rollback leaves no public catalog row", rollbackTest);
  test("submission query updates preserve status and append-only invariants", modelInvariantTest);
  test("catalog corrections apply selected fields and record the result revision", correctionApprovalTest);
  test("stale catalog corrections are rejected without changing the submission", staleCorrectionTest);
  test("corrections apply to legacy albums without a stored catalog revision", legacyRevisionCorrectionTest);
} else {
  test("transactional approval publishes a usable catalog album and keeps pending data private", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("concurrent approval retries are idempotent and create one album", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("approval persists mocked Cover Art Archive resolution and exact references", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("approval rollback leaves no public catalog row", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("submission query updates preserve status and append-only invariants", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("catalog corrections apply selected fields and record the result revision", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("stale catalog corrections are rejected without changing the submission", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
}
