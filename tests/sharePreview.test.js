const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_SITE_URL,
  buildAlbumPage,
  buildNotFoundPage,
  buildReviewPage,
  escapeHtml,
  resolveSiteUrl,
  safeImageUrl,
  serializeJsonLd,
  truncate,
} = require("../lib/sharePreview/render");

const ALBUM_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const COVER = "https://coverartarchive.org/release/0b7d3b8e-4c2f-4e1e-9b2a-1f3c5d7e9a0b/front-500";

function album(overrides = {}) {
  return {
    albumId: ALBUM_ID,
    title: "Blue Rooms",
    artistDisplayName: "The Example Band",
    releaseType: "album",
    releaseDate: "2019-04-12",
    releaseYear: 2019,
    cover: COVER,
    tracks: [{ trackId: "t1", title: "One" }, { trackId: "t2", title: "Two" }],
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    reviewId: REVIEW_ID,
    rating: 4.5,
    reviewText: "Warm, patient, and strange.",
    date: new Date("2026-09-01T00:00:00.000Z"),
    editedAt: null,
    ...overrides,
  };
}

function jsonLdOf(html) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match, "page has JSON-LD");
  return JSON.parse(match[1]);
}

function metaContent(html, attribute, name) {
  const match = html.match(new RegExp(`<meta ${attribute}="${name.replace(/[:.]/g, "\\$&")}" content="([^"]*)">`));
  return match ? match[1] : null;
}

