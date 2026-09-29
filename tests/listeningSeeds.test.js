const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBindings, prepareSeedPlan, verifySeedPlan, digest } = require("../lib/listening/seeds");
const { normalize, mappingKey, flags, pilotAllowed, baselineAvailable } = require("../lib/listening/common");
const albumId = "643ae86a-dfaa-44a2-8bab-ea8f887bacbf";
const entry = { artist: "Artist", album: "Album (Deluxe)", albumId, reason: "Reviewed the release relationship", sources: ["https://musicbrainz.org/release/example"] };
const query = (value) => ({ lean: async () => value });

test("production normalization preserves edition and performance distinctions", () => {
  assert.equal(normalize("  ＡLBUM  Deluxe "), "album deluxe");
  assert.notEqual(mappingKey("Artist", "Album"), mappingKey("Artist", "Album (Deluxe)"));
  for (const qualifier of ["Live", "Remix", "Acoustic", "Instrumental", "Re-recorded"]) assert.notEqual(mappingKey("Artist", `Album (${qualifier})`), mappingKey("Artist", "Album"));
  assert.notEqual(mappingKey("Other artist", "Album"), mappingKey("Artist", "Album"));
  assert.equal(baselineAvailable({ tracks: [{ title: "Song" }] }), false);
});

test("rollout flags default closed and pilot allowlist is explicit", () => {
  assert.deepEqual(flags({}), { connection: false, sync: false, discovery: false, moderation: false, detection: false, deepSweep: false });
  assert.equal(pilotAllowed("user", {}), false);
  assert.equal(pilotAllowed("user", { LASTFM_PILOT_USER_IDS: "another,user" }), true);
});

test("seed input requires explicit public catalog binding and reusable sources", () => {
  assert.equal(validateBindings([entry])[0].albumId, albumId);
  assert.throws(() => validateBindings([{ ...entry, albumId: "born-to-die:standard" }]), /INVALID_ALBUM_ID/);
  assert.throws(() => validateBindings([{ ...entry, username: "private" }]), /INVALID_SEED_BINDING/);
  assert.throws(() => validateBindings([{ ...entry, sources: ["https://example.org/?token=private"] }]), /INVALID_SEED_SOURCE/);
  assert.throws(() => validateBindings([entry, { ...entry, artist: "ARTIST" }]), /DUPLICATE_SEED_KEY/);
});

test("dry-run binds revision and exact target; checksum prevents edits", async () => {
  const plan = await prepareSeedPlan({ bindings: [entry], environment: "pilot", fingerprint: "target", AlbumCatalog: { findOne: () => query({ catalogRevision: 2, title: "Album", artistDisplayName: "Artist" }) }, AlbumMapping: { findOne: () => query(null) }, MappingCase: { findOne: () => query(null) } });
  assert.equal(plan.entries[0].catalogRevision, 2);
  const bytes = JSON.stringify(plan);
  assert.equal(verifySeedPlan(bytes, digest(bytes), "pilot", "target").entries.length, 1);
  assert.throws(() => verifySeedPlan(bytes + " ", digest(bytes), "pilot", "target"), /CHECKSUM/);
  assert.throws(() => verifySeedPlan(bytes, digest(bytes), "production", "target"), /TARGET/);
  assert.throws(() => verifySeedPlan(bytes, digest(bytes), "pilot", "other"), /TARGET/);
});
