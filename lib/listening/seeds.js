const { createHash } = require("node:crypto");
const { normalize, mappingKey, assertPublicAlbumId, safeError, catalogRevisionOf, catalogRevisionFilter } = require("./common");

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function targetFingerprint(connection) {
  return digest(JSON.stringify([connection.host, connection.port, connection.name]));
}
function validateBindings(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw safeError("INVALID_SEED_BINDINGS");
  const keys = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => !["artist", "album", "albumId", "reason", "sources"].includes(key))) throw safeError("INVALID_SEED_BINDING");
    for (const key of ["artist", "album", "reason"]) {
      if (typeof entry[key] !== "string" || !entry[key].trim() || entry[key].length > (key === "reason" ? 2000 : 500)) throw safeError("INVALID_SEED_BINDING");
    }
    assertPublicAlbumId(entry.albumId);
    if (!Array.isArray(entry.sources) || !entry.sources.length || entry.sources.length > 10) throw safeError("SEED_SOURCES_REQUIRED");
    const sources = entry.sources.map((source) => {
      if (typeof source !== "string" || source.length > 2000) throw safeError("INVALID_SEED_SOURCE");
      let url;
      try { url = new URL(source); } catch { throw safeError("INVALID_SEED_SOURCE"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw safeError("INVALID_SEED_SOURCE");
      return url.href;
    });
    const key = mappingKey(entry.artist, entry.album);
    if (keys.has(key)) throw safeError("DUPLICATE_SEED_KEY");
    keys.add(key);
    return { artist: entry.artist.trim(), album: entry.album.trim(), artistKey: normalize(entry.artist), albumKey: normalize(entry.album), key, albumId: entry.albumId.toLowerCase(), reason: entry.reason.trim(), sources };
  });
}

async function prepareSeedPlan({ bindings, environment, fingerprint, AlbumCatalog, MappingCase, AlbumMapping, now = new Date() }) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(environment || "")) throw safeError("NAMED_ENVIRONMENT_REQUIRED");
  const entries = [];
  for (const binding of validateBindings(bindings)) {
    const album = await AlbumCatalog.findOne({ albumId: binding.albumId }).lean();
    if (!album) throw safeError("SEED_CATALOG_TARGET_MISSING");
    const mapping = await AlbumMapping.findOne({ key: binding.key }).lean();
    if (mapping) throw safeError("SEED_MAPPING_ALREADY_EXISTS");
    const mappingCase = await MappingCase.findOne({ key: binding.key }).lean();
    entries.push({ ...binding, catalogRevision: catalogRevisionOf(album), targetTitle: album.title, targetArtist: album.artistDisplayName, caseId: mappingCase?.caseId || null, expectedRevision: mappingCase?.revision || null });
  }
  return { schema: "rescened-listening-mapping-seeds/v1", environment, fingerprint, createdAt: now.toISOString(), entries };
}

function verifySeedPlan(bytes, expectedHash, environment, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash || "") || digest(bytes) !== expectedHash) throw safeError("SEED_CHECKSUM_MISMATCH");
  let plan;
  try { plan = JSON.parse(bytes); } catch { throw safeError("INVALID_SEED_PLAN"); }
  if (plan.schema !== "rescened-listening-mapping-seeds/v1" || plan.environment !== environment || plan.fingerprint !== fingerprint || !Array.isArray(plan.entries)) throw safeError("SEED_TARGET_MISMATCH");
  const bindings = validateBindings(plan.entries.map(({ artist, album, albumId, reason, sources }) => ({ artist, album, albumId, reason, sources })));
  plan.entries.forEach((entry, index) => {
    if (entry.key !== bindings[index].key || !Number.isInteger(entry.catalogRevision) || entry.catalogRevision < 1 || (entry.caseId !== null && (!Number.isInteger(entry.expectedRevision) || entry.expectedRevision < 1))) throw safeError("INVALID_SEED_PLAN");
  });
  return plan;
}

async function applySeedPlan(plan, { reviewer, mongoose, AlbumCatalog, models, now = new Date() }) {
  if (typeof reviewer !== "string" || !reviewer.trim() || reviewer.length > 200) throw safeError("SEED_REVIEWER_REQUIRED");
  const { MappingCase, AlbumMapping, MappingAudit, Job } = models;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const entry of plan.entries) {
        const album = await AlbumCatalog.findOne({ albumId: entry.albumId, catalogRevision: catalogRevisionFilter(entry.catalogRevision) }).session(session);
        if (!album) throw safeError("SEED_CATALOG_REVISION_CHANGED", 409);
        if (await AlbumMapping.exists({ key: entry.key }).session(session)) throw safeError("SEED_MAPPING_ALREADY_EXISTS", 409);
        let mappingCase = await MappingCase.findOne({ key: entry.key }).session(session);
        if (entry.caseId) {
          if (!mappingCase || mappingCase.caseId !== entry.caseId || mappingCase.revision !== entry.expectedRevision) throw safeError("SEED_CASE_REVISION_CHANGED", 409);
        } else if (mappingCase) throw safeError("SEED_CASE_REVISION_CHANGED", 409);
        const identity = { key: entry.key, provider: "lastfm", artist: entry.artist, album: entry.album, artistKey: normalize(entry.artist), albumKey: normalize(entry.album), normalizationVersion: 1 };
        const evidence = entry.sources.map((url) => ({ type: "reviewed_seed", url, reviewedAt: plan.createdAt }));
        if (!mappingCase) [mappingCase] = await MappingCase.create([{ ...identity, status: "pending", revision: 1, evidence }], { session });
        const [mapping] = await AlbumMapping.create([{ ...identity, albumId: entry.albumId, catalogRevision: entry.catalogRevision, revision: 1, status: "active", evidence, reviewer, reason: entry.reason }], { session });
        const changed = await MappingCase.updateOne({ _id: mappingCase._id, revision: mappingCase.revision }, { $set: { status: "approved", evidence }, $inc: { revision: 1 } }, { session });
        if (changed.modifiedCount !== 1) throw safeError("SEED_CASE_REVISION_CHANGED", 409);
        await MappingAudit.create([{ caseId: mappingCase.caseId, mappingId: mapping.mappingId, action: "approve", reviewer, reason: entry.reason, revision: mappingCase.revision + 1, details: { albumId: entry.albumId, catalogRevision: entry.catalogRevision, seedEnvironment: plan.environment } }], { session });
        await Job.create([{ key: `reprocess:${mapping.mappingId}:1`, type: "reprocess", payload: { key: entry.key, mappingId: mapping.mappingId, mappingRevision: 1 }, status: "pending", runAt: now }], { session });
      }
    });
  } catch (error) {
    if (require("../../routes/utils/transactions").isTransactionUnavailable(error)) throw safeError("TRANSACTIONS_UNAVAILABLE", 503);
    throw error;
  } finally { await session.endSession(); }
  return { applied: plan.entries.length, environment: plan.environment };
}

module.exports = { digest, targetFingerprint, validateBindings, prepareSeedPlan, verifySeedPlan, applySeedPlan };
