const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const Artist = require("../models/Artist");
const {
  artistMbidOf,
  newArtistDocument,
  newCommunityArtistDocument,
} = require("../lib/artists/identity");
const {
  ArtistProposalValidationError,
  newObservedMusicBrainzArtistDocument,
  normalizeArtistProposals,
  normalizeArtistSelections,
  prepareArtistProposals,
  resolveArtistSelections,
} = require("../lib/artists/proposals");
const {
  RequestKeyConflictError,
  canonicalJson,
  createWithRequestKey,
  normalizeRequestKey,
  payloadDigest,
  requestKeyFields,
} = require("../routes/utils/requestKeys");
const { normalizeCommandBody } = require("../routes/utils/moderation");
const { approvalReceipt, approveAlbumSubmission, assertRetryMatchesApproval } = require("../routes/utils/approval");

const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "83096042-3785-481e-8843-dee69f1aad12";
const MBID_C = "e941e097-0f9e-496d-a381-dd74a953682c";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBSERVED_AT = new Date("2026-11-15T12:00:00.000Z");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function code(expected) {
  return (error) => {
    assert.equal(error.code, expected, error.message);
    return true;
  };
}

// In-memory registry that understands the identity helpers' query shapes and
// records the session each call received.
function fakeRegistry(rows = [], { createError } = {}) {
  const artists = clone(rows);
  const created = [];
  const sessions = [];
  return {
    artists,
    created,
    sessions,
    find(query) {
      let result = artists;
      if (query.artistId) result = artists.filter((artist) => query.artistId.$in.includes(artist.artistId));
      if (query.externalReferences) {
        const wanted = query.externalReferences.$elemMatch.externalId.$in;
        result = artists.filter((artist) => wanted.includes(artistMbidOf(artist)));
      }
      return {
        session(session) { sessions.push(session); return this; },
        lean() { return this; },
        exec: () => Promise.resolve(clone(result)),
      };
    },
    async create(documents, options) {
      sessions.push(options?.session);
      if (createError) throw createError;
      created.push(...clone(documents));
      artists.push(...clone(documents));
      return documents;
    },
  };
}

function registered(mbid, name, artistId = crypto.randomUUID()) {
  return newArtistDocument({ artistId, name, artistMbid: mbid, source: "import", provenance: { source: "musicbrainz" } });
}

function observation(mbid, name, extra = {}) {
  return { artistMbid: mbid, name, sortName: "", disambiguation: "", type: "", observedAt: OBSERVED_AT, ...extra };
}

async function validationErrors(document) {
  try {
    await document.validate();
    return undefined;
  } catch (error) {
    return error.errors || error;
  }
}

function community(proposalKey, canonicalName, url = "https://example.com/artist") {
  return { proposalKey, kind: "community", canonicalName, evidence: [{ url }] };
}

// ---------------------------------------------------------------------------
// Proposal and selection request contract

test("proposals accept the two explicit kinds and normalize them", () => {
  const proposals = normalizeArtistProposals([
    { proposalKey: "mb-1", kind: "musicbrainz", artistMbid: MBID_A.toUpperCase() },
    { proposalKey: "c-1", kind: "community", canonicalName: "  Café Noir ", evidence: [{ url: " https://example.com/a ", description: " Label page " }] },
  ]);
  assert.deepEqual(proposals, [
    { proposalKey: "mb-1", kind: "musicbrainz", artistMbid: MBID_A },
    { proposalKey: "c-1", kind: "community", canonicalName: "Café Noir", evidence: [{ url: "https://example.com/a", description: "Label page" }] },
  ]);
  assert.deepEqual(normalizeArtistProposals(undefined), []);
});

