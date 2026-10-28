const AlbumCatalog = require("../../models/AlbumCatalog");
const BoardItem = require("../../models/BoardItem");
const Like = require("../../models/Like");
const Listen = require("../../models/Listen");
const Review = require("../../models/Reviews");
const TrackRanking = require("../../models/TrackRanking");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { Genre } = require("../../models/Genre");
const { toPublicGenre } = require("../../lib/genres/read");
const { isGenresEnabled } = require("./serverConfig");
const { unplayedSavedIds } = require("./boardPick");
const { persistedReviewId } = require("./reviewInteractions");

// How far back stats reach. The rolling period covers this many years up to
// today, and single calendar years are offered only when they fall inside it.
const STATS_WINDOW_YEARS = 2;
const ROLLING_PERIOD = `${STATS_WINDOW_YEARS}y`;
const TOP_LIMIT = 10;
const COMMUNITY_MIN_REVIEWS = 3;
const RATINGS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

function statsError(message) {
  return Object.assign(new Error(message), { status: 400, code: "INVALID_STATS_REQUEST" });
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// The same calendar day N years earlier; Feb 29 falls back to Mar 1.
function yearsBefore(day, years) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return isoDay(date);
}

// Periods are calendar-day ranges compared against Listen.listenedOn, which is
// already the listener's local date. "Today" is the server's UTC date.
function availablePeriods(now = new Date()) {
  const today = isoDay(now);
  const windowStart = yearsBefore(today, STATS_WINDOW_YEARS);
  const periods = [{ value: ROLLING_PERIOD, label: `Last ${STATS_WINDOW_YEARS} years`, from: windowStart, to: today, year: null }];
  for (let year = now.getUTCFullYear(); `${year}-01-01` >= windowStart; year -= 1) {
    periods.push({ value: String(year), label: String(year), from: `${year}-01-01`, to: year === now.getUTCFullYear() ? today : `${year}-12-31`, year });
  }
  return periods;
}

function parseStatsQuery(query = {}, now = new Date()) {
  const unknown = Object.keys(query || {}).filter((key) => !["period", "automatic"].includes(key));
  if (unknown.length) throw statsError(`Unsupported fields: ${unknown.join(", ")}`);
  const value = query.period === undefined ? ROLLING_PERIOD : query.period;
  const period = availablePeriods(now).find((option) => option.value === value);
  if (!period) throw statsError(`period must be ${ROLLING_PERIOD} or a calendar year within the last ${STATS_WINDOW_YEARS} years`);
  const automatic = query.automatic === undefined ? "include" : query.automatic;
  if (!["include", "exclude"].includes(automatic)) throw statsError("automatic must be include or exclude");
  return { ...period, includeAutomatic: automatic === "include" };
}

function monthKeys(from, to) {
  const keys = [];
  let [year, month] = from.slice(0, 7).split("-").map(Number);
  const last = to.slice(0, 7);
  for (let key = from.slice(0, 7); key <= last;) {
    keys.push(key);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    key = `${year}-${String(month).padStart(2, "0")}`;
  }
  return keys;
}

function listensPerMonth(dayRows, from, to) {
  const counts = new Map();
  for (const row of dayRows) counts.set(row.day.slice(0, 7), (counts.get(row.day.slice(0, 7)) || 0) + row.count);
  return monthKeys(from, to).map((month) => ({ month, count: counts.get(month) || 0 }));
}

// Monday-first listen totals by weekday, from YYYY-MM-DD calendar days.
function weekdayTotals(dayRows) {
  const totals = new Array(7).fill(0);
  for (const row of dayRows) totals[(new Date(`${row.day}T00:00:00.000Z`).getUTCDay() + 6) % 7] += row.count;
  return totals;
}