test("escapeHtml escapes markup characters and drops control characters", () => {
  assert.equal(escapeHtml(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &#39; f");
  assert.equal(escapeHtml("bell\u0007 null\u0000 line\nbreak"), "bell null line break");
  assert.equal(escapeHtml(null), "");
});

test("truncate counts code points and never splits a surrogate pair", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
  const emoji = "🎵".repeat(10);
  const cut = truncate(emoji, 5);
  assert.equal(Array.from(cut).length, 5);
  assert.ok(cut.startsWith("🎵🎵🎵🎵"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), "no lone high surrogate");
});

test("JSON-LD escapes every < so text cannot close the script tag", () => {
  const serialized = serializeJsonLd({ text: "</script><script>alert(1)</script><!--" });
  assert.ok(!serialized.includes("<"));
  assert.equal(JSON.parse(serialized).text, "</script><script>alert(1)</script><!--");
});

test("a </script> breakout in review text stays inert in every part of the page", () => {
  const attack = `</script><script>alert("x")</script><img src=x onerror=alert(1)>"'&`;
  const html = buildReviewPage({ review: review({ reviewText: attack }), album: album({ title: attack }), author: { username: attack } });

  assert.equal((html.match(/<script/g) || []).length, 1, "only the JSON-LD script tag exists");
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(!html.includes("<img src=x"));
  const outsideJsonLd = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
  assert.ok(!outsideJsonLd.includes("onerror=alert(1)>"));
  assert.ok(!outsideJsonLd.includes(`"x"`));
  const data = jsonLdOf(html);
  assert.equal(data.reviewBody, attack);
  assert.equal(data.author.name, truncate(attack, 60));
});

test("album pages use the canonical domain, a summary card, and MusicAlbum JSON-LD", () => {
  const html = buildAlbumPage({ album: album(), siteUrl: "https://rescened.com" });

  assert.ok(html.includes(`<link rel="canonical" href="https://rescened.com/album/${ALBUM_ID}">`));
  assert.equal(metaContent(html, "property", "og:url"), `https://rescened.com/album/${ALBUM_ID}`);
  assert.equal(metaContent(html, "name", "twitter:card"), "summary");
  assert.equal(metaContent(html, "property", "og:type"), "music.album");
  assert.equal(metaContent(html, "property", "og:image"), COVER);
  assert.equal(metaContent(html, "name", "twitter:image"), COVER);
  assert.equal(metaContent(html, "name", "robots"), null);
  assert.ok(html.includes("<title>Blue Rooms by The Example Band · rescened</title>"));
  assert.ok(html.includes(`<a href="https://rescened.com/album/${ALBUM_ID}">`));

  const data = jsonLdOf(html);
  assert.equal(data["@type"], "MusicAlbum");
  assert.equal(data.name, "Blue Rooms");
  assert.deepEqual(data.byArtist, { "@type": "MusicGroup", name: "The Example Band" });
  assert.equal(data.url, `https://rescened.com/album/${ALBUM_ID}`);
  assert.equal(data.image, COVER);
  assert.equal(data.numTracks, 2);
});

test("a missing or non-https cover omits every image tag", () => {
  for (const cover of ["", "http://coverartarchive.org/release/x/front-500", "javascript:alert(1)", "data:image/png;base64,AAAA", "not a url", "https://user:pass@example.com/a.jpg"]) {
    const html = buildAlbumPage({ album: album({ cover }) });
    assert.equal(metaContent(html, "property", "og:image"), null, cover);
    assert.equal(metaContent(html, "name", "twitter:image"), null, cover);
    assert.ok(!html.includes("<img"), cover);
    assert.equal(jsonLdOf(html).image, undefined, cover);
    assert.equal(metaContent(html, "name", "twitter:card"), "summary");
  }
  assert.equal(safeImageUrl(COVER), COVER);
});

test("PUBLIC_SITE_URL is reduced to an origin and falls back to rescened.com", () => {
  assert.equal(DEFAULT_SITE_URL, "https://rescened.com");
  assert.equal(resolveSiteUrl(undefined), "https://rescened.com");
  assert.equal(resolveSiteUrl("https://rescened.com/"), "https://rescened.com");
  assert.equal(resolveSiteUrl("https://preview.rescened.com/some/path?q=1"), "https://preview.rescened.com");
  assert.equal(resolveSiteUrl("rescened.com"), "https://rescened.com");
  assert.equal(resolveSiteUrl("javascript:alert(1)"), "https://rescened.com");
  assert.equal(resolveSiteUrl("https://user:pass@rescened.com"), "https://rescened.com");
});

test("review pages show the author, rating, and text with Review JSON-LD", () => {
  const html = buildReviewPage({ review: review({ editedAt: new Date("2026-09-03T00:00:00.000Z") }), album: album(), author: { username: "listener" } });

  assert.ok(html.includes(`<link rel="canonical" href="https://rescened.com/review/${REVIEW_ID}">`));
  assert.equal(metaContent(html, "property", "og:type"), "article");
  assert.equal(metaContent(html, "name", "twitter:card"), "summary");
  assert.equal(metaContent(html, "property", "og:description"), "4.5/5 · Warm, patient, and strange.");
  assert.ok(html.includes("<title>listener&#39;s review of Blue Rooms by The Example Band · rescened</title>"));
  assert.ok(html.includes("<blockquote>Warm, patient, and strange.</blockquote>"));
  assert.ok(html.includes("<p>Rated 4.5 out of 5</p>"));
  assert.equal(metaContent(html, "name", "robots"), null);

  const data = jsonLdOf(html);
  assert.equal(data["@type"], "Review");
  assert.deepEqual(data.reviewRating, { "@type": "Rating", ratingValue: 4.5, bestRating: 5, worstRating: 1 });
  assert.equal(data.itemReviewed["@type"], "MusicAlbum");
  assert.equal(data.itemReviewed.url, `https://rescened.com/album/${ALBUM_ID}`);
  assert.deepEqual(data.author, { "@type": "Person", name: "listener" });
  assert.equal(data.datePublished, "2026-09-01T00:00:00.000Z");
  assert.equal(data.dateModified, "2026-09-03T00:00:00.000Z");
});

test("a private-profile author keeps their username but the page is noindex", () => {
  const html = buildReviewPage({ review: review(), album: album(), author: { username: "quietlistener" }, indexable: false });

  assert.equal(metaContent(html, "name", "robots"), "noindex");
  assert.ok(html.includes("quietlistener&#39;s review"));
  assert.equal(jsonLdOf(html).author.name, "quietlistener");
});

test("a deleted author reads as deleted user", () => {
  const html = buildReviewPage({ review: review(), album: album(), author: null });

  assert.ok(html.includes("deleted user&#39;s review of Blue Rooms"));
  assert.equal(jsonLdOf(html).author.name, "deleted user");
});

test("long review text is truncated in the description but kept in the body", () => {
  const text = "word ".repeat(60).trim();
  const html = buildReviewPage({ review: review({ reviewText: text }), album: album(), author: { username: "listener" } });
  const description = metaContent(html, "name", "description");

  assert.equal(Array.from(description).length, 200);
  assert.ok(description.endsWith("…"));
  assert.ok(html.includes(`<blockquote>${text}</blockquote>`));
});

test("the not-found page has generic site tags and is noindex", () => {
  const html = buildNotFoundPage({ siteUrl: "https://rescened.com" });

  assert.ok(html.includes("<title>rescened</title>"));
  assert.equal(metaContent(html, "name", "robots"), "noindex");
  assert.equal(metaContent(html, "name", "twitter:card"), "summary");
  assert.ok(!html.includes("rel=\"canonical\""));
  assert.ok(!html.includes("og:image"));
});

test("no rendered page carries an internal Mongo _id", () => {
  const objectId = "65f1c2a3b4c5d6e7f8091a2b";
  const leakyAlbum = { ...album(), _id: objectId, albumCatalogId: objectId };
  const leakyReview = { ...review(), _id: objectId, albumCatalogId: objectId, userId: "user_secret" };
  const pages = [
    buildAlbumPage({ album: leakyAlbum }),
    buildReviewPage({ review: leakyReview, album: leakyAlbum, author: { username: "listener", userId: "user_secret" } }),
    buildNotFoundPage(),
  ];
  for (const html of pages) {
    assert.ok(!html.includes(objectId));
    assert.ok(!html.includes("_id"));
    assert.ok(!html.includes("user_secret"));
  }
});

// Route tests: models and Clerk are stubbed; requests go to a local listener.
const express = require("express");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");
const { RATE_LIMITS, sharePreviewRateLimit } = require("../routes/utils/rateLimit");

const clerkPath = require.resolve("@clerk/express");
const sharePreviewPath = require.resolve("../routes/sharePreview");
const ALBUM_OBJECT_ID = new mongoose.Types.ObjectId();
const REVIEW_OBJECT_ID = new mongoose.Types.ObjectId();

function lean(value) {
  return { lean: async () => value };
}

function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  t.after(() => Object.entries(previous).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }));
}

