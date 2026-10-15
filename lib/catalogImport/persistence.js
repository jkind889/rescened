const crypto = require("node:crypto");

const DATA_FIELDS = [
  "albumId",
  "title",
  "artistDisplayName",
  "artistCredits",
  "releaseType",
  "releaseDate",
  "releaseDatePrecision",
  "releaseYear",
  "tracks",
  "label",
  "cover",
  "externalReferences",
  "fieldProvenance",
  "catalogSource",
];
const IMPORT_REFRESH_FIELDS = [
  "title",
  "artistDisplayName",
  "artistCredits",
  "releaseType",
  "releaseDate",
  "releaseDatePrecision",
  "releaseYear",
  "cover",
  "externalReferences",
];
const DATE_FIELDS = ["releaseDate", "releaseDatePrecision", "releaseYear"];
const USER_PROVENANCE_SOURCES = new Set(["community", "manual"]);
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CatalogImportError extends Error {
  constructor(message, code = "CATALOG_IMPORT_FAILED", details = []) {
    super(message);
    this.name = "CatalogImportError";
    this.code = code;
    this.details = details;
  }
}

function plain(value) {
  if (value && typeof value.toObject === "function") {
    return value.toObject({ depopulate: true, versionKey: false });
  }
  return value || {};
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function parseImportArgs(argv = []) {
  const result = {
    input: "",
    report: "",
    quarantineReport: "",
    apply: false,
    dryRun: true,
    help: false,
  };
  const seen = new Set();
  let selectedMode = "";

  function takeValue(flag, index) {
    if (seen.has(flag)) throw new CatalogImportError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CatalogImportError(`${flag} requires a value`, "INVALID_ARGUMENTS");
    }
    seen.add(flag);
    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") {
      result.input = takeValue(argument, index);
      index += 1;
    } else if (argument === "--report") {
      result.report = takeValue(argument, index);
      index += 1;
    } else if (argument === "--quarantine-report") {
      result.quarantineReport = takeValue(argument, index);
      index += 1;
    } else if (argument === "--apply" || argument === "--dry-run") {
      if (selectedMode && selectedMode !== argument) {
        throw new CatalogImportError("--apply and --dry-run cannot be used together", "INVALID_ARGUMENTS");
      }
      if (selectedMode === argument) {
        throw new CatalogImportError(`${argument} may only be supplied once`, "INVALID_ARGUMENTS");
      }
      selectedMode = argument;
      result.apply = argument === "--apply";
      result.dryRun = !result.apply;
    } else if (argument === "--help") {
      if (result.help) throw new CatalogImportError("--help may only be supplied once", "INVALID_ARGUMENTS");
      result.help = true;
    } else {
      throw new CatalogImportError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
    }
  }

  if (!result.help && !result.input) {
    throw new CatalogImportError("--input is required", "INVALID_ARGUMENTS");
  }
  return result;
}

function musicBrainzReference(entityType, externalId) {
  return {
    provider: "musicbrainz",
    entityType,
    externalId: String(externalId).toLowerCase(),
    url: `https://musicbrainz.org/${entityType}/${String(externalId).toLowerCase()}`,
  };
}

function normalizeMbid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MBID_PATTERN.test(normalized) ? normalized : "";
}

function provenance(source, row, datasetMeta, extra = {}) {
  return {
    source,
    datasetId: datasetMeta.datasetId,
    datasetGeneratedAt: datasetMeta.generatedAt,
    releaseGroupMbid: row.releaseGroupMbid,
    sourceFetchedAt: clone(row.sourceFetchedAt),
    ...extra,
  };
}

