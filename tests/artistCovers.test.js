const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { COVER_CYCLE_MAX, selectArtistCovers } = require("../lib/artists/read");

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const frontend = (file) => fs.readFileSync(path.join(__dirname, "../frontend/src", file), "utf8");
const helpers = import(`data:text/javascript;base64,${Buffer.from(frontend("features/artists/artists.js")).toString("base64")}`);

let counter = 0;
function row(overrides = {}) {
  counter += 1;
  return {
    albumId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    title: `Release ${counter}`,
    artistCredits: [{ name: "Me", role: "main", artistId: ME }],
    releaseYear: 2000 + counter,
    cover: `https://coverartarchive.org/release/${String(counter).padStart(8, "0")}-0000-4000-8000-000000000000/front-500`,
    ...overrides,
  };
}

test("covers come only from releases where the artist has a main credit, by identity", () => {
  const main = row();
  const defaultRole = row({ artistCredits: [{ name: "Me", artistId: ME }] });
  const featured = row({ artistCredits: [{ name: "Other", role: "main", artistId: OTHER }, { name: "Me", role: "featured", artistId: ME }] });
  const nameOnly = row({ artistCredits: [{ name: "Me", role: "main" }] });
  const someoneElse = row({ artistCredits: [{ name: "Me", role: "main", artistId: OTHER }] });
  const picked = selectArtistCovers([main, defaultRole, featured, nameOnly, someoneElse], ME);
  assert.deepEqual(picked.map((cover) => cover.albumId), [main.albumId, defaultRole.albumId], "a role-less credit counts as main; guest, name-only, and other-artist credits do not");
});

test("solo releases come before collaborations and each group keeps newest-first order", () => {
  const collabNew = row({ artistCredits: [{ name: "Me", role: "main", artistId: ME }, { name: "Other", role: "main", artistId: OTHER }] });
  const soloNew = row();
  const soloOld = row();
  // A credit with no identity is still another credited party.
  const collabPlain = row({ artistCredits: [{ name: "Me", role: "main", artistId: ME }, { name: "Plain Name", role: "main" }] });
  const picked = selectArtistCovers([collabNew, soloNew, collabPlain, soloOld], ME);
  assert.deepEqual(picked.map((cover) => cover.albumId), [soloNew.albumId, soloOld.albumId, collabNew.albumId, collabPlain.albumId]);
  // Two credits that share this artist's artistId are still one artist: solo.
  const aliases = row({ artistCredits: [{ name: "Me", role: "main", artistId: ME }, { name: "Also Me", role: "main", artistId: ME }] });
  assert.equal(selectArtistCovers([collabNew, aliases], ME)[0].albumId, aliases.albumId);
});

test("missing, blank, non-https, malformed, and duplicate covers are skipped and the cycle is capped", () => {
  const good = row();
  const sameImage = row({ cover: good.cover });
  const rows = [
    row({ cover: "" }),
    row({ cover: undefined }),
    row({ cover: "http://example.invalid/a.jpg" }),
    row({ cover: "javascript:alert(1)" }),
    row({ cover: "//example.invalid/a.jpg" }),
    row({ cover: "https://user:pass@example.invalid/a.jpg" }),
    row({ cover: `https://example.invalid/${"a".repeat(2100)}` }),
    row({ cover: 42 }),
    good,
    sameImage,
  ];
  assert.deepEqual(selectArtistCovers(rows, ME).map((cover) => cover.albumId), [good.albumId], "only the first of two releases sharing an image is kept");
  assert.deepEqual(selectArtistCovers([], ME), []);
  assert.deepEqual(selectArtistCovers(undefined, ME), []);
  const many = Array.from({ length: COVER_CYCLE_MAX + 5 }, () => row());
  assert.equal(selectArtistCovers(many, ME).length, COVER_CYCLE_MAX);
});

test("a cover entry exposes only the public album id, title, year, and image", () => {
  const [cover] = selectArtistCovers([{ ...row({ releaseYear: undefined, yearKey: 1999 }), _id: "internal", secret: "x" }], ME);
  assert.deepEqual(Object.keys(cover).sort(), ["albumId", "cover", "releaseYear", "title"]);
  assert.equal(cover.releaseYear, 1999);
  assert.equal(selectArtistCovers([row({ releaseYear: undefined, yearKey: -1 })], ME)[0].releaseYear, null);
});

