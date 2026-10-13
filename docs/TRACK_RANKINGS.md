# Track rankings

Signed-in users can order the tracks on a catalog album, best first. Each user has at most one ranking per album (`TrackRanking`, unique on user and album). The ranking is addressed by the album's public `albumId` and has no public ID of its own. Error codes are listed in [the error code reference](ERROR_CODES.md#track-rankings).

## Endpoints

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `GET` | `/track-rankings/album/:albumId` | Optional | Community standings, plus the viewer's own ranking when signed in. |
| `PUT` | `/track-rankings/album/:albumId` | Required | Replaces the viewer's ranking with `{ rankedTrackIds }` and returns the standings. |
| `DELETE` | `/track-rankings/album/:albumId` | Required | Removes the viewer's ranking (succeeds when there is none) and returns the standings. |

`PUT` accepts exactly `{ rankedTrackIds: string[] }`: 1–100 distinct `trackId` values from the album's current tracklist. A partial ranking (a top N) is allowed. IDs match case-insensitively and are stored in the catalog's spelling. An album without a tracklist returns `409 TRACKLIST_UNAVAILABLE`. Mutations share the `trackRankingMutation` limit (60 per 10 minutes per user).

## Response

```json
{
  "albumId": "…",
  "rankingCount": 3,
  "tracks": [{ "trackId": "…", "score": 0.8889, "rankedBy": 3, "averagePosition": 1.33 }],
  "viewerRanking": { "rankedTrackIds": ["…"], "unrankedTrackIds": ["…"], "updatedAt": "…" }
}
```

- `viewerRanking` is `null` for anonymous viewers and users without a ranking.
- `tracks` covers every track on the current tracklist, sorted by `score` (descending), then `rankedBy` (descending), then tracklist order.
- `rankedBy` and `averagePosition` count only rankings that list the track explicitly. `averagePosition` is `null` when no one did.
- `score` is `null` when the album has no rankings.

## Scoring

Standings use a Borda count normalized to the current tracklist of N tracks. Within one ranking, position p earns `(N − p) / (N − 1)` points, so first place earns 1 and last place earns 0. Tracks a ranking leaves out tie for the remaining positions and each receive the average of their points. Partial rankings therefore count against every omitted track: a single user who ranks only one obscure track cannot lift it above a track that most rankers placed highly. A track's `score` is its mean over all counted rankings, between 0 and 1. On a one-track album, the track scores 1.

## Tracklist changes

Rankings store catalog `trackId` values, not positions, and are never rewritten when the tracklist changes. On read, tracks no longer on the album are dropped and positions close up. Tracks the user has not ranked, including tracks added later, are returned as `unrankedTrackIds` in tracklist order. A ranking with no current tracks left is excluded from `rankingCount` and scoring until the user saves it again.

Baseline confirmation and corrections preserve existing `trackId` values. A correction that drops an entry's `trackId` (see [correction track lists](PHASE_2_SUBMISSIONS.md)) gives that track a new identity, so the old track falls out of existing rankings.

## Account deletion

The account-deletion transaction deletes the user's rankings, together with the other user-owned data listed in [the Last.fm sync guide](LASTFM_SYNC.md#account-and-privacy-contracts).
