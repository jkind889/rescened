const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");

const clerkPath = require.resolve("@clerk/express");
const rateLimitPath = require.resolve("../routes/utils/rateLimit");
const moderationPath = require.resolve("../routes/moderation");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const BaselineService = require("../lib/baselines/service");

const ORIGINALS = {
  startSession: mongoose.startSession,
  catalogFind: AlbumCatalog.find,
  catalogFindOne: AlbumCatalog.findOne,
  catalogCreate: AlbumCatalog.create,
  submissionFind: AlbumSubmission.find,
  submissionFindOne: AlbumSubmission.findOne,
  submissionFindOneAndUpdate: AlbumSubmission.findOneAndUpdate,
  publishSubmissionBaseline: BaselineService.publishSubmissionBaseline,
  invalidateAlbumBaseline: BaselineService.invalidateAlbumBaseline,
};

function validMetadata(title = "Kind of Blue") {
  return {
    title,
    artistDisplayName: "Miles Davis",
    artistCredits: [{ name: "Miles Davis", role: "main" }],
    releaseType: "album",
    releaseDate: "1959",
    releaseDatePrecision: "year",
    releaseYear: 1959,
    label: "Columbia",
    country: "US",
    catalogNumber: "CL 1355",
    barcode: "012345678905",
    tracks: [{ discNumber: 1, trackNumber: 1, title: "So What", durationMs: 562000, artistDisplayName: "Miles Davis" }],
    coverSourceUrl: "https://example.com/cover.jpg",
  };
}

function makeSubmission(overrides = {}) {
  const id = overrides._id || new mongoose.Types.ObjectId();
  return {
    _id: id,
    submissionId: overrides.submissionId || crypto.randomUUID(),
    submittedByUserId: overrides.submittedByUserId || "user_a",
    proposedMetadata: overrides.proposedMetadata || validMetadata(),
    supportingSources: overrides.supportingSources || [{ type: "official_label", url: "https://example.com/evidence" }],
    externalReferences: overrides.externalReferences || [],
    normalizedFingerprint: overrides.normalizedFingerprint || "f".repeat(64),
    status: overrides.status || "pending",
    approvedAlbumCatalogId: overrides.approvedAlbumCatalogId || null,
    duplicateOfSubmissionId: overrides.duplicateOfSubmissionId || null,
    candidateAlbumCatalogId: overrides.candidateAlbumCatalogId || null,
    candidateSubmissionIds: overrides.candidateSubmissionIds || [],
    duplicateSignals: overrides.duplicateSignals || [],
    currentRevision: overrides.currentRevision || 1,
    revisions: overrides.revisions || [],
    moderationHistory: overrides.moderationHistory || [],
    createdAt: overrides.createdAt || new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: overrides.updatedAt || new Date("2026-08-01T00:00:00.000Z"),
  };
}

