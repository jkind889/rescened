const { lookupAuthors } = require("../clerkAuthors");

// Maps Clerk user IDs to { userId, username, imageUrl }. A failed lookup
// falls back to the default name rather than failing the read.
function commentAuthors(ids) {
  return lookupAuthors(ids);
}

module.exports = { commentAuthors };
