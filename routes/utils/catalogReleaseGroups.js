const AlbumCatalog = require("../../models/AlbumCatalog");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { escapeRegex } = require("./catalogSearch");

function queryResult(query) {
  let result = query;
  if (result && typeof result.lean === "function") result = result.lean();
  if (result && typeof result.exec === "function") result = result.exec();
  return result;
}

function catalogReferenceQuery(mbid) {
  return {
    externalReferences: {
      $elemMatch: {
        provider: "musicbrainz",
        entityType: "release-group",
        externalId: { $regex: `^${escapeRegex(mbid)}$`, $options: "i" },
      },
    },
  };
}

// Local catalog albums for MusicBrainz release-group MBIDs, keyed by the
// lowercase MBID. Used to keep a known release group on its public albumId
// instead of showing it as an external candidate. Never writes.
async function findCatalogAlbumsByReleaseGroup(mbids) {
  const normalizedMbids = [...new Set(mbids.map((mbid) => String(mbid || "").trim().toLowerCase()).filter(Boolean))];
  if (!normalizedMbids.length) return new Map();

  const rows = await queryResult(AlbumCatalog.find({
    $or: normalizedMbids.map(catalogReferenceQuery),
  }));
  const matches = new Map();
  (rows || []).forEach((album) => {
    const source = typeof album?.toObject === "function" ? album.toObject() : album;
    const normalized = normalizeCatalogAlbum(album);
    (Array.isArray(source?.externalReferences) ? source.externalReferences : []).forEach((reference) => {
      if (
        String(reference?.provider || "").toLowerCase() === "musicbrainz"
        && String(reference?.entityType || "").toLowerCase() === "release-group"
      ) {
        const mbid = String(reference.externalId || "").trim().toLowerCase();
        if (normalizedMbids.includes(mbid) && !matches.has(mbid)) matches.set(mbid, normalized);
      }
    });
  });
  return matches;
}

module.exports = { findCatalogAlbumsByReleaseGroup };