test("proposals reject unknown, client-owned, and malformed fields", () => {
  const cases = [
    [{ proposalKey: "a", kind: "musicbrainz", artistMbid: MBID_A, name: "Client name" }, /name is not allowed/],
    [{ proposalKey: "a", kind: "musicbrainz", artistMbid: MBID_A, observation: { name: "X" } }, /observation is not allowed/],
    [{ proposalKey: "a", kind: "musicbrainz", artistMbid: MBID_A, artistId: crypto.randomUUID() }, /artistId is not allowed/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X", evidence: [{ url: "https://e.com" }], artistMbid: MBID_A }, /artistMbid is not allowed/],
    [{ proposalKey: "a", kind: "spotify", artistMbid: MBID_A }, /kind must be/],
    [{ proposalKey: "A", kind: "musicbrainz", artistMbid: MBID_A }, /proposalKey/],
    [{ proposalKey: "", kind: "musicbrainz", artistMbid: MBID_A }, /proposalKey/],
    [{ proposalKey: "a", kind: "musicbrainz", artistMbid: "not-an-mbid" }, /artistMbid must be/],
    [{ proposalKey: "a", kind: "community", canonicalName: " ", evidence: [{ url: "https://e.com" }] }, /canonicalName/],
    [{ proposalKey: "a", kind: "community", canonicalName: "Bad\u0007Name", evidence: [{ url: "https://e.com" }] }, /canonicalName/],
    [{ proposalKey: "a", kind: "community", canonicalName: "x".repeat(201), evidence: [{ url: "https://e.com" }] }, /200 characters/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X", evidence: [] }, /one to 5/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X" }, /one to 5/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X", evidence: [{ url: "http://e.com" }] }, /https/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X", evidence: [{ url: "https://user:pw@e.com" }] }, /credentials/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X", evidence: [{ url: "javascript:alert(1)" }] }, /https/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X", evidence: [{ url: "https://e.com", fetched: true }] }, /fetched is not allowed/],
    [{ proposalKey: "a", kind: "community", canonicalName: "X", evidence: [{ url: "https://e.com" }, { url: "https://e.com" }] }, /more than once/],
  ];
  for (const [entry, pattern] of cases) {
    assert.throws(() => normalizeArtistProposals([entry]), (error) => error instanceof ArtistProposalValidationError && pattern.test(error.message), JSON.stringify(entry));
  }
  assert.throws(() => normalizeArtistProposals({}), /must be an array/);
  assert.throws(
    () => normalizeArtistProposals(Array.from({ length: 21 }, (_, index) => community(`c${index}`, "X"))),
    /at most 20/,
  );
});

test("a repeated proposal key or MusicBrainz MBID must be expressed as explicit reuse", () => {
  assert.throws(
    () => normalizeArtistProposals([community("a", "One"), community("a", "Two")]),
    code("DUPLICATE_ARTIST_PROPOSAL"),
  );
  assert.throws(
    () => normalizeArtistProposals([
      { proposalKey: "a", kind: "musicbrainz", artistMbid: MBID_A },
      { proposalKey: "b", kind: "musicbrainz", artistMbid: MBID_A.toUpperCase() },
    ]),
    code("DUPLICATE_ARTIST_PROPOSAL"),
  );
  // Same canonical name, different people: both proposals stand.
  assert.equal(normalizeArtistProposals([community("a", "Nova"), community("b", "Nova")]).length, 2);
});

test("selections link credit positions to an existing artist or a proposal in the same revision", () => {
  const artistId = crypto.randomUUID();
  const proposals = normalizeArtistProposals([community("shared", "Shared")]);
  const selections = normalizeArtistSelections([
    { position: 2, kind: "proposal", proposalKey: "shared" },
    { position: 0, kind: "existing", artistId: artistId.toUpperCase() },
    { position: 1, kind: "proposal", proposalKey: "shared" },
  ], proposals, { creditCount: 3 });
  assert.deepEqual(selections, [
    { position: 0, kind: "existing", artistId },
    { position: 1, kind: "proposal", proposalKey: "shared" },
    { position: 2, kind: "proposal", proposalKey: "shared" },
  ]);
});

test("selections reject unknown fields, bad positions, unknown keys, and unattached proposals", () => {
  const proposals = normalizeArtistProposals([community("a", "A")]);
  const artistId = crypto.randomUUID();
  const cases = [
    [[{ position: 0, kind: "existing", artistId, artistMbid: MBID_A }], /artistMbid is not allowed/],
    [[{ position: 0, kind: "existing", artistId, name: "Rewritten" }], /name is not allowed/],
    [[{ position: 0, kind: "proposal", proposalKey: "a", artistId }], /artistId is not allowed/],
    [[{ position: 0, kind: "musicbrainz", artistMbid: MBID_A }], /kind must be/],
    [[{ position: 0, kind: "existing", artistId: MBID_A.replace(/^(.{14})./, "$13") }], /Rescened artist ID/],
    [[{ position: -1, kind: "proposal", proposalKey: "a" }], /non-negative integer/],
    [[{ position: 1.5, kind: "proposal", proposalKey: "a" }], /non-negative integer/],
    [[{ position: "0", kind: "proposal", proposalKey: "a" }], /non-negative integer/],
  ];
  for (const [list, pattern] of cases) {
    assert.throws(() => normalizeArtistSelections(list, proposals, { creditCount: 2 }), pattern, JSON.stringify(list));
  }
  assert.throws(() => normalizeArtistSelections([{ position: 2, kind: "proposal", proposalKey: "a" }], proposals, { creditCount: 2 }), code("ARTIST_SELECTION_OUT_OF_RANGE"));
  assert.throws(() => normalizeArtistSelections([
    { position: 0, kind: "proposal", proposalKey: "a" },
    { position: 0, kind: "existing", artistId },
  ], proposals, { creditCount: 2 }), code("DUPLICATE_ARTIST_SELECTION"));
  assert.throws(() => normalizeArtistSelections([{ position: 0, kind: "proposal", proposalKey: "b" }], proposals, { creditCount: 2 }), code("UNKNOWN_ARTIST_PROPOSAL"));
  assert.throws(() => normalizeArtistSelections([{ position: 0, kind: "existing", artistId }], proposals, { creditCount: 2 }), code("UNATTACHED_ARTIST_PROPOSAL"));
  assert.throws(() => normalizeArtistSelections([], [], {}), TypeError);
  assert.throws(
    () => normalizeArtistSelections(Array.from({ length: 21 }, (_, position) => ({ position, kind: "existing", artistId })), [], { creditCount: 40 }),
    /at most 20/,
  );
});

// ---------------------------------------------------------------------------
// Server-prepared MusicBrainz observations

test("preparation snapshots the exact MusicBrainz artist and never calls a provider for community proposals", async () => {
  const lookups = [];
  const proposals = normalizeArtistProposals([
    { proposalKey: "mb", kind: "musicbrainz", artistMbid: MBID_A },
    community("c", "Local Name"),
  ]);
  const prepared = await prepareArtistProposals(proposals, {
    lookupMusicBrainzArtist: async (mbid) => {
      lookups.push(mbid);
      return { artistMbid: mbid, name: " Canonical ", sortName: "Canonical", disambiguation: "x".repeat(900), type: "Group", extra: "dropped" };
    },
    now: () => OBSERVED_AT,
  });
  assert.deepEqual(lookups, [MBID_A]);
  assert.deepEqual(prepared[0].observation, {
    artistMbid: MBID_A, name: "Canonical", sortName: "Canonical", disambiguation: "x".repeat(500), type: "Group", observedAt: OBSERVED_AT,
  });
  assert.deepEqual(prepared[1], proposals[1]);
  assert.notEqual(prepared[1].evidence, proposals[1].evidence, "prepared evidence is a copy");

  const communityOnly = await prepareArtistProposals(normalizeArtistProposals([community("c", "X")]));
  assert.equal(communityOnly.length, 1);
  await assert.rejects(prepareArtistProposals(proposals), TypeError);
});

test("preparation refuses missing, redirected, and nameless MusicBrainz artists and surfaces provider failures", async () => {
  const proposals = normalizeArtistProposals([{ proposalKey: "mb", kind: "musicbrainz", artistMbid: MBID_A }]);
  await assert.rejects(prepareArtistProposals(proposals, { lookupMusicBrainzArtist: async () => null }), code("ARTIST_MBID_NOT_FOUND"));
  await assert.rejects(
    prepareArtistProposals(proposals, { lookupMusicBrainzArtist: async () => ({ artistMbid: MBID_B, name: "Merged" }) }),
    (error) => error.code === "ARTIST_MBID_REDIRECTED" && error.details[0].observed === MBID_B,
  );
  await assert.rejects(prepareArtistProposals(proposals, { lookupMusicBrainzArtist: async () => ({ artistMbid: MBID_A, name: "" }) }), code("ARTIST_OBSERVATION_INVALID"));
  const outage = Object.assign(new Error("provider down"), { code: "PROVIDER_UNAVAILABLE" });
  await assert.rejects(prepareArtistProposals(proposals, { lookupMusicBrainzArtist: async () => { throw outage; } }), (error) => error === outage);
});

// ---------------------------------------------------------------------------
// Artist construction

test("community artists have no external reference and record the reviewed canonical name", async () => {
  const provenance = { source: "community", submissionId: crypto.randomUUID(), revision: 2 };
  const first = newCommunityArtistDocument({ canonicalName: " Nova ", provenance, proposalKey: "c-1" });
  const second = newCommunityArtistDocument({ canonicalName: "Nova", provenance });
  assert.match(first.artistId, UUID_V4);
  assert.notEqual(first.artistId, second.artistId, "same name never implies the same artist");
  assert.deepEqual(first.externalReferences, []);
  assert.equal(first.name, "Nova");
  assert.equal(first.artistSource, "community");
  assert.deepEqual(first.fieldProvenance, { name: { ...provenance, nameSource: "community-proposal", proposalKey: "c-1" } });
  assert.equal(await validationErrors(new Artist(first)), undefined);
  assert.throws(() => newCommunityArtistDocument({ canonicalName: "" }), code("INVALID_ARTIST_NAME"));
  assert.throws(() => newCommunityArtistDocument({ canonicalName: "X", artistId: MBID_A.replace(/^(.{14})./, "$13") }), code("INVALID_ARTIST_ID"));
});

test("observed MusicBrainz artists use the observed canonical name and keep the observation time", async () => {
  const artist = newObservedMusicBrainzArtistDocument({ observation: observation(MBID_A, "Canonical"), provenance: { source: "community" } });
  assert.equal(artist.name, "Canonical");
  assert.equal(artistMbidOf(artist), MBID_A);
  assert.equal(artist.artistSource, "community");
  assert.equal(artist.fieldProvenance.name.nameSource, "musicbrainz-artist");
  assert.deepEqual(artist.fieldProvenance.name.observedAt, OBSERVED_AT);
  assert.equal(await validationErrors(new Artist(artist)), undefined);
});

// ---------------------------------------------------------------------------
// Transactional resolver (fake registry; the real index is covered by the
// integration suite)

const CREDITS = [
  { name: "Tyler, the Creator", role: "main" },
  { name: "Earth, Wind & Fire", role: "featured" },
  { name: "Nova" },
  { name: "Nova", role: "main" },
  { name: "Unselected, Inc.", role: "producer", artistId: crypto.randomUUID() },
];

test("resolution links, reuses, and creates artists while preserving every credit's wording", async () => {
  const known = registered(MBID_C, "Known Artist");
  const reusable = registered(MBID_A, "Registry Name Stays");
  const registry = fakeRegistry([known, reusable]);
  const session = { id: "caller-session" };
  const proposals = [
    { proposalKey: "mb-a", kind: "musicbrainz", artistMbid: MBID_A, observation: observation(MBID_A, "Different Upstream Name") },
    { proposalKey: "mb-b", kind: "musicbrainz", artistMbid: MBID_B, observation: observation(MBID_B, "Observed B") },
    { proposalKey: "nova-1", kind: "community", canonicalName: "Nova", evidence: [{ url: "https://example.com/1", description: "" }] },
    { proposalKey: "nova-2", kind: "community", canonicalName: "Nova", evidence: [{ url: "https://example.com/2", description: "" }] },
  ];
  const selections = [
    { position: 0, kind: "proposal", proposalKey: "mb-a" },
    { position: 1, kind: "proposal", proposalKey: "mb-b" },
    { position: 2, kind: "proposal", proposalKey: "nova-1" },
    { position: 3, kind: "proposal", proposalKey: "nova-2" },
  ];
  const result = await resolveArtistSelections({ credits: CREDITS, proposals, selections }, {
    Artist: registry, session, provenance: { source: "community", submissionId: "s" },
  });

  assert.ok(registry.sessions.length >= 2 && registry.sessions.every((value) => value === session), "every registry call joins the caller's session");
  // Credit wording, roles (including a missing role) and order never change.
  result.credits.forEach((credit, index) => {
    assert.equal(credit.name, CREDITS[index].name);
    assert.equal(credit.role, CREDITS[index].role);
    assert.equal(Object.prototype.hasOwnProperty.call(credit, "role"), Object.prototype.hasOwnProperty.call(CREDITS[index], "role"));
  });
  assert.deepEqual(result.credits[4], CREDITS[4], "unselected credits are untouched");
  assert.deepEqual(CREDITS[0], { name: "Tyler, the Creator", role: "main" }, "input credits are not mutated");

  assert.equal(result.credits[0].artistId, reusable.artistId);
  assert.equal(result.credits[0].artistMbid, MBID_A);
  assert.equal(registry.artists.find((artist) => artist.artistId === reusable.artistId).name, "Registry Name Stays", "an exact MBID reuse never renames");

  assert.equal(registry.created.length, 3);
  const createdB = registry.created.find((artist) => artistMbidOf(artist) === MBID_B);
  assert.equal(createdB.name, "Observed B", "a new MusicBrainz artist takes the observed name, not the credit wording");
  assert.equal(result.credits[1].artistId, createdB.artistId);

  assert.notEqual(result.credits[2].artistId, result.credits[3].artistId, "same-name community proposals stay distinct");
  const novas = registry.created.filter((artist) => artist.name === "Nova");
  assert.equal(novas.length, 2);
  assert.ok(novas.every((artist) => artist.externalReferences.length === 0 && !("artistMbid" in result.credits[2])));

  assert.deepEqual(result.resolutions.map(({ position, kind, proposalKey, outcome }) => ({ position, kind, proposalKey, outcome })), [
    { position: 0, kind: "musicbrainz", proposalKey: "mb-a", outcome: "reused" },
    { position: 1, kind: "musicbrainz", proposalKey: "mb-b", outcome: "created" },
    { position: 2, kind: "community", proposalKey: "nova-1", outcome: "created" },
    { position: 3, kind: "community", proposalKey: "nova-2", outcome: "created" },
  ]);
  assert.equal(result.resolutions[2].artistMbid, "");
});

test("an explicitly reused proposal key registers one artist for every credit that names it", async () => {
  const registry = fakeRegistry();
  const proposals = [{ proposalKey: "shared", kind: "community", canonicalName: "Shared", evidence: [{ url: "https://e.com", description: "" }] }];
  const result = await resolveArtistSelections({
    credits: [{ name: "Shared" }, { name: "Shared (as Alias)", role: "featured" }],
    proposals,
    selections: [{ position: 0, kind: "proposal", proposalKey: "shared" }, { position: 1, kind: "proposal", proposalKey: "shared" }],
  }, { Artist: registry });
  assert.equal(registry.created.length, 1);
  assert.equal(result.credits[0].artistId, result.credits[1].artistId);
  assert.equal(result.credits[1].name, "Shared (as Alias)");
});

test("existing selections must name a registered artist and pick up its registry MBID", async () => {
  const known = registered(MBID_C, "Known");
  const registry = fakeRegistry([known]);
  const linked = await resolveArtistSelections({
    credits: [{ name: "Known (credited)", role: "main" }],
    selections: [{ position: 0, kind: "existing", artistId: known.artistId }],
  }, { Artist: registry });
  assert.deepEqual(linked.credits[0], { name: "Known (credited)", role: "main", artistId: known.artistId, artistMbid: MBID_C });
  assert.deepEqual(linked.resolutions, [{ position: 0, kind: "existing", proposalKey: "", artistId: known.artistId, artistMbid: MBID_C, outcome: "linked" }]);
  assert.equal(registry.created.length, 0);

  const ghost = crypto.randomUUID();
  await assert.rejects(
    resolveArtistSelections({ credits: [{ name: "Ghost" }], selections: [{ position: 0, kind: "existing", artistId: ghost }] }, { Artist: registry }),
    (error) => error.code === "ARTIST_IDENTITY_CONFLICT" && error.details[0].code === "ARTIST_NOT_FOUND" && error.details[0].artistId === ghost,
  );
});

test("resolution refuses already-linked credits and tampered stored proposals", async () => {
  const registry = fakeRegistry();
  await assert.rejects(
    resolveArtistSelections({
      credits: [{ name: "Linked", artistMbid: MBID_A }],
      proposals: [{ proposalKey: "c", kind: "community", canonicalName: "C", evidence: [] }],
      selections: [{ position: 0, kind: "proposal", proposalKey: "c" }],
    }, { Artist: registry }),
    (error) => error.code === "ARTIST_IDENTITY_CONFLICT" && error.details[0].code === "CREDIT_ALREADY_LINKED",
  );
  const invalid = [
    // MusicBrainz proposal without a reviewed observation
    { proposals: [{ proposalKey: "m", kind: "musicbrainz", artistMbid: MBID_A }], selections: [{ position: 0, kind: "proposal", proposalKey: "m" }] },
    // Observation for a different MBID
    { proposals: [{ proposalKey: "m", kind: "musicbrainz", artistMbid: MBID_A, observation: observation(MBID_B, "B") }], selections: [{ position: 0, kind: "proposal", proposalKey: "m" }] },
    // Unattached proposal
    { proposals: [{ proposalKey: "c", kind: "community", canonicalName: "C" }], selections: [] },
    // Out-of-range position
    { proposals: [], selections: [{ position: 3, kind: "existing", artistId: crypto.randomUUID() }] },
    // Unknown key
    { proposals: [], selections: [{ position: 0, kind: "proposal", proposalKey: "nope" }] },
  ];
  for (const input of invalid) {
    await assert.rejects(resolveArtistSelections({ credits: [{ name: "X" }], ...input }, { Artist: registry }), code("ARTIST_PROPOSAL_INVALID"), JSON.stringify(input));
  }
  assert.equal(registry.created.length, 0);
});

test("a unique-index collision while registering is reported as a registration race", async () => {
  const registry = fakeRegistry([], { createError: Object.assign(new Error("E11000"), { code: 11000 }) });
  await assert.rejects(
    resolveArtistSelections({
      credits: [{ name: "Racer" }],
      proposals: [{ proposalKey: "m", kind: "musicbrainz", artistMbid: MBID_A, observation: observation(MBID_A, "Racer") }],
      selections: [{ position: 0, kind: "proposal", proposalKey: "m" }],
    }, { Artist: registry }),
    (error) => error.code === "ARTIST_IDENTITY_CONFLICT" && error.details[0].code === "ARTIST_REGISTRATION_RACE" && error.details[0].artistMbid === MBID_A,
  );
  const transient = Object.assign(new Error("WriteConflict"), { code: 112 });
  const failing = fakeRegistry([], { createError: transient });
  await assert.rejects(
    resolveArtistSelections({
      credits: [{ name: "C" }],
      proposals: [{ proposalKey: "c", kind: "community", canonicalName: "C" }],
      selections: [{ position: 0, kind: "proposal", proposalKey: "c" }],
    }, { Artist: failing }),
    (error) => error === transient,
    "transient transaction errors propagate unchanged so the caller's transaction can retry",
  );
});

// ---------------------------------------------------------------------------
// Request keys

test("request keys are optional UUID v4 values and payload digests ignore key order", () => {
  const key = crypto.randomUUID();
  assert.equal(normalizeRequestKey(key.toUpperCase()), key);
  assert.equal(normalizeRequestKey(undefined), "");
  assert.throws(() => normalizeRequestKey(undefined, { required: true }), code("INVALID_REQUEST_KEY"));
  assert.throws(() => normalizeRequestKey("retry-1"), code("INVALID_REQUEST_KEY"));
  assert.throws(() => normalizeRequestKey(42), code("INVALID_REQUEST_KEY"));
  assert.equal(canonicalJson({ b: [2, { d: 1, c: undefined }], a: "x" }), canonicalJson({ a: "x", b: [2, { d: 1 }] }));
  assert.equal(payloadDigest({ a: 1, b: 2 }), payloadDigest({ b: 2, a: 1 }));
  assert.notEqual(payloadDigest({ a: [1, 2] }), payloadDigest({ a: [2, 1] }));
  assert.match(payloadDigest({}), /^[0-9a-f]{64}$/);
  assert.deepEqual(requestKeyFields("", "d"), {});
  assert.deepEqual(requestKeyFields(key, "d"), { creationRequestKey: key, creationPayloadDigest: "d" });
});

function fakeKeyedModel(rows = []) {
  const records = [...rows];
  return {
    records,
    findOne(query) {
      return { exec: async () => records.find((row) => row.submittedByUserId === query.submittedByUserId && row.creationRequestKey === query.creationRequestKey) || null };
    },
  };
}

test("create with a request key returns the original record for the same payload and conflicts otherwise", async () => {
  const key = crypto.randomUUID();
  const digest = payloadDigest({ title: "A" });
  const model = fakeKeyedModel();
  let creates = 0;
  const create = async () => {
    creates += 1;
    const row = { submittedByUserId: "u1", ...requestKeyFields(key, digest), id: creates };
    model.records.push(row);
    return row;
  };
  const first = await createWithRequestKey({ Model: model, userId: "u1", requestKey: key, digest, create });
  const retry = await createWithRequestKey({ Model: model, userId: "u1", requestKey: key, digest, create });
  assert.equal(first.idempotent, false);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.document, first.document);
  assert.equal(creates, 1);
  await assert.rejects(
    createWithRequestKey({ Model: model, userId: "u1", requestKey: key, digest: payloadDigest({ title: "B" }), create }),
    (error) => error instanceof RequestKeyConflictError && error.status === 409,
  );
  const noKey = await createWithRequestKey({ Model: model, userId: "u1", requestKey: "", digest, create });
  assert.equal(noKey.idempotent, false);
  assert.equal(creates, 2);
});

