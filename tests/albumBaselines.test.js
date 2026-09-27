const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const Models = require("../models/AlbumBaseline");
const { BaselineError, flags, validateCandidate } = require("../lib/baselines/service");
const { hashCandidateTracklist } = require("../lib/baselines/musicBrainz");

function mbid() { return crypto.randomUUID(); }
function candidate(overrides = {}) {
  const releaseMbid = mbid();
  const value = {
    releaseMbid,
    releaseGroupMbid: mbid(),
    title: "[#]",
    artistDisplayName: "이달의 소녀",
    date: "2020-02-05",
    country: "KR",
    formats: ["CD"],
    disambiguation: "",
    status: "Official",
    tracks: [
      { discNumber: 1, trackNumber: 1, title: "#", durationMs: 180000, artistDisplayName: "LOONA", releaseTrackMbid: mbid(), recordingMbid: mbid() },
      { discNumber: 1, trackNumber: 2, title: "So What", durationMs: 198000, artistDisplayName: "LOONA", releaseTrackMbid: mbid(), recordingMbid: mbid() },
    ],
    retrievedAt: new Date("2026-09-26T00:00:00.000Z"),
    sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`,
    license: "CC0",
    tracklistHash: "",
    ...overrides,
  };
  if (!overrides.tracklistHash) value.tracklistHash = hashCandidateTracklist(value);
  return value;
}

test("baseline candidate validation preserves repeated recordings at distinct positions", () => {
  const value = candidate();
  value.tracks[1].recordingMbid = value.tracks[0].recordingMbid;
  value.tracklistHash = hashCandidateTracklist(value);
  assert.equal(validateCandidate(value), value);
});

test("baseline candidate validation rejects duplicate positions and incomplete identity", () => {
  const duplicate = candidate();
  duplicate.tracks[1].trackNumber = 1;
  assert.throws(() => validateCandidate(duplicate), (error) => error instanceof BaselineError && error.code === "INCOMPLETE_TRACKLIST");
  assert.throws(() => validateCandidate(candidate({ releaseGroupMbid: "invalid" })), /MusicBrainz UUID/);
  assert.throws(() => validateCandidate(candidate({ tracks: [] })), (error) => error.code === "INCOMPLETE_TRACKLIST");
});

test("baseline persistence validates immutable provenance and local track IDs", () => {
  const document = new Models.Baseline({
    baselineId: crypto.randomUUID(), albumId: crypto.randomUUID(), version: 1, catalogRevision: 2,
    candidate: candidate(), reviewedByUserId: "moderator", reviewedAt: new Date(), reason: "Confirmed standard Korean release",
  });
  assert.equal(document.validateSync(), undefined);
  assert.match(document.candidate.tracks[0].trackId, /^[0-9a-f-]{36}$/i);
  const invalid = new Models.Baseline({ ...document.toObject(), baselineId: crypto.randomUUID(), candidate: { ...candidate(), license: "unknown" } });
  assert.ok(invalid.validateSync());
});

test("enrichment and moderation flags are independent and disabled by default", () => {
  const previous = { enrichment: process.env.TRACKLIST_ENRICHMENT_ENABLED, baseline: process.env.TRACKLIST_BASELINE_MODERATION_ENABLED, moderation: process.env.COMMUNITY_MODERATION_ENABLED };
  delete process.env.TRACKLIST_ENRICHMENT_ENABLED; delete process.env.TRACKLIST_BASELINE_MODERATION_ENABLED; delete process.env.COMMUNITY_MODERATION_ENABLED;
  assert.deepEqual(flags(), { discovery: false, moderation: false });
  process.env.TRACKLIST_ENRICHMENT_ENABLED = "true"; process.env.TRACKLIST_BASELINE_MODERATION_ENABLED = "true";
  assert.deepEqual(flags(), { discovery: true, moderation: false });
  process.env.COMMUNITY_MODERATION_ENABLED = "true";
  assert.deepEqual(flags(), { discovery: true, moderation: true });
  for (const [key, value] of Object.entries(previous)) { const env = { enrichment: "TRACKLIST_ENRICHMENT_ENABLED", baseline: "TRACKLIST_BASELINE_MODERATION_ENABLED", moderation: "COMMUNITY_MODERATION_ENABLED" }[key]; if (value === undefined) delete process.env[env]; else process.env[env] = value; }
});
