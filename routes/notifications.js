const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const { notificationMutationRateLimit } = require("./utils/rateLimit");
const {
  clearNotifications,
  markRead,
  normalizeSelection,
  readPage,
  serializeNotifications,
  unreadCount,
} = require("./utils/notifications");
const Notification = require("../models/Notification");

const router = express.Router();
function auth(req, res, next) { const { userId } = getAuth(req); if (!userId) return res.status(401).json({ error: "Unauthorized" }); req.userId = userId; next(); }
async function authors(ids) {
  const map = new Map([...new Set(ids.filter((id) => id && id !== Notification.MODERATION_ACTOR_ID))].map((id) => [id, { userId: id, username: "rescened user", imageUrl: "" }]));
  if (!map.size) return map;
  try { const listed = await clerkClient.users.getUserList({ userId: [...map.keys()] }); const users = Array.isArray(listed) ? listed : listed.data || []; users.forEach((user) => map.set(user.id, { userId: user.id, username: user.username || "rescened user", imageUrl: user.imageUrl || "" })); } catch { /* optional */ }
  return map;
}
function sendError(res, error, fallback) {
  if (error?.status === 400) return res.status(400).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: fallback });
}

router.get("/unread-count", auth, async (req, res) => { try { res.json({ unreadCount: await unreadCount(req.userId) }); } catch { res.status(500).json({ error: "Failed to fetch notification count" }); } });

// Reading never changes state; clients mark rows read with POST /read.
// Transitional: a first-page read without markRead=false still marks the page
// read, for clients deployed before POST /read existed. Remove once they are gone.
router.get("/", auth, async (req, res) => {
  try {
    const { rows, nextCursor } = await readPage(req.userId, req.query?.cursor);
    const notifications = await serializeNotifications(rows, await authors(rows.map((row) => row.actorUserId)));
    const legacyMarkRead = req.query?.cursor === undefined && req.query?.markRead !== "false";
    const unread = rows.filter((row) => !row.readAt).map((row) => row.notificationId);
    if (legacyMarkRead && unread.length) await markRead(req.userId, { notificationIds: unread });
    res.json({ notifications, nextCursor });
  } catch (error) { sendError(res, error, "Failed to fetch notifications"); }
});

router.post("/read", auth, notificationMutationRateLimit, async (req, res) => {
  try {
    const updated = await markRead(req.userId, normalizeSelection(req.body));
    res.json({ updated, unreadCount: await unreadCount(req.userId) });
  } catch (error) { sendError(res, error, "Failed to mark notifications read"); }
});

// Clears rows, including ones created before their type was muted.
router.post("/clear", auth, notificationMutationRateLimit, async (req, res) => {
  try {
    const cleared = await clearNotifications(req.userId, normalizeSelection(req.body));
    res.json({ cleared, unreadCount: await unreadCount(req.userId) });
  } catch (error) { sendError(res, error, "Failed to clear notifications"); }
});

module.exports = router;
