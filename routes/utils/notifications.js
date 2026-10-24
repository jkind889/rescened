const crypto = require("node:crypto");
const AlbumCatalog = require("../../models/AlbumCatalog");
const AlbumSubmission = require("../../models/AlbumSubmission");
const BoardItem = require("../../models/BoardItem");
const BoardListen = require("../../models/BoardListen");
const Follow = require("../../models/Follow");
const Notification = require("../../models/Notification");
const Review = require("../../models/Reviews");
const UserProfile = require("../../models/UserProfile");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { liveMembershipStages } = require("./boardLibrary");

const { MODERATION_ACTOR_ID } = Notification;
const MUTABLE_TYPES = Object.freeze(["review_like", "follow", "followed_review"]);
// Contributors must always learn when a suggestion needs changes.
const LOCKED_TYPES = Object.freeze(["suggestion_status"]);
const REVIEW_TYPES = Object.freeze(["review_like", "followed_review"]);
const PAGE_SIZE = 30;
const MAX_IDS_PER_REQUEST = 100;
// Bounds the work one review creation can trigger inside the request. If the
// warning fires in practice, move the fan-out to the worker instead of raising it.
const FOLLOWED_REVIEW_CAP = 500;
const FOLLOWER_BATCH_SIZE = 1000;
const NOTIFICATION_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODERATION_ACTOR = Object.freeze({ userId: null, username: "Rescened moderators", imageUrl: "", isSystem: true });

class NotificationRequestError extends Error {
  constructor(message, code = "INVALID_NOTIFICATION_REQUEST") {
    super(message);
    this.name = "NotificationRequestError";
    this.status = 400;
    this.code = code;
  }
}

function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function withSession(query, session) { return session && query && typeof query.session === "function" ? query.session(session) : query; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function persistedNotificationId(notification) {
  const value = String(notification?.notificationId || "").trim().toLowerCase();
  if (NOTIFICATION_ID_V4.test(value)) return value;
  const error = new Error("Notification is missing a valid public identifier");
  error.status = 500;
  error.code = "NOTIFICATION_ID_INTEGRITY_ERROR";
  throw error;
}

// Preferences

function serializePreferences(profile) {
  const stored = plain(profile)?.notificationPreferences || {};
  const preferences = Object.fromEntries(MUTABLE_TYPES.map((type) => [type, stored[type] !== false]));
  LOCKED_TYPES.forEach((type) => { preferences[type] = true; });
  return { preferences, locked: [...LOCKED_TYPES] };
}

// Returns the $set for a partial preferences update. Unknown keys and
// non-boolean values are rejected; turning a locked type off is a distinct error.
function normalizePreferencesPatch(body) {
  if (!isRecord(body)) throw new NotificationRequestError("Notification preferences must be an object", "INVALID_NOTIFICATION_PREFERENCES");
  const keys = Object.keys(body);
  if (!keys.length) throw new NotificationRequestError("Choose at least one notification preference", "INVALID_NOTIFICATION_PREFERENCES");
  const set = {};
  for (const key of keys) {
    const known = MUTABLE_TYPES.includes(key) || LOCKED_TYPES.includes(key);
    if (!known) throw new NotificationRequestError(`${key} is not a notification preference`, "INVALID_NOTIFICATION_PREFERENCES");
    if (typeof body[key] !== "boolean") throw new NotificationRequestError(`${key} must be true or false`, "INVALID_NOTIFICATION_PREFERENCES");
    if (LOCKED_TYPES.includes(key)) {
      if (!body[key]) throw new NotificationRequestError(`${key} notifications cannot be turned off`, "NOTIFICATION_PREFERENCE_LOCKED");
      continue;
    }
    set[`notificationPreferences.${key}`] = body[key];
  }
  return set;
}

// Preferences are checked on write, so muted types never create rows.
async function mutedUserIds(userIds, type, session) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!MUTABLE_TYPES.includes(type) || !ids.length) return new Set();
  const rows = await withSession(
    UserProfile.find({ userId: { $in: ids }, [`notificationPreferences.${type}`]: false }, { userId: 1 }),
    session,
  );
  return new Set((rows || []).map((row) => plain(row).userId));
}

async function isMuted(userId, type, session) {
  return (await mutedUserIds([userId], type, session)).has(userId);
}

