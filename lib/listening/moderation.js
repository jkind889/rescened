const crypto = require("node:crypto");
const mongoose = require("mongoose");

const AlbumCatalog = require("../../models/AlbumCatalog");
const { assertPublicAlbumId, catalogRevisionOf, mappingKey, normalize, safeError } = require("./common");
const { isModerator } = require("../../routes/utils/submissions");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["pending", "approved", "rejected", "no_catalog_match"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function models() { return require("../../models/Listening"); }
function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value || null; }
function queryExec(query) { return query && typeof query.exec === "function" ? query.exec() : query; }
function sessionQuery(query, session) {
  return session && query && typeof query.session === "function" ? query.session(session) : query;
}
function read(Model, filter, session) { return queryExec(sessionQuery(Model.findOne(filter), session)); }

function fail(code, status = 400) { throw safeError(code, status); }
function assertCaseId(value) { if (typeof value !== "string" || !UUID.test(value)) fail("INVALID_CASE_ID"); return value.toLowerCase(); }
function assertRevision(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("INVALID_REVISION");
  return value;
}
function requiredReason(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 2_000) fail("INVALID_REASON");
  return value.trim();
}

function safeEvidenceUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) return "";
  let parsed;
  try { parsed = new URL(value.trim()); } catch { return ""; }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|secret|session|password|passwd|authorization|auth|api[_-]?key|sig|code)/iu.test(key)) return "";
  }
  return parsed.toString();
}
function commandBody(body, action) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("INVALID_REQUEST");
  const allowed = new Set(["expectedRevision", "reason"]);
  if (action === "approve") {
    allowed.add("albumId");
    allowed.add("expectedCatalogRevision");
  }
  Object.keys(body).forEach((key) => { if (!allowed.has(key)) fail("INVALID_REQUEST"); });
  return {
    expectedRevision: assertRevision(body.expectedRevision),
    reason: requiredReason(body.reason),
    albumId: action === "approve" ? assertPublicAlbumId(body.albumId) : "",
    expectedCatalogRevision: action === "approve" && body.expectedCatalogRevision !== undefined
      ? assertRevision(body.expectedCatalogRevision)
      : null,
  };
}

function publicEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const result = {};
    ["provider", "source", "retrievedAt", "reviewedAt", "artist", "album", "trackCount", "providerTrackCount", "catalogTrackCount", "sharedTrackCount", "missingTrackCount", "duplicateTitleAmbiguity", "countDifference", "releaseGroupMbid", "releaseMbid", "type", "externalId", "simplifiedTitle", "providerMetadataAvailable", "comparisonBasis", "baselineId", "baselineHash", "artistCreditDifference"].forEach((key) => {
      if (item[key] !== undefined && item[key] !== null && typeof item[key] !== "object") result[key] = item[key];
    });
    const sourceLink = safeEvidenceUrl(item.sourceLink || item.sourceUrl || item.url || item.providerSourceUrl);
    if (sourceLink) result.sourceLink = sourceLink;
    ["sharedTracks", "missingTracks", "extraTracks", "duplicateTitles", "identifierConflicts"].forEach((key) => {
      if (Array.isArray(item[key])) {
        const values = item[key].filter((entry) => ["string", "number", "boolean"].includes(typeof entry)).slice(0, 50);
        if (values.length) result[key] = values;
      }
    });
    if (typeof item.sharedTracks === "number") result.sharedTrackCount = item.sharedTracks;
    if (typeof item.missingTracks === "number") result.missingTrackCount = item.missingTracks;
    return result;
  }).filter(Boolean);
}

function publicCandidate(value) {
  const source = plain(value) || {};
  if (!source.albumId || !UUID.test(String(source.albumId))) return null;
  return {
    albumId: source.albumId,
    title: String(source.title || ""),
    artistDisplayName: String(source.artistDisplayName || ""),
    catalogRevision: Number(source.catalogRevision || 1),
    evidence: publicEvidence(source.evidence),
  };
}

function serializeCase(value) {
  const source = plain(value);
  if (!source) return null;
  return {
    caseId: source.caseId,
    provider: source.provider,
    artist: source.artist,
    album: source.album,
    artistKey: source.artistKey,
    albumKey: source.albumKey,
    status: source.status,
    revision: source.revision,
    encounterCount: source.encounterCount,
    candidates: (source.candidates || []).map(publicCandidate).filter(Boolean),
    evidence: publicEvidence(source.evidence),
    evidenceHash: source.evidenceHash || "",
    discoveryError: source.discoveryError || "",
    refreshedAt: source.refreshedAt ? new Date(source.refreshedAt).toISOString() : null,
  };
}

