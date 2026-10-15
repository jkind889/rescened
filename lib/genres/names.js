// Name ownership across the vocabulary. A genre's name, aliases, and their
// slugs share one namespace: no two genres (active or retired) may claim the
// same matching key or slug.

const { Genre } = require("../../models/Genre");

// The genre other than `excludeId` that already uses this matching key or
// slug as a name or alias, or null.
async function nameOwner({ normalizedName, slug }, { session = null, excludeId = null } = {}) {
  const query = {
    $or: [
      { normalizedName },
      { "aliases.normalizedName": normalizedName },
      { slug },
      { "aliases.slug": slug },
    ],
  };
  if (excludeId) query._id = { $ne: excludeId };
  const find = Genre.findOne(query);
  return (session ? find.session(session) : find).lean();
}

function publicOwner(owner) {
  return { genreId: owner.genreId, slug: owner.slug, name: owner.name };
}

module.exports = { nameOwner, publicOwner };
