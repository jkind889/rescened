// Renders the real artist-credit and card components to static markup. The
// frontend is bundled in memory with its own Vite, so this needs the frontend
// dependencies (npm --prefix frontend ci) and skips without them. No browser,
// API, database, Clerk, or provider is involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const frontend = path.join(__dirname, "../frontend");
const viteEntry = path.join(frontend, "node_modules/vite/dist/node/index.js");
const available = fs.existsSync(viteEntry);
const cacheDir = path.join(frontend, "node_modules/.cache/rescened-tests");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";

let ui;
let h;

test.before(async () => {
  if (!available) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  const src = path.join(frontend, "src").split(path.sep).join("/");
  fs.writeFileSync(path.join(cacheDir, "entry.jsx"), `
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
export { createElement } from "react";
export { CardLink, CardTitleLink } from "${src}/Components/CardLink.jsx";
export { default as ArtistCredits } from "${src}/features/artists/ArtistCredits.jsx";
export { artistLinkStore } from "${src}/features/artists/useArtistLinks.js";
export { RankedAlbumList, ReviewQueue } from "${src}/features/home/SignalPanels.jsx";
export function render(node) { return renderToStaticMarkup(<StaticRouter location="/">{node}</StaticRouter>); }
`);
  const { build } = await import(pathToFileURL(viteEntry).href);
  const result = await build({
    root: frontend,
    configFile: false,
    logLevel: "error",
    mode: "test",
    define: { "import.meta.env.VITE_API_URL": JSON.stringify("http://api.test") },
    oxc: { jsx: { runtime: "automatic" } },
    ssr: { noExternal: true },
    build: { ssr: path.join(cacheDir, "entry.jsx"), write: false, minify: false, rollupOptions: { output: { format: "esm" } } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  fs.writeFileSync(path.join(cacheDir, "bundle.mjs"), output[0].code);
  ui = await import(pathToFileURL(path.join(cacheDir, "bundle.mjs")).href);
  h = ui.createElement;
});

test.after(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const component = (name, fn) => test(name, { skip: available ? false : "Run npm --prefix frontend ci to enable the component render tests" }, fn);

// Every anchor with its href and visible text; fails the test if one nests in another.
function anchors(html) {
  const found = [];
  const stack = [];
  for (const token of html.match(/<a\b[^>]*>|<\/a>|[^<]+|<[^>]+>/g) || []) {
    if (/^<a\b/.test(token)) {
      assert.equal(stack.length, 0, `anchor nested in another anchor: ${html}`);
      const entry = { href: (token.match(/href="([^"]*)"/) || [])[1], text: "" };
      stack.push(entry);
      found.push(entry);
    } else if (token === "</a>") stack.pop();
    else if (stack.length && !token.startsWith("<")) stack[0].text += token.replaceAll("&amp;", "&");
  }
  return found;
}

const hrefs = (html) => anchors(html).map((entry) => entry.href);

component("credits link only artists the API confirmed, and keep the stored wording", () => {
  const album = {
    albumId: "album-1",
    artistDisplayName: "JAY-Z & Kanye West feat. Guest",
    artistCredits: [{ name: "JAY-Z", artistId: A }, { name: "Kanye West", artistId: B }, { name: "Guest" }],
  };
  const before = ui.render(h(ui.ArtistCredits, { album }));
  assert.equal(before, "JAY-Z &amp; Kanye West feat. Guest", "unverified credits are plain text");

  ui.artistLinkStore.confirm([A]);
  const one = ui.render(h(ui.ArtistCredits, { album }));
  assert.deepEqual(anchors(one).map((entry) => [entry.href, entry.text]), [[`/artist/${A}`, "JAY-Z"]]);
  assert.equal(one.replace(/<[^>]+>/g, "").replaceAll("&amp;", "&"), "JAY-Z & Kanye West feat. Guest");

  ui.artistLinkStore.confirm([B]);
  assert.deepEqual(hrefs(ui.render(h(ui.ArtistCredits, { album }))), [`/artist/${A}`, `/artist/${B}`], "multiple credits link separately, in order; the ID-less guest stays plain");
});

component("an album response that lists its linked artists is used as is, and a name never links", () => {
  const detail = {
    artistDisplayName: "Solo & Duo",
    artistCredits: [{ name: "Solo", artistId: C }, { name: "Duo", artistId: D }],
    artistPages: { artistIds: [C] },
  };
  assert.deepEqual(hrefs(ui.render(h(ui.ArtistCredits, { album: detail }))), [`/artist/${C}`]);

  // The same words as a confirmed artist's name, but no artistId: plain text.
  ui.artistLinkStore.confirm([E]);
  const nameOnly = { artistDisplayName: "Confirmed Name", artistCredits: [{ name: "Confirmed Name" }] };
  assert.equal(ui.render(h(ui.ArtistCredits, { album: nameOnly })), "Confirmed Name");
  assert.equal(ui.render(h(ui.ArtistCredits, { album: { artistDisplayName: "Confirmed Name" } })), "Confirmed Name", "no credits at all");
});

component("missing artists use the caller's fallback and never produce an empty link", () => {
  assert.equal(ui.render(h(ui.ArtistCredits, { album: undefined, fallback: "Unknown artist" })), "Unknown artist");
  assert.equal(ui.render(h(ui.ArtistCredits, { album: { artistDisplayName: "", artistCredits: [] }, fallback: "Artist unknown" })), "Artist unknown");
  assert.equal(ui.render(h(ui.ArtistCredits, { album: {} })), "");
});

component("home cards keep the album link and artist links as separate, non-nested links", () => {
  ui.artistLinkStore.confirm([A, B]);
  const albums = [
    { albumId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Watch the Throne", artistDisplayName: "JAY-Z & Kanye West", artistCredits: [{ name: "JAY-Z", artistId: A }, { name: "Kanye West", artistId: B }], reviewCount: 3, averageRating: 4.5 },
    { albumId: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Name Only", artistDisplayName: "JAY-Z", artistCredits: [{ name: "JAY-Z" }], reviewCount: 1, averageRating: 3 },
  ];
  const html = ui.render(h(ui.RankedAlbumList, { albums }));
  const links = anchors(html);
  assert.deepEqual(links.map((entry) => entry.href), [
    `/album/${albums[0].albumId}`, `/artist/${A}`, `/artist/${B}`,
    `/album/${albums[1].albumId}`,
  ], "the album link holds the title; artists link only with a confirmed artistId");
  assert.deepEqual(links.filter((entry) => entry.href.startsWith("/album/")).map((entry) => entry.text), ["Watch the Throne", "Name Only"], "the album link has real text, not an empty overlay");
  assert.match(html, /<div class="card-link signal-rank-row">/, "the card is a container, not an anchor");

  const queue = ui.render(h(ui.ReviewQueue, { albums: [{ albumId: albums[0].albumId, album: albums[0], listenCount: 2, lastListenedOn: "2026-11-01" }] }));
  const queueLinks = anchors(queue).map((entry) => entry.href);
  assert.deepEqual(queueLinks.filter((href) => href.startsWith("/artist/")), [`/artist/${A}`, `/artist/${B}`]);
  assert.equal(queueLinks.filter((href) => href.startsWith("/album/")).length, 2, "the title link and the separate Review action");
});
