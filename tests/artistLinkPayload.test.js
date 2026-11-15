// Client mapping between artist-picker selections on album-suggestion credit
// rows and the server's artistProposals/artistSelections contract, including
// the real SuggestionForm createDraft/buildPayload functions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { normalizeArtistProposals, normalizeArtistSelections } = require("../lib/artists/proposals");

const load = (file) => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, "../frontend/src", file), "utf8")).toString("base64")}`);
const LOCAL = "11111111-1111-4111-8111-111111111111";
const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "83096042-3785-481e-8843-dee69f1aad12";

test("picker selections map to the server contract with exact-MBID reuse only", async () => {
  const { artistRequestFields } = await load("features/artists/artistLinkPayload.js");
  assert.deepEqual(artistRequestFields([null, null]), {}, "no links leaves a legacy payload unchanged");
  const fields = artistRequestFields([
    { kind: "musicbrainz", artistMbid: MBID_A.toUpperCase(), name: "Nova" },
    null,
    { kind: "existing", artistId: LOCAL, name: "Local" },
    { kind: "musicbrainz", artistMbid: MBID_A, name: "Nova" },
    { kind: "community", canonicalName: "Same Name", evidence: [{ url: "https://example.com/1" }] },
    { kind: "community", canonicalName: "Same Name", evidence: [{ url: "https://example.com/2" }] },
    { kind: "musicbrainz", artistMbid: "not-an-mbid" },
  ]);
  assert.deepEqual(fields.artistProposals, [
    { proposalKey: "mb-1", kind: "musicbrainz", artistMbid: MBID_A },
    { proposalKey: "new-1", kind: "community", canonicalName: "Same Name", evidence: [{ url: "https://example.com/1" }] },
    { proposalKey: "new-2", kind: "community", canonicalName: "Same Name", evidence: [{ url: "https://example.com/2" }] },
  ], "same-name community artists stay separate; one MBID shares one proposal");
  assert.deepEqual(fields.artistSelections, [
    { position: 0, kind: "proposal", proposalKey: "mb-1" },
    { position: 2, kind: "existing", artistId: LOCAL },
    { position: 3, kind: "proposal", proposalKey: "mb-1" },
    { position: 4, kind: "proposal", proposalKey: "new-1" },
    { position: 5, kind: "proposal", proposalKey: "new-2" },
  ]);
  // The exact shape the server's strict validator accepts.
  const proposals = normalizeArtistProposals(fields.artistProposals);
  assert.equal(normalizeArtistSelections(fields.artistSelections, proposals, { creditCount: 7 }).length, 5);
});

test("stored selections restore onto credit positions for a revision", async () => {
  const { linksFromSubmission, artistRequestFields } = await load("features/artists/artistLinkPayload.js");
  const source = {
    proposedMetadata: { artistCredits: [{ name: "Tyler, the Creator" }, { name: "Guest" }, { name: "New Band" }] },
    artistProposals: [
      { proposalKey: "mb-1", kind: "musicbrainz", artistMbid: MBID_B, observation: { artistMbid: MBID_B, name: "Guest Canonical", disambiguation: "US", observedAt: "2026-11-15T00:00:00Z" } },
      { proposalKey: "new-1", kind: "community", canonicalName: "New Band", evidence: [{ url: "https://example.com/band", description: "" }] },
    ],
    artistSelections: [
      { position: 0, kind: "existing", artistId: LOCAL },
      { position: 1, kind: "proposal", proposalKey: "mb-1" },
      { position: 2, kind: "proposal", proposalKey: "new-1" },
      { position: 9, kind: "existing", artistId: LOCAL },
    ],
  };
  const links = linksFromSubmission(source);
  assert.equal(links.length, 3, "out-of-range positions are ignored");
  assert.deepEqual(links[1], { kind: "musicbrainz", proposalKey: "mb-1", artistMbid: MBID_B, name: "Guest Canonical", disambiguation: "US", type: "", country: "" });
  assert.deepEqual(links[2], { kind: "community", proposalKey: "new-1", canonicalName: "New Band", evidence: [{ url: "https://example.com/band" }] });
  assert.deepEqual(artistRequestFields(links).artistSelections.map((selection) => selection.position), [0, 1, 2], "restored links resubmit unchanged");
});

test("an explicitly shared community proposal stays one proposal across a revision", async () => {
  const { linksFromSubmission, artistRequestFields } = await load("features/artists/artistLinkPayload.js");
  const source = {
    proposedMetadata: { artistCredits: [{ name: "Band" }, { name: "Band (as remixer)" }, { name: "Band" }] },
    artistProposals: [
      { proposalKey: "shared", kind: "community", canonicalName: "Band", evidence: [{ url: "https://example.com/band", description: "" }] },
      { proposalKey: "other", kind: "community", canonicalName: "Band", evidence: [{ url: "https://example.com/other-band", description: "" }] },
    ],
    artistSelections: [
      { position: 0, kind: "proposal", proposalKey: "shared" },
      { position: 1, kind: "proposal", proposalKey: "shared" },
      { position: 2, kind: "proposal", proposalKey: "other" },
    ],
  };
  const fields = artistRequestFields(linksFromSubmission(source));
  assert.deepEqual(fields.artistProposals.map((proposal) => proposal.proposalKey), ["shared", "other"], "explicit sharing survives; a same-name proposal stays separate");
  assert.deepEqual(fields.artistSelections, [
    { position: 0, kind: "proposal", proposalKey: "shared" },
    { position: 1, kind: "proposal", proposalKey: "shared" },
    { position: 2, kind: "proposal", proposalKey: "other" },
  ]);
  const proposals = normalizeArtistProposals(fields.artistProposals);
  assert.equal(normalizeArtistSelections(fields.artistSelections, proposals, { creditCount: 3 }).length, 3);
});

test("new picker choices never reuse a restored proposal key", async () => {
  const { artistRequestFields } = await load("features/artists/artistLinkPayload.js");
  const fields = artistRequestFields([
    { kind: "community", canonicalName: "Picked", evidence: [{ url: "https://example.com/p" }] },
    { kind: "community", proposalKey: "new-1", canonicalName: "Restored", evidence: [{ url: "https://example.com/r" }] },
    { kind: "musicbrainz", artistMbid: MBID_A, name: "Picked MB" },
    { kind: "musicbrainz", proposalKey: "mb-7", artistMbid: MBID_A, name: "Restored MB" },
    { kind: "community", proposalKey: "mb-7", canonicalName: "Kind clash", evidence: [{ url: "https://example.com/k" }] },
  ]);
  assert.deepEqual(fields.artistProposals.map(({ proposalKey, kind }) => [proposalKey, kind]), [
    ["new-2", "community"],
    ["new-1", "community"],
    ["mb-1", "musicbrainz"],
    ["mb-7", "community"],
  ], "fresh keys skip restored ones, and one MBID shares one proposal (mb-7 was not used by the shared MusicBrainz proposal, so the community link keeps it)");
  assert.deepEqual(fields.artistSelections.map((selection) => selection.proposalKey), ["new-2", "new-1", "mb-1", "mb-1", "mb-7"]);
  const clash = artistRequestFields([
    { kind: "musicbrainz", proposalKey: "k", artistMbid: MBID_A, name: "MB" },
    { kind: "community", proposalKey: "k", canonicalName: "Kind clash", evidence: [{ url: "https://example.com/k" }] },
  ]);
  assert.deepEqual(clash.artistProposals.map(({ proposalKey, kind }) => [proposalKey, kind]), [["k", "musicbrainz"], ["new-1", "community"]], "a key is never reused across kinds");
  const proposals = normalizeArtistProposals(fields.artistProposals);
  assert.equal(normalizeArtistSelections(fields.artistSelections, proposals, { creditCount: 5 }).length, 5);
});

test("SuggestionForm sends links beside unchanged credit wording, roles, and order", async () => {
  const form = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/Community/SuggestionForm.jsx"), "utf8");
  const functions = form.slice(form.indexOf("const MAX_ARTISTS"), form.indexOf("function FormError"));
  const { creditIdentity, creditPayload } = await load("features/community/artistCredits.js");
  const { artistRequestFields, linksFromSubmission } = await load("features/artists/artistLinkPayload.js");
  const context = vm.createContext({ RELEASE_TYPE_OPTIONS: [], SOURCE_TYPE_OPTIONS: [], buildAlbumGenreProposal: () => null, creditIdentity, creditPayload, artistRequestFields, linksFromSubmission });
  const { createDraft, buildPayload } = vm.runInContext(`${functions}\n({ createDraft, buildPayload })`, context);
  const draft = createDraft({
    proposedMetadata: {
      title: "Fixture",
      artistCredits: [
        { name: "Tyler, the Creator", role: "main" },
        { name: "Prefilled", role: "featured", artistMbid: MBID_A },
        { name: "Earth, Wind & Fire", role: "producer" },
      ],
      releaseType: "album",
      releaseDate: "2026",
    },
    supportingSources: [{ type: "other", url: "https://example.com/" }],
  });
  draft.proposedMetadata.artistCredits[0].link = { kind: "existing", artistId: LOCAL, name: "Tyler Canonical" };
  // A row still carrying its prefill identity never sends a link.
  draft.proposedMetadata.artistCredits[1].link = { kind: "musicbrainz", artistMbid: MBID_B, name: "Ignored" };
  draft.proposedMetadata.artistCredits[2].link = { kind: "community", canonicalName: "EWF", evidence: [{ url: "https://example.com/ewf" }] };

  const linked = buildPayload(draft, true);
  assert.deepEqual(JSON.parse(JSON.stringify(linked.proposedMetadata.artistCredits)), [
    { name: "Tyler, the Creator", role: "main" },
    { name: "Prefilled", role: "featured", artistMbid: MBID_A },
    { name: "Earth, Wind & Fire", role: "producer" },
  ], "credit wording, roles and order are untouched; commas stay inside one credit");
  assert.deepEqual(JSON.parse(JSON.stringify(linked.artistSelections)), [
    { position: 0, kind: "existing", artistId: LOCAL },
    { position: 2, kind: "proposal", proposalKey: "new-1" },
  ]);

  const off = buildPayload(draft, false);
  assert.equal("artistSelections" in off, false, "with linking off the payload keeps the legacy shape");
  assert.equal("artistProposals" in off, false);

  // Renaming the prefilled credit drops its old identity, so its link is sent.
  draft.proposedMetadata.artistCredits[1].name = "Prefilled (renamed)";
  const renamed = buildPayload(draft, true);
  assert.deepEqual(JSON.parse(JSON.stringify(renamed.proposedMetadata.artistCredits[1])), { name: "Prefilled (renamed)", role: "featured" });
  assert.deepEqual(JSON.parse(JSON.stringify(renamed.artistSelections.map((selection) => selection.position))), [0, 1, 2]);

  const restored = createDraft(JSON.parse(JSON.stringify(draft)));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.proposedMetadata.artistCredits.map((artist) => artist.link?.kind || null))), ["existing", "musicbrainz", "community"], "a local draft keeps its links");
});
