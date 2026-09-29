const assert = require("node:assert/strict");
const test = require("node:test");
const { mappingKey } = require("../lib/listening/common");
const { countablePositions, mappingIndex, matchEvent, requiredPositions } = require("../lib/listening/trackMatching");
const { detectSessions } = require("../lib/listening/detection");

const ALBUM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T0 = Date.parse("2026-09-25T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const recording = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const releaseTrack = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function baseline(specs, extra = {}) {
  return {
    albumId: ALBUM, baselineId: uuid(800), version: 1, tracklistHash: "a".repeat(64),
    tracks: specs.map((spec, index) => {
      const value = typeof spec === "string" ? { title: spec } : spec;
      return {
        trackId: uuid(index + 1), discNumber: value.disc || 1, trackNumber: value.number || index + 1, title: value.title,
        durationMs: value.durationMs === undefined ? 200_000 : value.durationMs, artistDisplayName: value.artist || "Artist",
        recordingMbid: value.recordingMbid || recording(index + 1), releaseTrackMbid: releaseTrack(index + 1),
      };
    }),
    ...extra,
  };
}
const numbered = (count) => baseline(Array.from({ length: count }, (_, index) => `Track ${index + 1}`));
const mapping = (album = "Album", albumId = ALBUM, artist = "Artist", n = 900) => ({ key: mappingKey(artist, album), mappingId: uuid(n), revision: 1, albumId, status: "active" });

let sequence = 0;
function event(track, minute, extra = {}) {
  sequence += 1;
  return {
    eventId: uuid(10_000 + sequence), identityKey: `key-${sequence}`, artist: "Artist", album: "Album", track,
    playedAt: new Date(T0 + minute * MINUTE), expiresAt: new Date(T0 + 30 * 24 * HOUR), ...extra,
  };
}
// Plays the given track numbers four minutes apart, starting at `start` minutes.
const play = (numbers, start = 0, extra = {}) => numbers.map((number, index) => event(`Track ${number}`, start + index * 4, extra));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

function detect(events, { album = numbered(10), mappings = [mapping()], windows = [{ start: new Date(T0 - HOUR), end: null }], evaluatedAt = T0 + 3 * 24 * HOUR, ...rest } = {}) {
  return detectSessions({ events, windows, mappings, baselines: [album], evaluatedAt: new Date(evaluatedAt), ...rest });
}
function matchOne(track, album, extra = {}, mappings = [mapping()]) {
  return matchEvent({ artist: "Artist", album: "Album", track, ...extra }, { mappings: mappingIndex(mappings), baselines: new Map([[ALBUM, album]]) });
}

test("matching folds typography but keeps other punctuation significant", () => {
  const album = baseline(["Don’t Stop", "“Quoted” Song", "Rock–Roll"]);
  assert.equal(matchOne("Don't Stop", album).trackId, uuid(1));
  assert.deepEqual(matchOne("Don't Stop", album).rules, []);
  assert.equal(matchOne("\"Quoted\" Song", album).trackId, uuid(2));
  assert.equal(matchOne("Rock-Roll", album).trackId, uuid(3));
  assert.equal(matchOne("Dont Stop", album).status, "unmatched_track");
});

test("featured-artist rule needs the primary credit and every named guest", () => {
  const album = baseline([{ title: "Song", artist: "Artist feat. Guest & Other" }, { title: "Solo", artist: "Artist" }]);
  const stripped = matchOne("Song (feat. Guest & Other)", album);
  assert.equal(stripped.trackId, uuid(1));
  assert.deepEqual(stripped.rules, ["featured_artist"]);
  assert.equal(matchOne("Song", album).trackId, uuid(1));
  assert.equal(matchOne("Song [ft. Guest]", album).trackId, uuid(1));
  assert.equal(matchOne("Song (feat. Stranger)", album).status, "unmatched_track");
  // A featured-artist scrobble is a separate mapping key and needs its own approved mapping.
  const credited = { artist: "Artist feat. Guest & Other" };
  assert.equal(matchOne("Song", album, credited).status, "mapping_unavailable");
  assert.deepEqual(matchOne("Song", album, credited, [mapping("Album", ALBUM, credited.artist)]).rules, []);
  assert.equal(matchOne("Solo (feat. Guest)", album).status, "unmatched_track");
  // A primary-credit prefix must end at a join phrase, not mid-name.
  assert.equal(matchOne("Song", album, { artist: "Artis" }, [mapping("Album", ALBUM, "Artis")]).status, "unmatched_track");
});

