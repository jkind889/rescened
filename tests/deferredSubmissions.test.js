const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");

const suggestionsPath = require.resolve("../routes/suggestions");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const BaselineService = require("../lib/baselines/service");
const {
  decodeApprovedCursor,
  encodeApprovedCursor,
  normalizeCorrectionPayload,
  serializeApprovedFeedItem,
  serializeSubmission,
} = require("../routes/utils/submissions");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const {
  buildPlan: buildReconciliationPlan,
  parseArgs: parseReconciliationArgs,
} = require("../scripts/reconcileCommunityPublication");

const originals = {
  startSession: mongoose.startSession,
  catalogFind: AlbumCatalog.find,
  catalogFindOne: AlbumCatalog.findOne,
  catalogFindOneAndUpdate: AlbumCatalog.findOneAndUpdate,
  submissionFind: AlbumSubmission.find,
  submissionFindOne: AlbumSubmission.findOne,
  submissionFindOneAndUpdate: AlbumSubmission.findOneAndUpdate,
  publishSubmissionBaseline: BaselineService.publishSubmissionBaseline,
  invalidateAlbumBaseline: BaselineService.invalidateAlbumBaseline,
};

function chain(rows) {
  let value = [...rows];
  return {
    populate() { return this; },
    sort(spec) {
      const direction = spec.approvedAt === -1 ? -1 : 1;
      value.sort((left, right) => (new Date(left.approvedAt) - new Date(right.approvedAt)) * direction);
      return this;
    },
    limit(limit) { value = value.slice(0, limit); return this; },
    session() { return this; },
    exec() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function callRoute(router, method, path, req = {}) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
  const res = response();
  for (const handler of layer.route.stack.map((item) => item.handle)) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

function targetAlbum(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Original title",
    artistDisplayName: "Original artist",
    artistCredits: [{ name: "Original artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2020",
    releaseDatePrecision: "year",
    releaseYear: 2020,
    tracks: [{ trackId: crypto.randomUUID(), discNumber: 1, trackNumber: 1, title: "Track one", durationMs: 1000, artistDisplayName: "Original artist" }],
    label: "Original label",
    cover: "https://example.com/original.jpg",
    externalReferences: [],
    fieldProvenance: { title: { source: "import" }, label: { source: "import" } },
    catalogSource: "import",
    catalogRevision: 3,
    ...overrides,
  };
}

function correctionBody(album, overrides = {}) {
  return {
    albumId: album.albumId,
    proposedChanges: { title: "Corrected title", label: "Corrected label", ...overrides },
    supportingSources: [{ type: "official_label", url: "https://example.com/evidence" }],
  };
}

test.afterEach(() => {
  mongoose.startSession = originals.startSession;
  AlbumCatalog.find = originals.catalogFind;
  AlbumCatalog.findOne = originals.catalogFindOne;
  AlbumCatalog.findOneAndUpdate = originals.catalogFindOneAndUpdate;
  AlbumSubmission.find = originals.submissionFind;
  AlbumSubmission.findOne = originals.submissionFindOne;
  AlbumSubmission.findOneAndUpdate = originals.submissionFindOneAndUpdate;
  BaselineService.publishSubmissionBaseline = originals.publishSubmissionBaseline;
  BaselineService.invalidateAlbumBaseline = originals.invalidateAlbumBaseline;
  delete require.cache[suggestionsPath];
});

test.beforeEach(() => {
  BaselineService.publishSubmissionBaseline = async () => null;
  BaselineService.invalidateAlbumBaseline = async () => false;
});

test("correction normalization captures a typed baseline and refuses client-owned track IDs", () => {
  const album = targetAlbum();
  const existingTrack = album.tracks[0].trackId;
  const payload = normalizeCorrectionPayload(correctionBody(album, {
    tracks: [
      { trackId: existingTrack, discNumber: 1, trackNumber: 1, title: "Corrected track", durationMs: 2000 },
      { discNumber: 1, trackNumber: 2, title: "New track" },
    ],
  }), album);

  assert.equal(payload.baseCatalogRevision, 3);
  assert.equal(payload.baseValues.title, album.title);
  assert.equal(payload.baseValues.tracks[0].trackId, existingTrack);
  assert.match(payload.proposedChanges.tracks[1].trackId, /^[0-9a-f-]{36}$/);
  assert.equal(serializeSubmission({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "user_a",
    submissionType: "catalog_correction",
    status: "pending",
    targetAlbumCatalogId: album,
    baseCatalogRevision: payload.baseCatalogRevision,
    baseValues: payload.baseValues,
    baseProvenance: payload.baseProvenance,
    proposedChanges: payload.proposedChanges,
    supportingSources: payload.supportingSources,
    revisions: [],
    moderationHistory: [],
  }, { detail: true }).baseProvenance, undefined);

  assert.throws(
    () => normalizeCorrectionPayload(correctionBody(album, { title: "Another title", tracks: [{ trackId: crypto.randomUUID(), title: "No" }] }), album),
    /must belong to the target album/,
  );
});

test("approved feed is anonymous, current-catalog based, and advances past corrupt rows", async () => {
  const album = targetAlbum({ title: "Current catalog title" });
  const valid = {
    _id: new mongoose.Types.ObjectId(),
    submissionId: crypto.randomUUID(),
    status: "approved",
    approvedAt: new Date("2026-09-02T12:00:00.000Z"),
    approvalPublicationType: "catalog_corrected",
    approvedAlbumCatalogId: album,
    submittedByUserId: "private-user",
  };
  const corrupt = {
    _id: new mongoose.Types.ObjectId(),
    submissionId: crypto.randomUUID(),
    status: "approved",
    approvedAt: new Date("2026-09-02T11:00:00.000Z"),
    approvalPublicationType: "catalog_linked",
    approvedAlbumCatalogId: new mongoose.Types.ObjectId(),
    submittedByUserId: "another-private-user",
  };
  AlbumSubmission.find = (query = {}) => chain([valid, corrupt].filter((row) => row.status === query.status));
  delete require.cache[suggestionsPath];
  const router = require("../routes/suggestions");

  const result = await callRoute(router, "get", "/approved", { query: { limit: "1" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.suggestions.length, 1);
  assert.equal(result.body.suggestions[0].album.title, "Current catalog title");
  assert.equal(result.body.suggestions[0].publicationType, "catalog_corrected");
  assert.equal("submittedByUserId" in result.body.suggestions[0], false);
  assert.equal("_id" in result.body.suggestions[0], false);
  assert.ok(result.body.nextCursor);
  assert.deepEqual(decodeApprovedCursor(result.body.nextCursor).approvedAt, valid.approvedAt);
  assert.equal(serializeApprovedFeedItem(corrupt), null);
  assert.equal(serializeApprovedFeedItem({ ...valid, submissionId: "not-a-public-id" }), null);
  assert.equal(decodeApprovedCursor(encodeApprovedCursor(valid.approvedAt, valid._id)).id, String(valid._id));
});

test("community reconciliation is dry-run-first and refuses ambiguous approval history", () => {
  const album = targetAlbum({ catalogRevision: undefined });
  delete album.catalogRevision;
  const submission = {
    _id: new mongoose.Types.ObjectId(),
    submissionId: crypto.randomUUID(),
    submissionType: "new_album",
    status: "approved",
    approvedAt: null,
    approvalPublicationType: null,
    approvedAlbumCatalogId: album,
    moderationHistory: [{ action: "approved", createdAt: new Date("2026-09-02T10:00:00.000Z") }],
  };
  const plan = buildReconciliationPlan({
    albums: [album],
    submissions: [submission],
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(plan.counts.catalogRevisionInitializations, 1);
  assert.equal(plan.counts.approvalMetadataUpdates, 1);
  assert.equal(plan.ambiguous.length, 0);
  assert.equal(parseReconciliationArgs([]).dryRun, true);
  assert.throws(
    () => parseReconciliationArgs(["--apply", "--confirm-target", "rescened"]),
    /reviewed dry-run report/,
  );

  const ambiguous = buildReconciliationPlan({
    albums: [targetAlbum({ catalogRevision: 2 })],
    submissions: [{ ...submission, moderationHistory: [] }],
  });
  assert.equal(ambiguous.counts.ambiguous, 1);
});

test("correction approval patches selected fields once and records the application partition", async () => {
  const album = targetAlbum();
  const submission = {
    _id: new mongoose.Types.ObjectId(),
    submissionId: crypto.randomUUID(),
    submittedByUserId: "user_a",
    submissionType: "catalog_correction",
    status: "pending",
    targetAlbumCatalogId: album._id,
    baseCatalogRevision: album.catalogRevision,
    baseValues: { title: album.title, label: album.label },
    baseProvenance: { title: album.fieldProvenance.title, label: album.fieldProvenance.label },
    proposedChanges: { title: "Corrected title", label: "Corrected label" },
    supportingSources: [{ type: "official_label", url: "https://example.com/evidence" }],
    externalReferences: [],
    normalizedFingerprint: "f".repeat(64),
    currentRevision: 1,
    revisions: [],
    moderationHistory: [],
  };
  AlbumSubmission.findOne = async () => submission;
  AlbumSubmission.findOneAndUpdate = async (_query, update) => {
    Object.assign(submission, update.$set);
    submission.moderationHistory.push(update.$push.moderationHistory);
    return submission;
  };
  AlbumCatalog.findOne = async (query = {}) => (
    String(query._id || "") === String(album._id) ? album : null
  );
  AlbumCatalog.find = () => chain([album]);
  AlbumCatalog.findOneAndUpdate = async (_query, update) => {
    Object.assign(album, update.$set);
    album.catalogRevision += update.$inc.catalogRevision;
    return album;
  };
  mongoose.startSession = async () => ({
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  });

  const result = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "moderator",
    applyFields: ["label", "title"],
    reason: "Verified against the cited source",
  });

  assert.equal(result.suggestion.status, "approved");
  assert.equal(result.suggestion.publicationType, "catalog_corrected");
  assert.equal(result.suggestion.moderationHistory.at(-1).application.appliedFields.join(","), "title,label");
  assert.deepEqual(result.suggestion.moderationHistory.at(-1).application.unappliedFields, []);
  assert.equal(album.title, "Corrected title");
  assert.equal(album.label, "Corrected label");
  assert.equal(album.catalogRevision, 4);
  assert.equal(result.suggestion.baseProvenance.title.source, "import");
});