test("a concurrent create that loses the unique index returns the winner or a conflict", async () => {
  const key = crypto.randomUUID();
  const digest = payloadDigest({ title: "A" });
  const model = fakeKeyedModel();
  const collision = Object.assign(new Error("E11000"), { code: 11000, keyPattern: { submittedByUserId: 1, creationRequestKey: 1 } });
  const winner = { submittedByUserId: "u1", ...requestKeyFields(key, digest) };
  const loserCreate = async () => {
    model.records.push(winner); // the other request committed first
    throw collision;
  };
  const result = await createWithRequestKey({ Model: model, userId: "u1", requestKey: key, digest, create: loserCreate });
  assert.deepEqual(result, { document: winner, idempotent: true });

  const other = fakeKeyedModel();
  await assert.rejects(
    createWithRequestKey({
      Model: other,
      userId: "u1",
      requestKey: key,
      digest,
      create: async () => { other.records.push({ submittedByUserId: "u1", ...requestKeyFields(key, payloadDigest({ title: "Z" })) }); throw collision; },
    }),
    code("REQUEST_KEY_CONFLICT"),
  );
  const unrelated = Object.assign(new Error("E11000"), { code: 11000, keyPattern: { submissionId: 1 } });
  await assert.rejects(
    createWithRequestKey({ Model: fakeKeyedModel(), userId: "u1", requestKey: key, digest, create: async () => { throw unrelated; } }),
    (error) => error === unrelated,
  );
});