test("only allowlisted remaster suffixes are stripped", () => {
  const album = baseline(["Come Together", "Something"]);
  for (const title of ["Come Together - Remastered 2009", "Come Together - 2009 Remaster", "Come Together (2011 Remaster)", "Come Together [Remastered]", "Come Together - Remastered Version"]) {
    const match = matchOne(title, album);
    assert.equal(match.trackId, uuid(1), title);
    assert.deepEqual(match.rules, ["remaster_suffix"], title);
  }
  for (const title of ["Come Together - Live", "Come Together - Demo", "Come Together (Remix)", "Come Together - Mono Remaster"]) {
    assert.equal(matchOne(title, album).status, "unmatched_track", title);
  }
});

test("a key that fits more than one position is ambiguous, never a best guess", () => {
  const album = baseline(["Intro", "Song", "Intro", { title: "Song", artist: "Artist feat. Guest" }]);
  assert.equal(matchOne("Intro", album).status, "ambiguous_track");
  // A bare title could be the solo or the featured position.
  assert.equal(matchOne("Song", album).status, "ambiguous_track");
});

test("unresolved context returns a concrete reason", () => {
  const album = numbered(3);
  const context = { mappings: mappingIndex([mapping(), mapping("Revoked", ALBUM, "Artist", 901)].map((value, index) => index ? { ...value, status: "revoked" } : value)), baselines: new Map() };
  assert.equal(matchEvent({ artist: "Artist", album: "Unknown", track: "Track 1" }, context).status, "mapping_unavailable");
  assert.equal(matchEvent({ artist: "Artist", album: "Revoked", track: "Track 1" }, context).status, "mapping_unavailable");
  assert.equal(matchEvent({ artist: "Artist", album: "Album", track: "Track 1" }, context).status, "baseline_unavailable");
  assert.equal(matchOne("Track 1", album, { identityConflict: true }).status, "identity_conflict");
});

test("a track ID is used only once it is established on the reviewed baseline", () => {
  const album = baseline(["One", "Two", "Three"]);
  const byRecording = matchOne("One", album, { trackMbid: recording(1).toUpperCase() });
  assert.equal(byRecording.trackId, uuid(1));
  assert.deepEqual(byRecording.rules, ["recording_id"]);
  assert.deepEqual(matchOne("Two", album, { trackMbid: releaseTrack(2) }).rules, ["release_track_id"]);
  // Unknown or malformed IDs leave the event unresolved instead of falling back to text.
  assert.equal(matchOne("One", album, { trackMbid: uuid(999) }).status, "unverified_track_id");
  assert.equal(matchOne("One", album, { trackMbid: "not-an-id" }).status, "unverified_track_id");
  // Text that points only at another position contradicts an established ID.
  assert.equal(matchOne("Two", album, { trackMbid: recording(1) }).status, "identity_conflict");
  // An established unique ID identifies the position even when the text rules do not.
  assert.deepEqual(matchOne("One (2011 Stereo Mix)", album, { trackMbid: recording(1) }).rules, ["recording_id"]);
});

test("a recording shared by several positions is resolved only by text", () => {
  const album = baseline([{ title: "Theme", recordingMbid: recording(50) }, { title: "Theme (Reprise)", recordingMbid: recording(50) }, { title: "Theme", recordingMbid: recording(50), artist: "Artist feat. Guest" }]);
  assert.equal(matchOne("Theme (Reprise)", album, { trackMbid: recording(50) }).trackId, uuid(2));
  assert.equal(matchOne("Theme", album, { trackMbid: recording(50) }).status, "ambiguous_track");
  assert.equal(matchOne("Unrelated", album, { trackMbid: recording(50) }).status, "identity_conflict");
  // A release-track ID still separates positions that share a recording.
  assert.equal(matchOne("Theme", album, { trackMbid: releaseTrack(3) }).trackId, uuid(3));
});

