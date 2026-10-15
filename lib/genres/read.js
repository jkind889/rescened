// Public genre reads. Responses carry genreId, slug, and name only; Mongo
// _id values stay internal.

const AlbumCatalog = require("../../models/AlbumCatalog");
const { Genre } = require("../../models/Genre");
const { genreMatchKey } = require("./vocabulary");

const SEARCH_LIMIT = 10;
const MAX_QUERY_LENGTH = 40;

function toPublicGenre(genre) {
  return { genreId: genre.genreId, slug: genre.slug, name: genre.name };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Active genres for an album in stored order (primary first). Retired genres
// stay on the album until a reviewed merge remaps them, but are not shown.
async function resolveAlbumGenres(album) {
  const ids = Array.isArray(album?.genres) ? album.genres : [];
  if (!ids.length) return [];
  const rows = await Genre.find({ _id: { $in: ids }, status: "active" }).lean();
  const byId = new Map(rows.map((genre) => [String(genre._id), genre]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean).map(toPublicGenre);
}

// Matches active genres whose name or alias starts with the query, or has a
// word that does. The vocabulary is small, so an unanchored scan is fine.
async function searchGenres(query, { limit = SEARCH_LIMIT } = {}) {
  const key = genreMatchKey(String(query || "").slice(0, MAX_QUERY_LENGTH));
  if (!key) return [];
  const pattern = new RegExp(`(^| )${escapeRegex(key)}`);
  const rows = await Genre.find({
    status: "active",
    $or: [{ normalizedName: pattern }, { "aliases.normalizedName": pattern }],
  }).limit(100).lean();

  const rank = (genre) => {
    if (genre.normalizedName === key) return 0;
    if ((genre.aliases || []).some((alias) => alias.normalizedName === key)) return 1;
    if (genre.normalizedName.startsWith(key)) return 2;
    return 3;
  };
  return rows
    .map((genre) => ({ genre, rank: rank(genre) }))
    .sort((left, right) => left.rank - right.rank || left.genre.name.localeCompare(right.genre.name))
    .slice(0, limit)
    .map(({ genre }) => {
      const matchedAlias = (genre.aliases || []).find((alias) => pattern.test(alias.normalizedName) && !pattern.test(genre.normalizedName));
      return matchedAlias ? { ...toPublicGenre(genre), matchedAlias: matchedAlias.name } : toPublicGenre(genre);
    });
}

// Resolves a current slug or an alias slug (such as one kept after a rename)
// to an active genre. `canonical` is false when the caller should switch to
// the genre's current slug.
async function findGenreBySlug(slug) {
  const value = String(slug || "").trim().toLowerCase();
  if (!value) return null;
  const genre = await Genre.findOne({ status: "active", $or: [{ slug: value }, { "aliases.slug": value }] }).lean();
  if (!genre) return null;
  return { genre, canonical: genre.slug === value };
}

// Active top-level genres by name: the choices for a new genre's parent.
async function listTopLevelGenres() {
  const rows = await Genre.find({ status: "active", parent: null }).sort({ name: 1 }).lean();
  return rows.map(toPublicGenre);
}

async function genreDetail(slug) {
  const found = await findGenreBySlug(slug);
  if (!found) return null;
  const { genre, canonical } = found;
  const [parent, children, albumCount] = await Promise.all([
    genre.parent ? Genre.findOne({ _id: genre.parent, status: "active" }).lean() : null,
    Genre.find({ parent: genre._id, status: "active" }).sort({ name: 1 }).lean(),
    AlbumCatalog.countDocuments({ genres: genre._id }),
  ]);
  return {
    genre: toPublicGenre(genre),
    canonical,
    aliases: (genre.aliases || []).map((alias) => alias.name),
    parent: parent ? toPublicGenre(parent) : null,
    children: children.map(toPublicGenre),
    albumCount,
  };
}

module.exports = {
  MAX_QUERY_LENGTH,
  SEARCH_LIMIT,
  findGenreBySlug,
  genreDetail,
  listTopLevelGenres,
  resolveAlbumGenres,
  searchGenres,
  toPublicGenre,
};
