// The synthetic preview's in-page fake API and launcher arguments. The fake
// API is fixture-only; these tests keep its guards honest so the preview
// does not demonstrate behavior the real server refuses.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const { DEFAULT_PORT, parsePort, entrySource } = require("../scripts/artistSuggestionsPreview.cjs");

const loadFakeApi = () => import(pathToFileURL(path.join(__dirname, "../scripts/preview/artistSuggestionsFakeApi.mjs")).href);
const MBID_NEW = "83096042-3785-481e-8843-dee69f1aad12";
const MBID_REGISTERED = "a74b1b7f-71a5-4011-9441-d0b5e4122711";

test("the launcher uses a fixed loopback port and labels the page synthetic", () => {
  assert.equal(parsePort([]), DEFAULT_PORT);
  assert.equal(parsePort(["--port", "5391"]), 5391);
  assert.throws(() => parsePort(["--port", "80"]), /1024 to 65535/);
  assert.throws(() => parsePort(["--port", "abc"]), /integer/);
  const source = entrySource();
  assert.match(source, /SYNTHETIC PREVIEW/);
  assert.equal(/mongodb|MONGO_URI|CLERK_SECRET|musicbrainz\.org\/ws/i.test(source), false, "the preview never reaches a database, Clerk secret, or MusicBrainz API");
});

test("the fake API keeps the real guards: request keys, exact-MBID reuse, and reviewed revisions", async () => {
  const { createFakeApi } = await loadFakeApi();
  const api = createFakeApi({ now: () => new Date("2026-11-15T00:00:00.000Z") });
  assert.deepEqual(api.handle("GET", "/artist-discovery/capabilities").body, { enabled: true });
  const local = api.handle("GET", "/artist-discovery/local?q=Nova&limit=8").body.results;
  assert.equal(local.length, 2, "same-name local artists stay distinct");
  const candidates = api.handle("GET", "/artist-discovery/musicbrainz?q=Nova").body.candidates;
  assert.equal(candidates.find((row) => row.artistMbid === MBID_REGISTERED).registeredArtistId, local[0].artistId);

  const already = api.handle("POST", "/artist-suggestions", { artistProposal: { kind: "musicbrainz", artistMbid: MBID_REGISTERED }, requestKey: "k0" });
  assert.equal(already.status, 409);
  assert.equal(already.body.existingArtist.artistId, local[0].artistId);
  assert.equal(api.handle("POST", "/artist-suggestions", { artistProposal: { kind: "musicbrainz", artistMbid: MBID_NEW } }).body.code, "INVALID_REQUEST_KEY");

  const body = { artistProposal: { kind: "musicbrainz", artistMbid: MBID_NEW }, note: "UK", requestKey: "k1" };
  const created = api.handle("POST", "/artist-suggestions", body);
  assert.equal(created.status, 201);
  assert.match(created.body.submissionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(api.handle("POST", "/artist-suggestions", body).body.idempotent, true);
  assert.equal(api.handle("POST", "/artist-suggestions", { ...body, note: "changed" }).body.code, "REQUEST_KEY_CONFLICT");
  const id = created.body.submissionId;
  assert.equal(api.handle("GET", `/artist-suggestions/${id}`, undefined, "user_other").status, 404);
  assert.equal(JSON.stringify(api.handle("GET", "/artist-suggestions/mine").body).includes("evidence"), false);

  assert.equal(api.handle("POST", `/moderation/artist-suggestions/${id}/approve`, {}).body.code, "EXPECTED_REVISION_REQUIRED");
  assert.equal(api.handle("POST", `/moderation/artist-suggestions/${id}/approve`, { expectedRevision: 2 }).body.code, "STATE_CONFLICT");
  assert.equal(api.handle("POST", `/moderation/artist-suggestions/${id}/reject`, { expectedRevision: 1 }).status, 400, "a reason is required");
  const changes = api.handle("POST", `/moderation/artist-suggestions/${id}/request-changes`, { expectedRevision: 1, reason: "More" });
  assert.equal(changes.body.suggestion.status, "needs_changes");
  assert.equal(api.handle("POST", `/artist-suggestions/${id}/revise`, { artistProposal: body.artistProposal, expectedRevision: 2 }).body.code, "REVISION_CONFLICT");
  const revised = api.handle("POST", `/artist-suggestions/${id}/revise`, { artistProposal: body.artistProposal, expectedRevision: 1 });
  assert.equal(revised.body.currentRevision, 2);
  const approved = api.handle("POST", `/moderation/artist-suggestions/${id}/approve`, { expectedRevision: 2 });
  assert.equal(approved.body.suggestion.approvalOutcome, "created");
  assert.equal(api.handle("GET", "/artist-discovery/musicbrainz?q=Nova").body.candidates.find((row) => row.artistMbid === MBID_NEW).registeredArtistId, approved.body.suggestion.approvedArtistId);

  const other = api.handle("POST", "/artist-suggestions", { artistProposal: { kind: "community", canonicalName: "Nova", evidence: [{ url: "https://example.com/nova" }] }, requestKey: "k2" });
  const detail = api.handle("GET", `/moderation/artist-suggestions/${other.body.submissionId}`).body;
  assert.equal(detail.context.sameNameArtists.length, 3, "advisory duplicate targets by name (two fixtures and the one just approved); nothing is merged");
  assert.equal(api.handle("POST", `/moderation/artist-suggestions/${other.body.submissionId}/mark-duplicate`, { expectedRevision: 1, duplicateOfArtistId: "nope" }).body.code, "INVALID_DUPLICATE_TARGET");
  assert.equal(api.handle("GET", "/suggestions/mine").body.code, "SYNTHETIC_PREVIEW", "everything else is refused");
});
