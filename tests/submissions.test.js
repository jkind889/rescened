const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const clerkPath = require.resolve("@clerk/express");
const rateLimitPath = require.resolve("../routes/utils/rateLimit");
const suggestionsPath = require.resolve("../routes/suggestions");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const {
  SubmissionValidationError,
  decodeCursor,
  encodeCursor,
  normalizedFingerprint,
  normalizeSubmissionPayload,
  serializeSubmission,
} = require("../routes/utils/submissions");

const ORIGINAL_ALBUM_FIND = AlbumCatalog.find;
const ORIGINAL_SUBMISSION_STATIC = {
  create: AlbumSubmission.create,
  find: AlbumSubmission.find,
  findOne: AlbumSubmission.findOne,
  findOneAndUpdate: AlbumSubmission.findOneAndUpdate,
};

function validBody(overrides = {}) {
  return {
    proposedMetadata: {
      title: "Kind of Blue",
      artistCredits: [{ name: "Miles Davis" }],
      releaseType: "album",
      releaseDate: "1959",
      ...overrides.proposedMetadata,
    },
    supportingSources: overrides.supportingSources || [
      { type: "musicbrainz", url: "https://musicbrainz.org/release-group/example" },
    ],
    externalReferences: overrides.externalReferences || [],
  };
}

