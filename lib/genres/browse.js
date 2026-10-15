// Albums for a genre's browse page. Two orders, both keyset-paged:
//   rating: albums with at least MIN_RATED_REVIEWS reviews first, by community
//           average, then review count; the rest follow in the same order.
//   recent: by most recent review; albums nobody reviewed come last.
// Sub-genres are included unless the caller opts out.

const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const Review = require("../../models/Reviews");
const { Genre } = require("../../models/Genre");
const { findGenreBySlug, toPublicGenre } = require("./read");

const SORTS = ["rating", "recent"];
const MIN_RATED_REVIEWS = 3;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const EPOCH = new Date(0);

function browseError(message, status = 400, code = "INVALID_GENRE_BROWSE") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function encodeCursor(sort, row) {
  const value = sort === "rating"
    ? { s: sort, r: row.rated, a: row.averageRating, c: row.reviewCount, id: String(row._id) }
    : { s: sort, t: new Date(row.lastActivity).toISOString(), id: String(row._id) };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(sort, cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value.s !== sort || !mongoose.isValidObjectId(value.id)) throw new Error("mismatch");
    const id = new mongoose.Types.ObjectId(value.id);
    if (sort === "rating") {
      if (![0, 1].includes(value.r) || !Number.isFinite(value.a) || !Number.isInteger(value.c)) throw new Error("bad");
      return { $or: [
        { rated: { $lt: value.r } },
        { rated: value.r, averageRating: { $lt: value.a } },
        { rated: value.r, averageRating: value.a, reviewCount: { $lt: value.c } },
        { rated: value.r, averageRating: value.a, reviewCount: value.c, _id: { $gt: id } },
      ] };
    }
    const time = new Date(value.t);
    if (Number.isNaN(time.getTime())) throw new Error("bad");
    return { $or: [{ lastActivity: { $lt: time } }, { lastActivity: time, _id: { $gt: id } }] };
  } catch {
    throw browseError("cursor is invalid", 400, "INVALID_GENRE_CURSOR");
  }
}

function parseBrowseQuery(query = {}) {
  for (const key of Object.keys(query)) {
    if (!["sort", "includeChildren", "cursor", "limit"].includes(key) || typeof query[key] !== "string") {
      throw browseError(`Unsupported query field ${key}`);
    }
  }
  const sort = query.sort || "rating";
  if (!SORTS.includes(sort)) throw browseError("sort must be rating or recent");
  if (query.includeChildren !== undefined && !["true", "false"].includes(query.includeChildren)) {
    throw browseError("includeChildren must be true or false");
  }
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw browseError(`limit must be 1-${MAX_LIMIT}`);
  if (query.cursor !== undefined && query.cursor.length > 512) throw browseError("cursor is invalid", 400, "INVALID_GENRE_CURSOR");
  return { sort, includeChildren: query.includeChildren !== "false", cursor: query.cursor || null, limit };
}

function albumCard(row) {
  return {
    albumId: row.albumId,
    title: row.title || "",
    artistDisplayName: row.artistDisplayName || "",
    releaseYear: row.releaseYear ?? null,
    releaseType: row.releaseType || "album",
    cover: row.cover || "",
    reviewCount: row.reviewCount,
    averageRating: row.reviewCount ? Math.round(row.averageRating * 10) / 10 : null,
  };
}

async function genreAlbums(slug, query) {
  const options = parseBrowseQuery(query);
  const found = await findGenreBySlug(slug);
  if (!found) throw browseError("Genre not found", 404, "GENRE_NOT_FOUND");
  const { genre } = found;
  const children = options.includeChildren
    ? await Genre.find({ parent: genre._id, status: "active" }).select("_id").lean()
    : [];
  const ids = [genre._id, ...children.map((child) => child._id)];
  const cursorMatch = decodeCursor(options.sort, options.cursor);
  const sortStage = options.sort === "rating"
    ? { rated: -1, averageRating: -1, reviewCount: -1, _id: 1 }
    : { lastActivity: -1, _id: 1 };

  const rows = await AlbumCatalog.aggregate([
    { $match: { genres: { $in: ids } } },
    { $project: { albumId: 1, title: 1, artistDisplayName: 1, releaseYear: 1, releaseType: 1, cover: 1 } },
    {
      $lookup: {
        from: Review.collection.name,
        localField: "_id",
        foreignField: "albumCatalogId",
        pipeline: [{ $group: { _id: null, count: { $sum: 1 }, average: { $avg: "$rating" }, last: { $max: "$date" } } }],
        as: "stats",
      },
    },
    { $set: {
      reviewCount: { $ifNull: [{ $arrayElemAt: ["$stats.count", 0] }, 0] },
      averageRating: { $ifNull: [{ $arrayElemAt: ["$stats.average", 0] }, 0] },
      lastActivity: { $ifNull: [{ $arrayElemAt: ["$stats.last", 0] }, EPOCH] },
    } },
    { $set: { rated: { $cond: [{ $gte: ["$reviewCount", MIN_RATED_REVIEWS] }, 1, 0] } } },
    ...(cursorMatch ? [{ $match: cursorMatch }] : []),
    { $sort: sortStage },
    { $limit: options.limit + 1 },
  ]);
  const page = rows.slice(0, options.limit);
  return {
    genre: toPublicGenre(genre),
    canonical: found.canonical,
    sort: options.sort,
    includeChildren: options.includeChildren,
    minimumReviews: MIN_RATED_REVIEWS,
    albums: page.map(albumCard),
    nextCursor: rows.length > options.limit ? encodeCursor(options.sort, page[page.length - 1]) : null,
  };
}

// Album _ids for a genre filter (the genre and, by default, its sub-genres).
async function genreFilterIds(slug, { includeChildren = true } = {}) {
  const found = await findGenreBySlug(slug);
  if (!found) return null;
  const children = includeChildren ? await Genre.find({ parent: found.genre._id, status: "active" }).select("_id").lean() : [];
  return { genre: toPublicGenre(found.genre), ids: [found.genre._id, ...children.map((child) => child._id)] };
}

module.exports = {
  MAX_LIMIT,
  MIN_RATED_REVIEWS,
  genreAlbums,
  genreFilterIds,
  parseBrowseQuery,
};