function serializeMapping(value) {
  const source = plain(value);
  if (!source) return null;
  return {
    mappingId: source.mappingId,
    provider: source.provider,
    artist: source.artist,
    album: source.album,
    artistKey: source.artistKey,
    albumKey: source.albumKey,
    normalizationVersion: source.normalizationVersion,
    albumId: source.albumId,
    catalogRevision: source.catalogRevision,
    revision: source.revision,
    status: source.status,
    evidence: publicEvidence(source.evidence),
    reason: source.reason,
  };
}

function serializeHistory(rows) {
  return (rows || []).map((row) => {
    const source = plain(row) || {};
    return {
      action: source.action,
      reason: source.reason,
      revision: source.revision,
      createdAt: source.createdAt ? new Date(source.createdAt).toISOString() : null,
    };
  });
}

function mappingSnapshot(value) {
  const source = plain(value);
  if (!source) return null;
  return {
    mappingId: source.mappingId || "",
    status: source.status || "",
    albumId: source.albumId || "",
    catalogRevision: Number(source.catalogRevision || 0),
    revision: Number(source.revision || 0),
    evidence: publicEvidence(source.evidence),
  };
}

// Case candidates are a discovery snapshot. Report each album's current catalog
// revision so a later change, such as a baseline filling empty tracks, does not
// leave moderators approving against a revision that can only conflict. The
// stored snapshot is not rewritten.
async function withCurrentRevisions(cases) {
  const albumIds = [...new Set(cases.flatMap((item) => item.candidates.map((candidate) => candidate.albumId)))];
  if (!albumIds.length) return cases;
  const rows = await queryExec(AlbumCatalog.find({ albumId: { $in: albumIds } }).select("albumId catalogRevision").lean());
  const revisions = new Map((rows || []).map((row) => [row.albumId, catalogRevisionOf(row)]));
  return cases.map((item) => ({ ...item, candidates: item.candidates.map((candidate) => (revisions.has(candidate.albumId) ? { ...candidate, catalogRevision: revisions.get(candidate.albumId) } : candidate)) }));
}

async function detail(caseId) {
  const Model = models();
  const found = await read(Model.MappingCase, { caseId });
  if (!found) return null;
  const mapping = await read(Model.AlbumMapping, { key: found.key });
  let historyQuery = Model.MappingAudit.find({ caseId });
  if (historyQuery?.sort) historyQuery = historyQuery.sort({ createdAt: 1, _id: 1 });
  const history = await queryExec(historyQuery);
  const [current] = await withCurrentRevisions([serializeCase(found)]);
  return { case: current, mapping: serializeMapping(mapping), history: serializeHistory(history) };
}

function cursorEncode(row) {
  const source = plain(row);
  return Buffer.from(JSON.stringify({ encounterCount: Number(source.encounterCount || 0), updatedAt: new Date(source.updatedAt || 0).toISOString(), id: String(source._id) })).toString("base64url");
}
function cursorDecode(cursor) {
  if (!cursor) return null;
  try {
    const source = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const updatedAt = new Date(source.updatedAt);
    if (!mongoose.isValidObjectId(source.id) || !Number.isSafeInteger(Number(source.encounterCount)) || Number.isNaN(updatedAt.getTime())) throw new Error("invalid");
    return { encounterCount: Number(source.encounterCount), updatedAt, id: source.id };
  } catch { fail("INVALID_CURSOR"); }
}

async function listCases({ status, priority, cursor, limit = DEFAULT_LIMIT } = {}) {
  const Model = models();
  const parsedLimit = Number(limit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) fail("INVALID_LIMIT");
  if (status && !STATUSES.has(status)) fail("INVALID_STATUS");
  if (priority && priority !== "high") fail("INVALID_PRIORITY");
  const query = status ? { status } : {};
  if (priority === "high") query.encounterCount = { $gte: 2 };
  const decoded = cursorDecode(cursor);
  if (decoded) {
    query.$and = [{ $or: [
      { encounterCount: { $lt: decoded.encounterCount } },
      { encounterCount: decoded.encounterCount, updatedAt: { $gt: decoded.updatedAt } },
      { encounterCount: decoded.encounterCount, updatedAt: decoded.updatedAt, _id: { $gt: decoded.id } },
    ] }];
  }
  let result = Model.MappingCase.find(query);
  if (result?.sort) result = result.sort({ encounterCount: -1, updatedAt: 1, _id: 1 });
  if (result?.limit) result = result.limit(parsedLimit + 1);
  const rows = await queryExec(result);
  const page = rows.length > parsedLimit ? rows.slice(0, parsedLimit) : rows;
  return { items: await withCurrentRevisions(page.map(serializeCase)), nextCursor: rows.length > parsedLimit ? cursorEncode(page[page.length - 1]) : null };
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function catalogSearch(q, limit = 20) {
  if (typeof q !== "string" || q.trim().length < 2 || q.trim().length > 200) fail("INVALID_QUERY");
  const parsedLimit = Number(limit);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) fail("INVALID_LIMIT");
  const pattern = new RegExp(escapeRegex(q.trim()), "i");
  let result = AlbumCatalog.find({ $or: [{ title: pattern }, { artistDisplayName: pattern }, { "artistCredits.name": pattern }] });
  if (result?.sort) result = result.sort({ artistDisplayName: 1, title: 1, _id: 1 });
  if (result?.limit) result = result.limit(parsedLimit);
  const rows = await queryExec(result);
  return { items: (rows || []).map((row) => {
    const source = plain(row);
    return { albumId: source.albumId, title: source.title, artistDisplayName: source.artistDisplayName, catalogRevision: catalogRevisionOf(source) };
  }).filter((row) => row.albumId) };
}