test("duplicate groups contain only positions a text scrobble cannot tell apart", () => {
  const album = baseline([
    { title: "Song", artist: "Singer" }, { title: "Song", artist: "Other Band" },
    { title: "Intro" }, { title: "Intro (Remastered)" },
    { title: "Duet", artist: "Artist" }, { title: "Duet", artist: "Artist feat. Guest" },
    { title: "Anthem", artist: "Florence and the Machine" }, { title: "Anthem", artist: "Florence" },
    "Solo",
  ]);
  const result = countablePositions(album);
  assert.deepEqual(result.excluded.map((item) => item.trackId), [uuid(3), uuid(4), uuid(5), uuid(6), uuid(7), uuid(8)]);
  assert.ok(result.excluded.every((item) => item.reason === "duplicate_position"));
  assert.deepEqual(result.countable, [uuid(1), uuid(2), uuid(9)]);
  // Same title by different artists stays countable and matchable by text.
  const mappings = [mapping("Album", ALBUM, "Singer"), mapping("Album", ALBUM, "Other Band", 904)];
  assert.equal(matchOne("Song", album, { artist: "Singer" }, mappings).trackId, uuid(1));
  assert.equal(matchOne("Song", album, { artist: "Other Band" }, mappings).trackId, uuid(2));
});

test("an established ID identifies a duplicate position without making it countable", () => {
  const album = baseline(["Intro", "Track 2", "Track 3", "Track 4", "Intro", "Track 6"]);
  assert.equal(matchOne("Intro", album).status, "ambiguous_track");
  assert.equal(matchOne("Intro", album, { trackMbid: recording(5) }).trackId, uuid(5));
  const result = detect([event("Intro", 0, { trackMbid: recording(1) }), ...play([2, 3, 4], 4), event("Intro", 16)], { album });
  assert.equal(result.sessions[0].countable.required, 4);
  assert.equal(result.sessions[0].evidence[0].credit, "excluded_position");
  assert.equal(result.sessions[0].plays[0].distinct, 3);
  assert.equal(result.diagnostics.ambiguous_track, 1);
});

test("required positions are ceil(80%) of countable positions", () => {
  assert.deepEqual([1, 3, 4, 5, 10, 12, 15].map(requiredPositions), [1, 3, 4, 4, 8, 10, 12]);
  assert.equal(requiredPositions(0), 0);
});

test("countable positions exclude short, placeholder, non-audio, and duplicate tracks", () => {
  const album = baseline([
    "One", { title: "Skit", durationMs: 12_000 }, { title: "Unknown Length", durationMs: null }, "[silence]",
    "Interlude", "Interlude", "Two", { title: "Video", disc: 2, number: 1 },
  ], { media: [{ discNumber: 1, format: "CD" }, { discNumber: 2, format: "DVD-Video" }] });
  const result = countablePositions(album);
  assert.deepEqual(result.excluded.map((item) => item.reason), ["short_track", "placeholder_title", "duplicate_position", "duplicate_position", "non_audio_medium"]);
  assert.deepEqual(result.countable, [uuid(1), uuid(3), uuid(7)]);
  assert.equal(result.required, 3);
  assert.equal(result.unknownDurations, 1);
  assert.equal(result.diagnostic, "baseline_countability");
  assert.equal(countablePositions(numbered(10)).diagnostic, null);
  assert.equal(countablePositions(baseline([{ title: "Short", durationMs: 5_000 }])).eligible, false);
});

test("short interludes no longer make an album impossible to qualify", () => {
  const album = baseline(range(1, 10).map((number) => ({ title: `Track ${number}`, durationMs: [3, 6, 9].includes(number) ? 20_000 : 200_000 })));
  const result = detect(play([1, 2, 4, 5, 7, 8]), { album });
  assert.equal(result.sessions[0].countable.required, 6);
  assert.equal(result.sessions[0].coverage, "qualified");
  const withInterlude = detect(play([1, 2, 3, 4, 5]), { album });
  assert.equal(withInterlude.sessions[0].plays[0].distinct, 4);
  assert.equal(withInterlude.sessions[0].evidence.find((item) => item.trackId === uuid(3)).credit, "excluded_position");
});

