// MusicBrainz discography for a registry artist, loaded separately from the
// local "On Rescened" releases. It browses by the artist's verified
// MusicBrainz MBID, one provider page per request, and reconciles each
// release group with the local catalog. A known release group is returned as
// its catalog album (public albumId, local metadata); the rest stay external
// candidates. Nothing is imported or written, and provider IDs never become
// albumIds.

const Artist = require("../../models/Artist");
const { artistMbidOf, normalizeArtistId } = require("./identity");
const { findCatalogAlbumsByReleaseGroup } = require("../../routes/utils/catalogReleaseGroups");
const musicBrainz = require("../musicBrainzSearch");
const { isExternalAlbumSearchEnabled } = require("../../routes/utils/serverConfig");

const MAX_CURSOR_LENGTH = 512;

function discographyError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseDiscographyQuery(query = {}) {
  for (const key of Object.keys(query)) {
    if (!["type", "cursor"].includes(key) || typeof query[key] !== "string") {
      throw discographyError(`Unsupported query field ${key}`, 400, "INVALID_ARTIST_DISCOGRAPHY");
    }
  }
  const type = query.type || "album";
  if (!musicBrainz.DISCOGRAPHY_FILTERS.includes(type)) {
    throw discographyError(`type must be one of ${musicBrainz.DISCOGRAPHY_FILTERS.join(", ")}`, 400, "INVALID_ARTIST_DISCOGRAPHY");
  }
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > MAX_CURSOR_LENGTH)) {
    throw discographyError("cursor is invalid", 400, "INVALID_DISCOGRAPHY_CURSOR");
  }
  return { type, cursor: query.cursor || null };
}

// The cursor names the artist, the filter, and the raw provider offset, so it
// cannot be replayed against another artist or filter.
function encodeDiscographyCursor(artistId, type, offset) {
  return Buffer.from(JSON.stringify({ v: 1, a: artistId, t: type, o: offset })).toString("base64url");
}

function decodeDiscographyCursor(artistId, type, cursor) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value?.v !== 1 || value.a !== artistId || value.t !== type || !Number.isInteger(value.o)
      || value.o < 1 || value.o > musicBrainz.MAX_PROVIDER_OFFSET) throw new Error("mismatch");
    return value.o;
  } catch {
    throw discographyError("cursor is invalid", 400, "INVALID_DISCOGRAPHY_CURSOR");
  }
}

function catalogRow(candidate, album) {
  return {
    kind: "catalog",
    externalId: candidate.externalId,
    albumId: album.albumId,
    title: album.title,
    artistDisplayName: album.artistDisplayName,
    releaseType: album.releaseType,
    releaseYear: album.releaseYear ?? null,
    cover: album.cover || "",
    sourceUrl: candidate.sourceUrl,
  };
}

async function artistDiscography(rawArtistId, query, { browse = musicBrainz.browseArtistDiscography, ArtistModel = Artist, findCatalog = findCatalogAlbumsByReleaseGroup } = {}) {
  const artistId = normalizeArtistId(rawArtistId);
  if (!artistId) throw discographyError("artistId must be a Rescened artist ID", 400, "INVALID_ARTIST_ID");
  const options = parseDiscographyQuery(query);
  const offset = decodeDiscographyCursor(artistId, options.type, options.cursor);
  const artist = await ArtistModel.findOne({ artistId }).select("artistId externalReferences").lean();
  if (!artist) throw discographyError("Artist not found", 404, "ARTIST_NOT_FOUND");
  const artistMbid = artistMbidOf(artist);
  if (!artistMbid) throw discographyError("This artist has no MusicBrainz identity", 404, "ARTIST_DISCOGRAPHY_NOT_AVAILABLE");

  const page = await browse(artistMbid, { filter: options.type, offset });
  const catalog = await findCatalog(page.candidates.map((candidate) => candidate.externalId));
  const releases = page.candidates.map((candidate) => {
    const album = catalog.get(candidate.externalId);
    return album ? catalogRow(candidate, album) : candidate;
  });
  return {
    artistId,
    source: { provider: "musicbrainz", artistUrl: `https://musicbrainz.org/artist/${artistMbid}`, license: "CC0", view: "website-default" },
    // "Suggest this album" prefills from the release-group lookup, which is
    // gated by EXTERNAL_ALBUM_SEARCH_ENABLED. Without it the UI offers only
    // the MusicBrainz link rather than a suggestion action that would fail.
    suggestionsAvailable: isExternalAlbumSearchEnabled(),
    type: options.type,
    // providerCount is MusicBrainz's raw browse total for the request in
    // providerScope, before local verification: for album, ep, and single it
    // counts every website-default group of that primary type (including
    // live, compilation, and other secondary types); for other and all it
    // counts the artist's whole website-default discography. It is not the
    // number of rows that match the filter. offset/returned describe the raw
    // provider page; filteredOut counts returned rows dropped because their
    // artist credit or type did not verify.
    providerCount: page.providerCount,
    providerScope: { status: "website-default", primaryType: ["album", "ep", "single"].includes(options.type) ? options.type : null },
    offset: page.offset,
    returned: page.returned,
    filteredOut: page.filteredOut,
    releases,
    nextCursor: page.nextOffset === null ? null : encodeDiscographyCursor(artistId, options.type, page.nextOffset),
    truncatedAtOffsetCap: page.truncatedAtOffsetCap,
  };
}

module.exports = {
  artistDiscography,
  decodeDiscographyCursor,
  encodeDiscographyCursor,
  parseDiscographyQuery,
};
