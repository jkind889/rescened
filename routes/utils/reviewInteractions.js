const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const Like = require("../../models/Like");
const Notification = require("../../models/Notification");
const Review = require("../../models/Reviews");
const UserProfile = require("../../models/UserProfile");
const { isTransactionUnavailable } = require("./transactions");

const REVIEW_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_CODES = {
  deletion: "REVIEW_DELETION_UNAVAILABLE",
  like: "REVIEW_LIKE_UNAVAILABLE",
  pin: "REVIEW_PIN_UNAVAILABLE",
};
class ReviewTransactionUnavailableError extends Error {
  constructor(action) {
    super("Review interaction is unavailable until MongoDB transactions are enabled");
    this.name = "ReviewTransactionUnavailableError";
    this.status = 503;
    this.code = ACTION_CODES[action] || ACTION_CODES.like;
  }
}

class ReviewNotFoundError extends Error {
  constructor() {
    super("Review not found");
    this.status = 404;
    this.code = "REVIEW_NOT_FOUND";
  }
}

class InvalidReviewIdError extends Error {
  constructor() {
    super("Review id is invalid");
    this.status = 400;
    this.code = "INVALID_REVIEW_ID";
  }
}

class PinnedReviewValidationError extends Error {
  constructor() {
    super("Pinned review must belong to your profile");
    this.status = 400;
    this.code = "INVALID_PINNED_REVIEW";
  }
}

function isReviewId(reviewId) {
  return REVIEW_ID_V4.test(String(reviewId || "").trim());
}

function assertReviewId(reviewId) {
  const value = String(reviewId || "").trim().toLowerCase();
  if (!isReviewId(value)) throw new InvalidReviewIdError();
  return value;
}

function persistedReviewId(review) {
  const value = String(review?.reviewId || "").trim().toLowerCase();
  if (isReviewId(value)) return value;
  const error = new Error("Review is missing a valid public identifier");
  error.status = 500;
  error.code = "REVIEW_ID_INTEGRITY_ERROR";
  throw error;
}

function sessionQuery(query, session) {
  return query && typeof query.session === "function" ? query.session(session) : query;
}

async function runReviewTransaction(action, callback) {
  let session;
  try {
    if (typeof mongoose.startSession !== "function") throw new ReviewTransactionUnavailableError(action);
    session = await mongoose.startSession();
    if (!session || typeof session.withTransaction !== "function") throw new ReviewTransactionUnavailableError(action);
    return await session.withTransaction(() => callback(session));
  } catch (error) {
    if (error instanceof ReviewTransactionUnavailableError) throw error;
    if (isTransactionUnavailable(error)) throw new ReviewTransactionUnavailableError(action);
    throw error;
  } finally {
    if (session && typeof session.endSession === "function") await session.endSession();
  }
}

async function claimReview(reviewId, userId, session) {
  const filter = { reviewId };
  if (userId !== undefined) filter.userId = userId;
  return Review.findOneAndUpdate(
    filter,
    { $inc: { interactionRevision: 1 } },
    { returnDocument: "after", session },
  );
}

async function deleteOwnedReview(reviewId, userId) {
  const id = assertReviewId(reviewId);
  return runReviewTransaction("deletion", async (session) => {
    const review = await claimReview(id, userId, session);
    if (!review) return { deleted: false };

    await Like.deleteMany({ targetType: "review", reviewId: review._id }, { session });
    await Notification.deleteMany({ type: "review_like", reviewId: review._id }, { session });
    await UserProfile.updateMany({ pinnedReviewId: review._id }, { $set: { pinnedReviewId: null } }, { session });
    const result = await Review.deleteOne({ _id: review._id, userId }, { session });
    if (result.deletedCount !== 1) throw new Error("Review deletion lost its ownership claim");
    return { deleted: true };
  });
}

async function mutateReviewLike(reviewId, userId, liked) {
  const id = assertReviewId(reviewId);
  if (typeof liked !== "boolean") throw Object.assign(new Error("liked must be true or false"), { status: 400 });
  return runReviewTransaction("like", async (session) => {
    const review = await claimReview(id, undefined, session);
    if (!review) throw new ReviewNotFoundError();

    if (liked) {
      await Like.updateOne(
        { userId, targetType: "review", reviewId: review._id },
        { $setOnInsert: { userId, targetType: "review", reviewId: review._id } },
        { upsert: true, session },
      );
      if (review.userId && review.userId !== userId && !Review.isDeletedAuthor(review.userId)) {
        await Notification.updateOne(
          { recipientUserId: review.userId, actorUserId: userId, type: "review_like", reviewId: review._id },
          { $setOnInsert: { notificationId: crypto.randomUUID(), recipientUserId: review.userId, actorUserId: userId, type: "review_like", reviewId: review._id } },
          { upsert: true, session },
        );
      }
    } else {
      await Like.deleteOne({ userId, targetType: "review", reviewId: review._id }, { session });
    }

    const album = await sessionQuery(AlbumCatalog.findById(review.albumCatalogId), session);
    const likeCount = await sessionQuery(Like.countDocuments({ targetType: "review", reviewId: review._id }), session);
    return {
      reviewId: id,
      albumId: album?.albumId || "",
      likeCount,
      likedByViewer: liked,
    };
  });
}

async function assertPinnedReview(reviewId, userId, session) {
  const id = assertReviewId(reviewId);
  const review = await claimReview(id, userId, session);
  if (!review) throw new PinnedReviewValidationError();
  return review;
}

module.exports = {
  REVIEW_ID_V4,
  ACTION_CODES,
  ReviewTransactionUnavailableError,
  ReviewNotFoundError,
  InvalidReviewIdError,
  PinnedReviewValidationError,
  isReviewId,
  assertReviewId,
  persistedReviewId,
  runReviewTransaction,
  claimReview,
  deleteOwnedReview,
  mutateReviewLike,
  assertPinnedReview,
};