function buildCatalogInput(row, datasetMeta = {}) {
  const references = [musicBrainzReference("release-group", row.releaseGroupMbid)];
  if (row.representativeReleaseMbid) {
    references.push(musicBrainzReference("release", row.representativeReleaseMbid));
  }

  const musicBrainzFields = [
    "title",
    "artistDisplayName",
    "artistCredits",
    "releaseType",
    "releaseDate",
    "releaseDatePrecision",
    "releaseYear",
  ];
  const fieldProvenance = {};
  for (const field of musicBrainzFields) {
    fieldProvenance[field] = provenance("musicbrainz", row, datasetMeta);
  }
  fieldProvenance.externalReferences = provenance("musicbrainz", row, datasetMeta, {
    representativeReleaseMbid: row.representativeReleaseMbid || null,
  });
  fieldProvenance.cover = provenance("cover-art-archive", row, datasetMeta, {
    releaseMbid: row.cover?.releaseMbid || null,
    imageId: row.cover?.imageId || null,
  });
  fieldProvenance.selectionSignals = provenance("listenbrainz", row, datasetMeta, {
    selectedRange: row.selectedRange,
    signals: clone(row.selectionSignals),
  });
  fieldProvenance._import = {
    source: "import",
    datasetId: datasetMeta.datasetId,
    schemaVersion: datasetMeta.schemaVersion,
    datasetGeneratedAt: datasetMeta.generatedAt,
    sourceLicenses: clone(datasetMeta.sourceLicenses || {}),
  };

  return {
    albumId: crypto.randomUUID(),
    title: row.title,
    artistDisplayName: row.artistDisplayName,
    artistCredits: row.artistCredits.map((credit) => ({ name: credit.name, role: "main" })),
    releaseType: row.releaseType,
    releaseDate: row.releaseDate,
    releaseDatePrecision: row.releaseDatePrecision,
    releaseYear: row.releaseYear,
    tracks: [],
    label: "",
    cover: row.cover?.url500 || "",
    externalReferences: references,
    fieldProvenance,
    catalogSource: "import",
    catalogRevision: 1,
  };
}

function fieldHasUserProvenance(fieldProvenance, field) {
  const entry = fieldProvenance?.[field];
  const source = typeof entry === "string" ? entry : entry?.source;
  return USER_PROVENANCE_SOURCES.has(String(source || "").toLowerCase());
}

function isMusicBrainzReference(reference) {
  return String(reference?.provider || "").toLowerCase() === "musicbrainz";
}

function normalizedReference(reference) {
  const provider = String(reference?.provider || "").trim().toLowerCase();
  const entityType = String(reference?.entityType || "").trim().toLowerCase();
  const externalId = String(reference?.externalId || "").trim().toLowerCase();
  if (!provider || !entityType || !externalId) return null;
  return { provider, entityType, externalId, key: `${provider}|${entityType}|${externalId}` };
}

function musicBrainzReferenceKeys(document) {
  const keys = new Set();
  for (const reference of plain(document).externalReferences || []) {
    const normalized = normalizedReference(reference);
    if (normalized?.provider === "musicbrainz") keys.add(normalized.key);
  }
  return keys;
}

function representativeReleaseMbid(document) {
  const source = plain(document);
  const candidates = [
    source.fieldProvenance?.cover?.releaseMbid,
    source.fieldProvenance?.externalReferences?.representativeReleaseMbid,
    /^https:\/\/coverartarchive\.org\/release\/([0-9a-f-]{36})\/front-500$/i.exec(String(source.cover || ""))?.[1],
  ];
  for (const candidate of candidates) {
    const mbid = normalizeMbid(candidate);
    if (mbid) return mbid;
  }
  return "";
}

function preserveExistingRepresentativeReference(existing, merged, mergedProvenance) {
  const releaseMbid = representativeReleaseMbid(existing);
  if (!releaseMbid) return;
  const existingReference = (existing.externalReferences || []).find((reference) => {
    const normalized = normalizedReference(reference);
    return normalized?.provider === "musicbrainz"
      && normalized.entityType === "release"
      && normalized.externalId === releaseMbid;
  });
  if (!existingReference) return;

  const alreadyPresent = (merged.externalReferences || []).some((reference) => {
    const normalized = normalizedReference(reference);
    return normalized?.provider === "musicbrainz"
      && normalized.entityType === "release"
      && normalized.externalId === releaseMbid;
  });
  if (!alreadyPresent) merged.externalReferences.push(clone(existingReference));

  const incomingProvenance = mergedProvenance.externalReferences || {};
  mergedProvenance.externalReferences = {
    ...incomingProvenance,
    representativeReleaseMbid: releaseMbid,
    preservedRepresentativeRelease: true,
  };
}