// Writes

async function recordFollow({ recipientUserId, actorUserId }) {
  if (await isMuted(recipientUserId, "follow")) return false;
  const key = { recipientUserId, actorUserId, type: "follow" };
  await Notification.updateOne(key, { $setOnInsert: { ...key, notificationId: crypto.randomUUID() } }, { upsert: true });
  return true;
}

// Runs inside the like transaction, so the read of the recipient's
// preference and the insert commit together.
async function recordReviewLike({ review, actorUserId, session }) {
  const recipientUserId = review.userId;
  if (!recipientUserId || recipientUserId === actorUserId || Review.isDeletedAuthor(recipientUserId)) return false;
  if (await isMuted(recipientUserId, "review_like", session)) return false;
  const key = { recipientUserId, actorUserId, type: "review_like", reviewId: review._id };
  await Notification.updateOne(key, { $setOnInsert: { ...key, notificationId: crypto.randomUUID() } }, { upsert: true, session });
  return true;
}

// Must run in the transaction that moves the suggestion to `status`. The dedup
// key includes the moderated revision, so an idempotent retry inserts nothing
// while a later decision on a revised suggestion still notifies.
async function recordSuggestionStatus({ submission, status, actorUserId, session }) {
  if (!session) throw new Error("Suggestion notifications require a transaction session");
  const source = plain(submission);
  const recipientUserId = source?.submittedByUserId;
  if (!recipientUserId || recipientUserId === actorUserId) return false;
  const key = {
    recipientUserId,
    type: "suggestion_status",
    submissionId: source._id,
    submissionRevision: source.currentRevision,
    submissionStatus: status,
  };
  await Notification.updateOne(
    key,
    { $setOnInsert: { ...key, notificationId: crypto.randomUUID(), actorUserId: MODERATION_ACTOR_ID } },
    { upsert: true, session },
  );
  return true;
}

// Keeps followers in follow order (most recent first) and stops adding at the
// cap; everyone eligible past it counts as skipped.
function takeRecipients(state, orderedIds, withAlbum, muted, cap) {
  for (const id of orderedIds) {
    if (!withAlbum.has(id) || muted.has(id)) continue;
    if (state.recipients.length < cap) state.recipients.push(id);
    else state.skipped += 1;
  }
  return state;
}

async function followersWithAlbum(followerIds, albumCatalogId) {
  const match = { albumCatalogId, userId: { $in: followerIds } };
  const [saved, linked] = await Promise.all([
    BoardItem.distinct("userId", match),
    BoardListen.aggregate([...liveMembershipStages(match), { $group: { _id: "$userId" } }]),
  ]);
  return new Set([...saved, ...linked.map((row) => row._id)]);
}

async function followedReviewRecipients({ reviewerId, albumCatalogId, cap = FOLLOWED_REVIEW_CAP }) {
  const state = { recipients: [], skipped: 0 };
  let batch = [];
  const flush = async () => {
    const ids = batch.filter((id) => id && id !== reviewerId);
    batch = [];
    if (!ids.length) return;
    const [withAlbum, muted] = await Promise.all([
      followersWithAlbum(ids, albumCatalogId),
      mutedUserIds(ids, "followed_review"),
    ]);
    takeRecipients(state, ids, withAlbum, muted, cap);
  };
  const follows = Follow.find({ followingId: reviewerId }, { followerId: 1 })
    .sort({ createdAt: -1, _id: -1 })
    .lean()
    .cursor({ batchSize: FOLLOWER_BATCH_SIZE });
  for await (const follow of follows) {
    batch.push(follow.followerId);
    if (batch.length >= FOLLOWER_BATCH_SIZE) await flush();
  }
  await flush();
  return state;
}

function onlyDuplicateKeyErrors(error) {
  const errors = error?.writeErrors || error?.result?.getWriteErrors?.() || [];
  return error?.code === 11000 || (errors.length > 0 && errors.every((item) => (item.code ?? item.err?.code) === 11000));
}

