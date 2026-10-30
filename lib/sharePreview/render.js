// Pure builders for the crawler-facing share pages (docs/SHARE_PREVIEWS.md).
//
// Link-preview crawlers do not run JavaScript, so album and review pages get a
// small server-rendered document with their title, description, canonical
// link, Open Graph and Twitter tags, and JSON-LD. Inputs are already-resolved
// public shapes: catalog albums by albumId, reviews by reviewId, and author
// usernames. Nothing here reads a model, and no Mongo _id may reach a builder.
const SITE_NAME = "rescened";
const DEFAULT_SITE_URL = "https://rescened.com";
const DEFAULT_DESCRIPTION = "Rate, review, and share the albums you love on rescened.";
const DELETED_AUTHOR_NAME = "deleted user";

const TITLE_LIMIT = 120;
const DESCRIPTION_LIMIT = 200;
// Reviews are capped at 300 characters on write; this only bounds legacy text.
const REVIEW_BODY_LIMIT = 600;

const RELEASE_TYPE_LABELS = {
  album: "Album",
  ep: "EP",
  single: "Single",
  mixtape: "Mixtape",
  soundtrack: "Soundtrack",
  compilation: "Compilation",
  live: "Live album",
  remix: "Remix album",
  other: "Release",
};

// Control characters are dropped, and runs of whitespace (including newlines)
// collapse to one space, because every value lands in a tag or a single line.
function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Counts code points, so a cut never splits a surrogate pair.
function truncate(value, limit) {
  const text = cleanText(value);
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return `${characters.slice(0, Math.max(limit - 1, 0)).join("").trimEnd()}…`;
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON-LD sits inside <script>; escaping every "<" means no value can close the
// tag or open a comment.
function serializeJsonLd(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// PUBLIC_SITE_URL is reduced to an http(s) origin; anything else falls back to
// the production domain rather than producing a broken canonical link.
function resolveSiteUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_SITE_URL;
    if (url.username || url.password) return DEFAULT_SITE_URL;
    return url.origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

// Covers are linked, never proxied or copied, and only https: links are used.
function safeImageUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

function albumUrl(siteUrl, albumId) {
  return `${siteUrl}/album/${encodeURIComponent(albumId)}`;
}

function reviewUrl(siteUrl, reviewId) {
  return `${siteUrl}/review/${encodeURIComponent(reviewId)}`;
}

function formatRating(rating) {
  const value = Number(rating);
  return Number.isFinite(value) ? String(value) : "";
}

function isoDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

function artistJsonLd(name) {
  return name ? { "@type": "MusicGroup", name } : undefined;
}

function metaTags({ title, description, canonical, image, imageAlt, ogType, noindex }) {
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
  ];
  if (noindex) tags.push('<meta name="robots" content="noindex">');
  if (canonical) tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`);
  tags.push(
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:type" content="${escapeHtml(ogType)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
  );
  if (canonical) tags.push(`<meta property="og:url" content="${escapeHtml(canonical)}">`);
  if (image) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(image)}">`,
      `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}">`,
    );
  }
  tags.push(
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
  );
  if (image) {
    tags.push(
      `<meta name="twitter:image" content="${escapeHtml(image)}">`,
      `<meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">`,
    );
  }
  return tags;
}

function htmlDocument({ head, body }) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...head,
    "</head>",
    "<body>",
    "<main>",
    ...body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function albumSummary(album) {
  const type = RELEASE_TYPE_LABELS[album.releaseType] || RELEASE_TYPE_LABELS.album;
  const year = Number.isInteger(album.releaseYear) && album.releaseYear > 0 ? `, released ${album.releaseYear}` : "";
  return `${type} by ${cleanText(album.artistDisplayName)}${year}.`;
}

// album: a normalized catalog album (routes/utils/albumCatalog.js).
function buildAlbumPage({ album, siteUrl }) {
  const site = resolveSiteUrl(siteUrl);
  const canonical = albumUrl(site, album.albumId);
  const name = truncate(album.title, TITLE_LIMIT);
  const artist = truncate(album.artistDisplayName, TITLE_LIMIT);
  const title = truncate(`${name} by ${artist} · ${SITE_NAME}`, TITLE_LIMIT);
  const description = truncate(`${albumSummary(album)} Read reviews and rate it on ${SITE_NAME}.`, DESCRIPTION_LIMIT);
  const image = safeImageUrl(album.cover);
  const imageAlt = truncate(`Cover of ${name} by ${artist}`, TITLE_LIMIT);

  const jsonLd = compact({
    "@context": "https://schema.org",
    "@type": "MusicAlbum",
    name: cleanText(album.title),
    byArtist: artistJsonLd(cleanText(album.artistDisplayName)),
    url: canonical,
    image,
    datePublished: cleanText(album.releaseDate),
    numTracks: Array.isArray(album.tracks) && album.tracks.length ? album.tracks.length : undefined,
  });

  return htmlDocument({
    head: [
      ...metaTags({ title, description, canonical, image, imageAlt, ogType: "music.album" }),
      `<script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>`,
    ],
    body: [
      `<h1>${escapeHtml(name)}</h1>`,
      `<p>${escapeHtml(albumSummary(album))}</p>`,
      ...(image ? [`<img src="${escapeHtml(image)}" alt="${escapeHtml(imageAlt)}" width="500" height="500">`] : []),
      `<p><a href="${escapeHtml(canonical)}">See ${escapeHtml(name)} on ${escapeHtml(SITE_NAME)}</a></p>`,
    ],
  });
}