function stubClerk(t, users) {
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: { clerkClient: { users: { async getUserList() { return { data: users }; } } } },
  };
  t.after(() => {
    if (previous) require.cache[clerkPath] = previous;
    else delete require.cache[clerkPath];
  });
}

function stubData(t, { storedAlbum = { _id: ALBUM_OBJECT_ID, ...album() }, storedReview, profile = null } = {}) {
  const calls = { album: [], review: [], profile: [] };
  t.mock.method(AlbumCatalog, "findOne", (filter, fields) => {
    calls.album.push({ filter, fields });
    const matches = storedAlbum && (filter.albumId === storedAlbum.albumId || String(filter._id) === String(storedAlbum._id));
    return lean(matches ? storedAlbum : null);
  });
  t.mock.method(Review, "findOne", (filter, fields) => {
    calls.review.push({ filter, fields });
    return lean(storedReview && filter.reviewId === storedReview.reviewId ? storedReview : null);
  });
  t.mock.method(UserProfile, "findOne", (filter, fields) => {
    calls.profile.push({ filter, fields });
    return lean(profile);
  });
  return calls;
}

async function request(t, path) {
  delete require.cache[sharePreviewPath];
  const app = express();
  app.use("/share", require("../routes/sharePreview"));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function storedReview(overrides = {}) {
  return { _id: REVIEW_OBJECT_ID, ...review(), userId: "user_author", albumCatalogId: ALBUM_OBJECT_ID, ...overrides };
}

test("share routes return a non-cached 404 while SHARE_PREVIEWS_ENABLED is off", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: undefined });
  const calls = stubData(t);

  for (const path of [`/share/album/${ALBUM_ID}`, `/share/review/${REVIEW_ID}`]) {
    const response = await request(t, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.ok(response.body.includes('<meta name="robots" content="noindex">'));
  }
  assert.equal(calls.album.length + calls.review.length, 0, "no reads while disabled");
});

