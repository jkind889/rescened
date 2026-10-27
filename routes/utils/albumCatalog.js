const crypto = require("node:crypto");
const AlbumCatalog = require("../../models/AlbumCatalog");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_TYPES = new Set(["album", "ep", "single", "mixtape", "soundtrack", "compilation", "live", "remix", "other"]);

function isAlbumId(value) {
  return UUID_V4.test(String(value || "").trim());
}

function requireAlbumId(value) {
  const albumId = String(value || "").trim().toLowerCase();
  if (!isAlbumId(albumId)) {
    const error = new Error("albumId must be a UUID v4");
    error.status = 400;
    throw error;
  }
  return albumId;
}

function deriveReleaseYear(releaseDate) {
  const match = String(releaseDate || "").match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function deriveReleasePrecision(releaseDate) {
  const value = String(releaseDate || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "day";
  if (/^\d{4}-\d{2}$/.test(value)) return "month";
  if (/^\d{4}$/.test(value)) return "year";
  return "";
}

function normalizeTrack(track, index) {
  const title = String(track?.title || "").trim();
  if (!title) return null;
  return {
    trackId: String(track?.trackId || crypto.randomUUID()).trim(),
    discNumber: Math.max(Number(track?.discNumber) || 1, 1),
    trackNumber: Math.max(Number(track?.trackNumber) || index + 1, 1),
    title,
    durationMs: Math.max(Number(track?.durationMs) || 0, 0),
    artistDisplayName: String(track?.artistDisplayName || "").trim(),
  };
}

function normalizeAlbumInput(input = {}, options = {}) {
  const title = String(input.title || "").trim();
  const artistDisplayName = String(input.artistDisplayName || input.artist || "").trim();
  if (!title || !artistDisplayName) {
    const error = new Error("title and artistDisplayName are required");
    error.status = 400;
    throw error;
  }

  const releaseDate = String(input.releaseDate || "").trim();
  const releaseType = RELEASE_TYPES.has(input.releaseType) ? input.releaseType : "album";
  const artistCredits = (Array.isArray(input.artistCredits) ? input.artistCredits : [])
    .map((credit) => ({ name: String(credit?.name || credit || "").trim(), role: String(credit?.role || "main").trim() }))
    .filter((credit) => credit.name);
  if (artistCredits.length === 0) artistCredits.push({ name: artistDisplayName, role: "main" });

  const externalReferences = (Array.isArray(input.externalReferences) ? input.externalReferences : [])
    .map((reference) => ({
      provider: String(reference?.provider || "").trim().toLowerCase(),
      entityType: String(reference?.entityType || "album").trim().toLowerCase(),
      externalId: String(reference?.externalId || "").trim(),
      url: String(reference?.url || "").trim(),
    }))
    .filter((reference) => reference.provider && reference.entityType && reference.externalId)
    .map((reference) => ({ ...reference, url: reference.url.startsWith("https://") ? reference.url : "" }))
    .filter((reference, index, all) => all.findIndex((candidate) => (
      candidate.provider === reference.provider
      && candidate.entityType === reference.entityType
      && candidate.externalId === reference.externalId
    )) === index);

  return {
    albumId: options.albumId || (isAlbumId(input.albumId) ? String(input.albumId).trim().toLowerCase() : crypto.randomUUID()),
    title,
    artistDisplayName,
    artistCredits,
    releaseType,
    releaseDate,
    releaseDatePrecision: ["year", "month", "day"].includes(input.releaseDatePrecision) ? input.releaseDatePrecision : deriveReleasePrecision(releaseDate),
    releaseYear: Number.isInteger(Number(input.releaseYear)) && Number(input.releaseYear) > 0 ? Number(input.releaseYear) : deriveReleaseYear(releaseDate),
    tracks: (Array.isArray(input.tracks) ? input.tracks : []).map(normalizeTrack).filter(Boolean),
    label: String(input.label || "").trim(),
    cover: String(input.cover || "").trim(),
    externalReferences,
    fieldProvenance: input.fieldProvenance && typeof input.fieldProvenance === "object" ? input.fieldProvenance : {},
    catalogSource: ["community", "import", "manual"].includes(input.catalogSource) ? input.catalogSource : "community",
    catalogRevision: Number.isInteger(input.catalogRevision) && input.catalogRevision > 0 ? input.catalogRevision : 1,
  };
}

// Exactly the fields normalizeCatalogAlbum reads, for album lookups that only
// serialize the public shape. Skips fieldProvenance and other internal fields.
const CATALOG_ALBUM_FIELDS = "albumId title artistDisplayName artistCredits releaseType releaseDate releaseDatePrecision releaseYear cover tracks label externalReferences catalogSource";

function normalizeCatalogAlbum(album) {
  if (!album) return null;
  const source = typeof album.toObject === "function" ? album.toObject() : album;
  return {
    albumId: source.albumId,
    title: source.title || "",
    artistDisplayName: source.artistDisplayName || "",
    artistCredits: Array.isArray(source.artistCredits) ? source.artistCredits : [],
    releaseType: source.releaseType || "album",
    releaseDate: source.releaseDate || "",
    releaseDatePrecision: source.releaseDatePrecision || "",
    releaseYear: source.releaseYear ?? deriveReleaseYear(source.releaseDate),
    cover: source.cover || "",
    tracks: Array.isArray(source.tracks) ? source.tracks : [],
    label: source.label || "",
    externalReferences: Array.isArray(source.externalReferences) ? source.externalReferences : [],
    catalogSource: source.catalogSource || "community",
  };
}

function toSearchResult(album) {
  return normalizeCatalogAlbum(album);
}

function validateCatalogDocument(input, options = {}) {
  const value = options.existingId ? { ...input, _id: options.existingId } : input;
  const document = new AlbumCatalog(value);
  const error = document.validateSync();
  if (error) throw error;
  return document;
}

async function findAlbumByPublicId(albumId) {
  const normalized = requireAlbumId(albumId);
  const album = await AlbumCatalog.findOne({ albumId: normalized });
  if (!album) {
    const error = new Error("Album not found");
    error.status = 404;
    throw error;
  }
  return album;
}

async function createCatalogAlbum(input, options = {}) {
  const normalized = normalizeAlbumInput(input);
  if (options.session) {
    const created = await AlbumCatalog.create([normalized], { session: options.session });
    return Array.isArray(created) ? created[0] : created;
  }
  return AlbumCatalog.create(normalized);
}

module.exports = {
  UUID_V4,
  CATALOG_ALBUM_FIELDS,
  isAlbumId,
  requireAlbumId,
  normalizeAlbumInput,
  normalizeCatalogAlbum,
  validateCatalogDocument,
  toSearchResult,
  findAlbumByPublicId,
  createCatalogAlbum,
};