function mergeImportedCatalog(existingValue, incomingValue) {
  const existing = clone(plain(existingValue));
  const incoming = clone(incomingValue);
  const existingRevision = Number.isSafeInteger(Number(existing.catalogRevision)) && Number(existing.catalogRevision) > 0
    ? Number(existing.catalogRevision)
    : 1;
  const merged = { ...incoming, albumId: existing.albumId, catalogSource: "import", catalogRevision: existingRevision };
  const existingProvenance = existing.fieldProvenance || {};
  const mergedProvenance = { ...(incoming.fieldProvenance || {}) };
  const preserveExistingCover = Boolean(existing.cover) && (
    fieldHasUserProvenance(existingProvenance, "cover") || !incoming.cover
  );

  for (const field of IMPORT_REFRESH_FIELDS) {
    if (fieldHasUserProvenance(existingProvenance, field)) {
      merged[field] = clone(existing[field]);
      mergedProvenance[field] = clone(existingProvenance[field]);
    }
  }

  // A release date is one semantic value spread across three catalog fields.
  // If a user owns any part of it, retain the complete existing tuple so a
  // refresh cannot combine a manual date with imported precision/year data.
  if (DATE_FIELDS.some((field) => fieldHasUserProvenance(existingProvenance, field))) {
    for (const field of DATE_FIELDS) {
      merged[field] = clone(existing[field]);
      if (existingProvenance[field]) mergedProvenance[field] = clone(existingProvenance[field]);
    }
  }

  merged.tracks = Array.isArray(existing.tracks) ? clone(existing.tracks) : [];
  merged.label = String(existing.label || "");
  if (existingProvenance.tracks) mergedProvenance.tracks = clone(existingProvenance.tracks);
  if (existingProvenance.label) mergedProvenance.label = clone(existingProvenance.label);
  // Genres are community-owned and outside DATA_FIELDS, so the refresh never
  // writes them; keep their provenance, since fieldProvenance is set whole.
  if (existingProvenance.genres) mergedProvenance.genres = clone(existingProvenance.genres);

  if (!fieldHasUserProvenance(existingProvenance, "externalReferences")) {
    const preserved = (existing.externalReferences || []).filter((reference) => !isMusicBrainzReference(reference));
    merged.externalReferences = [...incoming.externalReferences, ...clone(preserved)];
  }

  if (!incoming.cover && existing.cover) {
    merged.cover = existing.cover;
    if (existingProvenance.cover) mergedProvenance.cover = clone(existingProvenance.cover);
  }
  if (preserveExistingCover) {
    preserveExistingRepresentativeReference(existing, merged, mergedProvenance);
  }

  merged.fieldProvenance = mergedProvenance;
  return merged;
}

function sourceMbid(item) {
  return String(item?.row?.releaseGroupMbid || item?.sourceMbid || "").toLowerCase();
}

function quarantineEntry(item, code, pointer, message) {
  return {
    rowIndex: Number.isInteger(item?.index) ? item.index : (item?.rowIndex ?? null),
    sourceMbid: sourceMbid(item) || null,
    code,
    pointer,
    message,
  };
}

async function resolveQuery(query) {
  let resolved = query;
  if (resolved && typeof resolved.lean === "function") resolved = resolved.lean();
  if (resolved && typeof resolved.exec === "function") resolved = resolved.exec();
  return resolved;
}

function comparable(document) {
  const source = plain(document);
  const picked = {};
  for (const field of DATA_FIELDS) picked[field] = clone(source[field]);
  return picked;
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSort(value[key])]));
  }
  return value;
}

function documentsEqual(left, right) {
  return JSON.stringify(stableSort(comparable(left))) === JSON.stringify(stableSort(comparable(right)));
}

function validCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function expectedDateTuple(value) {
  if (value === "") return { precision: "", year: null };
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(value));
  if (!match) return null;
  const year = Number(match[1]);
  if (match[2]) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    if (match[3] && !validCalendarDate(year, month, Number(match[3]))) return null;
  }
  return {
    precision: match[3] ? "day" : match[2] ? "month" : "year",
    year,
  };
}

function assertFinalDocumentSemantics(document, expectedReleaseGroupMbid) {
  const source = plain(document);
  const date = expectedDateTuple(source.releaseDate);
  if (!date || source.releaseDatePrecision !== date.precision || source.releaseYear !== date.year) {
    throw new CatalogImportError(
      "Merged releaseDate, releaseDatePrecision, and releaseYear must describe the same calendar value",
      "FINAL_DOCUMENT_SEMANTIC_INVALID",
    );
  }

  const seenReferences = new Set();
  let sourceReferenceCount = 0;
  for (const reference of source.externalReferences || []) {
    const normalized = normalizedReference(reference);
    if (!normalized) continue;
    if (seenReferences.has(normalized.key)) {
      throw new CatalogImportError(
        `Merged catalog document contains duplicate external reference ${normalized.key}`,
        "FINAL_DOCUMENT_SEMANTIC_INVALID",
      );
    }
    seenReferences.add(normalized.key);
    if (normalized.provider !== "musicbrainz") continue;
    if (["release-group", "release"].includes(normalized.entityType) && !normalizeMbid(normalized.externalId)) {
      throw new CatalogImportError(
        `Merged MusicBrainz ${normalized.entityType} reference is not a valid MBID`,
        "FINAL_DOCUMENT_SEMANTIC_INVALID",
      );
    }
    if (
      normalized.entityType === "release-group"
      && normalized.externalId === normalizeMbid(expectedReleaseGroupMbid)
    ) sourceReferenceCount += 1;
  }
  if (sourceReferenceCount !== 1) {
    throw new CatalogImportError(
      "Merged catalog document must retain exactly one matching MusicBrainz release-group reference",
      "FINAL_DOCUMENT_SEMANTIC_INVALID",
    );
  }

  const coverReleaseMbid = representativeReleaseMbid(source);
  if (source.cover && coverReleaseMbid) {
    const releaseKey = `musicbrainz|release|${coverReleaseMbid}`;
    if (!seenReferences.has(releaseKey)) {
      throw new CatalogImportError(
        "Merged Cover Art Archive cover must retain its MusicBrainz release reference",
        "FINAL_DOCUMENT_SEMANTIC_INVALID",
      );
    }
  }
}

async function validatedDocument(AlbumCatalog, document, existingId, expectedReleaseGroupMbid) {
  const candidate = new AlbumCatalog(existingId ? { ...document, _id: existingId } : document);
  await candidate.validate();
  const validated = comparable(candidate);
  assertFinalDocumentSemantics(validated, expectedReleaseGroupMbid);
  return validated;
}

function existingReleaseGroupMbid(album) {
  const reference = (plain(album).externalReferences || []).find((candidate) => (
    isMusicBrainzReference(candidate)
    && String(candidate.entityType || "").toLowerCase() === "release-group"
  ));
  return String(reference?.externalId || "").toLowerCase();
}

