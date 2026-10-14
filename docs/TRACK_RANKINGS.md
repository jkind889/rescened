# Track rankings

Signed-in users can order the tracks on a catalog album, best first. Each user has at most one ranking per album (`TrackRanking`, unique on user and album). The ranking is addressed by the album's public `albumId` and has no public ID of its own. Error codes are listed in [the error code reference](ERROR_CODES.md#track-rankings).

## Endpoints

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `GET` | `/track-rankings/album/:albumId` | Optional | Community standings, plus the viewer's own ranking and comparison when signed in. `?scope=circle` (sign-in required) counts only the viewer and people they follow. |
| `PUT` | `/track-rankings/album/:albumId` | Required | Replaces the viewer's ranking with `{ rankedTrackIds }` and returns the standings. |
| `DELETE` | `/track-rankings/album/:albumId` | Required | Removes the viewer's ranking (succeeds when there is none) and returns the standings. |

| `GET` | `/profile/:userId/rankings` | Optional | One user's rankings, most recently changed first, each with its top three tracks. Gated like other profile reads: private profiles are owner-only. |

`PUT` accepts exactly `{ rankedTrackIds: string[] }`: 1–100 distinct `trackId` values from the album's current tracklist. A partial ranking (a top N) is allowed. IDs match case-insensitively and are stored in the catalog's spelling. An album without a tracklist returns `409 TRACKLIST_UNAVAILABLE`. Mutations share the `trackRankingMutation` limit (60 per 10 minutes per user).

## Response

```json
{
  "albumId": "…",
  "scope": "community",
  "rankingCount": 3,
  "confidence": "settled",
  "tracks": [{ "trackId": "…", "score": 0.8889, "rankedBy": 3, "averagePosition": 1.33 }],
  "viewerRanking": { "rankedTrackIds": ["…"], "unrankedTrackIds": ["…"], "updatedAt": "…" },
  "viewerComparison": {
    "rankingCount": 3,
    "confidence": "settled",
    "agreement": 40,
    "hottestTake": { "trackId": "…", "viewerPosition": 1, "communityPosition": 4, "delta": 3 },
    "tracks": [{ "trackId": "…", "viewerPosition": 1, "communityPosition": 4, "delta": 3 }]
  }
}
```

- `scope` is `community` (default) or `circle`. Any other value returns `400 INVALID_TRACK_RANKING_REQUEST`; `circle` without sign-in returns `401`.
- `confidence` is `early` below 3 distinct counted rankings and `settled` from 3 on. Clients label early standings and never call a track the favorite while early. Scores are not adjusted for sample size.

- `viewerRanking` is `null` for anonymous viewers and users without a ranking.
- `tracks` covers every track on the current tracklist, sorted by `score` (descending), then `rankedBy` (descending), then tracklist order.
- `rankedBy` and `averagePosition` count only rankings that list the track explicitly. `averagePosition` is `null` when no one did.
- `score` is `null` when the album has no rankings.
- `viewerComparison` is present only in the community scope, for a signed-in viewer whose ranking still has current tracks, and when at least one other person has ranked the album. Otherwise it is `null`. It compares the viewer's ranked tracks with standings from **everyone except the viewer**, so a ranking is never compared with itself.
  - **Small samples are withheld.** With fewer than 3 other rankings, a comparison would show one or two specific people's orderings, including people with private profiles. The response is then `{ rankingCount, confidence: "early", agreement: null, hottestTake: null, tracks: [] }`, and the client says the comparison appears once 3 others have ranked. From 3 on, `confidence` is `settled` and every field is filled.
  - Positions are competition positions (tied scores share a position: 1, 1, 3).
  - `delta` is `communityPosition − viewerPosition`, positive when the viewer places a track higher than others do. It is `null` for a track no other listener ranked explicitly, because that track's position is a tie no one chose. The client shows no arrow for it.
  - `agreement` is Spearman's rho over the viewer's ranked tracks mapped to 0–100, or `null` with fewer than three ranked tracks or no variation.
  - `hottestTake` is the track with the largest absolute non-null delta (earliest viewer position on ties), or `null` when every such delta is 0.

## Circle scope

The circle scope counts the viewer plus every followed account whose profile is not private. Following someone does not grant access to a private profile's data, and with a small circle the standings could otherwise reveal one person's ranking. This matches the network activity feed. The community scope keeps counting every ranking as an anonymous aggregate, and withholds the viewer comparison below 3 other rankers for the same reason. Community standings themselves are still shown from the first ranking, labeled early.

## Fan favorite

`GET /albums/album/:albumId/social` includes `topTrack: { trackId, title, score, rankingCount }` once community standings are `settled` and the top score is not tied, and `null` otherwise. The album page shows it as a "Fan favorite" badge in the Tracks tab and a line in the sidebar.

## Profiles and activity

`GET /profile/:userId/rankings` accepts `limit` (1–24, default 12) and `cursor`, rejecting other fields with `400 INVALID_TRACK_RANKING_REQUEST`. Entries carry an album summary, `topTracks` (up to three `{ trackId, position, title }` after reconciling with the current tracklist), `rankedCount`, `trackCount`, and `updatedAt`. Rankings with no current tracks, and rankings of deleted catalog albums, are filtered out before the page limit, so they never produce short or empty pages. Results are ordered by `updatedAt`, then album, backed by the `{ userId, updatedAt, albumCatalogId }` index. The cursor encodes the last entry's `updatedAt` and public `albumId`; it never contains a Mongo ID. A malformed cursor returns `400 INVALID_TRACK_RANKING_CURSOR`. If the cursor's album has since been deleted, paging continues by `updatedAt` alone, which can skip only another ranking saved in the same millisecond.

Profile activity and the network feed include `ranked_album` items, timed by the ranking's `updatedAt`, so re-saving a ranking moves it back to the top. The network feed skips followed private profiles as it does for reviews and listens. Items use the ID `ranking:<userId>:<albumId>`.

## Scoring

Standings use a Borda count normalized to the current tracklist of N tracks. Within one ranking, position p earns `(N − p) / (N − 1)` points, so first place earns 1 and last place earns 0. Tracks a ranking leaves out tie for the remaining positions and each receive the average of their points. Partial rankings therefore count against every omitted track: a single user who ranks only one obscure track cannot lift it above a track that most rankers placed highly. A track's `score` is its mean over all counted rankings, between 0 and 1. On a one-track album, the track scores 1.

## Tracklist changes

Rankings store catalog `trackId` values, not positions, and are never rewritten when the tracklist changes. On read, tracks no longer on the album are dropped and positions close up. Tracks the user has not ranked, including tracks added later, are returned as `unrankedTrackIds` in tracklist order. A ranking with no current tracks left is excluded from `rankingCount` and scoring until the user saves it again.

Baseline confirmation and corrections preserve existing `trackId` values. A correction that drops an entry's `trackId` (see [correction track lists](PHASE_2_SUBMISSIONS.md)) gives that track a new identity, so the old track falls out of existing rankings.

## Account deletion

The account-deletion transaction deletes the user's rankings, together with the other user-owned data listed in [the Last.fm sync guide](LASTFM_SYNC.md#account-and-privacy-contracts).