// Best-effort fan-out after a review is created. Upserts make a retried
// creation harmless. Recipients only ever learn about their own boards.
async function fanOutFollowedReview(review, { cap = FOLLOWED_REVIEW_CAP, logger = console } = {}) {
  const source = plain(review);
  const reviewerId = source?.userId;
  if (!source?._id || !reviewerId || Review.isDeletedAuthor(reviewerId)) return { notified: 0, skipped: 0 };
  const albumCatalogId = source.albumCatalogId?._id || source.albumCatalogId;
  const { recipients, skipped } = await followedReviewRecipients({ reviewerId, albumCatalogId, cap });
  if (skipped > 0) {
    logger.warn("[notifications] followed_review fan-out hit its cap", {
      reviewId: source.reviewId, cap, notified: recipients.length, skipped,
    });
  }
  if (!recipients.length) return { notified: 0, skipped };
  try {
    await Notification.bulkWrite(recipients.map((recipientUserId) => {
      const key = { recipientUserId, type: "followed_review", reviewId: source._id };
      return {
        updateOne: {
          filter: key,
          update: { $setOnInsert: { ...key, actorUserId: reviewerId, notificationId: crypto.randomUUID() } },
          upsert: true,
        },
      };
    }), { ordered: false });
  } catch (error) {
    // A concurrent retry of the same creation already inserted those rows.
    if (!onlyDuplicateKeyErrors(error)) throw error;
  }
  // Review deletion removes these rows in its transaction, but a deletion that
  // committed while the fan-out ran would miss the rows written after it.
  if (!(await Review.exists({ _id: source._id }))) {
    await Notification.deleteMany({ type: "followed_review", reviewId: source._id });
    return { notified: 0, skipped };
  }
  return { notified: recipients.length, skipped };
}

// Reads

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    createdAt: new Date(row.createdAt).toISOString(),
    notificationId: persistedNotificationId(row),
  })).toString("base64url");
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    if (typeof value !== "string") throw new Error("invalid");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const createdAt = new Date(decoded?.createdAt);
    const notificationId = String(decoded?.notificationId || "").toLowerCase();
    if (Number.isNaN(createdAt.getTime()) || !NOTIFICATION_ID_V4.test(notificationId)) throw new Error("invalid");
    return { createdAt, notificationId };
  } catch {
    throw new NotificationRequestError("Notification cursor is invalid", "INVALID_NOTIFICATION_CURSOR");
  }
}