test("threshold boundaries use distinct standard positions, not bonus tracks or totals", () => {
  const seven = detect([...play(range(1, 7)), event("Bonus Track", 40)]);
  assert.equal(seven.sessions[0].coverage, "below_threshold");
  assert.equal(seven.diagnostics.unmatched_track, 1);
  const eight = detect(play(range(1, 8)));
  assert.equal(eight.sessions[0].coverage, "qualified");
  assert.equal(eight.sessions[0].plays[0].qualifyingEventId, eight.sessions[0].evidence[7].eventId);
  assert.equal(detect(play([1, 2, 3]), { album: numbered(4) }).sessions[0].coverage, "below_threshold");
  assert.equal(detect(play([1, 2, 3, 4]), { album: numbered(5) }).sessions[0].coverage, "qualified");
});

test("shuffle is allowed and repeats before qualification add no coverage", () => {
  const shuffled = detect(play([7, 2, 12, 9, 1, 15, 4, 11, 3, 14, 5, 8]), { album: numbered(15) });
  assert.equal(shuffled.sessions[0].coverage, "qualified");
  const repeated = detect(play([1, 2, 3, 4, 5, 1, 2, 3, 4, 5]));
  assert.equal(repeated.sessions.length, 1);
  assert.equal(repeated.sessions[0].plays.length, 1);
  assert.equal(repeated.sessions[0].plays[0].distinct, 5);
  assert.equal(repeated.sessions[0].evidence.filter((item) => item.credit === "repeat").length, 5);
});

test("back-to-back replays qualify as separate plays in one session", () => {
  const result = detect(play([...range(1, 10), ...range(1, 10)]));
  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.sessions[0].plays.map((item) => [item.ordinal, item.distinct, item.coverage]), [[1, 10, "qualified"], [2, 10, "qualified"]]);
  assert.equal(result.sessions[0].plays[1].firstEventAt.getTime(), T0 + 40 * MINUTE);
});

test("finishing an album or repeating a favorite does not create a second play", () => {
  const finished = detect(play(range(1, 10)));
  assert.equal(finished.sessions[0].plays.length, 1);
  // Qualify at track 8, repeat it, finish 9-10, then replay only half the album.
  const favorite = detect(play([...range(1, 8), 8, 9, 10, ...range(1, 5)]));
  const [first, second] = favorite.sessions[0].plays;
  assert.equal(first.distinct, 10);
  assert.equal(second.distinct, 6);
  assert.equal(second.coverage, "below_threshold");
});

test("sessions split after a gap over two hours or at the 24-hour cap", () => {
  const exactGap = detect([...play(range(1, 4)), ...play(range(5, 8), 12 + 120)]);
  assert.equal(exactGap.sessions.length, 1);
  assert.equal(exactGap.sessions[0].coverage, "qualified");
  const overGap = detect([...play(range(1, 4)), ...play(range(5, 8), 12 + 121)]);
  assert.equal(overGap.sessions.length, 2);
  assert.ok(overGap.sessions.every((session) => session.coverage === "below_threshold"));
  // One track every 90 minutes never exceeds the gap, so only the cap splits it.
  const slow = detect(Array.from({ length: 20 }, (_, index) => event(`Track ${(index % 10) + 1}`, index * 90)));
  assert.equal(slow.sessions.length, 2);
  assert.equal(slow.sessions[1].startedAt.getTime() - slow.sessions[0].startedAt.getTime(), 24 * HOUR);
});

test("other albums neither close nor extend a session", () => {
  const other = { ...numbered(10), albumId: OTHER, baselineId: uuid(801) };
  const events = [...play(range(1, 5)), ...play(range(1, 10), 30, { album: "Other" }), ...play(range(1, 10), 180, { album: "Other" }), ...play(range(6, 10), 200)];
  const result = detectSessions({
    events, windows: [{ start: new Date(T0 - HOUR), end: null }], mappings: [mapping(), mapping("Other", OTHER, "Artist", 902)],
    baselines: [numbered(10), other], evaluatedAt: new Date(T0 + 3 * 24 * HOUR),
  });
  const albumSessions = result.sessions.filter((session) => session.albumId === ALBUM);
  assert.equal(albumSessions.length, 2);
  assert.ok(albumSessions.every((session) => session.coverage === "below_threshold"));
  assert.equal(result.sessions.filter((session) => session.albumId === OTHER).length, 1);
});