function createChain(items) {
  let result = [...items];
  return {
    populate() { return this; },
    sort() { return this; },
    limit(value) { result = result.slice(0, value); return this; },
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

function installRouteMocks({ userId = "user_a", documents = [], createCalls = [], updateCalls = [] } = {}) {
  let currentDocuments = documents;
  const makeQuery = (rows) => createChain(rows);
  AlbumCatalog.find = () => makeQuery([]);
  AlbumSubmission.find = (query = {}) => {
    let rows = currentDocuments;
    if (query.submittedByUserId) rows = rows.filter((row) => row.submittedByUserId === query.submittedByUserId);
    if (query.status?.$in) rows = rows.filter((row) => query.status.$in.includes(row.status));
    return makeQuery(rows);
  };
  AlbumSubmission.findOne = async (query = {}) => currentDocuments.find((row) => (
    (!query.submissionId || row.submissionId === query.submissionId)
    && (!query.submittedByUserId || row.submittedByUserId === query.submittedByUserId)
  )) || null;
  AlbumSubmission.create = async (data) => {
    const now = new Date();
    const created = {
      ...data,
      _id: new (require("mongoose").Types.ObjectId)(),
      submissionId: data.submissionId || crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    currentDocuments.push(created);
    createCalls.push(created);
    return created;
  };
  AlbumSubmission.findOneAndUpdate = async (query, update) => {
    const found = currentDocuments.find((row) => (
      row.submissionId === query.submissionId
      && (!query.submittedByUserId || row.submittedByUserId === query.submittedByUserId)
      && (!query.status || (query.status.$in ? query.status.$in.includes(row.status) : row.status === query.status))
      && (query.currentRevision === undefined || row.currentRevision === query.currentRevision)
    ));
    if (!found) return null;
    Object.assign(found, update.$set || {});
    if (update.$push?.revisions) found.revisions = [...(found.revisions || []), update.$push.revisions];
    if (update.$push?.moderationHistory) found.moderationHistory = [...(found.moderationHistory || []), update.$push.moderationHistory];
    found.updateCalls = (found.updateCalls || 0) + 1;
    updateCalls.push(found);
    return found;
  };
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: { getAuth: () => ({ userId }) },
  };
  const pass = (req, res, next) => next();
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: {
      submissionCreateRateLimit: pass,
      submissionMutationRateLimit: pass,
      genreSuggestionRateLimit: pass,
    },
  };
  delete require.cache[suggestionsPath];
  process.env.COMMUNITY_SUBMISSIONS_ENABLED = "true";
  return {
    get documents() { return currentDocuments; },
    router: require("../routes/suggestions"),
  };
}

test.afterEach(() => {
  AlbumCatalog.find = ORIGINAL_ALBUM_FIND;
  Object.assign(AlbumSubmission, ORIGINAL_SUBMISSION_STATIC);
  delete require.cache[suggestionsPath];
  delete require.cache[clerkPath];
  delete require.cache[rateLimitPath];
  delete process.env.MODERATOR_USER_IDS;
  delete process.env.COMMUNITY_SUBMISSIONS_ENABLED;
});

test("submission payloads normalize metadata, dates, sources, and fingerprints", () => {
  const payload = normalizeSubmissionPayload(validBody({
    proposedMetadata: {
      releaseDate: "1959-08-17",
      barcode: "0 1234-5678-90",
      tracks: [{ title: "So What" }],
    },
  }));
  assert.equal(payload.proposedMetadata.releaseDatePrecision, "day");
  assert.equal(payload.proposedMetadata.releaseYear, 1959);
  assert.equal(payload.proposedMetadata.barcode, "01234567890");
  assert.equal(payload.proposedMetadata.artistDisplayName, "Miles Davis");
  assert.equal(payload.proposedMetadata.tracks[0].trackNumber, 1);
  assert.match(normalizedFingerprint(payload.proposedMetadata), /^[0-9a-f]{64}$/);
});

test("submission payloads reject unknown fields and non-HTTPS evidence", () => {
  assert.throws(
    () => normalizeSubmissionPayload({ ...validBody(), status: "approved" }),
    (error) => error instanceof SubmissionValidationError && error.code === "INVALID_SUBMISSION",
  );
  assert.throws(
    () => normalizeSubmissionPayload(validBody({ supportingSources: [{ type: "other", url: "http://example.com" }] })),
    /https URL/,
  );
  assert.throws(
    () => normalizeSubmissionPayload(validBody({ externalReferences: [{ provider: "spotify", entityType: "album", externalId: "abc" }] })),
    /supporting evidence/,
  );
});

test("submission schema enforces public identity, references, and status invariants", () => {
  const payload = normalizeSubmissionPayload(validBody());
  const base = {
    submittedByUserId: "user_a",
    ...payload,
    normalizedFingerprint: normalizedFingerprint(payload.proposedMetadata),
  };
  const approved = new AlbumSubmission({ ...base, status: "approved" });
  assert.match(approved.validateSync().errors.approvedAlbumCatalogId.message, /must reference/);
  const duplicate = new AlbumSubmission({ ...base, status: "duplicate" });
  assert.match(duplicate.validateSync().errors.duplicateOfSubmissionId.message, /must reference/);
  assert.equal(AlbumSubmission.schema.path("submissionId").options.immutable, true);
  assert.ok(AlbumSubmission.schema.indexes().some(([fields]) => fields.normalizedFingerprint === 1));
  assert.ok(AlbumSubmission.schema.indexes().some(([fields]) => fields.submittedByUserId === 1 && fields.createdAt === -1));
});

test("cursor encoding is opaque and round-trips its ordering values", () => {
  const id = new (require("mongoose").Types.ObjectId)();
  const createdAt = new Date("2026-08-14T12:00:00.000Z");
  const cursor = encodeCursor(createdAt, id);
  assert.equal(cursor.includes(String(id)), false);
  const decoded = decodeCursor(cursor);
  assert.equal(decoded.id, String(id));
  assert.equal(decoded.createdAt.toISOString(), createdAt.toISOString());
  assert.throws(() => decodeCursor("not-a-cursor"), /cursor is invalid/);
});

test("POST /suggestions creates a pending revision with audit history", async () => {
  const state = installRouteMocks({});
  const result = await callRoute(state.router, "post", "/", { body: validBody(), query: {} });
  assert.equal(result.status, 201);
  assert.equal(result.body.status, "pending");
  assert.equal(result.body.currentRevision, 1);
  assert.equal(result.body.revisions.length, 1);
  assert.equal(result.body.moderationHistory[0].action, "submitted");
  assert.equal("_id" in result.body, false);
});

test("POST /suggestions accepts exact matches and records a duplicate signal", async () => {
  const catalogId = new (require("mongoose").Types.ObjectId)();
  const state = installRouteMocks({});
  AlbumCatalog.find = () => createChain([{
    _id: catalogId,
    title: "Kind of Blue",
    artistDisplayName: "Miles Davis",
    artistCredits: [{ name: "Miles Davis" }],
    releaseType: "album",
    releaseYear: 1959,
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: "example" }],
  }]);
  const result = await callRoute(state.router, "post", "/", {
    body: validBody({ externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: "example" }] }),
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.hasPossibleDuplicate, true);
  assert.equal(state.documents[0].duplicateSignals[0].targetType, "catalog");
});

