const fs = require("node:fs");
const path = require("node:path");

const roots = [
  "benchmarks",
  "routes",
  "models",
  "server.js",
  "frontend/src",
  "lib/catalogImport",
  "scripts/fetchListenBrainzCatalog.js",
  "scripts/importCatalogDataset.js",
  "scripts/validateCatalogDataset.js",
];
const allowed = ["spotifyProfileUrl", "Spotify Profile", "open.spotify.com/user/"];
const forbidden = ["spotifyId", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "api.spotify.com", "accounts.spotify.com", "getSpotifyAccessToken", "normalizeSpotify"];

function filesIn(target) {
  const full = path.resolve(target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [full];
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => filesIn(path.join(full, entry.name)));
}

const violations = [];
for (const file of roots.flatMap(filesIn)) {
  if (!/\.(js|jsx|cjs)$/.test(file)) continue;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (allowed.some((token) => line.includes(token))) return;
    forbidden.filter((token) => line.includes(token)).forEach((token) => violations.push(`${path.relative(process.cwd(), file)}:${index + 1} contains ${token}`));
  });
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Catalog contract clean: no provider identity or Spotify API dependencies found.");
}
