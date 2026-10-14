# Next feature plans: track rankings, listening stats, community genres

Status: proposal, October 2026. None of the three plans below is implemented. Each plan lists the decisions that need an answer before work starts.

The three plans are ordered by dependency rather than size. Genres (plan 3) make the stats page (plan 2) richer, but neither blocks the other. Track rankings (plan 1) are independent.

---

## 1. Track rankings: after community standings

### Where things stand

Community standings are already on `main` ([behavior guide](TRACK_RANKINGS.md)). `GET /track-rankings/album/:albumId` returns a Borda-count `score`, `rankedBy`, and `averagePosition` for every track. The album page's Ranking tab shows community standings and the viewer's drag-to-rank editor. The model already has a `{ userId, updatedAt }` index intended for profile listings.

So "community track ranking" from the earlier idea list is done. This plan covers the next layer: making standings trustworthy at small sample sizes, personal and social views, and surfacing rankings outside the Ranking tab.

### Slices

| # | Slice | Backend | Frontend |
| --- | --- | --- | --- |
| 1 | Small-sample honesty | Add `confidence: "early" \| "settled"` to the standings response, `early` below a threshold of distinct rankers. | Show "Based on N rankings" and an "Early" label. Don't show a #1 badge while early. |
| 2 | You vs. community | Add `viewerComparison` when the viewer has a ranking: per-track position delta and an agreement score (Spearman's rho over the tracks both rank, mapped to 0–100%). | A "Your take" column with ▲/▼ deltas, plus "Your hottest take" (largest absolute delta). |
| 3 | Circle standings | `GET …?scope=circle` runs the same Borda pipeline restricted to the viewer and the people they follow, **excluding private profiles** (matching `getNetworkActivity`). | A Community / People you follow toggle on the Ranking tab. |
| 4 | Surface the result | Album social context gains `topTrack` (the #1 track, once `settled`). | A "Fan favorite" badge in the Tracks tab and one line in the album sidebar. |
| 5 | Rankings on profiles | `GET /profile/:userId/rankings` (cursor-paged by `updatedAt`, `profileAccess`-gated) returns each album's current top 3. | A Rankings section on the profile (inside Activity, or its own tab). |
| 6 | Activity events | Add a `ranked_album` activity type to profile activity and network activity, reading `TrackRanking.updatedAt`. | Render it in feeds the same way as listens. |

### Design notes

- **Privacy in the circle view.** With few followed rankers, circle standings could reveal one person's ranking. Excluding private profiles keeps the circle view consistent with the network feed. Community standings stay anonymous aggregates and keep counting everyone.
- **Score shrinkage (optional, contract change).** The Borda mean could be shrunk toward 0.5 with a prior weight *k*: `(sum + 0.5k) / (count + k)`. This reorders tracks at low counts, so it changes the documented `score` meaning and the [behavior guide](TRACK_RANKINGS.md) would need an update. Slice 1's label is the cheaper, non-breaking alternative. Pick one rather than both.
- **Agreement metric.** Compute Spearman's rho only over tracks the viewer ranked, against their community order, after the same reconciliation `reconcileWithTracklist` already does. Return `null` for fewer than three shared tracks.
- **Performance.** Standings are aggregated on every read. That is fine at current scale; the pipeline uses the `{ albumCatalogId: 1 }` index. Add an album with a few thousand rankings to `benchmarks/` before deciding anything. Only if that is slow, materialize a per-album standings document that is recomputed after each write. It is derived data, so recomputing idempotently is enough and no transaction is needed.
- **Not planned yet:** a site-wide "top tracks" leaderboard. Borda scores are normalized per album and are not comparable across albums of different lengths. A leaderboard would need a different measure (for example, #1-pick counts) and is a separate design.

### Verification

`npm test` covers the pure scoring additions (agreement, deltas, confidence threshold) as unit tests. Circle-scope aggregation and privacy filtering get a case in `tests/trackRankings.integration.test.js` (`npm run test:integration`). The frontend changes need lint and build. Update [TRACK_RANKINGS.md](TRACK_RANKINGS.md) for every new response field.

### Decisions needed

1. The "settled" threshold: 3 or 5 distinct rankers?
2. Score shrinkage or the "Early" label only?
3. Should rankings appear in activity feeds (slice 6), or stay on album pages and profiles?

---

## 2. Personal listening stats

### Goal

A Stats tab on profiles that summarizes a user's listening, reviewing, and saving for a chosen year or for all time. It uses only local data: `Listen`, `Review`, `BoardItem`, `TrackRanking`, and `AlbumCatalog`. This is also the foundation for a later year-in-review recap.

### API

```http
GET /profile/me/stats?period=2026
GET /profile/:userId/stats?period=all
```

- Access goes through the existing `profileAccess`: private profiles are owner-only and return the standard `403` with `isPrivate`.
- `period` is a four-digit year or `all`. It is strictly validated, and unknown query fields are rejected with `INVALID_STATS_REQUEST`.
- The response carries public catalog `albumId` values only, with album display fields resolved from `AlbumCatalog` at read time and no denormalized snapshots.

Response sections (each computed independently, so one empty section never fails the rest):

| Section | Contents | Source |
| --- | --- | --- |
| `listening` | Total listens, distinct albums, listens per month (12 buckets for a year), busiest weekday, longest daily streak, manual vs. automatic split. | `Listen.listenedOn` is already a local calendar date, so no timezone conversion is needed. |
| `topAlbums` | Top 10 albums by listen count, ties broken by most recent listen. | `Listen` grouped by `albumCatalogId`, then catalog lookup. |
| `topArtists` | Top 10 by listen count, credited to `artistDisplayName`. | Catalog lookup. Without artist IDs, name collisions merge (see notes). |
| `eras` | Listens by release decade, plus the share of listens to albums released in the selected year. | `AlbumCatalog.releaseYear`. |
| `listeningTime` | Estimated hours, counting only albums whose full tracklist has durations, reported with how many listens it covers. | `tracks.durationMs`. |
| `reviews` | Count, average, 9-bucket distribution, review rate (reviewed ÷ distinct albums listened), most-liked review, and "versus the community": average of (your rating − album average) over albums with at least 3 other reviews. | `Review`, `Like`. |
| `library` | Albums saved, unplayed backlog (the same rule as `GET /boards/pick`, which already ships), and track rankings made. | `BoardItem`, `Listen`, `Review`, `TrackRanking`. |

### Implementation

- Put the computation in a new `routes/utils/listeningStats.js`, split into one pure function per section and a thin aggregation layer, so the arithmetic (streaks, buckets, deltas) is unit-testable without MongoDB.
- Listening aggregates use the existing `{ userId, listenedOn }` index, with the `period` range matched on `listenedOn` strings. Reviews use `{ userId, date }`. Bound every pipeline: top-N stages use `$limit` before the catalog `$lookup`.
- Review periods use the review `date` (a UTC timestamp), while listens use the local `listenedOn` day. Document this mismatch. A review written at 11 p.m. local time on Dec 31 can count toward the next year.
- **Caching.** Compute on read first. Add a heavy-user case to `benchmarks/`. If the p95 is too slow, cache per `(userId, period)` with a short TTL, invalidated by the user's newest `Listen`/`Review` `updatedAt`. Do not store snapshots of other users' data.
- **Frontend.** A `Stats` profile tab with a year selector (years with data, plus All time). Charts are plain CSS bars in the style of the album rating histogram. No chart library: bars, a 12-month column chart, and ranked lists cover everything above.

### Notes and risks

- **Artist identity.** `topArtists` groups by display name until the catalog has artist IDs. Collaborations credited as "A & B" count as their own artist. Grouping by `artistCredits` names with `role: "main"` is slightly better; name collisions remain either way.
- **Automatic listens.** Last.fm-detected listens count by default and are labeled. Offer a toggle to exclude them, since detection accuracy is still being audited.
- **Empty states.** New users see a single prompt to log a listen, not a page of zeros.

### Verification

- Unit tests for each pure section function and for `period` validation.
- One integration test seeds listens, reviews and saves across two years and checks year isolation and private-profile denial.
- `npm run check:catalog-contract` (album-bearing response), plus frontend lint and build.

### Decisions needed

1. Should other people see a user's stats on public profiles, or only the owner?
2. Include automatic listens by default?
3. Cap "all time" (for example, the last 10 years), or leave it unbounded?

---

## 3. Community genres

### Goal

Albums get a small ordered set of genres (for example, "Hip hop", "Jazz rap") from a moderated vocabulary. Genres appear on album pages, enable browsing (`/genre/:slug`) and search filtering, and feed the stats page's "top genres".

### Recommendation: a controlled vocabulary through the correction workflow

There are two models:

| Model | How it works | Trade-off |
| --- | --- | --- |
| **Controlled genres (recommended first)** | A moderator-managed `Genre` vocabulary. Albums carry up to 5 `genreIds`, changed only through the existing catalog-correction workflow. | Reuses submission, review, provenance, transaction, and audit machinery that is already built and tested. It is slower for contributors, but it is trustworthy and consistent. |
| Free-form user tags | Any user tags any album, and counts determine the display (Last.fm style). | Needs new spam, abuse, and normalization moderation, and the data is noisy. Better as a later layer on top of the vocabulary. |

### Data model

```text
Genre
  genreId      UUID v4, public, immutable
  slug         unique, URL-facing, can change on rename (old slugs kept in aliases)
  name         display name
  parentId     optional broader genre (one level is enough at first)
  aliases      alternative names and retired slugs, for search and redirects
  status       active | retired

AlbumCatalog
  genres       [ObjectId → Genre], max 5, first = primary
  fieldProvenance.genres   community provenance on every change
```

- Public APIs expose `genreId` and `slug`, never Mongo `_id`, the same as the other public IDs.
- `/genre/:slug` resolves current slugs and aliases, so a rename doesn't break shared links.

### Workflow

1. **Seed the vocabulary.** Use an operator CLI (`npm run genres:import`) following the existing dry-run-first pattern: a checked-in, checksummed vocabulary dataset; `--dry-run` writes a report; the apply step needs explicit authorization for the named database. Start with about 150 genres written by hand rather than copying a provider taxonomy.
2. **Contributors propose.** Add `genres` as a new correction field group (`{ genreIds: [...] }`, full replacement, 0–5 entries, active genres only). Corrections already handle baselines, stale detection through `catalogRevision`, `applyFields`, and transactional application, so genres become one more group in the field-group table in [PHASE_2_SUBMISSIONS.md](PHASE_2_SUBMISSIONS.md#mutable-field-groups).
3. **Moderators apply.** This uses the existing correction review UI and adds a genre diff renderer. Approval writes `fieldProvenance.genres` with `source: "community"`, so the catalog importer never overwrites it.
4. **Vocabulary changes.** Adding, renaming or retiring genres is a moderator command with an append-only audit record. It's rare, so start with the operator CLI and add a UI only if needed. Retiring a genre hides it from proposals and browsing but does not rewrite albums. A reviewed migration remaps them.
5. **A quick genre form.** A lighter "Suggest genres" entry on the album page creates a correction containing only the `genres` group, so contributors don't need the full correction editor.

### Read surfaces

- The album page shows genre chips linking to `/genre/:slug`.
- `GET /genres/:slug/albums` returns catalog albums with that genre (optionally including child genres), sorted by community average rating with a minimum review count, or by recent activity. It is cursor-paged.
- Search gains an optional `genre` filter on local catalog search. External discovery candidates never carry genres.
- Stats (plan 2) gains `topGenres` once enough albums are tagged.

### Licensing and provider boundary

- Version 1 does not import genres from MusicBrainz. MusicBrainz's core data is CC0, but tags and genres are user-contributed supplementary data under a different license. Confirm the exact terms before any import, and keep any future import behind the catalog importer's provenance rules.
- No new external API is needed.

### Rollout

1. Genre model, vocabulary CLI, seeded dev data. The read-only album chips stay hidden behind a `GENRES_ENABLED` flag.
2. The `genres` correction field group: validation, baseline, application, provenance, and tests (`npm test` plus `npm run test:integration`, since approval is transactional).
3. Moderator diff UI and the quick-suggest form.
4. Browse page and the search filter (`npm run check:catalog-contract`; extend the contract scan to the new routes if it doesn't cover them).
5. Turn on the flag in production after the dev database has a meaningful tagged set.

### Decisions needed

1. Controlled vocabulary first, with user tags later, or user tags only?
2. Max genres per album: 3 or 5?
3. Should child genres count when browsing a parent ("Hip hop" includes "Jazz rap")?
4. Who maintains the vocabulary: moderators in the app, or only the operator CLI at first?