test("cycle helpers drop unusable covers and wrap in both directions", async () => {
  const { usableCovers, coverCycleStep, coverCycleLabel, coverCaption, currentCover, COVER_CYCLE_MAX: max } = await helpers;
  const a = { albumId: "a", title: "A", releaseYear: 2001, cover: "https://example.invalid/a.jpg" };
  const b = { albumId: "b", title: "B", releaseYear: null, cover: "https://example.invalid/b.jpg" };
  assert.deepEqual(usableCovers([a, b, null, { ...a, albumId: "" }, { ...a, title: "" }, { ...a, cover: "http://example.invalid/x" }, { ...b, albumId: "dup" }, "x"]), [a, b]);
  assert.deepEqual(usableCovers([a, b], ["https://example.invalid/a.jpg"]), [b], "a cover that failed to load is dropped");
  assert.deepEqual(usableCovers([a], ["https://example.invalid/a.jpg"]), []);
  assert.deepEqual(usableCovers(undefined), []);
  assert.deepEqual(usableCovers("nope"), []);
  assert.equal(usableCovers(Array.from({ length: 20 }, (_, i) => ({ ...a, albumId: `x${i}`, cover: `https://example.invalid/${i}.jpg` }))).length, max);

  assert.equal(coverCycleStep(0, 3, 1), 1);
  assert.equal(coverCycleStep(2, 3, 1), 0, "forward wraps to the first");
  assert.equal(coverCycleStep(0, 3, -1), 2, "back wraps to the last");
  assert.equal(coverCycleStep(7, 3, 1), 2, "an index left over from a longer list is brought into range");
  assert.equal(coverCycleStep(0, 0, 1), 0);
  assert.equal(coverCycleStep(Number.NaN, 3, 1), 1);
  assert.equal(coverCycleLabel(0, 3), "1 of 3");
  assert.equal(coverCycleLabel(4, 3), "2 of 3");
  assert.equal(coverCycleLabel(0, 0), "");
  assert.equal(currentCover([a, b], 3), b);
  assert.equal(currentCover([], 0), null);
  assert.equal(coverCaption(a), "A (2001)");
  assert.equal(coverCaption(b), "B");
  assert.equal(coverCaption(null), "");
});

test("the cycle advances by itself only when nothing is in the way", async () => {
  const { shouldAutoAdvance } = await helpers;
  const free = { count: 3, paused: false, reducedMotion: false, hovered: false, focused: false, hidden: false };
  assert.equal(shouldAutoAdvance(free), true);
  assert.equal(shouldAutoAdvance({ ...free, count: 1 }), false, "one cover never cycles");
  assert.equal(shouldAutoAdvance({ ...free, count: 0 }), false);
  for (const blocker of ["paused", "reducedMotion", "hovered", "focused", "hidden"]) {
    assert.equal(shouldAutoAdvance({ ...free, [blocker]: true }), false, blocker);
  }
  assert.equal(shouldAutoAdvance({ count: 2 }), true, "unspecified conditions default to free");
});

test("the component and styles keep the motion, pause, and fallback contract and use no provider", () => {
  const component = frontend("features/artists/ArtistCoverCycle.jsx");
  const css = frontend("features/artists/ArtistPage.css");
  const page = frontend("Pages/ArtistPage.jsx");
  for (const required of [
    "(prefers-reduced-motion: reduce)", "visibilitychange", "if (!cover) return null;", "aria-live={multiple && !auto ? \"polite\" : \"off\"}",
    "aria-roledescription", "Pause cover cycle", "Play cover cycle", "Previous cover", "Next cover", "reducedMotion ? null", "eager",
    ":focus-visible", "event.pointerType === \"mouse\"", "setFailed(", "Cover art from releases by",
  ]) assert.ok(component.includes(required), required);
  assert.equal(/fetch\(|wikipedia|wikidata|commons|upload\.wikimedia|XMLHttpRequest/i.test(component), false, "the cycle reads only the covers it was given");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.artist-cover-frame\.is-moving \.artist-cover-image\s*\{\s*animation: none;/);
  assert.match(css, /\.artist-page-header:has\(> \.artist-cover-cycle\)/, "the two-column header applies only while the cycle renders");
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(page, /usableCovers\(data\?\.covers\)/, "an older API without covers leaves the header unchanged");
});
