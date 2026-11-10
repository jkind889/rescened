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

test("album form drafts and payloads preserve genres together with an unedited provider edition", async () => {
  const vm = require("node:vm");
  const { buildAlbumGenreProposal } = await helpers;
  const form = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/Community/SuggestionForm.jsx"), "utf8");
  const functions = form.slice(form.indexOf("const MAX_ARTISTS"), form.indexOf("function FormError"));
  const context = vm.createContext({ RELEASE_TYPE_OPTIONS: [], SOURCE_TYPE_OPTIONS: [], buildAlbumGenreProposal });
  const { createDraft, buildPayload } = vm.runInContext(`${functions}\n({ createDraft, buildPayload })`, context);
  const initial = {
    proposedMetadata: { title: "Fixture", artistCredits: [{ name: "Artist" }], releaseType: "album", releaseDate: "2026" },
    supportingSources: [{ type: "musicbrainz", url: "https://musicbrainz.org/" }],
    editionProposal: { previewId: "11111111-1111-4111-8111-111111111111", candidate: { tracks: [{ title: "One", discNumber: 1, trackNumber: 1 }] } },
    proposedGenres: { add: [{ genre: { genreId: "jazz-id", name: "Jazz" } }], note: "Genre evidence" },
  };
  const draft = createDraft(initial);
  assert.equal(draft.proposedMetadata.tracks[0].title, "One");
  assert.equal(draft.proposedGenres.note, "Genre evidence");
  const payload = JSON.parse(JSON.stringify(buildPayload(draft)));
  assert.equal(payload.editionPreviewId, initial.editionProposal.previewId);
  assert.equal(Object.hasOwn(payload.proposedMetadata, "tracks"), false, "provider tracks remain server-authored");
  assert.deepEqual(payload.proposedGenres, { add: [{ genreId: "jazz-id" }], note: "Genre evidence" });
});
