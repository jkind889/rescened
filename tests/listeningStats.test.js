const assert = require("node:assert/strict");
const test = require("node:test");
const Listen = require("../models/Listen");
const {
  STATS_WINDOW_YEARS,
  availablePeriods,
  eras,
  listeningStats,
  listeningTime,
  listensPerMonth,
  longestStreak,
  parseStatsQuery,
  ratingDistribution,
  summarizeListening,
  topArtists,
  versusCommunity,
  weekdayTotals,
} = require("../routes/utils/listeningStats");

const NOW = new Date("2026-10-14T15:00:00.000Z");

test("periods cover a rolling window plus the calendar years inside it", () => {
  assert.equal(STATS_WINDOW_YEARS, 2);
  assert.deepEqual(availablePeriods(NOW).map(({ value, from, to }) => [value, from, to]), [
    ["2y", "2024-10-14", "2026-10-14"],
    ["2026", "2026-01-01", "2026-10-14"],
    ["2025", "2025-01-01", "2025-12-31"],
  ]);
  // On Jan 1 the window starts exactly on a year boundary, so that year is offered too.
  assert.deepEqual(availablePeriods(new Date("2027-01-01T00:00:00Z")).map((period) => period.value), ["2y", "2027", "2026", "2025"]);
  // Feb 29 has no counterpart two years earlier.
  assert.equal(availablePeriods(new Date("2028-02-29T12:00:00Z"))[0].from, "2026-03-01");
});

test("stats queries reject unknown fields, periods outside the window, and bad toggles", () => {
  assert.equal(parseStatsQuery({}, NOW).value, "2y");
  assert.equal(parseStatsQuery({}, NOW).includeAutomatic, true);
  assert.equal(parseStatsQuery({ period: "2025", automatic: "exclude" }, NOW).includeAutomatic, false);
  for (const query of [{ period: "2024" }, { period: "all" }, { period: ["2026"] }, { automatic: "no" }, { userId: "other" }]) {
    assert.throws(() => parseStatsQuery(query, NOW), (error) => error.status === 400 && error.code === "INVALID_STATS_REQUEST");
  }
});

test("listening summaries bucket months, weekdays, and the longest streak", () => {
  const days = [
    { day: "2026-01-30", count: 2, automatic: 1 },
    { day: "2026-01-31", count: 1, automatic: 0 },
    { day: "2026-02-01", count: 1, automatic: 0 },
    { day: "2026-03-10", count: 3, automatic: 3 },
  ];
  assert.deepEqual(listensPerMonth(days, "2025-12-15", "2026-03-31"), [
    { month: "2025-12", count: 0 }, { month: "2026-01", count: 3 }, { month: "2026-02", count: 1 }, { month: "2026-03", count: 3 },
  ]);
  // 2026-01-30 is a Friday, 01-31 Saturday, 02-01 Sunday, 03-10 Tuesday.
  assert.deepEqual(weekdayTotals(days), [0, 3, 0, 0, 2, 1, 1]);
  assert.deepEqual(longestStreak(days.map((row) => row.day)), { days: 3, start: "2026-01-30", end: "2026-02-01" });
  assert.deepEqual(longestStreak([]), { days: 0, start: null, end: null });

  const summary = summarizeListening(days, "2026-01-01", "2026-03-31");
  assert.equal(summary.totalListens, 7);
  assert.equal(summary.automaticListens, 4);
  assert.equal(summary.manualListens, 3);
  assert.equal(summary.busiestWeekday, 1);
  assert.equal(summarizeListening([], "2026-01-01", "2026-12-31").busiestWeekday, null);
});

test("album rows feed artists, eras, and an honest listening-time estimate", () => {
  const rows = [
    { listenCount: 3, lastListenedOn: "2026-05-01", album: { artistDisplayName: "Artist", releaseYear: 2026, trackCount: 2, timedTrackCount: 2, runtimeMs: 1800000 } },
    { listenCount: 2, lastListenedOn: "2026-06-01", album: { artistDisplayName: "artist", releaseYear: 1999, trackCount: 3, timedTrackCount: 2, runtimeMs: 900000 } },
    { listenCount: 2, lastListenedOn: "2026-07-01", album: { artistDisplayName: "Other", releaseYear: null, trackCount: 0, timedTrackCount: 0, runtimeMs: 0 } },
  ];
  assert.deepEqual(topArtists(rows), [{ name: "Artist", listenCount: 5, albumCount: 2 }, { name: "Other", listenCount: 2, albumCount: 1 }]);
  assert.deepEqual(eras(rows, 2026), {
    decades: [{ decade: 1990, listenCount: 2 }, { decade: 2020, listenCount: 3 }],
    unknownYearListens: 2,
    releasedThatYearShare: 43,
  });
  assert.equal(eras(rows, null).releasedThatYearShare, null);
  // Only the fully timed album counts: 3 listens × 30 minutes.
  assert.deepEqual(listeningTime(rows), { estimatedHours: 1.5, coveredListens: 3, totalListens: 7 });
});

test("review helpers bucket half stars and compare against the community", () => {
  assert.deepEqual(ratingDistribution([5, 4.5, 5, 1]).filter((bucket) => bucket.count), [
    { rating: 1, count: 1 }, { rating: 4.5, count: 1 }, { rating: 5, count: 2 },
  ]);
  assert.deepEqual(versusCommunity([{ rating: 5, communityAverage: 4 }, { rating: 3, communityAverage: 3.5 }]), { difference: 0.25, albumCount: 2 });
  assert.deepEqual(versusCommunity([]), { difference: null, albumCount: 0 });
});

test("stats validate the query before touching the database", async (t) => {
  const aggregate = t.mock.method(Listen, "aggregate", () => assert.fail("must validate first"));
  await assert.rejects(listeningStats("owner", { period: "1999" }, NOW), (error) => error.code === "INVALID_STATS_REQUEST");
  assert.equal(aggregate.mock.callCount(), 0);
});