test("GET /suggestions/mine returns a bounded cursor page", async () => {
  const documents = [1, 2].map((index) => ({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "user_a",
    status: "pending",
    proposedMetadata: { title: `Album ${index}` },
    supportingSources: [],
    externalReferences: [],
    currentRevision: 1,
    revisions: [],
    moderationHistory: [],
    createdAt: new Date(`2026-08-1${index}T00:00:00.000Z`),
    updatedAt: new Date(`2026-08-1${index}T00:00:00.000Z`),
    _id: new (require("mongoose").Types.ObjectId)(),
  }));
  const state = installRouteMocks({ documents });
  const result = await callRoute(state.router, "get", "/mine", { query: { limit: "1" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.suggestions.length, 1);
  assert.ok(result.body.nextCursor);
  const invalid = await callRoute(state.router, "get", "/mine", { query: { cursor: "bad" } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_CURSOR");
});

test("mutations are disabled by default and anonymous users receive 401", async () => {
  const state = installRouteMocks({ userId: "user_a" });
  process.env.COMMUNITY_SUBMISSIONS_ENABLED = "false";
  const disabled = await callRoute(state.router, "post", "/", { body: validBody(), query: {} });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.code, "SUBMISSIONS_DISABLED");

  delete require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: { getAuth: () => ({ userId: "" }) },
  };
  delete require.cache[suggestionsPath];
  const anonymousRouter = require("../routes/suggestions");
  const anonymous = await callRoute(anonymousRouter, "post", "/", { body: validBody(), query: {} });
  assert.equal(anonymous.status, 401);
});

test("creation rate limiting stops the database write and preserves the shared 429 shape", async () => {
  const createCalls = [];
  installRouteMocks({ createCalls });
  const block = (req, res) => res.status(429).json({ error: "Too many suggestion submissions.", code: "RATE_LIMITED", retryAfterSeconds: 60 });
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: { submissionCreateRateLimit: block, submissionMutationRateLimit: (req, res, next) => next(), genreSuggestionRateLimit: (req, res, next) => next() },
  };
  delete require.cache[suggestionsPath];
  const router = require("../routes/suggestions");
  const result = await callRoute(router, "post", "/", { body: validBody() });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, "RATE_LIMITED");
  assert.equal(createCalls.length, 0);
});

test("GET /suggestions/:submissionId protects owners and permits allowlisted moderators", async () => {
  const document = {
    submissionId: crypto.randomUUID(),
    submittedByUserId: "user_a",
    status: "pending",
    proposedMetadata: { title: "Kind of Blue" },
    supportingSources: [],
    externalReferences: [],
    currentRevision: 1,
    revisions: [{ revision: 1, submittedAt: new Date(), proposedMetadata: normalizeSubmissionPayload(validBody()).proposedMetadata, supportingSources: normalizeSubmissionPayload(validBody()).supportingSources, externalReferences: [], normalizedFingerprint: "old" }],
    moderationHistory: [],
  };
  const state = installRouteMocks({ userId: "user_b", documents: [document] });
  const hidden = await callRoute(state.router, "get", "/:submissionId", { params: { submissionId: document.submissionId } });
  assert.equal(hidden.status, 404);
  process.env.MODERATOR_USER_IDS = "user_mod";
  delete require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: { getAuth: () => ({ userId: "user_mod" }) },
  };
  delete require.cache[suggestionsPath];
  const moderatorRouter = require("../routes/suggestions");
  const visible = await callRoute(moderatorRouter, "get", "/:submissionId", { params: { submissionId: document.submissionId } });
  assert.equal(visible.status, 200);
});

test("revise returns needs-changes submissions to pending and withdraw is terminal", async () => {
  const document = {
    submissionId: crypto.randomUUID(),
    submittedByUserId: "user_a",
    status: "needs_changes",
    proposedMetadata: normalizeSubmissionPayload(validBody()).proposedMetadata,
    supportingSources: normalizeSubmissionPayload(validBody()).supportingSources,
    externalReferences: [],
    normalizedFingerprint: "old",
    currentRevision: 1,
    revisions: [],
    moderationHistory: [],
  };
  const state = installRouteMocks({ documents: [document] });
  const revised = await callRoute(state.router, "post", "/:submissionId/revise", { params: { submissionId: document.submissionId }, body: validBody({ proposedMetadata: { title: "Bitches Brew" } }) });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.status, "pending");
  assert.equal(revised.body.currentRevision, 2);
  assert.equal(revised.body.revisions.length, 1);

  const withdrawn = await callRoute(state.router, "post", "/:submissionId/withdraw", { params: { submissionId: document.submissionId }, body: {} });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, "withdrawn");
  const invalid = await callRoute(state.router, "post", "/:submissionId/withdraw", { params: { submissionId: document.submissionId }, body: {} });
  assert.equal(invalid.status, 409);
});

test("serializers hide private identifiers and expose only duplicate presence", () => {
  const serialized = serializeSubmission({
    _id: "internal",
    submissionId: crypto.randomUUID(),
    submittedByUserId: "user_a",
    status: "pending",
    proposedMetadata: {},
    supportingSources: [],
    externalReferences: [],
    candidateSubmissionIds: ["private-submission-id"],
    duplicateSignals: [{ targetType: "submission", matchType: "fingerprint", key: "secret" }],
    currentRevision: 1,
    revisions: [],
    moderationHistory: [],
  });
  assert.equal("_id" in serialized, false);
  assert.equal("candidateSubmissionIds" in serialized, false);
  assert.equal(serialized.hasPossibleDuplicate, true);
});
