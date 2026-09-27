const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Deliberately preserves punctuation, accents, and edition distinctions.
function normalize(value) {
  return typeof value === "string" ? value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ") : "";
}

function mappingKey(artist, album) {
  return JSON.stringify(["lastfm", normalize(artist), normalize(album)]);
}

function flags(env = process.env) {
  return {
    connection: env.LASTFM_CONNECTION_ENABLED === "true",
    sync: env.LASTFM_SYNC_ENABLED === "true",
    discovery: env.LASTFM_DISCOVERY_ENABLED === "true",
    moderation: env.ALBUM_MAPPING_MODERATION_ENABLED === "true",
  };
}

function pilotAllowed(userId, env = process.env) {
  return Boolean(userId) && (env.LASTFM_PILOT_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean).includes(userId);
}

function safeError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function assertPublicAlbumId(value) {
  if (typeof value !== "string" || !PUBLIC_ID.test(value)) throw safeError("INVALID_ALBUM_ID");
  return value;
}

// Albums written before revisions were tracked have no stored field; like the
// importer and cover backfill, treat them as revision 1.
function catalogRevisionOf(album) {
  const revision = Number(album?.catalogRevision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}
function catalogRevisionFilter(revision) {
  return Number(revision) === 1 ? { $in: [null, 1] } : revision;
}

// Catalog tracks alone are not a reviewed standard baseline.
function baselineAvailable() { return false; }

module.exports = { normalize, mappingKey, flags, pilotAllowed, safeError, assertPublicAlbumId, catalogRevisionOf, catalogRevisionFilter, baselineAvailable };