function createChain(rows, populateRows = null) {
  let result = [...rows];
  return {
    populate(path) {
      if (typeof populateRows === "function") result = populateRows(path, result);
      return this;
    },
    sort(spec) {
      const direction = spec.updatedAt || spec.createdAt || 1;
      result.sort((a, b) => (new Date(a.updatedAt || a.createdAt) - new Date(b.updatedAt || b.createdAt)) * direction);
      return this;
    },
    limit(value) { result = result.slice(0, value); return this; },
    session() { return this; },
    exec() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function callRoute(router, method, path, req = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
  const res = response();
  for (const handler of route.route.stack.map((layer) => layer.handle)) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

function installMocks({ userId = "user_mod", documents = [], catalogs = [] } = {}) {
  let currentDocuments = documents;
  let currentCatalogs = catalogs;
  const pass = (req, res, next) => next();
  BaselineService.publishSubmissionBaseline = async () => null;
  BaselineService.invalidateAlbumBaseline = async () => false;
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: { getAuth: () => ({ userId }) },
  };
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: { moderationMutationRateLimit: pass },
  };
  AlbumCatalog.find = () => createChain(currentCatalogs);
  AlbumCatalog.findOne = (query = {}) => {
    const found = currentCatalogs.find((row) => (
      (!query.albumId || row.albumId === query.albumId)
      && (!query._id || String(row._id) === String(query._id))
    )) || null;
    return Promise.resolve(found);
  };
  AlbumCatalog.create = async (input) => {
    const data = Array.isArray(input) ? input[0] : input;
    const created = {
      ...data,
      _id: new mongoose.Types.ObjectId(),
      albumId: data.albumId || crypto.randomUUID(),
    };
    currentCatalogs.push(created);
    return Array.isArray(input) ? [created] : created;
  };
  AlbumSubmission.find = (query = {}) => {
    let rows = currentDocuments;
    if (query.status?.$in) rows = rows.filter((row) => query.status.$in.includes(row.status));
    if (typeof query.status === "string") rows = rows.filter((row) => row.status === query.status);
    if (query.submittedByUserId) rows = rows.filter((row) => row.submittedByUserId === query.submittedByUserId);
    if (query._id?.$in) rows = rows.filter((row) => query._id.$in.some((id) => String(id) === String(row._id)));
    if (query._id?.$ne) rows = rows.filter((row) => String(row._id) !== String(query._id.$ne));
    return createChain(rows, (path, populatedRows) => {
      if (path !== "approvedAlbumCatalogId") return populatedRows;
      return populatedRows.map((row) => {
        const reference = row.approvedAlbumCatalogId;
        if (!reference || reference.albumId) return row;
        const album = currentCatalogs.find((candidate) => String(candidate._id) === String(reference));
        return album ? { ...row, approvedAlbumCatalogId: album } : row;
      });
    });
  };
  AlbumSubmission.findOne = (query = {}) => Promise.resolve(currentDocuments.find((row) => (
    (!query.submissionId || row.submissionId === query.submissionId)
    && (!query._id || String(row._id) === String(query._id))
  )) || null);
  AlbumSubmission.findOneAndUpdate = async (query, update) => {
    const found = currentDocuments.find((row) => (
      (!query.submissionId || row.submissionId === query.submissionId)
      && (!query._id || String(row._id) === String(query._id))
      && (!query.status || row.status === query.status)
      && (!query.currentRevision || row.currentRevision === query.currentRevision)
    ));
    if (!found) return null;
    Object.assign(found, update.$set || {});
    if (update.$push?.moderationHistory) found.moderationHistory.push(update.$push.moderationHistory);
    found.updatedAt = new Date();
    return found;
  };
  process.env.MODERATOR_USER_IDS = "user_mod";
  process.env.COMMUNITY_MODERATION_ENABLED = "true";
  delete require.cache[moderationPath];
  return {
    get documents() { return currentDocuments; },
    get catalogs() { return currentCatalogs; },
    router: require("../routes/moderation"),
  };
}

test.afterEach(() => {
  mongoose.startSession = ORIGINALS.startSession;
  AlbumCatalog.find = ORIGINALS.catalogFind;
  AlbumCatalog.findOne = ORIGINALS.catalogFindOne;
  AlbumCatalog.create = ORIGINALS.catalogCreate;
  AlbumSubmission.find = ORIGINALS.submissionFind;
  AlbumSubmission.findOne = ORIGINALS.submissionFindOne;
  AlbumSubmission.findOneAndUpdate = ORIGINALS.submissionFindOneAndUpdate;
  BaselineService.publishSubmissionBaseline = ORIGINALS.publishSubmissionBaseline;
  BaselineService.invalidateAlbumBaseline = ORIGINALS.invalidateAlbumBaseline;
  delete require.cache[moderationPath];
  delete require.cache[clerkPath];
  delete require.cache[rateLimitPath];
  delete process.env.MODERATOR_USER_IDS;
  delete process.env.COMMUNITY_MODERATION_ENABLED;
});

test("moderator queue enforces auth, filters, oldest-first order, and public serialization", async () => {
  const old = makeSubmission({ submissionId: crypto.randomUUID(), updatedAt: new Date("2026-08-01T00:00:00.000Z") });
  const newer = makeSubmission({ submissionId: crypto.randomUUID(), updatedAt: new Date("2026-08-02T00:00:00.000Z"), hasPossibleDuplicate: true });
  newer.duplicateSignals = [{ targetType: "submission", matchType: "fingerprint", key: "private" }];
  const state = installMocks({ documents: [newer, old] });
  const result = await callRoute(state.router, "get", "/", { query: { status: "pending", limit: "1" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.suggestions[0].submissionId, old.submissionId);
  assert.ok(result.body.nextCursor);
  assert.equal("_id" in result.body.suggestions[0], false);
  assert.equal(result.body.suggestions[0].sourceCount, 1);
  const invalidCursor = await callRoute(state.router, "get", "/", { query: { cursor: "not-a-cursor" } });
  assert.equal(invalidCursor.status, 400);
  assert.equal(invalidCursor.body.code, "INVALID_CURSOR");

  delete require.cache[clerkPath];
  require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: { getAuth: () => ({ userId: "user_other" }) } };
  delete require.cache[moderationPath];
  const nonModerator = await callRoute(require("../routes/moderation"), "get", "/", { query: {} });
  assert.equal(nonModerator.status, 403);
  assert.equal(nonModerator.body.code, "MODERATOR_REQUIRED");
});

test("moderator reads remain available while command writes are disabled", async () => {
  const document = makeSubmission();
  const state = installMocks({ documents: [document] });
  process.env.COMMUNITY_MODERATION_ENABLED = "false";
  const queue = await callRoute(state.router, "get", "/", { query: {} });
  assert.equal(queue.status, 200);
  const command = await callRoute(state.router, "post", "/:submissionId/reject", { params: { submissionId: document.submissionId }, body: { reason: "Not enough evidence" } });
  assert.equal(command.status, 503);
  assert.equal(command.body.code, "MODERATION_DISABLED");
});

test("moderator detail exposes the published album for approved duplicate candidates", async () => {
  const catalog = {
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Kind of Blue",
  };
  const approvedCandidate = makeSubmission({
    status: "approved",
    approvedAlbumCatalogId: catalog._id,
  });
  const document = makeSubmission({
    candidateSubmissionIds: [approvedCandidate._id],
    duplicateSignals: [{
      targetType: "submission",
      matchType: "fingerprint",
      key: "same-release",
      submissionId: approvedCandidate._id,
    }],
  });
  const state = installMocks({ documents: [document, approvedCandidate], catalogs: [catalog] });

  const result = await callRoute(state.router, "get", "/:submissionId", {
    params: { submissionId: document.submissionId },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.duplicateCandidates.submissions.length, 1);
  assert.equal(result.body.duplicateCandidates.submissions[0].submissionId, approvedCandidate.submissionId);
  assert.equal(result.body.duplicateCandidates.submissions[0].approvedAlbumId, catalog.albumId);
});

test("moderator commands enforce reasons, target validation, and conditional transitions", async () => {
  const target = makeSubmission({ status: "approved", approvedAlbumCatalogId: new mongoose.Types.ObjectId() });
  const document = makeSubmission();
  const state = installMocks({ documents: [document, target] });
  const missingReason = await callRoute(state.router, "post", "/:submissionId/reject", { params: { submissionId: document.submissionId }, body: {} });
  assert.equal(missingReason.status, 400);
  const unknownField = await callRoute(state.router, "post", "/:submissionId/reject", { params: { submissionId: document.submissionId }, body: { reason: "Insufficient evidence", status: "rejected" } });
  assert.equal(unknownField.status, 400);
  const rejected = await callRoute(state.router, "post", "/:submissionId/reject", { params: { submissionId: document.submissionId }, body: { reason: "Insufficient evidence" } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.suggestion.status, "rejected");
  assert.equal(rejected.body.suggestion.moderationHistory.at(-1).action, "rejected");

  const duplicateDocument = makeSubmission();
  state.documents.push(duplicateDocument);
  const duplicate = await callRoute(state.router, "post", "/:submissionId/mark-duplicate", {
    params: { submissionId: duplicateDocument.submissionId },
    body: { duplicateOfSubmissionId: target.submissionId, reason: "Same release" },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.suggestion.status, "duplicate");
  assert.equal(duplicate.body.suggestion.moderationHistory.at(-1).action, "marked_duplicate");
  const terminal = await callRoute(state.router, "post", "/:submissionId/reject", { params: { submissionId: duplicateDocument.submissionId }, body: { reason: "Again" } });
  assert.equal(terminal.status, 409);
  assert.equal(terminal.body.code, "INVALID_SUBMISSION_STATE");
});

test("approval creates a catalog album transactionally and is idempotent", async () => {
  const directUrl = "https://example.com/cover.jpg";
  const document = makeSubmission({ proposedMetadata: { ...validMetadata(), coverSourceUrl: directUrl } });
  const state = installMocks({ documents: [document] });
  const session = {
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  };
  mongoose.startSession = async () => session;
  const first = await callRoute(state.router, "post", "/:submissionId/approve", {
    params: { submissionId: document.submissionId },
    body: { confirmPossibleDuplicate: true, reason: "Evidence verified" },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.suggestion.status, "approved");
  assert.match(first.body.albumUrl, /^\/album\/[0-9a-f-]{36}$/);
  assert.equal(first.body.album.cover, directUrl);
  assert.equal(state.catalogs.length, 1);
  assert.equal(state.documents[0].moderationHistory.at(-1).action, "approved");

  const second = await callRoute(state.router, "post", "/:submissionId/approve", {
    params: { submissionId: document.submissionId },
    body: {},
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(state.catalogs.length, 1);
  assert.equal(state.documents[0].moderationHistory.filter((event) => event.action === "approved").length, 1);
});

test("approval publishes a moderator-reviewed direct cover URL without fetching it", async () => {
  const directUrl = "https://images.example.test/kind-of-blue.jpg";
  const document = makeSubmission({ proposedMetadata: { ...validMetadata(), coverSourceUrl: directUrl } });
  const state = installMocks({ documents: [document] });
  mongoose.startSession = async () => ({ async withTransaction(callback) { await callback(); }, async endSession() {} });
  const result = await callRoute(state.router, "post", "/:submissionId/approve", {
    params: { submissionId: document.submissionId },
    body: { confirmPossibleDuplicate: true },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.album.cover, directUrl);
  assert.equal(state.catalogs[0].fieldProvenance.cover.source, "community");
  assert.equal(state.catalogs[0].fieldProvenance.cover.url, directUrl);
  assert.equal(state.catalogs[0].fieldProvenance.cover.submissionId, document.submissionId);
  assert.equal(result.body.album.externalReferences.some((reference) => reference.provider === "cover-art-archive"), false);
});

test("approval applies an injected Cover Art Archive result and derived MusicBrainz references", async () => {
  mongoose.startSession = async () => ({ async withTransaction(callback) { await callback(); }, async endSession() {} });
  let input;
  const releaseMbid = "01234567-89ab-4cde-8123-456789abcdef";
  const { approveAlbumSubmission } = require("../routes/utils/approval");
  const secondDocument = makeSubmission({ proposedMetadata: { ...validMetadata(), coverSourceUrl: "" } });
  const secondState = installMocks({ documents: [secondDocument] });
  const automatic = await approveAlbumSubmission({
    submissionId: secondDocument.submissionId,
    actorUserId: "user_mod",
    confirmPossibleDuplicate: true,
    coverResolver: async (candidate) => {
      input = candidate;
      return {
        status: "resolved",
        coverUrl: `https://coverartarchive.org/release/${releaseMbid}/front-500`,
        source: "cover-art-archive",
        method: "release",
        releaseMbid,
        imageId: "image-1",
        size: 500,
        verifiedAt: "2026-08-26T00:00:00.000Z",
      };
    },
  });
  assert.equal(automatic.album.cover, `https://coverartarchive.org/release/${releaseMbid}/front-500`);
  assert.equal(input.title, secondDocument.proposedMetadata.title);
  assert.equal(automatic.album.fieldProvenance, undefined);
  const created = secondState.catalogs[0];
  assert.equal(created.fieldProvenance.cover.provider, "cover-art-archive");
  assert.equal(created.fieldProvenance.cover.releaseMbid, releaseMbid);
  assert.equal(created.externalReferences.some((reference) => reference.externalId === releaseMbid), true);
});

test("approval retains exact resolver references when CAA has no usable artwork", async () => {
  const groupMbid = "11111111-1111-4111-8111-111111111111";
  const document = makeSubmission({ proposedMetadata: { ...validMetadata(), coverSourceUrl: "" } });
  const state = installMocks({ documents: [document] });
  mongoose.startSession = async () => ({ async withTransaction(callback) { await callback(); }, async endSession() {} });
  const { approveAlbumSubmission } = require("../routes/utils/approval");
  const result = await approveAlbumSubmission({
    submissionId: document.submissionId,
    actorUserId: "user_mod",
    confirmPossibleDuplicate: true,
    coverResolver: async () => ({
      status: "unresolved",
      resolved: false,
      reason: "no_approved_front",
      derivedReferences: [{
        provider: "musicbrainz",
        entityType: "release-group",
        externalId: groupMbid,
        url: `https://musicbrainz.org/release-group/${groupMbid}`,
      }],
    }),
  });
  assert.equal(result.album.cover, "");
  assert.equal(state.catalogs[0].externalReferences.some((reference) => reference.externalId === groupMbid), true);
  assert.equal(state.catalogs[0].fieldProvenance.cover, undefined);
});

test("artwork lookup failures do not block approval and linked albums stay unchanged", async () => {
  const document = makeSubmission({ proposedMetadata: { ...validMetadata(), coverSourceUrl: "" } });
  const catalog = {
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Existing album",
    artistDisplayName: "Existing artist",
    cover: "https://images.example.test/existing.jpg",
    externalReferences: [],
  };
  const state = installMocks({ documents: [document], catalogs: [catalog] });
  mongoose.startSession = async () => ({ async withTransaction(callback) { await callback(); }, async endSession() {} });
  let lookupCount = 0;
  const { approveAlbumSubmission } = require("../routes/utils/approval");
  const failed = await approveAlbumSubmission({
    submissionId: document.submissionId,
    actorUserId: "user_mod",
    confirmPossibleDuplicate: true,
    coverResolver: async () => { lookupCount += 1; throw new Error("provider unavailable"); },
  });
  assert.equal(failed.album.cover, "");
  assert.equal(lookupCount, 1);

  const linkedDocument = makeSubmission({ proposedMetadata: { ...validMetadata(), coverSourceUrl: "" } });
  state.documents.push(linkedDocument);
  const linked = await approveAlbumSubmission({
    submissionId: linkedDocument.submissionId,
    actorUserId: "user_mod",
    albumId: catalog.albumId,
    coverResolver: async () => { throw new Error("must not resolve linked album"); },
  });
  assert.equal(linked.album.albumId, catalog.albumId);
  assert.equal(state.catalogs[0].cover, "https://images.example.test/existing.jpg");
});

test("approval rejects artwork resolved against a stale submission revision", async () => {
  const document = makeSubmission({ proposedMetadata: { ...validMetadata(), coverSourceUrl: "" } });
  const state = installMocks({ documents: [document] });
  mongoose.startSession = async () => ({ async withTransaction(callback) { await callback(); }, async endSession() {} });
  const { approveAlbumSubmission } = require("../routes/utils/approval");
  await assert.rejects(
    approveAlbumSubmission({
      submissionId: document.submissionId,
      actorUserId: "user_mod",
      confirmPossibleDuplicate: true,
      coverResolver: async () => {
        document.currentRevision = 2;
        document.updatedAt = new Date("2026-08-02T00:00:00.000Z");
        return { status: "resolved", coverUrl: "https://coverartarchive.org/release/01234567-89ab-4cde-8123-456789abcdef/front-500" };
      },
    }),
    (error) => error.code === "STATE_CONFLICT",
  );
  assert.equal(state.catalogs.length, 0);
});

test("approval reports unavailable when Mongo cannot start a transaction", async () => {
  const document = makeSubmission();
  const state = installMocks({ documents: [document] });
  mongoose.startSession = async () => ({
    async withTransaction() { const error = new Error("Transaction numbers are only allowed on a replica set member"); error.code = 20; throw error; },
    async endSession() {},
  });
  const result = await callRoute(state.router, "post", "/:submissionId/approve", { params: { submissionId: document.submissionId }, body: {} });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "APPROVAL_UNAVAILABLE");
  assert.equal(state.documents[0].status, "pending");
});

test("approval links an explicitly selected catalog album and rejects an exact match without selection", async () => {
  const catalog = {
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Kind of Blue",
    artistDisplayName: "Miles Davis",
    artistCredits: [{ name: "Miles Davis" }],
    releaseType: "album",
    releaseDate: "1959",
    releaseYear: 1959,
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: "kind-of-blue" }],
    cover: "",
  };
  const linked = makeSubmission({ externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: "different" }] });
  const state = installMocks({ documents: [linked], catalogs: [catalog] });
  mongoose.startSession = async () => ({ async withTransaction(callback) { await callback(); }, async endSession() {} });
  const linkedResult = await callRoute(state.router, "post", "/:submissionId/approve", {
    params: { submissionId: linked.submissionId },
    body: { albumId: catalog.albumId },
  });
  assert.equal(linkedResult.status, 200);
  assert.equal(linkedResult.body.album.albumId, catalog.albumId);
  assert.equal(state.catalogs.length, 1);

  const exact = makeSubmission({ externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: "kind-of-blue" }] });
  const exactState = installMocks({ documents: [exact], catalogs: [catalog] });
  mongoose.startSession = async () => ({ async withTransaction(callback) { await callback(); }, async endSession() {} });
  const exactResult = await callRoute(exactState.router, "post", "/:submissionId/approve", { params: { submissionId: exact.submissionId }, body: { confirmPossibleDuplicate: true } });
  assert.equal(exactResult.status, 409);
  assert.equal(exactResult.body.code, "EXACT_CATALOG_MATCH");
});

test("moderator mutation rate limiting happens before persistence", async () => {
  const document = makeSubmission();
  installMocks({ documents: [document] });
  const rateLimited = (req, res) => res.status(429).json({ error: "Too many moderation commands.", code: "RATE_LIMITED", retryAfterSeconds: 60 });
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: { moderationMutationRateLimit: rateLimited },
  };
  delete require.cache[moderationPath];
  const router = require("../routes/moderation");
  const result = await callRoute(router, "post", "/:submissionId/reject", { params: { submissionId: document.submissionId }, body: { reason: "No evidence" } });
  assert.equal(result.status, 429);
  assert.equal(document.status, "pending");
});