// review: { reviewId, rating, reviewText, date, editedAt }.
// author: { username } for a live account, or null for a deleted account.
// indexable is false for authors with private profiles: the preview keeps their
// username, but search engines are asked not to index the page.
function buildReviewPage({ review, album, author, indexable = true, siteUrl }) {
  const site = resolveSiteUrl(siteUrl);
  const canonical = reviewUrl(site, review.reviewId);
  const username = truncate(author?.username || DELETED_AUTHOR_NAME, 60) || DELETED_AUTHOR_NAME;
  const name = truncate(album.title, TITLE_LIMIT);
  const artist = truncate(album.artistDisplayName, TITLE_LIMIT);
  const rating = formatRating(review.rating);
  const ratingText = rating ? `Rated ${rating} out of 5` : "";
  const title = truncate(`${username}'s review of ${name} by ${artist} · ${SITE_NAME}`, TITLE_LIMIT);
  const description = truncate([rating ? `${rating}/5` : "", cleanText(review.reviewText)].filter(Boolean).join(" · "), DESCRIPTION_LIMIT);
  const image = safeImageUrl(album.cover);
  const imageAlt = truncate(`Cover of ${name} by ${artist}`, TITLE_LIMIT);
  const albumLink = albumUrl(site, album.albumId);

  const jsonLd = compact({
    "@context": "https://schema.org",
    "@type": "Review",
    url: canonical,
    author: { "@type": "Person", name: username },
    reviewBody: truncate(review.reviewText, REVIEW_BODY_LIMIT),
    reviewRating: rating ? { "@type": "Rating", ratingValue: Number(rating), bestRating: 5, worstRating: 1 } : undefined,
    datePublished: isoDate(review.date),
    dateModified: isoDate(review.editedAt),
    itemReviewed: compact({
      "@type": "MusicAlbum",
      name: cleanText(album.title),
      byArtist: artistJsonLd(cleanText(album.artistDisplayName)),
      url: albumLink,
      image,
    }),
  });

  return htmlDocument({
    head: [
      ...metaTags({ title, description, canonical, image, imageAlt, ogType: "article", noindex: !indexable }),
      `<script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>`,
    ],
    body: [
      `<h1>${escapeHtml(`${username}'s review of ${name}`)}</h1>`,
      `<p><a href="${escapeHtml(albumLink)}">${escapeHtml(name)}</a> by ${escapeHtml(artist)}</p>`,
      ...(ratingText ? [`<p>${escapeHtml(ratingText)}</p>`] : []),
      `<blockquote>${escapeHtml(truncate(review.reviewText, REVIEW_BODY_LIMIT))}</blockquote>`,
      ...(image ? [`<img src="${escapeHtml(image)}" alt="${escapeHtml(imageAlt)}" width="500" height="500">`] : []),
      `<p><a href="${escapeHtml(canonical)}">Read this review on ${escapeHtml(SITE_NAME)}</a></p>`,
    ],
  });
}

// A missing album or review, or a failed render, gets generic site tags and is
// never indexed.
function buildNotFoundPage({ siteUrl, message = "This page could not be found." } = {}) {
  const site = resolveSiteUrl(siteUrl);
  return htmlDocument({
    head: metaTags({ title: SITE_NAME, description: DEFAULT_DESCRIPTION, canonical: "", image: "", imageAlt: "", ogType: "website", noindex: true }),
    body: [
      `<h1>${escapeHtml(SITE_NAME)}</h1>`,
      `<p>${escapeHtml(message)}</p>`,
      `<p><a href="${escapeHtml(`${site}/`)}">Go to ${escapeHtml(SITE_NAME)}</a></p>`,
    ],
  });
}

// Albums only: review permalinks stay out of the sitemap. albums is a list of
// { albumId, updatedAt } catalog rows; anything without a public UUID is skipped.
const PUBLIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildSitemap({ albums = [], siteUrl } = {}) {
  const site = resolveSiteUrl(siteUrl);
  const entries = albums
    .filter((album) => PUBLIC_UUID.test(String(album?.albumId || "")))
    .map((album) => {
      const lastmod = isoDate(album.updatedAt);
      return [
        "<url>",
        `<loc>${escapeHtml(albumUrl(site, String(album.albumId).toLowerCase()))}</loc>`,
        ...(lastmod ? [`<lastmod>${lastmod}</lastmod>`] : []),
        "</url>",
      ].join("");
    });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");
}

module.exports = {
  DEFAULT_DESCRIPTION,
  DEFAULT_SITE_URL,
  DELETED_AUTHOR_NAME,
  DESCRIPTION_LIMIT,
  SITE_NAME,
  TITLE_LIMIT,
  albumUrl,
  buildAlbumPage,
  buildNotFoundPage,
  buildReviewPage,
  buildSitemap,
  cleanText,
  escapeHtml,
  resolveSiteUrl,
  reviewUrl,
  safeImageUrl,
  serializeJsonLd,
  truncate,
};