// The longest run of consecutive listening days. days must be sorted ascending.
function longestStreak(days) {
  let best = { days: 0, start: null, end: null };
  let start = null;
  let previous = null;
  for (const day of days) {
    const followsPrevious = previous && Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${previous}T00:00:00.000Z`) === 86400000;
    if (!followsPrevious) start = day;
    const length = Math.round((Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86400000) + 1;
    if (length > best.days) best = { days: length, start, end: day };
    previous = day;
  }
  return best;
}

function summarizeListening(dayRows, from, to) {
  const total = dayRows.reduce((sum, row) => sum + row.count, 0);
  const automatic = dayRows.reduce((sum, row) => sum + row.automatic, 0);
  const weekdays = weekdayTotals(dayRows);
  const busiest = Math.max(...weekdays);
  return {
    totalListens: total,
    daysListened: dayRows.length,
    manualListens: total - automatic,
    automaticListens: automatic,
    perMonth: listensPerMonth(dayRows, from, to),
    weekdays,
    busiestWeekday: busiest > 0 ? weekdays.indexOf(busiest) : null,
    longestStreak: longestStreak(dayRows.map((row) => row.day)),
  };
}

function albumSummary(album) {
  const normalized = normalizeCatalogAlbum(album);
  if (!normalized?.albumId) return null;
  const { albumId, title, artistDisplayName, releaseYear, cover } = normalized;
  return { albumId, title, artistDisplayName, releaseYear, cover };
}

function byCountThenRecent(a, b) {
  return b.listenCount - a.listenCount || String(b.lastListenedOn).localeCompare(String(a.lastListenedOn));
}

function topAlbums(albumRows) {
  return [...albumRows].sort(byCountThenRecent).slice(0, TOP_LIMIT)
    .map((row) => ({ album: albumSummary(row.album), listenCount: row.listenCount, lastListenedOn: row.lastListenedOn }))
    .filter((row) => row.album);
}

// Without catalog artist IDs, artists are grouped by display name, so a
// collaboration credited as "A & B" counts separately from A and from B.
function topArtists(albumRows) {
  const artists = new Map();
  for (const row of albumRows) {
    const name = String(row.album.artistDisplayName || "").trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const entry = artists.get(key) || { name, listenCount: 0, albumCount: 0, lastListenedOn: "" };
    entry.listenCount += row.listenCount;
    entry.albumCount += 1;
    if (row.lastListenedOn > entry.lastListenedOn) entry.lastListenedOn = row.lastListenedOn;
    artists.set(key, entry);
  }
  return [...artists.values()].sort(byCountThenRecent).slice(0, TOP_LIMIT)
    .map(({ name, listenCount, albumCount }) => ({ name, listenCount, albumCount }));
}

// Every genre on a listened album gets that album's listens, the way an
// artist does. Retired genres drop out.
async function topGenres(albumRows) {
  const counts = new Map();
  for (const row of albumRows) {
    for (const id of row.album.genres || []) {
      const key = String(id);
      const entry = counts.get(key) || { listenCount: 0, albumCount: 0, lastListenedOn: "" };
      entry.listenCount += row.listenCount;
      entry.albumCount += 1;
      if (row.lastListenedOn > entry.lastListenedOn) entry.lastListenedOn = row.lastListenedOn;
      counts.set(key, entry);
    }
  }
  if (!counts.size) return [];
  const genres = await Genre.find({ _id: { $in: [...counts.keys()] }, status: "active" }).lean();
  return genres
    .map((genre) => ({ genre: toPublicGenre(genre), ...counts.get(String(genre._id)) }))
    .sort(byCountThenRecent)
    .slice(0, TOP_LIMIT)
    .map(({ genre, listenCount, albumCount }) => ({ genre, listenCount, albumCount }));
}

function eras(albumRows, year) {
  const decades = new Map();
  let unknown = 0;
  let sameYear = 0;
  let total = 0;
  for (const row of albumRows) {
    total += row.listenCount;
    const releaseYear = Number(row.album.releaseYear);
    if (!Number.isInteger(releaseYear) || releaseYear < 1) { unknown += row.listenCount; continue; }
    const decade = Math.floor(releaseYear / 10) * 10;
    decades.set(decade, (decades.get(decade) || 0) + row.listenCount);
    if (year && releaseYear === year) sameYear += row.listenCount;
  }
  return {
    decades: [...decades].sort((a, b) => a[0] - b[0]).map(([decade, listenCount]) => ({ decade, listenCount })),
    unknownYearListens: unknown,
    // Only meaningful for a single calendar year: listens to that year's releases.
    releasedThatYearShare: year && total ? Math.round((sameYear / total) * 100) : null,
  };
}

// Counts only albums whose whole tracklist has durations, so a partial tracklist
// never understates a listen.
function listeningTime(albumRows) {
  let totalMs = 0;
  let coveredListens = 0;
  let totalListens = 0;
  for (const row of albumRows) {
    totalListens += row.listenCount;
    if (row.album.trackCount > 0 && row.album.timedTrackCount === row.album.trackCount) {
      totalMs += row.album.runtimeMs * row.listenCount;
      coveredListens += row.listenCount;
    }
  }
  return { estimatedHours: Math.round((totalMs / 3600000) * 10) / 10, coveredListens, totalListens };
}

function ratingDistribution(ratings) {
  const counts = new Map(RATINGS.map((rating) => [rating, 0]));
  for (const rating of ratings) if (counts.has(rating)) counts.set(rating, counts.get(rating) + 1);
  return RATINGS.map((rating) => ({ rating, count: counts.get(rating) }));
}

// Mean of (your rating − everyone else's average) over albums that at least
// COMMUNITY_MIN_REVIEWS other people reviewed.
function versusCommunity(pairs) {
  if (!pairs.length) return { difference: null, albumCount: 0 };
  const difference = pairs.reduce((sum, pair) => sum + (pair.rating - pair.communityAverage), 0) / pairs.length;
  return { difference: Math.round(difference * 100) / 100, albumCount: pairs.length };
}

function listenMatch(userId, period) {
  return {
    userId,
    listenedOn: { $gte: period.from, $lte: period.to },
    ...(period.includeAutomatic ? {} : { source: { $ne: "automatic" } }),
  };
}

async function listenDays(userId, period) {
  const rows = await Listen.aggregate([
    { $match: listenMatch(userId, period) },
    { $group: { _id: "$listenedOn", count: { $sum: 1 }, automatic: { $sum: { $cond: [{ $eq: ["$source", "automatic"] }, 1, 0] } } } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((row) => ({ day: row._id, count: row.count, automatic: row.automatic }));
}

// One row per listened album with only the catalog fields stats need. Runtime
// is summed in the database so tracklists never leave it.
async function listenAlbums(userId, period) {
  const rows = await Listen.aggregate([
    { $match: listenMatch(userId, period) },
    { $group: { _id: "$albumCatalogId", listenCount: { $sum: 1 }, lastListenedOn: { $max: "$listenedOn" } } },
    {
      $lookup: {
        from: AlbumCatalog.collection.name,
        localField: "_id",
        foreignField: "_id",
        pipeline: [{
          $project: {
            _id: 0, albumId: 1, title: 1, artistDisplayName: 1, releaseYear: 1, cover: 1, artistCredits: 1, genres: 1, tracks: { $literal: [] },
            trackCount: { $size: { $ifNull: ["$tracks", []] } },
            timedTrackCount: { $size: { $filter: { input: { $ifNull: ["$tracks", []] }, cond: { $gt: ["$$this.durationMs", 0] } } } },
            runtimeMs: { $sum: { $ifNull: ["$tracks.durationMs", []] } },
          },
        }],
        as: "album",
      },
    },
    // Deleted catalog albums drop out rather than producing broken links.
    { $unwind: "$album" },
  ]);
  return rows.map((row) => ({ albumCatalogId: row._id, listenCount: row.listenCount, lastListenedOn: row.lastListenedOn, album: row.album }));
}

async function reviewStats(userId, period, listenedAlbumIds) {
  const reviews = await Review.find({
    userId,
    date: { $gte: new Date(`${period.from}T00:00:00.000Z`), $lte: new Date(`${period.to}T23:59:59.999Z`) },
  }).select("reviewId albumCatalogId rating reviewText date editedAt").sort({ date: -1, _id: -1 }).lean();

  const latestByAlbum = new Map();
  for (const review of reviews) if (!latestByAlbum.has(String(review.albumCatalogId))) latestByAlbum.set(String(review.albumCatalogId), review);
  const albumIds = [...latestByAlbum.values()].map((review) => review.albumCatalogId);

  const [reviewedListened, likeRows, communityRows] = await Promise.all([
    listenedAlbumIds.length ? Review.distinct("albumCatalogId", { userId, albumCatalogId: { $in: listenedAlbumIds } }) : [],
    reviews.length ? Like.aggregate([
      { $match: { targetType: "review", reviewId: { $in: reviews.map((review) => review._id) } } },
      { $group: { _id: "$reviewId", likeCount: { $sum: 1 } } },
      { $sort: { likeCount: -1, _id: -1 } },
      { $limit: 1 },
    ]) : [],
    albumIds.length ? Review.aggregate([
      { $match: { albumCatalogId: { $in: albumIds }, userId: { $ne: userId } } },
      { $group: { _id: "$albumCatalogId", average: { $avg: "$rating" }, count: { $sum: 1 } } },
      { $match: { count: { $gte: COMMUNITY_MIN_REVIEWS } } },
    ]) : [],
  ]);

  let mostLiked = null;
  if (likeRows[0]) {
    const review = reviews.find((entry) => String(entry._id) === String(likeRows[0]._id));
    const album = review ? albumSummary(await AlbumCatalog.findById(review.albumCatalogId).lean()) : null;
    if (review && album) {
      mostLiked = { reviewId: persistedReviewId(review), rating: review.rating, reviewText: review.reviewText, date: review.date, editedAt: review.editedAt || null, likeCount: likeRows[0].likeCount, album };
    }
  }
  const community = new Map(communityRows.map((row) => [String(row._id), row.average]));
  const pairs = [...latestByAlbum].filter(([id]) => community.has(id)).map(([id, review]) => ({ rating: review.rating, communityAverage: community.get(id) }));
  const ratings = reviews.map((review) => review.rating);

  return {
    count: reviews.length,
    averageRating: ratings.length ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 100) / 100 : null,
    distribution: ratingDistribution(ratings),
    // Listened albums in the period that the user has reviewed at any time.
    reviewRate: listenedAlbumIds.length ? Math.round((reviewedListened.length / listenedAlbumIds.length) * 100) : null,
    mostLiked,
    versusCommunity: versusCommunity(pairs),
  };
}

// Current library totals; these are not limited to the period.
async function libraryStats(userId) {
  const [saved, unplayed, rankings] = await Promise.all([
    BoardItem.distinct("albumCatalogId", { userId }),
    unplayedSavedIds(userId),
    TrackRanking.countDocuments({ userId }),
  ]);
  return { savedAlbums: saved.length, unplayedSaved: unplayed.length, trackRankings: rankings };
}

async function listeningStats(userId, query, now = new Date()) {
  const period = parseStatsQuery(query, now);
  const [days, albums] = await Promise.all([listenDays(userId, period), listenAlbums(userId, period)]);
  const [reviews, library, genres] = await Promise.all([
    reviewStats(userId, period, albums.map((row) => row.albumCatalogId)),
    libraryStats(userId),
    isGenresEnabled() ? topGenres(albums) : null,
  ]);
  return {
    userId,
    period: { value: period.value, label: period.label, from: period.from, to: period.to },
    availablePeriods: availablePeriods(now).map(({ value, label }) => ({ value, label })),
    includesAutomatic: period.includeAutomatic,
    listening: { ...summarizeListening(days, period.from, period.to), distinctAlbums: albums.length },
    topAlbums: topAlbums(albums),
    topArtists: topArtists(albums),
    // Present only while genres are enabled.
    ...(genres ? { topGenres: genres } : {}),
    eras: eras(albums, period.year),
    listeningTime: listeningTime(albums),
    reviews,
    library,
  };
}

module.exports = {
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
  topAlbums,
  topArtists,
  topGenres,
  versusCommunity,
  weekdayTotals,
};