async function startSession() {
  if (typeof mongoose.startSession !== "function") throw safeError("MAPPING_MODERATION_UNAVAILABLE", 503);
  const session = await mongoose.startSession();
  if (!session || typeof session.startTransaction !== "function" || typeof session.commitTransaction !== "function") {
    try { await session?.endSession?.(); } catch { /* noop */ }
    throw safeError("MAPPING_MODERATION_UNAVAILABLE", 503);
  }
  return session;
}

async function enqueueReprocess(Model, mapping, session, now, status = "active") {
  if (!Model.Job?.findOneAndUpdate) return;
  const key = `reprocess:${mapping.key}:${mapping.revision}`;
  const payload = {
    key: mapping.key,
    mappingId: mapping.mappingId,
    mappingRevision: mapping.revision,
    status,
  };
  let query = Model.Job.findOneAndUpdate(
    { key },
    {
      $setOnInsert: { key, type: "reprocess", attempts: 0 },
      $set: { payload, status: "pending", runAt: now, error: "" },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  if (session && query?.session) query = query.session(session);
  await queryExec(query);
}

function transactionError(error) {
  if (isTransactionUnavailable(error)) return safeError("MAPPING_MODERATION_UNAVAILABLE", 503);
  if (error?.code === 11000 || error?.code === 112 || error?.codeName === "WriteConflict" || error?.codeName === "DuplicateKey") {
    return safeError("MAPPING_CONFLICT", 409);
  }
  return error;
}

async function moderate(caseIdInput, action, body, reviewer, { clock } = {}) {
  if (!isModerator(reviewer)) fail("MODERATOR_REQUIRED", 403);
  const caseId = assertCaseId(caseIdInput);
  const command = commandBody(body, action);
  const Model = models();
  const now = clock ? new Date(clock()) : new Date();
  let session;
  try {
    session = await startSession();
    session.startTransaction();
    const current = await read(Model.MappingCase, { caseId }, session);
    if (!current) fail("MAPPING_CASE_NOT_FOUND", 404);
    if (Number(current.revision) !== command.expectedRevision) fail("REVISION_CONFLICT", 409);
    if (action !== "revoke" && !["pending", "rejected", "no_catalog_match", ...(action === "refresh" ? ["approved"] : [])].includes(current.status)) fail("STATE_CONFLICT", 409);
    const key = current.key || mappingKey(current.artist, current.album);
    let mapping = await read(Model.AlbumMapping, { key }, session);
    let nextCaseStatus = current.status;
    let auditAction = action;
    let revokeDetails = null;
    let approvalDetails = null;
    if (action === "approve") {
      const catalog = await queryExec(sessionQuery(AlbumCatalog.findOne({ albumId: command.albumId }), session));
      if (!catalog) fail("CATALOG_ALBUM_NOT_FOUND", 404);
      const catalogPlain = plain(catalog);
      const reviewedCandidate = (current.candidates || []).find((candidate) => plain(candidate)?.albumId === command.albumId);
      const expectedCatalogRevision = command.expectedCatalogRevision
        || (reviewedCandidate && Number(plain(reviewedCandidate).catalogRevision));
      if (expectedCatalogRevision && Number(catalogPlain.catalogRevision || 1) !== Number(expectedCatalogRevision)) {
        fail("CATALOG_REVISION_CONFLICT", 409);
      }
      if (mapping?.status === "active" && mapping.albumId !== command.albumId) fail("CONFLICTING_MAPPING", 409);
      const priorMapping = mappingSnapshot(mapping);
      const mappingInput = {
        key,
        provider: "lastfm",
        artist: current.artist,
        album: current.album,
        artistKey: current.artistKey || normalize(current.artist),
        albumKey: current.albumKey || normalize(current.album),
        normalizationVersion: 1,
        albumId: command.albumId,
        catalogRevision: Number(catalogPlain.catalogRevision || 1),
        revision: mapping ? Number(mapping.revision || 0) + 1 : 1,
        status: "active",
        // Preserve the provider comparison that justified the selected
        // candidate, not only the case-level discovery snapshot. Both are
        // bounded and privacy-filtered before persistence.
        evidence: publicEvidence([
          ...(Array.isArray(current.evidence) ? current.evidence : []),
          ...(Array.isArray(plain(reviewedCandidate)?.evidence) ? plain(reviewedCandidate).evidence : []),
        ]),
        reviewer,
        reason: command.reason,
      };
      if (mapping) {
        const updated = await Model.AlbumMapping.findOneAndUpdate(
          { key },
          { $set: mappingInput },
          { returnDocument: "after", runValidators: true, session },
        );
        mapping = updated || mapping;
      } else {
        const created = await Model.AlbumMapping.create([mappingInput], { session });
        mapping = created[0];
      }
      nextCaseStatus = "approved";
      auditAction = "approved";
      approvalDetails = {
        previous: priorMapping,
        selected: mappingSnapshot(mapping),
      };
      await enqueueReprocess(Model, plain(mapping), session, now, "active");
    } else if (action === "revoke") {
      if (!mapping || mapping.status !== "active") fail("MAPPING_NOT_ACTIVE", 409);
      const previousMapping = plain(mapping);
      const updated = await Model.AlbumMapping.findOneAndUpdate(
        { key, status: "active" },
        { $set: { status: "revoked", revision: Number(mapping.revision || 0) + 1, reviewer, reason: command.reason } },
        { returnDocument: "after", runValidators: true, session },
      );
      mapping = updated || mapping;
      nextCaseStatus = "pending";
      auditAction = "revoked";
      await enqueueReprocess(Model, plain(mapping), session, now, "revoked");
      revokeDetails = {
        albumId: previousMapping.albumId,
        catalogRevision: previousMapping.catalogRevision,
        mappingRevision: previousMapping.revision,
        status: previousMapping.status,
        evidence: publicEvidence(previousMapping.evidence),
      };
    } else if (action === "refresh") {
      // Refreshing an approved case only refreshes provider evidence. It never
      // revokes or changes the active identity mapping implicitly.
      nextCaseStatus = current.status === "approved" ? "approved" : "pending";
      auditAction = "refresh_requested";
      if (Model.Job?.findOneAndUpdate) {
        let query = Model.Job.findOneAndUpdate(
          { key: `discovery:${caseId}` },
          { $setOnInsert: { key: `discovery:${caseId}`, type: "discovery", attempts: 0 }, $set: { payload: { caseId, key, allowApproved: current.status === "approved" }, status: "pending", runAt: now, error: "" } },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
        );
        if (session && query?.session) query = query.session(session);
        await queryExec(query);
      }
    } else if (action === "reject") {
      nextCaseStatus = "rejected";
      auditAction = "rejected";
    } else if (action === "no-catalog-match") {
      nextCaseStatus = "no_catalog_match";
      auditAction = "no_catalog_match";
    } else {
      fail("INVALID_ACTION");
    }
    const nextRevision = Number(current.revision) + 1;
    const update = {
      $set: { status: nextCaseStatus, revision: nextRevision, refreshedAt: action === "refresh" ? now : current.refreshedAt, discoveryError: "" },
    };
    const changed = await Model.MappingCase.findOneAndUpdate(
      { caseId, revision: command.expectedRevision },
      update,
      { returnDocument: "after", runValidators: true, session },
    );
    if (!changed) fail("REVISION_CONFLICT", 409);
    const audit = {
      auditId: crypto.randomUUID(),
      caseId,
      mappingId: mapping?.mappingId || "",
      action: auditAction,
      reviewer,
      reason: command.reason,
      revision: nextRevision,
      details: action === "approve"
        ? approvalDetails
        : action === "revoke"
          ? { ...revokeDetails }
          : {},
    };
    await Model.MappingAudit.create([audit], { session });
    await session.commitTransaction();
  } catch (error) {
    try { await session?.abortTransaction?.(); } catch { /* noop */ }
    throw transactionError(error);
  } finally {
    try { await session?.endSession?.(); } catch { /* noop */ }
  }
  return detail(caseId);
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  catalogSearch,
  detail,
  listCases,
  moderate,
  publicCandidate,
  serializeCase,
  serializeMapping,
};
