const fs = require("node:fs");
const path = require("node:path");

const roots = [
  "benchmarks",
  "routes",
  "models",
  "server.js",
  "frontend/src",
  "lib/catalogImport",
  "lib/listeningStudy",
  "lib/listening",
  "lib/baselines",
  "lib/genres",
  "scripts/lastfmStudy.js",
  "scripts/listeningWorker.js",
  "scripts/listeningMappingSeeds.js",
  "scripts/listeningMetrics.js",
  "scripts/fetchListenBrainzCatalog.js",
  "scripts/importCatalogDataset.js",
  "scripts/validateCatalogDataset.js",
  "scripts/importGenres.js",
  "scripts/backfillMissingAlbumCovers.js",
];
const allowed = ["spotifyProfileUrl", "Spotify Profile", "open.spotify.com/user/"];
const forbidden = ["spotifyId", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "api.spotify.com", "accounts.spotify.com", "getSpotifyAccessToken", "normalizeSpotify"];

function filesIn(target) {
  const full = path.resolve(target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => filesIn(path.join(full, entry.name)));
}

// Album genres advance their own genresRevision instead of catalogRevision,
// which is only safe while no other catalog writer touches them.
// Models only declare fields (a genre suggestion stores a genresRevision
// baseline), so the write guard covers routes, libraries, and scripts.
const genreWriters = ["models/", "lib/genres/"];
const genreWritePatterns = [/\bgenresRevision\b/, /\$(set|unset|push|pull|pullAll|addToSet)\b.*\bgenres\b/, /["']fieldProvenance\.genres["']/];

const violations = [];
for (const file of roots.flatMap(filesIn)) {
  if (!/\.(js|jsx|cjs)$/.test(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (allowed.some((token) => line.includes(token))) return;
    forbidden.filter((token) => line.includes(token)).forEach((token) => violations.push(`${path.relative(process.cwd(), file)}:${index + 1} contains ${token}`));
  });
  const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
  if (!genreWriters.some((prefix) => relative.startsWith(prefix))) {
    lines.forEach((line, index) => {
      if (genreWritePatterns.some((pattern) => pattern.test(line))) violations.push(`${relative}:${index + 1} writes album genres outside the genre service`);
    });
  }
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Catalog contract clean: no provider identity or Spotify API dependencies found.");
}
