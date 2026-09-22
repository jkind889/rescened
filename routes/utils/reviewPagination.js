const crypto = require("crypto");
const mongoose = require("mongoose");
const Like = require("../../models/Like");
const Review = require("../../models/Reviews");

const DEFAULT_REVIEW_PAGE_SIZE = 20;
const MAX_REVIEW_PAGE_SIZE = 50;
const CURSOR_VERSION = 1;
const POPULAR_CURSOR_VERSION = 2;
const POPULAR_PAGE_TIMEOUT_MS = 10000;
const VALID_SORTS = new Set(["recent", "popular"]);

class ReviewFeedValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReviewFeedValidationError";
    this.status = 400;
    this.code = code;
  }
}

function cursorKey() {
  // CLERK_SECRET_KEY is already required for the API. Deployments can set a
  // dedicated REVIEW_CURSOR_SECRET to rotate cursor tokens independently.
  const secret = process.env.REVIEW_CURSOR_SECRET || process.env.CLERK_SECRET_KEY || "rescened-review-cursor-development-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

function encodeCursor(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cursorKey(), iv);
  const version = payload.sort === "popular" ? POPULAR_CURSOR_VERSION : CURSOR_VERSION;
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ v: version, ...payload }), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decodeCursor(cursor, expected) {
  if (typeof cursor !== "string" || cursor.length > 4096) {
    throw new ReviewFeedValidationError("Review cursor is invalid", "INVALID_REVIEW_CURSOR");
  }
  const parts = String(cursor || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new ReviewFeedValidationError("Review cursor is invalid", "INVALID_REVIEW_CURSOR");
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", cursorKey(), Buffer.from(parts[0], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8"));
    if (
      payload?.v !== (expected.sort === "popular" ? POPULAR_CURSOR_VERSION : CURSOR_VERSION)
      || payload.sort !== expected.sort
      || payload.scope !== expected.scope
      || !mongoose.isValidObjectId(payload.id)
      || !Number.isFinite(new Date(payload.date).getTime())
      || (payload.sort === "popular" && (
        !Number.isSafeInteger(payload.likeCount) || payload.likeCount < 0 || !validSnapshotTime(payload.snapshotTime)
      ))
    ) {
      throw new Error("cursor shape");
    }
    return { ...payload, id: new mongoose.Types.ObjectId(payload.id), date: new Date(payload.date) };
  } catch (error) {
    if (error instanceof ReviewFeedValidationError) throw error;
    throw new ReviewFeedValidationError("Review cursor is invalid", "INVALID_REVIEW_CURSOR");
  }
}

function parseLimit(value) {
  if (value === undefined || value === "") return DEFAULT_REVIEW_PAGE_SIZE;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_REVIEW_PAGE_SIZE;
  return Math.min(MAX_REVIEW_PAGE_SIZE, parsed);
}

function parseReviewFeedQuery(query, scope) {
  const sort = String(query?.sort || "recent").trim().toLowerCase();
  if (!VALID_SORTS.has(sort)) {
    throw new ReviewFeedValidationError("Review sort must be recent or popular", "INVALID_REVIEW_SORT");
  }
  const limit = parseLimit(query?.limit);
  const cursor = query?.cursor ? decodeCursor(query.cursor, { sort, scope }) : null;
  return { sort, limit, cursor, scope, snapshotTime: cursor?.snapshotTime || null };
}

function recentCursorFilter(cursor) {
  if (!cursor) return {};
  return {
    $or: [
      { date: { $lt: cursor.date } },
      { date: cursor.date, _id: { $lt: cursor.id } },
    ],
  };
}

function popularCursorFilter(cursor) {
  if (!cursor) return null;
  return {
    $or: [
      { likeCount: { $lt: cursor.likeCount } },
      { likeCount: cursor.likeCount, date: { $lt: cursor.date } },
      { likeCount: cursor.likeCount, date: cursor.date, _id: { $lt: cursor.id } },
    ],
  };
}

function buildPopularReviewPagePipeline(match, { cursor, limit }) {
  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: Like.collection.name,
        let: { currentReviewId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$targetType", "review"] },
                  { $eq: ["$reviewId", "$$currentReviewId"] },
                ],
              },
            },
          },
          { $count: "count" },
        ],
        as: "reviewLikeStats",
      },
    },
    { $set: { likeCount: { $ifNull: [{ $arrayElemAt: ["$reviewLikeStats.count", 0] }, 0] } } },
  ];
  const after = popularCursorFilter(cursor);
  if (after) pipeline.push({ $match: after });
  pipeline.push(
    { $sort: { likeCount: -1, date: -1, _id: -1 } },
    { $limit: limit + 1 },
    { $project: { _id: 1, date: 1, likeCount: 1 } },
  );
  return pipeline;
}