test("approved aliases for the same album share one session", () => {
  const events = [...play(range(1, 4)), ...play(range(5, 8), 20, { album: "Album (Deluxe)" })];
  const result = detect(events, { mappings: [mapping(), mapping("Album (Deluxe)", ALBUM, "Artist", 903)] });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].coverage, "qualified");
  assert.equal(result.sessions[0].mappings.length, 2);
});

test("pause is a hard boundary and paused events are excluded", () => {
  const windows = [{ windowId: "w1", start: new Date(T0 - HOUR), end: new Date(T0 + 30 * MINUTE) }, { windowId: "w2", start: new Date(T0 + 40 * MINUTE), end: null }];
  const result = detect([...play(range(1, 5)), event("Track 6", 32), ...play(range(6, 10), 45)], { windows });
  assert.deepEqual(result.sessions.map((session) => [session.windowKey, session.plays[0].distinct, session.lifecycle]), [["w1", 5, "closed"], ["w2", 5, "closed"]]);
  assert.equal(result.diagnostics.outside_activation_window, 1);
});

test("unusable evidence is excluded and conflicting duplicate deliveries are held", () => {
  const events = [
    event("Track 1", 0, { nowPlaying: true }),
    event("Track 2", 4, { expiresAt: new Date(T0 + HOUR) }),
    event("Track 3", 8, { identityKey: "same", trackMbid: "11111111-1111-4111-8111-111111111111" }),
    event("Track 3", 8, { identityKey: "same", trackMbid: "22222222-2222-4222-8222-222222222222" }),
    event("Track 4", 12, { identityKey: "dup" }),
    event("Track 4", 12, { identityKey: "dup" }),
  ];
  const result = detect(events, { evaluatedAt: T0 + 2 * HOUR });
  assert.equal(result.diagnostics.now_playing, 1);
  assert.equal(result.diagnostics.evidence_expired, 1);
  assert.equal(result.diagnostics.duplicate_delivery, 2);
  assert.equal(result.diagnostics.identity_conflict, 1);
  assert.equal(result.sessions[0].evidence.length, 1);
});

test("multi-disc positions stay distinct", () => {
  const album = baseline([...range(1, 5).map((n) => ({ title: `Disc One ${n}`, disc: 1, number: n })), ...range(1, 5).map((n) => ({ title: `Disc Two ${n}`, disc: 2, number: n }))]);
  const events = [...range(1, 4).map((n, index) => event(`Disc One ${n}`, index * 4)), ...range(1, 4).map((n, index) => event(`Disc Two ${n}`, 20 + index * 4))];
  const result = detect(events, { album });
  assert.equal(result.sessions[0].plays[0].distinct, 8);
  assert.equal(result.sessions[0].coverage, "qualified");
});

test("proposed dates use each play's first event in the saved time zone", () => {
  // 23:30 in New York on September 24, crossing midnight during the play.
  const start = (Date.parse("2026-09-25T03:30:00Z") - T0) / MINUTE;
  const result = detect(play([...range(1, 10), ...range(1, 10)], start), { timeZone: "America/New_York", windows: [{ start: new Date(T0 - 24 * HOUR), end: null }] });
  assert.deepEqual(result.sessions[0].plays.map((item) => item.proposedDate), ["2026-09-24", "2026-09-25"]);
  assert.throws(() => detect([], { timeZone: "Not/AZone" }), { code: "INVALID_TIME_ZONE" });
});

test("lifecycle stays open until the gap or cap can no longer be extended", () => {
  const events = play(range(1, 8));
  assert.equal(detect(events, { evaluatedAt: T0 + HOUR }).sessions[0].lifecycle, "open");
  assert.equal(detect(events, { evaluatedAt: T0 + 28 * MINUTE + 2 * HOUR + 1 }).sessions[0].lifecycle, "closed");
});
