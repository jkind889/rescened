const assert = require("node:assert/strict");
const test = require("node:test");

const listenBrainzResponse = require("./fixtures/catalogImport/listenbrainz-ok-computer-all-time.json");
const musicBrainzReleaseGroup = require("./fixtures/catalogImport/musicbrainz-ok-computer-release-group.json");
const { validateAlbumRow } = require("../lib/catalogImport/dataset");
const {
  collectCandidates,
  mapMusicBrainzReleaseGroup,
} = require("../lib/catalogImport/listenBrainz");

const RELEASE_GROUP_MBID = "b1392450-e666-3926-a536-22c65f834433";
const RELEASE_MBID = "30702389-5c67-4438-9ea0-2351c8de0f1d";
const ARTIST_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const LISTENBRAINZ_FETCHED_AT = "2026-08-15T03:49:31.306Z";
const MUSICBRAINZ_FETCHED_AT = "2026-08-15T03:49:32.222Z";

test("captured official provider responses map through the strict catalog row path", () => {
  assert.equal(Object.hasOwn(musicBrainzReleaseGroup, "data"), false);
  assert.equal(Object.hasOwn(musicBrainzReleaseGroup, "fetchedAt"), false);

  const collected = collectCandidates([{
    config: { range: "all_time", quota: 1, candidateLimit: 1000 },
    payload: listenBrainzResponse.payload,
    fetchedAt: LISTENBRAINZ_FETCHED_AT,
  }]);

  assert.equal(collected.stats.rowsFetched, 1);
  assert.equal(collected.stats.validRows, 1);
  assert.equal(collected.stats.uniqueCandidates, 1);
  assert.equal(collected.invalidRows.length, 0);

  const candidate = collected.candidates.get(RELEASE_GROUP_MBID);
  assert.ok(candidate);
  assert.deepEqual(candidate.selectionSignals, [{
    range: "all_time",
    rank: 1,
    listenCount: 1254408,
  }]);

  const row = mapMusicBrainzReleaseGroup(
    musicBrainzReleaseGroup,
    candidate,
    "all_time",
    MUSICBRAINZ_FETCHED_AT,
  );
  const validation = validateAlbumRow(row, 0);

  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(row.releaseGroupMbid, RELEASE_GROUP_MBID);
  assert.equal(row.title, "OK Computer");
  assert.equal(row.artistDisplayName, "Radiohead");
  assert.deepEqual(row.artistCredits, [{
    artistMbid: ARTIST_MBID,
    name: "Radiohead",
    artistName: "Radiohead",
    joinPhrase: "",
  }]);
  assert.equal(row.releaseType, "album");
  assert.equal(row.releaseDate, "1997-05-21");
  assert.equal(row.releaseDatePrecision, "day");
  assert.equal(row.releaseYear, 1997);
  assert.equal(row.representativeReleaseMbid, RELEASE_MBID);
  assert.deepEqual(row.cover, {
    releaseMbid: RELEASE_MBID,
    imageId: 43287476628,
    url500: `https://coverartarchive.org/release/${RELEASE_MBID}/front-500`,
  });
  assert.deepEqual(row.sourceFetchedAt, {
    listenbrainz: LISTENBRAINZ_FETCHED_AT,
    musicbrainz: MUSICBRAINZ_FETCHED_AT,
  });
});
