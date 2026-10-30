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
