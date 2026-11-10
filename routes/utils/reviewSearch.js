const AlbumCatalog = require("../../models/AlbumCatalog");

const MAX_REVIEW_SEARCH_LENGTH = 200;
const REVIEW_SEARCH_TIMEOUT_MS = 10000;

function normalizeReviewSearch(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > MAX_REVIEW_SEARCH_LENGTH) {
    throw Object.assign(new Error(`Review search must be text of ${MAX_REVIEW_SEARCH_LENGTH} characters or fewer`), {
      status: 400, code: "INVALID_REVIEW_SEARCH",
    });
  }
  // Preserve Unicode literally: lowercasing can expand characters such as İ.
  // The database regex supplies case-insensitive matching without rewriting text.
  return value.trim().replace(/\s+/gu, " ");
}

function reviewSearchStages(search) {
  if (!search) return [];
  // Literal substring matching, not a caller-supplied regular expression.
  // Start from this author's reviews and join each catalog record by its _id;
  // never scan the whole catalog or materialize an unbounded list of album IDs.
  // Match the same Unicode whitespace that JavaScript normalizes above; Mongo
  // PCRE does not necessarily give \s the same Unicode semantics.
  const pattern = search.split(" ").map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+");
  return [
    { $lookup: {
      from: AlbumCatalog.collection.name,
      localField: "albumCatalogId",
      foreignField: "_id",
      pipeline: [
        { $match: { $or: ["title", "artistDisplayName", "artistCredits.name"].map((field) => ({ [field]: { $regex: pattern, $options: "i" } })) } },
        { $project: { _id: 1 } },
      ],
      as: "reviewSearchAlbum",
    } },
    { $match: { "reviewSearchAlbum.0": { $exists: true } } },
    { $unset: "reviewSearchAlbum" },
  ];
}

module.exports = { MAX_REVIEW_SEARCH_LENGTH, REVIEW_SEARCH_TIMEOUT_MS, normalizeReviewSearch, reviewSearchStages };