function cursorFilter(cursor) {
  if (!cursor) return {};
  return { $or: [
    { createdAt: { $lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, notificationId: { $lt: cursor.notificationId } },
  ] };
}

async function readPage(recipientUserId, cursorValue, limit = PAGE_SIZE) {
  const cursor = decodeCursor(cursorValue);
  const rows = await Notification.find({ recipientUserId, ...cursorFilter(cursor) })
    .sort({ createdAt: -1, notificationId: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? encodeCursor(page.at(-1)) : null };
}

function idKey(value) { return String(value?._id || value || ""); }

async function reviewSubjects(rows) {
  const ids = [...new Set(rows.filter((row) => REVIEW_TYPES.includes(row.type)).map((row) => idKey(row.reviewId)).filter(Boolean))];
  if (!ids.length) return new Map();
  const reviews = await Review.find({ _id: { $in: ids } }).lean();
  const albums = await AlbumCatalog.find({ _id: { $in: [...new Set(reviews.map((review) => idKey(review.albumCatalogId)))] } });
  const albumMap = new Map(albums.map((album) => [idKey(album), normalizeCatalogAlbum(album)]));
  // Required here because reviewInteractions requires this module for likes.
  const { persistedReviewId } = require("./reviewInteractions");
  return new Map(reviews.map((review) => {
    const album = albumMap.get(idKey(review.albumCatalogId)) || null;
    return [idKey(review), { review: { reviewId: persistedReviewId(review), rating: review.rating }, album }];
  }));
}

async function suggestionSubjects(rows) {
  const ids = [...new Set(rows.filter((row) => row.type === "suggestion_status").map((row) => idKey(row.submissionId)).filter(Boolean))];
  if (!ids.length) return new Map();
  const submissions = await AlbumSubmission.find({ _id: { $in: ids } })
    .populate("approvedAlbumCatalogId")
    .populate("targetAlbumCatalogId")
    .lean();
  return new Map(submissions.map((submission) => {
    const album = normalizeCatalogAlbum(submission.approvedAlbumCatalogId || submission.targetAlbumCatalogId);
    return [idKey(submission), {
      submissionId: submission.submissionId,
      submissionType: submission.submissionType || "new_album",
      title: album?.title || submission.proposedMetadata?.title || "",
      ...(album?.albumId ? { albumId: album.albumId } : {}),
    }];
  }));
}

function subjectFor(row, reviews, suggestions) {
  if (REVIEW_TYPES.includes(row.type)) return reviews.get(idKey(row.reviewId)) || null;
  if (row.type === "suggestion_status") {
    const suggestion = suggestions.get(idKey(row.submissionId));
    return suggestion ? { ...suggestion, status: row.submissionStatus } : null;
  }
  return null;
}

// actors maps Clerk user IDs to { userId, username, imageUrl }.
async function serializeNotifications(rows, actors) {
  const [reviews, suggestions] = await Promise.all([reviewSubjects(rows), suggestionSubjects(rows)]);
  return rows.map((row) => {
    const isSystem = row.actorUserId === MODERATION_ACTOR_ID;
    const subject = subjectFor(row, reviews, suggestions);
    const review = REVIEW_TYPES.includes(row.type) && subject ? subject : null;
    return {
      notificationId: persistedNotificationId(row),
      type: row.type,
      actor: isSystem ? { ...MODERATION_ACTOR } : actors.get(row.actorUserId) || { userId: row.actorUserId, username: "rescened user", imageUrl: "" },
      actorUserId: isSystem ? null : row.actorUserId,
      subject,
      readAt: row.readAt || null,
      createdAt: row.createdAt,
      // Pre-subject fields, kept while older clients still read them.
      reviewId: review?.review.reviewId || "",
      albumId: review?.album?.albumId || "",
      review: review ? { reviewId: review.review.reviewId, albumId: review.album?.albumId || "", album: review.album, rating: review.review.rating } : null,
    };
  });
}

// Read state

function normalizeSelection(body) {
  if (!isRecord(body)) throw new NotificationRequestError("Request body must be an object");
  const keys = Object.keys(body);
  if (keys.length !== 1 || !["notificationIds", "all"].includes(keys[0])) {
    throw new NotificationRequestError("Send either notificationIds or all");
  }
  if (keys[0] === "all") {
    if (body.all !== true) throw new NotificationRequestError("all must be true");
    return { all: true };
  }
  const ids = body.notificationIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS_PER_REQUEST) {
    throw new NotificationRequestError(`notificationIds must list 1 to ${MAX_IDS_PER_REQUEST} notifications`);
  }
  const normalized = ids.map((id) => (typeof id === "string" ? id.trim().toLowerCase() : ""));
  if (normalized.some((id) => !NOTIFICATION_ID_V4.test(id))) throw new NotificationRequestError("notificationIds must be UUID v4 values");
  return { notificationIds: [...new Set(normalized)] };
}

function selectionFilter(recipientUserId, selection) {
  return selection.all ? { recipientUserId } : { recipientUserId, notificationId: { $in: selection.notificationIds } };
}

async function markRead(recipientUserId, selection, now = new Date()) {
  const result = await Notification.updateMany({ ...selectionFilter(recipientUserId, selection), readAt: null }, { $set: { readAt: now } });
  return result.modifiedCount || 0;
}

async function clearNotifications(recipientUserId, selection) {
  const result = await Notification.deleteMany(selectionFilter(recipientUserId, selection));
  return result.deletedCount || 0;
}

async function unreadCount(recipientUserId) {
  return Notification.countDocuments({ recipientUserId, readAt: null });
}

module.exports = {
  FOLLOWED_REVIEW_CAP,
  LOCKED_TYPES,
  MODERATION_ACTOR,
  MUTABLE_TYPES,
  NotificationRequestError,
  PAGE_SIZE,
  clearNotifications,
  decodeCursor,
  encodeCursor,
  fanOutFollowedReview,
  followedReviewRecipients,
  isMuted,
  markRead,
  mutedUserIds,
  normalizePreferencesPatch,
  normalizeSelection,
  persistedNotificationId,
  readPage,
  recordFollow,
  recordReviewLike,
  recordSuggestionStatus,
  serializeNotifications,
  serializePreferences,
  takeRecipients,
  unreadCount,
};
