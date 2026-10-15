// Context for a moderator reviewing a genre suggestion: what the album has
// now, whether that differs from what the contributor saw, and existing
// genres that look like each proposed new name (candidates to map onto).

const AlbumCatalog = require("../../models/AlbumCatalog");
const { Genre } = require("../../models/Genre");

const MAX_CANDIDATES = 5;
const MAX_VOCABULARY_SCAN = 5000;

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function genreRef(genre) {
  return { genreId: genre.genreId, slug: genre.slug, name: genre.name };
}

function editDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

// Ranks vocabulary entries against one proposed matching key:
// 0 exact name or alias; 1 close spelling, ignoring spaces ("hiphop");
// 2 one name contains the other ("lofi hiphop" contains "hip hop");
// 3 a shared word.
function rankCandidate(key, genre) {
  const names = [genre.normalizedName, ...(genre.aliases || []).map((alias) => alias.normalizedName)];
  if (names.includes(key)) return { rank: 0, match: "exact" };
  const compactKey = key.replace(/ /g, "");
  const compactNames = names.map((name) => name.replace(/ /g, ""));
  if (compactKey.length >= 4 && compactNames.some((name) => editDistance(compactKey, name, 2) <= 2)) return { rank: 1, match: "spelling" };
  if (compactNames.some((name) => Math.min(name.length, compactKey.length) >= 4 && (compactKey.includes(name) || name.includes(compactKey)))) {
    return { rank: 2, match: "contains" };
  }
  const words = new Set(key.split(" ").filter((word) => word.length >= 3));
  if (names.some((name) => name.split(" ").some((word) => words.has(word)))) return { rank: 3, match: "word" };
  return null;
}

function candidatesFor(key, vocabulary) {
  return vocabulary
    .map((genre) => ({ genre, score: rankCandidate(key, genre) }))
    .filter((entry) => entry.score)
    .sort((left, right) => left.score.rank - right.score.rank || left.genre.name.localeCompare(right.genre.name))
    .slice(0, MAX_CANDIDATES)
    .map(({ genre, score }) => ({ ...genreRef(genre), match: score.match }));
}

async function genreReview(submission) {
  const source = plain(submission) || {};
  const targetId = plain(source.targetAlbumCatalogId)?._id || source.targetAlbumCatalogId;
  const album = targetId ? await AlbumCatalog.findById(targetId).select("genres").lean() : null;
  const ids = (album?.genres || []).map(String);
  const rows = ids.length ? await Genre.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(rows.map((genre) => [String(genre._id), genre]));
  const currentGenres = ids.map((id) => byId.get(id)).filter(Boolean)
    .map((genre) => ({ ...genreRef(genre), status: genre.status }));
  const baseline = (source.genreBaseline?.genres || []).map((genre) => genre.genreId);
  const stale = JSON.stringify(baseline) !== JSON.stringify(currentGenres.map((genre) => genre.genreId));

  const additions = source.genreChanges?.additions || [];
  const needsCandidates = additions.some((entry) => entry.newGenre);
  const vocabulary = needsCandidates
    ? await Genre.find({ status: "active" }).select("genreId slug name normalizedName aliases").limit(MAX_VOCABULARY_SCAN).lean()
    : [];
  return {
    albumMissing: !album,
    currentGenres,
    stale,
    newGenreCandidates: additions.map((entry) => (entry.newGenre ? candidatesFor(entry.newGenre.normalizedName, vocabulary) : null)),
  };
}

module.exports = { candidatesFor, editDistance, genreReview, rankCandidate };
