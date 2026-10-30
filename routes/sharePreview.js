// Crawler-facing share pages. Vercel rewrites link-preview and search crawler
// requests for /album/:albumId and /review/:reviewId here, because crawlers do
// not run the SPA's JavaScript. See docs/SHARE_PREVIEWS.md.
//
// Mounted in server.js before the global API limiter: every proxied request
// arrives from Vercel's addresses, so these pages have their own IP bucket.
const express = require("express");
const AlbumCatalog = require("../models/AlbumCatalog");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");
const { CATALOG_ALBUM_FIELDS, UUID_V4, normalizeCatalogAlbum } = require("./utils/albumCatalog");
const { cacheSharePreview, noStore } = require("./utils/cacheHeaders");
const { sharePreviewRateLimit } = require("./utils/rateLimit");
const { DEFAULT_AUTHOR, lookupAuthors } = require("../lib/clerkAuthors");
const { buildAlbumPage, buildNotFoundPage, buildReviewPage, buildSitemap, resolveSiteUrl } = require("../lib/sharePreview/render");

const router = express.Router();
const REVIEW_FIELDS = "reviewId userId albumCatalogId rating reviewText date editedAt";
// One sitemap file holds at most 50,000 URLs; the catalog is far below that.
const SITEMAP_URL_LIMIT = 50000;
// The sitemap reads the whole catalog, so it is built at most once per window
// per process, and concurrent requests share one build.
const SITEMAP_TTL_MS = 15 * 60 * 1000;
let sitemapCache = null;

// Read per request, so the flag and site URL follow the environment.
function isSharePreviewsEnabled(env = process.env) {
  return String(env.SHARE_PREVIEWS_ENABLED || "").trim().toLowerCase() === "true";
}

function siteUrl() {
  return resolveSiteUrl(process.env.PUBLIC_SITE_URL);
}

function publicId(value) {
  const id = String(value || "").trim().toLowerCase();
  return UUID_V4.test(id) ? id : "";
}

function sendPage(res, status, html) {
  return res.status(status).type("html").send(html);
}

// Missing, deleted, and disabled pages are never cached, so a later fix or a
// re-enabled flag shows up on the next crawl.
function sendNotFound(res) {
  noStore(res);
  return sendPage(res, 404, buildNotFoundPage({ siteUrl: siteUrl() }));
}

function sendFailure(res, error) {
  console.error("[share-preview] render failed", { message: error?.message });
  noStore(res);
  return sendPage(res, 500, buildNotFoundPage({ siteUrl: siteUrl(), message: "This preview is unavailable right now." }));
}

function requireEnabled(req, res, next) {
  if (!isSharePreviewsEnabled()) return sendNotFound(res);
  next();
}

router.use(requireEnabled, sharePreviewRateLimit);

router.get("/album/:albumId", async (req, res) => {
  try {
    const albumId = publicId(req.params.albumId);
    if (!albumId) return sendNotFound(res);
    const album = await AlbumCatalog.findOne({ albumId }, CATALOG_ALBUM_FIELDS).lean();
    if (!album) return sendNotFound(res);
    cacheSharePreview(res);
    return sendPage(res, 200, buildAlbumPage({ album: normalizeCatalogAlbum(album), siteUrl: siteUrl() }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

// Reviews by private profiles keep their author's username, because reviews
// are public, but are marked noindex. Deleted accounts read as "deleted user".
router.get("/review/:reviewId", async (req, res) => {
  try {
    const reviewId = publicId(req.params.reviewId);
    if (!reviewId) return sendNotFound(res);
    const review = await Review.findOne({ reviewId }, REVIEW_FIELDS).lean();
    if (!review) return sendNotFound(res);
    const deleted = Review.isDeletedAuthor(review.userId);
    const [album, authors, profile] = await Promise.all([
      AlbumCatalog.findOne({ _id: review.albumCatalogId }, CATALOG_ALBUM_FIELDS).lean(),
      deleted ? new Map() : lookupAuthors([review.userId]),
      deleted ? null : UserProfile.findOne({ userId: review.userId }, "isPrivate").lean(),
    ]);
    if (!album) return sendNotFound(res);
    cacheSharePreview(res);
    return sendPage(res, 200, buildReviewPage({
      review,
      album: normalizeCatalogAlbum(album),
      author: deleted ? null : { username: authors.get(review.userId)?.username || DEFAULT_AUTHOR },
      indexable: !profile?.isPrivate,
      siteUrl: siteUrl(),
    }));
  } catch (error) {
    return sendFailure(res, error);
  }
});

async function loadSitemap(site) {
  const albums = await AlbumCatalog.find({}, "albumId updatedAt").sort({ _id: 1 }).limit(SITEMAP_URL_LIMIT).lean();
  if (albums.length >= SITEMAP_URL_LIMIT) {
    console.warn("[share-preview] sitemap reached the 50,000 URL limit; split it into a sitemap index");
  }
  return buildSitemap({ albums, siteUrl: site });
}

function readSitemap(site, now = Date.now()) {
  if (sitemapCache && sitemapCache.site === site && sitemapCache.expiresAt > now) return sitemapCache.xml;
  const entry = { site, expiresAt: now + SITEMAP_TTL_MS, xml: loadSitemap(site) };
  sitemapCache = entry;
  // A failed build is not reused; the next request tries again.
  entry.xml.catch(() => { if (sitemapCache === entry) sitemapCache = null; });
  return entry.xml;
}

// Albums only. Review permalinks, including private-profile reviews, are never listed.
router.get("/sitemap.xml", async (req, res) => {
  try {
    const xml = await readSitemap(siteUrl());
    cacheSharePreview(res);
    return res.status(200).type("application/xml").send(xml);
  } catch (error) {
    console.error("[share-preview] sitemap failed", { message: error?.message });
    noStore(res);
    return res.status(500).type("text/plain").send("Sitemap unavailable");
  }
});

module.exports = router;
module.exports.isSharePreviewsEnabled = isSharePreviewsEnabled;