// ---------------------------------------------------------------------------
// Reviewed-revision command guards and approval receipts

test("every moderation command accepts an optional reviewed revision", () => {
  const target = crypto.randomUUID();
  assert.deepEqual(normalizeCommandBody({ reason: "No", expectedRevision: 2 }, "reject"), { reason: "No", expectedRevision: 2 });
  assert.deepEqual(normalizeCommandBody({ reason: "Fix", expectedRevision: 1 }, "request_changes"), { reason: "Fix", expectedRevision: 1 });
  assert.equal(normalizeCommandBody({ duplicateOfSubmissionId: target, expectedRevision: 3 }, "mark_duplicate").expectedRevision, 3);
  assert.equal(normalizeCommandBody({ expectedRevision: 4 }, "approve").expectedRevision, 4);
  assert.equal("expectedRevision" in normalizeCommandBody({}, "approve"), false, "existing clients keep working");
  assert.equal("expectedRevision" in normalizeCommandBody({ reason: "No" }, "reject"), false);
  for (const value of [0, -1, 1.5, "2", null, true]) {
    assert.throws(() => normalizeCommandBody({ expectedRevision: value }, "approve"), /expectedRevision must be a positive integer/, String(value));
    assert.throws(() => normalizeCommandBody({ reason: "x", expectedRevision: value }, "reject"), /expectedRevision must be a positive integer/);
  }
});