function regexExact(value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`, "i");
}

function referenceLookupQuery(referenceKeys) {
  const idsByType = new Map();
  for (const key of referenceKeys) {
    const [provider, entityType, externalId] = String(key).split("|");
    if (provider !== "musicbrainz" || !entityType || !externalId) continue;
    if (!idsByType.has(entityType)) idsByType.set(entityType, new Set());
    idsByType.get(entityType).add(externalId);
  }
  const clauses = [...idsByType.entries()].map(([entityType, externalIds]) => ({
    externalReferences: {
      $elemMatch: {
        provider: regexExact("musicbrainz"),
        entityType: regexExact(entityType),
        externalId: { $in: [...externalIds].map(regexExact) },
      },
    },
  }));
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function documentIdentity(document) {
  const source = plain(document);
  return String(source._id || source.albumId || "");
}

function buildExistingReferenceMap(existingRows) {
  const references = new Map();
  for (const album of existingRows || []) {
    for (const key of musicBrainzReferenceKeys(album)) {
      if (!references.has(key)) references.set(key, []);
      const owners = references.get(key);
      if (!owners.some((owner) => documentIdentity(owner) === documentIdentity(album))) owners.push(album);
    }
  }
  return references;
}

async function loadExistingReferenceOwners(AlbumCatalog, requestedReferenceKeys) {
  const initialQuery = referenceLookupQuery(requestedReferenceKeys);
  if (!initialQuery) return { existingRows: [], existingByReference: new Map() };

  let existingRows = await resolveQuery(AlbumCatalog.find(initialQuery));
  const expandedReferenceKeys = new Set(requestedReferenceKeys);
  for (const album of existingRows || []) {
    for (const key of musicBrainzReferenceKeys(album)) expandedReferenceKeys.add(key);
  }

  // A refresh can preserve an importer-owned cover and its representative
  // release reference even when the new dataset has no cover. Expand the
  // lookup once around the matched catalog rows so collisions on those final
  // merged keys are discovered before any operation is planned.
  if (expandedReferenceKeys.size > requestedReferenceKeys.size) {
    existingRows = await resolveQuery(AlbumCatalog.find(referenceLookupQuery(expandedReferenceKeys)));
  }
  return {
    existingRows,
    existingByReference: buildExistingReferenceMap(existingRows),
  };
}

function referencePointer(item, key) {
  return key.includes("|release-group|")
    ? `/albums/${item.index}/releaseGroupMbid`
    : `/albums/${item.index}/representativeReleaseMbid`;
}

function conflictingExistingOwner(referenceMap, keys, existing) {
  const expectedIdentity = existing ? documentIdentity(existing) : "";
  for (const key of keys) {
    const unexpected = (referenceMap.get(key) || []).find((owner) => (
      !expectedIdentity || documentIdentity(owner) !== expectedIdentity
    ));
    if (unexpected) return { key, owner: unexpected };
  }
  return null;
}

function concurrencyFilter(existing) {
  const source = plain(existing);
  const filter = { _id: source._id, catalogSource: "import" };
  filter.updatedAt = source.updatedAt === undefined ? { $exists: false } : source.updatedAt;
  filter.catalogRevision = source.catalogRevision === undefined ? { $in: [null, 1] } : source.catalogRevision;
  return filter;
}

async function preflightImport({ validation, AlbumCatalog }) {
  if (!validation || !Array.isArray(validation.validAlbums)) {
    throw new CatalogImportError("Dataset validation result is required", "INVALID_VALIDATION_RESULT");
  }
  if (validation.validAlbums.length === 0) {
    throw new CatalogImportError("Dataset contains zero valid albums", "NO_VALID_ALBUMS");
  }

  const quarantined = clone(validation.quarantined || []);
  const uniqueRows = [];
  const seen = new Set();
  for (const item of validation.validAlbums) {
    const mbid = sourceMbid(item);
    if (!mbid || seen.has(mbid)) {
      quarantined.push(quarantineEntry(
        item,
        mbid ? "DUPLICATE_SOURCE_KEY" : "MISSING_SOURCE_KEY",
        `/albums/${item.index}/releaseGroupMbid`,
        mbid ? "Duplicate MusicBrainz release-group MBID" : "Missing MusicBrainz release-group MBID",
      ));
      continue;
    }
    seen.add(mbid);
    uniqueRows.push(item);
  }

  const requestedReferenceKeys = new Set();
  for (const item of uniqueRows) {
    for (const key of musicBrainzReferenceKeys(buildCatalogInput(item.row, validation.dataset))) {
      requestedReferenceKeys.add(key);
    }
  }
  const { existingByReference } = await loadExistingReferenceOwners(
    AlbumCatalog,
    requestedReferenceKeys,
  );

  const operations = [];
  const accepted = [];
  const claimedBatchReferences = new Map();
  let conflicted = 0;
  for (const item of uniqueRows) {
    const mbid = sourceMbid(item);
    const releaseGroupKey = `musicbrainz|release-group|${mbid}`;
    const releaseGroupOwners = existingByReference.get(releaseGroupKey) || [];
    const existing = releaseGroupOwners.length === 1 ? releaseGroupOwners[0] : null;
    if (releaseGroupOwners.length > 1) {
      conflicted += 1;
      quarantined.push(quarantineEntry(
        item,
        "EXISTING_REFERENCE_CONFLICT",
        referencePointer(item, releaseGroupKey),
        "Multiple catalog albums already claim this MusicBrainz release-group MBID",
      ));
      continue;
    }
    if (existing && String(plain(existing).catalogSource || "community").toLowerCase() !== "import") {
      conflicted += 1;
      quarantined.push(quarantineEntry(
        item,
        "EXISTING_CATALOG_CONFLICT",
        `/albums/${item.index}/releaseGroupMbid`,
        `MusicBrainz release group is owned by an existing ${plain(existing).catalogSource || "community"} catalog album`,
      ));
      continue;
    }

    try {
      const incoming = buildCatalogInput(item.row, validation.dataset);
      const merged = existing ? mergeImportedCatalog(existing, incoming) : incoming;
      const document = await validatedDocument(AlbumCatalog, merged, plain(existing)._id, mbid);
      const finalReferenceKeys = musicBrainzReferenceKeys(document);
      const existingConflict = conflictingExistingOwner(existingByReference, finalReferenceKeys, existing);
      if (existingConflict) {
        conflicted += 1;
        quarantined.push(quarantineEntry(
          item,
          "EXISTING_REFERENCE_CONFLICT",
          referencePointer(item, existingConflict.key),
          `MusicBrainz reference ${existingConflict.key} is owned by another catalog album`,
        ));
        continue;
      }
      const batchConflict = [...finalReferenceKeys].find((key) => claimedBatchReferences.has(key));
      if (batchConflict) {
        conflicted += 1;
        quarantined.push(quarantineEntry(
          item,
          "DUPLICATE_MUSICBRAINZ_REFERENCE",
          referencePointer(item, batchConflict),
          `MusicBrainz reference ${batchConflict} is already claimed by album row ${claimedBatchReferences.get(batchConflict)}`,
        ));
        continue;
      }
      let action = "inserted";
      if (existing) action = documentsEqual(existing, document) ? "unchanged" : "refreshed";

      const record = {
        action,
        rowIndex: item.index,
        releaseGroupMbid: mbid,
        document,
        existingId: plain(existing)._id || null,
        existingUpdatedAt: plain(existing).updatedAt ?? null,
      };
      accepted.push(record);
      for (const key of finalReferenceKeys) claimedBatchReferences.set(key, item.index);
      if (action === "inserted") {
        operations.push({ insertOne: { document } });
      } else if (action === "refreshed") {
        operations.push({
          updateOne: {
            filter: concurrencyFilter(existing),
            update: { $set: document, $inc: { catalogRevision: 1 } },
          },
        });
      }
    } catch (error) {
      quarantined.push(quarantineEntry(
        item,
        error.code === "FINAL_DOCUMENT_SEMANTIC_INVALID" ? error.code : "MODEL_VALIDATION_FAILED",
        `/albums/${item.index}`,
        error.message,
      ));
    }
  }

  const count = (action) => accepted.filter((record) => record.action === action).length;
  return {
    datasetId: validation.dataset.datasetId,
    schemaVersion: validation.dataset.schemaVersion,
    accepted,
    operations,
    quarantined,
    counts: {
      inserted: count("inserted"),
      refreshed: count("refreshed"),
      unchanged: count("unchanged"),
      quarantined: quarantined.length,
      conflicted,
    },
  };
}

async function applyImport({ plan, AlbumCatalog, mongoose }) {
  if (!plan || !Array.isArray(plan.operations)) {
    throw new CatalogImportError("A preflight import plan is required", "INVALID_IMPORT_PLAN");
  }
  if (plan.operations.length === 0) return { applied: true, writeCount: 0 };
  if (!mongoose || typeof mongoose.startSession !== "function") {
    throw new CatalogImportError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  }

  let session;
  let transactionCompleted = false;
  try {
    session = await mongoose.startSession();
    if (typeof session.withTransaction !== "function") {
      throw new CatalogImportError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
    }
    let result;
    await session.withTransaction(async () => {
      result = await AlbumCatalog.bulkWrite(plan.operations, { session, ordered: true });
      const expectedUpdates = plan.operations.filter((operation) => operation.updateOne).length;
      if (expectedUpdates && Number(result?.matchedCount ?? expectedUpdates) !== expectedUpdates) {
        throw new CatalogImportError(
          "An imported catalog row changed after preflight",
          "CONCURRENT_CATALOG_CHANGE",
        );
      }
    });
    transactionCompleted = true;
    return { applied: true, writeCount: plan.operations.length, result };
  } catch (error) {
    error.importPlan = error.importPlan || plan;
    error.transactionState = error.transactionState || (transactionCompleted ? "committed" : "rolled-back");
    if (transactionCompleted) error.databaseCommitted = true;
    if (typeof error.code !== "string") {
      error.importErrorCode = transactionCompleted
        ? "IMPORT_COMMITTED_SESSION_CLEANUP_FAILED"
        : "TRANSACTION_ROLLED_BACK";
    }
    throw error;
  } finally {
    if (typeof session?.endSession === "function") {
      try {
        await session.endSession();
      } catch (error) {
        error.importPlan = error.importPlan || plan;
        error.transactionState = transactionCompleted ? "committed" : "rolled-back";
        error.databaseCommitted = transactionCompleted;
        error.importErrorCode = transactionCompleted
          ? "IMPORT_COMMITTED_SESSION_CLEANUP_FAILED"
          : "TRANSACTION_ROLLED_BACK";
        throw error;
      }
    }
  }
}

function createImportReport(plan, options = {}) {
  return {
    reportVersion: "1.0.0",
    datasetId: plan.datasetId,
    schemaVersion: plan.schemaVersion,
    mode: options.apply ? "apply" : "dry-run",
    generatedAt: (options.now || new Date()).toISOString(),
    applied: Boolean(options.apply),
    counts: clone(plan.counts),
    albums: plan.accepted.map(({ action, rowIndex, releaseGroupMbid }) => ({
      action,
      rowIndex,
      releaseGroupMbid,
    })),
    quarantine: clone(plan.quarantined),
  };
}

async function runImport(options = {}) {
  const AlbumCatalog = options.AlbumCatalog || require("../../models/AlbumCatalog");
  const mongoose = options.mongoose || require("mongoose");
  let validation = options.validation;
  if (!validation) {
    if (!options.input) throw new CatalogImportError("input is required", "INVALID_ARGUMENTS");
    const { readDatasetFile } = options.datasetModule || require("./dataset");
    validation = await readDatasetFile(options.input);
  }
  const plan = await preflightImport({ validation, AlbumCatalog });
  if (options.apply) {
    try {
      await applyImport({ plan, AlbumCatalog, mongoose });
    } catch (error) {
      error.importPlan = error.importPlan || plan;
      throw error;
    }
  }
  const report = createImportReport(plan, { apply: Boolean(options.apply), now: options.now });
  return {
    validation,
    plan,
    report,
    exitCode: plan.quarantined.length ? 2 : 0,
  };
}

module.exports = {
  CatalogImportError,
  parseImportArgs,
  buildCatalogInput,
  mergeImportedCatalog,
  preflightImport,
  applyImport,
  createImportReport,
  runImport,
  documentsEqual,
  assertFinalDocumentSemantics,
  concurrencyFilter,
  musicBrainzReferenceKeys,
  referenceLookupQuery,
};
