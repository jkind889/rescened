const DEFAULT_AUTHOR = "rescened user";
// Clerk returns 10 users unless asked for more; a thread page or moderator
// queue can name many more, so look them up in bounded batches.
const BATCH_SIZE = 100;

// Maps Clerk user IDs to { userId, username, imageUrl }. A failed lookup
// falls back to the default name rather than failing the read.
async function commentAuthors(ids) {
  const map = new Map([...new Set(ids.filter(Boolean))].map((id) => [id, { userId: id, username: DEFAULT_AUTHOR, imageUrl: "" }]));
  const keys = [...map.keys()];
  const batches = [];
  for (let start = 0; start < keys.length; start += BATCH_SIZE) batches.push(keys.slice(start, start + BATCH_SIZE));
  // Resolved per call so tests can substitute the Clerk module.
  const { clerkClient } = require("@clerk/express");
  await Promise.all(batches.map(async (batch) => {
    try {
      const listed = await clerkClient.users.getUserList({ userId: batch, limit: batch.length });
      const users = Array.isArray(listed) ? listed : listed.data || [];
      users.forEach((user) => map.set(user.id, { userId: user.id, username: user.username || DEFAULT_AUTHOR, imageUrl: user.imageUrl || "" }));
    } catch { /* optional */ }
  }));
  return map;
}

module.exports = { commentAuthors };