test("an album share page renders from the catalog with a short public cache", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true", PUBLIC_SITE_URL: "https://rescened.com" });
  const calls = stubData(t);

  const response = await request(t, `/share/album/${ALBUM_ID.toUpperCase()}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.match(response.headers.get("content-type"), /^text\/html; charset=utf-8/);
  assert.deepEqual(calls.album[0].filter, { albumId: ALBUM_ID });
  assert.ok(response.body.includes(`<link rel="canonical" href="https://rescened.com/album/${ALBUM_ID}">`));
  assert.ok(response.body.includes('<meta name="twitter:card" content="summary">'));
  assert.ok(!response.body.includes(String(ALBUM_OBJECT_ID)));
});

test("an unknown or malformed album id returns a non-cached 404", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true" });
  const calls = stubData(t, { storedAlbum: null });

  for (const path of ["/share/album/33333333-3333-4333-8333-333333333333", "/share/album/not-a-uuid", `/share/album/${String(ALBUM_OBJECT_ID)}`]) {
    const response = await request(t, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(calls.album.length, 1, "malformed ids never reach the database");
});

test("a review share page shows the author's username and links the catalog album", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true", PUBLIC_SITE_URL: undefined });
  stubClerk(t, [{ id: "user_author", username: "listener", imageUrl: "" }]);
  const calls = stubData(t, { storedReview: storedReview(), profile: { isPrivate: false } });

  const response = await request(t, `/share/review/${REVIEW_ID}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.ok(response.body.includes("listener&#39;s review of Blue Rooms"));
  assert.ok(response.body.includes(`<link rel="canonical" href="https://rescened.com/review/${REVIEW_ID}">`));
  assert.ok(!response.body.includes('content="noindex"'));
  assert.deepEqual(calls.profile[0].filter, { userId: "user_author" });
  for (const secret of [String(ALBUM_OBJECT_ID), String(REVIEW_OBJECT_ID), "user_author", "_id"]) {
    assert.ok(!response.body.includes(secret), secret);
  }
  assert.ok(!/comment/i.test(response.body), "no comment count");
});

test("a review by a private profile keeps the username and is noindex", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true" });
  stubClerk(t, [{ id: "user_author", username: "quietlistener", imageUrl: "" }]);
  stubData(t, { storedReview: storedReview(), profile: { isPrivate: true } });

  const response = await request(t, `/share/review/${REVIEW_ID}`);

  assert.equal(response.status, 200);
  assert.ok(response.body.includes("quietlistener&#39;s review"));
  assert.ok(response.body.includes('<meta name="robots" content="noindex">'));
});

test("a review by a deleted account reads as deleted user without a Clerk or profile lookup", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true" });
  stubClerk(t, []);
  const calls = stubData(t, { storedReview: storedReview({ userId: Review.DELETED_AUTHOR_ID }) });

  const response = await request(t, `/share/review/${REVIEW_ID}`);

  assert.equal(response.status, 200);
  assert.ok(response.body.includes("deleted user&#39;s review"));
  assert.ok(!response.body.includes(Review.DELETED_AUTHOR_ID));
  assert.equal(calls.profile.length, 0);
});