test("approval retries must match the receipt's revision, target, and fields", () => {
  const album = { albumId: crypto.randomUUID() };
  const correction = {
    submissionType: "catalog_correction",
    currentRevision: 2,
    approvalReceipt: { revision: 2, publicationType: "catalog_corrected", targetAlbumId: album.albumId, appliedFields: ["title", "label"], artistResolutions: [] },
  };
  assertRetryMatchesApproval(correction, { expectedRevision: 2, applyFields: ["label", "title"], album });
  assertRetryMatchesApproval(correction, {}, "omitted values are not asserted");
  assert.throws(() => assertRetryMatchesApproval(correction, { expectedRevision: 1, album }), code("APPROVAL_CONFLICT"));
  assert.throws(() => assertRetryMatchesApproval(correction, { applyFields: ["title"], album }), code("APPROVAL_CONFLICT"));
  assert.throws(() => assertRetryMatchesApproval(correction, { albumId: crypto.randomUUID(), album }), code("APPROVAL_CONFLICT"));

  // Legacy approvals without a receipt fall back to the current revision and
  // the approval event's recorded fields.
  const legacy = {
    submissionType: "catalog_correction",
    currentRevision: 3,
    moderationHistory: [{ action: "submitted" }, { action: "approved", application: { appliedFields: ["title"] } }],
  };
  assertRetryMatchesApproval(legacy, { expectedRevision: 3, applyFields: ["title"], album });
  assert.throws(() => assertRetryMatchesApproval(legacy, { expectedRevision: 2, album }), code("APPROVAL_CONFLICT"));
  assert.throws(() => assertRetryMatchesApproval(legacy, { applyFields: ["title", "label"], album }), code("APPROVAL_CONFLICT"));
  assertRetryMatchesApproval({ submissionType: "catalog_correction", currentRevision: 1 }, { applyFields: ["title"], album });
});

