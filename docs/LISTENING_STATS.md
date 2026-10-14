# Listening stats

Profiles have a Stats tab that summarizes one user's listening, reviewing, and library. Everything is computed on request from local data (`Listen`, `Review`, `Like`, `BoardItem`, `TrackRanking`, and `AlbumCatalog`). No snapshots are stored and no external service is called. The computation lives in `routes/utils/listeningStats.js`.

## Endpoints

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `GET` | `/profile/me/stats` | Required | The signed-in user's stats. |
| `GET` | `/profile/:userId/stats` | Optional | Another user's stats. Gated like other profile reads: a private profile returns `403` with `isPrivate: true` to everyone but its owner. |

Query fields (anything else returns `400 INVALID_STATS_REQUEST`):

| Field | Values | Default |
| --- | --- | --- |
| `period` | `2y` (rolling: the same calendar day two years ago through today), or a calendar year that falls entirely inside that window. | `2y` |
| `automatic` | `include` or `exclude` Last.fm-detected listens. | `include` |

The history window is `STATS_WINDOW_YEARS` (2). Changing that constant moves the rolling period and the years offered. Years outside the window are rejected rather than clipped.

### Day boundaries

Listens and reviews use different clocks, so their period edges do not line up exactly:

- **"Today" is the server's UTC date.** A listener ahead of UTC (for example, in Asia or Australia) who logs a listen dated their local today will not see it in the current period until UTC reaches that date, at most about 14 hours later.
- **Listens** match on `listenedOn`, the listener's own calendar date.
- **Reviews** match on their UTC timestamp (see [Reviews](#how-each-figure-is-computed) below). A review written late on Dec 31 in a timezone behind UTC counts toward the next year.

Fixing either would need a stored timezone for every user; today only Last.fm connections have one.

### Rate limit

Both endpoints share the `profileStats` bucket: 60 requests per 10 minutes, keyed by signed-in user or by IP for anonymous viewers. `/profile/me/stats` authenticates first, so an anonymous `401` does not consume a bucket. An exhausted bucket returns `429 RATE_LIMITED` with `Retry-After`.

## Response

```json
{
  "userId": "…",
  "period": { "value": "2y", "label": "Last 2 years", "from": "2024-10-14", "to": "2026-10-14" },
  "availablePeriods": [{ "value": "2y", "label": "Last 2 years" }, { "value": "2026", "label": "2026" }, { "value": "2025", "label": "2025" }],
  "includesAutomatic": true,
  "listening": {
    "totalListens": 11, "distinctAlbums": 9, "daysListened": 3, "manualListens": 6, "automaticListens": 5,
    "perMonth": [{ "month": "2026-09", "count": 11 }],
    "weekdays": [4, 7, 0, 0, 0, 0, 0],
    "busiestWeekday": 1,
    "longestStreak": { "days": 2, "start": "2026-09-21", "end": "2026-09-22" }
  },
  "topAlbums": [{ "album": { "albumId": "…", "title": "…", "artistDisplayName": "…", "releaseYear": 2024, "cover": "…" }, "listenCount": 2, "lastListenedOn": "2026-09-29" }],
  "topArtists": [{ "name": "…", "listenCount": 2, "albumCount": 1 }],
  "eras": { "decades": [{ "decade": 2020, "listenCount": 9 }], "unknownYearListens": 0, "releasedThatYearShare": null },
  "listeningTime": { "estimatedHours": 2.7, "coveredListens": 10, "totalListens": 11 },
  "reviews": {
    "count": 22, "averageRating": 4.25,
    "distribution": [{ "rating": 1, "count": 0 }],
    "reviewRate": 67,
    "mostLiked": { "reviewId": "…", "rating": 5, "reviewText": "…", "date": "…", "likeCount": 1, "album": { "albumId": "…" } },
    "versusCommunity": { "difference": 0.4, "albumCount": 12 }
  },
  "library": { "savedAlbums": 1, "unplayedSaved": 0, "trackRankings": 1 }
}
```

## How each figure is computed

- **Listening.** Listens are matched on `listenedOn`, which is already the listener's local calendar date, so no timezone conversion happens. `perMonth` has one entry per month in the period, including empty months. `weekdays` is Monday-first, and `busiestWeekday` indexes into it (`null` with no listens). `longestStreak` is the longest run of consecutive days with at least one listen.
- **Top albums and artists.** Each has a top 10, ordered by listen count, then most recent listen. Artists are grouped by `artistDisplayName`, compared case-insensitively. Until the catalog has artist IDs, a collaboration credited as "A & B" counts as its own artist, and two artists who share a name are merged.
- **Eras.** Listens are grouped by release decade, and listens to albums without a release year are counted in `unknownYearListens`. `releasedThatYearShare` is the share of listens to albums released in the selected calendar year, and is `null` for the rolling period.
- **Listening time.** This is an estimate. It counts an album's runtime per listen only when every track on its tracklist has a duration, so a partial tracklist never understates time. `coveredListens` says how many listens the estimate includes.
- **Reviews.**
  - Reviews are matched on their `date` timestamp in UTC (00:00 on `from` through 23:59:59.999 on `to`). This differs from listens: a review written late on Dec 31 in a timezone behind UTC can count toward the next year.
  - `reviewRate` is the share of albums listened to in the period that the user has reviewed at any time.
  - `mostLiked` is the period's review with the most likes; it is `null` if none has a like.
  - `versusCommunity.difference` is the mean of (the user's latest rating − everyone else's average). It uses only albums that at least 3 other people reviewed, and is `null` when there are none.
- **Library.** These are current totals and are not limited to the period:
  - explicitly saved albums
  - saved albums never logged or reviewed (the same rule as `GET /boards/pick`)
  - track rankings

Responses carry only public `albumId` and `reviewId` values. Album display fields are read from `AlbumCatalog` at request time, and listens of deleted catalog albums drop out.

## Performance

Four listen and review aggregations run per request. They use the `Listen { userId, listenedOn }` and `Review { userId, date }` indexes. Per-album rows are bounded by the albums a user listened to in two years, and runtimes are summed inside MongoDB so tracklists never leave the database. There is no cache yet. Add a heavy-user case to `benchmarks/` before adding one.

## Tests

`tests/listeningStats.test.js` covers the period rules and the arithmetic. `tests/listeningStats.integration.test.js` (part of `npm run test:integration`) seeds listens and reviews across years against MongoDB and checks period isolation, the automatic toggle, community comparison, and private-profile denial.
