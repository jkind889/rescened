// Titles and descriptions for pages that render their own head tags. They
// match the crawler share pages (lib/sharePreview/render.js), so a shared link
// reads the same before and after the SPA loads.
// Canonical links always name the production site, whatever host serves the SPA.
export const SITE_URL = "https://rescened.com";
export const SITE_NAME = "rescened";
const DESCRIPTION_LIMIT = 200;

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

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Counts code points, so a cut never splits a surrogate pair.
export function truncateText(value, limit) {
  const characters = Array.from(clean(value));
  if (characters.length <= limit) return characters.join("");
  return `${characters.slice(0, Math.max(limit - 1, 0)).join("").trimEnd()}…`;
}

export function canonicalUrl(path) {
  return `${SITE_URL}${path}`;
}

export function albumPageMeta(album) {
  const type = RELEASE_TYPE_LABELS[album?.releaseType] || RELEASE_TYPE_LABELS.album;
  const artist = clean(album?.artistDisplayName);
  const year = Number.isInteger(album?.releaseYear) && album.releaseYear > 0 ? `, released ${album.releaseYear}` : "";
  return {
    title: `${clean(album?.title)} by ${artist} · ${SITE_NAME}`,
    description: truncateText(`${type} by ${artist}${year}. Read reviews and rate it on ${SITE_NAME}.`, DESCRIPTION_LIMIT),
    canonical: canonicalUrl(`/album/${encodeURIComponent(album?.albumId || "")}`),
  };
}

export function reviewPageMeta(review) {
  const album = review?.album || {};
  const username = clean(review?.author?.username) || "deleted user";
  const rating = Number(review?.rating);
  return {
    title: `${username}'s review of ${clean(album.title)} by ${clean(album.artistDisplayName)} · ${SITE_NAME}`,
    description: truncateText([Number.isFinite(rating) ? `${rating}/5` : "", clean(review?.reviewText)].filter(Boolean).join(" · "), DESCRIPTION_LIMIT),
    canonical: canonicalUrl(`/review/${encodeURIComponent(review?.reviewId || "")}`),
  };
}