test("a deleted review, or one whose album is gone, returns 404 with no-store", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true" });
  stubClerk(t, []);
  stubData(t, { storedReview: null });
  const missing = await request(t, `/share/review/${REVIEW_ID}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "private, no-store");
  assert.ok(missing.body.includes("<title>rescened</title>"));

  t.mock.restoreAll();
  stubData(t, { storedAlbum: null, storedReview: storedReview() });
  const orphaned = await request(t, `/share/review/${REVIEW_ID}`);
  assert.equal(orphaned.status, 404);
  assert.equal(orphaned.headers.get("cache-control"), "private, no-store");
});

test("a database failure returns a non-cached 500 page", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true" });
  t.mock.method(console, "error", () => {});
  t.mock.method(AlbumCatalog, "findOne", () => ({ lean: async () => { throw new Error("connection reset"); } }));

  const response = await request(t, `/share/album/${ALBUM_ID}`);

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(!response.body.includes("connection reset"));
});

test("share pages have their own IP-keyed bucket and mount before the global API limiter", async (t) => {
  assert.equal(RATE_LIMITS.sharePreview.keyPrefix, "rescened:share-preview");
  assert.notEqual(RATE_LIMITS.sharePreview.keyPrefix, RATE_LIMITS.globalApi.keyPrefix);

  delete require.cache[sharePreviewPath];
  const router = require("../routes/sharePreview");
  assert.ok(router.stack.some((layer) => layer.handle === sharePreviewRateLimit), "router applies the share bucket");

  const serverPath = require.resolve("../server");
  withEnv(t, { MONGO_URI: "mongodb://example.test/rescened", CLERK_SECRET_KEY: "sk_test_share", CLERK_PUBLISHABLE_KEY: "pk_test_share", NODE_ENV: "test" });
  delete require.cache[serverPath];
  t.after(() => { delete require.cache[serverPath]; });
  const { app } = require("../server");
  const { globalApiRateLimit } = require("../routes/utils/rateLimit");
  const stack = app.router.stack;
  const shareIndex = stack.findIndex((layer) => layer.handle === router);
  const globalIndex = stack.findIndex((layer) => layer.handle === globalApiRateLimit);
  assert.ok(shareIndex >= 0, "share router is mounted");
  assert.ok(globalIndex > shareIndex, "share router runs before the global API limiter");
});

test("the sitemap lists catalog albums only, with canonical URLs and lastmod", () => {
  const xml = require("../lib/sharePreview/render").buildSitemap({
    siteUrl: "https://rescened.com",
    albums: [
      { albumId: ALBUM_ID, updatedAt: new Date("2026-10-01T12:00:00.000Z") },
      { albumId: "44444444-4444-4444-8444-444444444444", updatedAt: null },
      { albumId: "65f1c2a3b4c5d6e7f8091a2b", updatedAt: new Date() },
      { albumId: "" },
    ],
  });

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes(`<url><loc>https://rescened.com/album/${ALBUM_ID}</loc><lastmod>2026-10-01T12:00:00.000Z</lastmod></url>`));
  assert.ok(xml.includes("<url><loc>https://rescened.com/album/44444444-4444-4444-8444-444444444444</loc></url>"));
  assert.equal((xml.match(/<url>/g) || []).length, 2);
  assert.ok(!xml.includes("65f1c2a3b4c5d6e7f8091a2b"));
  assert.ok(!xml.includes("/review/"));
});

test("the sitemap route reads only public album fields and serves XML", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "true", PUBLIC_SITE_URL: "https://rescened.com" });
  const calls = [];
  t.mock.method(AlbumCatalog, "find", (filter, fields) => {
    calls.push({ filter, fields });
    const query = {
      sort(order) { calls.push({ sort: order }); return query; },
      limit(count) { calls.push({ limit: count }); return query; },
      lean: async () => [{ _id: ALBUM_OBJECT_ID, albumId: ALBUM_ID, updatedAt: new Date("2026-10-01T12:00:00.000Z") }],
    };
    return query;
  });
  t.mock.method(Review, "find", () => { throw new Error("reviews must not be read for the sitemap"); });

  const response = await request(t, "/share/sitemap.xml");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/xml/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(calls[0], { filter: {}, fields: "albumId updatedAt" });
  assert.deepEqual(calls.find((call) => call.limit), { limit: 50000 });
  assert.ok(response.body.includes(`<loc>https://rescened.com/album/${ALBUM_ID}</loc>`));
  assert.ok(!response.body.includes(String(ALBUM_OBJECT_ID)));
});

test("the sitemap route is off with the flag and retries after a failure", async (t) => {
  withEnv(t, { SHARE_PREVIEWS_ENABLED: "false" });
  const off = await request(t, "/share/sitemap.xml");
  assert.equal(off.status, 404);
  assert.equal(off.headers.get("cache-control"), "private, no-store");

  process.env.SHARE_PREVIEWS_ENABLED = "true";
  t.mock.method(console, "error", () => {});
  let attempts = 0;
  t.mock.method(AlbumCatalog, "find", () => {
    attempts += 1;
    const query = { sort: () => query, limit: () => query, lean: async () => { if (attempts === 1) throw new Error("timeout"); return []; } };
    return query;
  });
  delete require.cache[sharePreviewPath];
  const app = express();
  app.use("/share", require("../routes/sharePreview"));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/share/sitemap.xml`;

  const failed = await fetch(url);
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get("cache-control"), "private, no-store");
  const retried = await fetch(url);
  assert.equal(retried.status, 200);
  await fetch(url);
  assert.equal(attempts, 2, "a successful build is reused within its window");
});