function validSnapshotTime(value) {
  return value && Number.isInteger(value.t) && value.t > 0 && value.t <= 0xffffffff
    && Number.isInteger(value.i) && value.i >= 0 && value.i <= 0xffffffff;
}

function popularFeedUnavailable() {
  return Object.assign(new Error("Popular reviews are temporarily unavailable. Please try again."), {
    status: 503, code: "POPULAR_REVIEWS_UNAVAILABLE",
  });
}

async function readPopularReviewPage(match, feed, db = Review.db.db) {
  const deadline = Date.now() + POPULAR_PAGE_TIMEOUT_MS;
  const remainingTime = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw popularFeedUnavailable();
    return remaining;
  };
  let snapshotTime = feed.snapshotTime;
  let cursor = feed.cursor;
  const rows = [];
  try {
    while (rows.length <= feed.limit) {
      // A real database snapshot preserves deleted/recreated likes as well as
      // new likes. A createdAt cutoff on the live Like collection cannot do so.
      const result = await db.command({
        aggregate: Review.collection.name,
        pipeline: [
          ...buildPopularReviewPagePipeline(match, { cursor, limit: feed.limit }),
          // At most 51 tiny rank tuples become one document. Requesting two
          // documents exhausts the command cursor without retaining a session
          // or server cursor between HTTP requests.
          { $group: { _id: null, rows: { $push: "$$ROOT" } } },
        ],
        cursor: { batchSize: 2 },
        readConcern: {
          level: "snapshot",
          ...(snapshotTime ? { atClusterTime: new mongoose.mongo.Timestamp(snapshotTime) } : {}),
        },
        maxTimeMS: remainingTime(),
      }, { readPreference: "primary" });
      if (!snapshotTime) {
        const timestamp = result.cursor.atClusterTime || result.atClusterTime;
        if (!timestamp) throw popularFeedUnavailable();
        snapshotTime = { t: timestamp.getHighBitsUnsigned(), i: timestamp.getLowBitsUnsigned() };
      }
      const ranked = result.cursor.firstBatch[0]?.rows || [];
      if (!ranked.length) break;

      // Freeze only ranking. Never resurrect deleted reviews or return their
      // historical text; resolve each page against current review documents.
      const current = await Review.find({ ...match, _id: { $in: ranked.map((row) => row._id) } })
        .maxTimeMS(remainingTime()).lean();
      const byId = new Map(current.map((row) => [String(row._id), row]));
      for (const rank of ranked) {
        const review = byId.get(String(rank._id));
        if (review) rows.push({ ...review, likeCount: rank.likeCount, date: rank.date });
        if (rows.length > feed.limit) break;
      }
      if (ranked.length <= feed.limit) break;
      const last = ranked.at(-1);
      cursor = { id: last._id, date: last.date, likeCount: last.likeCount };
    }
    return { rows, snapshotTime };
  } catch (error) {
    if ([239, 246, 286].includes(error?.code) || ["SnapshotTooOld", "SnapshotUnavailable"].includes(error?.codeName)) {
      if (feed.cursor) {
        throw new ReviewFeedValidationError("Review cursor has expired. Reload the list to continue.", "INVALID_REVIEW_CURSOR");
      }
      throw popularFeedUnavailable();
    }
    if ([20, 50, 72, 134].includes(error?.code)) throw popularFeedUnavailable();
    throw error;
  }
}

function nextCursorFor(review, { sort, scope, snapshotTime }) {
  if (!review) return null;
  if (sort === "popular" && !validSnapshotTime(snapshotTime)) throw popularFeedUnavailable();
  return encodeCursor({
    sort,
    scope,
    snapshotTime: sort === "popular" ? snapshotTime : undefined,
    likeCount: sort === "popular" ? Number(review.likeCount) || 0 : undefined,
    date: new Date(review.date).toISOString(),
    id: String(review._id),
  });
}

module.exports = {
  DEFAULT_REVIEW_PAGE_SIZE,
  MAX_REVIEW_PAGE_SIZE,
  ReviewFeedValidationError,
  buildPopularReviewPagePipeline,
  decodeCursor,
  encodeCursor,
  nextCursorFor,
  parseReviewFeedQuery,
  readPopularReviewPage,
  recentCursorFilter,
};