test("approval receipts validate as approved-only, append-once records", async () => {
  const albumId = crypto.randomUUID();
  const receipt = approvalReceipt({
    revision: 2,
    publicationType: "catalog_created",
    album: { albumId },
    artistResolutions: [{ position: 0, kind: "community", proposalKey: "c", artistId: crypto.randomUUID(), artistMbid: "", outcome: "created" }],
    approvedAt: OBSERVED_AT,
  });
  assert.deepEqual(Object.keys(receipt), ["revision", "publicationType", "targetAlbumId", "appliedFields", "artistResolutions", "approvedAt"]);
  const base = {
    submissionId: crypto.randomUUID(),
    submittedByUserId: "u1",
    proposedMetadata: { title: "T", artistDisplayName: "A", artistCredits: [{ name: "A" }], releaseType: "album", releaseDate: "2026", releaseDatePrecision: "year", releaseYear: 2026 },
    supportingSources: [{ type: "other", url: "https://example.com" }],
    normalizedFingerprint: "f".repeat(64),
  };
  const pending = new AlbumSubmission({ ...base, approvalReceipt: receipt });
  assert.match((await validationErrors(pending))?.approvalReceipt?.message || "", /approved submissions/);
  const approved = new AlbumSubmission({
    ...base, status: "approved", approvedAlbumCatalogId: new mongoose.Types.ObjectId(), approvedAt: OBSERVED_AT, approvalPublicationType: "catalog_created", approvalReceipt: receipt,
  });
  assert.equal(await validationErrors(approved), undefined);
  const badResolution = new AlbumSubmission({
    ...base, status: "approved", approvedAlbumCatalogId: new mongoose.Types.ObjectId(), approvedAt: OBSERVED_AT, approvalPublicationType: "catalog_created",
    approvalReceipt: { ...receipt, artistResolutions: [{ ...receipt.artistResolutions[0], outcome: "merged" }] },
  });
  assert.ok(await validationErrors(badResolution));

  const keyOnly = new AlbumSubmission({ ...base, creationRequestKey: crypto.randomUUID() });
  assert.ok((await validationErrors(keyOnly))?.creationRequestKey);
  assert.equal(await validationErrors(new AlbumSubmission({ ...base, ...requestKeyFields(crypto.randomUUID(), payloadDigest(base)) })), undefined);
});

