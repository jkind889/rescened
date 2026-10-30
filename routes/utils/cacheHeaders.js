// HTTP caching for read endpoints. Only anonymous, site-wide feeds may be
// stored by browsers or shared caches, and only briefly: the server re-ranks
// them on the same cadence (see feedCache.js). Responses that depend on the
// viewer, such as likedByViewer, must never be stored or shared.
const PUBLIC_FEED_MAX_AGE_SECONDS = 60;
const PUBLIC_FEED_STALE_SECONDS = 120;

const PUBLIC_FEED = `public, max-age=${PUBLIC_FEED_MAX_AGE_SECONDS}, stale-while-revalidate=${PUBLIC_FEED_STALE_SECONDS}`;
const VIEWER_SPECIFIC = "private, no-store";
// Crawler share pages (routes/sharePreview.js). Platforms also cache unfurls on
// their side, so a deleted review's card can outlive this anyway.
const SHARE_PREVIEW_MAX_AGE_SECONDS = 300;
const SHARE_PREVIEW = `public, max-age=${SHARE_PREVIEW_MAX_AGE_SECONDS}`;

// Set only on a successful response, so an error is never cached.
function cachePublicFeed(res) {
  res.set("Cache-Control", PUBLIC_FEED);
  return res;
}

function cacheSharePreview(res) {
  res.set("Cache-Control", SHARE_PREVIEW);
  return res;
}

function noStore(res) {
  res.set("Cache-Control", VIEWER_SPECIFIC);
  return res;
}

module.exports = {
  PUBLIC_FEED,
  PUBLIC_FEED_MAX_AGE_SECONDS,
  SHARE_PREVIEW,
  VIEWER_SPECIFIC,
  cachePublicFeed,
  cacheSharePreview,
  noStore,
};
