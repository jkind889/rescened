const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/features/community/genres.js"), "utf8").replace(/^import .*;\n/gm, "");
const helpers = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("inline genres round-trip local drafts and server revisions without workflow fields", async () => {
  const { initialGenreForm, albumGenreChanges, buildAlbumGenreProposal } = await helpers;
  const changes = {
    add: [{ genre: { genreId: "jazz-id", slug: "jazz", name: "Jazz" } }, { newGenre: { name: "Cloud Jazz", parent: { genreId: "parent-id", name: "Electronic" } } }],
    primary: { addIndex: 1 }, note: "Private context",
  };
  const form = initialGenreForm([], changes);
  const restored = JSON.parse(JSON.stringify(albumGenreChanges(form)));
  assert.deepEqual(initialGenreForm([], restored), form);
  assert.deepEqual(buildAlbumGenreProposal(restored), {
    add: [{ genreId: "jazz-id" }, { newGenre: { name: "Cloud Jazz", parentGenreId: "parent-id" }, primary: true }],
    note: "Private context",
  });
  const removed = { ...form, additions: form.additions.slice(0, 1) };
  assert.equal(albumGenreChanges(removed).primary, null, "removing the selected primary clears its index");
  assert.equal(buildAlbumGenreProposal(null), null);
  assert.equal(buildAlbumGenreProposal(albumGenreChanges({ ...form, additions: [] })), null);
});