test("submission updates cannot write a receipt outside approval or remove one", async () => {
  const filter = { submissionId: crypto.randomUUID() };
  await assert.rejects(
    AlbumSubmission.findOneAndUpdate(filter, { $set: { status: "rejected", approvalReceipt: { revision: 1 } } }).exec(),
    /approval receipt is written only/,
  );
  await assert.rejects(AlbumSubmission.findOneAndUpdate(filter, { $unset: { approvalReceipt: "" } }).exec(), /cannot be removed/);
});

// approveAlbumSubmission's revision guards run before any transaction, so
// they can be exercised with stubbed reads.
test("single approval refuses a stale reviewed revision and an approval made at another revision", async (t) => {
  const originals = { findOne: AlbumSubmission.findOne, catalogFindOne: AlbumCatalog.findOne, startSession: mongoose.startSession };
  t.after(() => {
    AlbumSubmission.findOne = originals.findOne;
    AlbumCatalog.findOne = originals.catalogFindOne;
    mongoose.startSession = originals.startSession;
  });
  let stored;
  const album = { _id: new mongoose.Types.ObjectId(), albumId: crypto.randomUUID(), title: "T", artistDisplayName: "A", artistCredits: [{ name: "A", role: "main" }] };
  AlbumSubmission.findOne = () => ({ exec: async () => stored });
  AlbumCatalog.findOne = () => ({ exec: async () => album });
  mongoose.startSession = async () => { throw new Error("no transaction should start"); };

  stored = { submissionId: crypto.randomUUID(), submissionType: "new_album", status: "pending", currentRevision: 3 };
  await assert.rejects(approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", expectedRevision: 2 }), code("STATE_CONFLICT"));

  stored = {
    submissionId: crypto.randomUUID(),
    submissionType: "new_album",
    status: "approved",
    currentRevision: 2,
    approvedAlbumCatalogId: album._id,
    approvalReceipt: { revision: 2, publicationType: "catalog_created", targetAlbumId: album.albumId, appliedFields: [], artistResolutions: [] },
    moderationHistory: [],
  };
  await assert.rejects(approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", expectedRevision: 1 }), code("APPROVAL_CONFLICT"));
  const retry = await approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", expectedRevision: 2 });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.album.albumId, album.albumId);

  stored = { ...stored, submissionType: "genre_suggestion", approvalReceipt: undefined, currentRevision: 4 };
  await assert.rejects(approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", expectedRevision: 3 }), code("APPROVAL_CONFLICT"));
});
