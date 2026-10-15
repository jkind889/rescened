# Next feature plans: track rankings, listening stats, community genres

Status, October 2026: plan 1 is implemented on branch `track-ranking-followups` (see [TRACK_RANKINGS.md](TRACK_RANKINGS.md)), and plan 2 on `listening-stats` (see [LISTENING_STATS.md](LISTENING_STATS.md)). Plan 3 is designed with all decisions answered, and slices 1 (vocabulary, seed, reads, album chips), 2 (contributor suggestions through the API), 3 (moderator approval through the API), 4 (the contributor and moderator UI), 5 (vocabulary commands and the merge CLI), and 6 (browsing, the search filter, and top genres) are built on `community-genres` (see [COMMUNITY_GENRES.md](COMMUNITY_GENRES.md)).

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

### Decisions (answered 2026-10-14)

1. Standings are "settled" at **3** distinct rankers.
2. **Early label only.** Scores are not shrunk, so the documented `score` meaning is unchanged.
3. Rankings **appear in activity feeds** (profile activity and the network feed), and also get their own Rankings tab on profiles.

All six slices are built. The Rankings section became its own profile tab rather than part of Activity.

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

### Decisions (answered 2026-10-14)

1. Stats are **visible on public profiles**. Private profiles stay owner-only.
2. Automatic listens are **included by default**, with a toggle to exclude them.
3. History is **capped at 2 years**. There is no unbounded "all time": the default period is the last two years, and single calendar years inside that window can be selected.

Built as described above, except that the result is not cached and no benchmark case has been added yet. [LISTENING_STATS.md](LISTENING_STATS.md) is the maintained contract.

---

## 3. Community genres

### Goal

Contributors suggest genres for any catalog album, including genres that don't exist yet, and moderators approve them in the same queue as album corrections. Approved genres appear as chips on album pages, power `/genre/:slug` browsing and a search filter, and feed a "top genres" section on the stats page.

Direction (2026-10-14): genres are **user-submitted and moderator-approved**, following the album-revision model. This replaces the earlier "operator vocabulary first, user tags later" recommendation. A vocabulary still exists, but contributors grow it through moderated suggestions instead of relying only on an operator.

### Recommendation: a `genre_suggestion` submission type

Genre suggestions reuse the `AlbumSubmission` collection, append-only revisions, moderation events, workflow states (pending, needs changes, approved, rejected, withdrawn), owner and moderator detail views, and transactional approval. They get their own `submissionType` instead of becoming a ninth correction field group, because three correction rules don't fit them:

| Correction rule | Why it doesn't fit genres | Genre suggestion rule |
| --- | --- | --- |
| A field group is a full replacement value. | Many people make small additions. With full replacement, two pending suggestions would clobber each other. | An explicit operation list (`add`, `remove`), like `externalReferences.add`. |
| Approval requires `catalogRevision` to equal the baseline. Any catalog write makes the correction stale (`409 CATALOG_CHANGED`). | A cover backfill or a title fix would stale every pending genre suggestion, and each genre approval would stale every pending correction. | Genres get their own `genresRevision` counter. Correction writers never touch `genres`, and genre writers never touch other fields, so the two sets are disjoint. |
| Corrections can only change existing field values. | Contributors also need to propose genres that aren't in the vocabulary yet. | A suggestion may include new genre names. The moderator resolves each one when approving. |

The approve endpoint already branches on `submissionType`, so this is a third branch rather than a new pipeline. The full correction editor never edits genres. Genres have their own lighter form.

`genresRevision` is a deliberate, documented exception to the rule that every catalog writer increments `catalogRevision`. Document it in [PHASE_2_SUBMISSIONS.md](PHASE_2_SUBMISSIONS.md#catalog-revision-token) when this is built, and extend `npm run check:catalog-contract` so that only the genre service writes `AlbumCatalog.genres` and the importer never does.

### Data model

```text
Genre
  genreId          UUID v4, public, immutable
  slug             unique, URL-facing; changes on rename (old slugs move to aliases)
  name             display name
  normalizedName   unique; the matching key (see Validation)
  aliases          [{ name, normalizedName }], also searched and used to redirect old slugs
  parentId         optional broader genre; one level only
  status           active | retired
  kind             genre (only value in version 1; reserved for descriptors later)
  origin           { source: seed | community, submissionId?, createdAt }

GenreEvent (append-only)
  genreId, action (create | rename | alias_add | reparent | retire | merge)
  actorUserId, reason, before, after, submissionId?, createdAt

AlbumCatalog (new fields)
  genres                  [ObjectId → Genre], ordered, max 5, first = primary
  genresRevision          integer, starts at 0
  fieldProvenance.genres  { source: "community", submissionId, approvedBy, approvedAt }
```

- Public APIs expose `genreId`, `slug`, and `name`, never a Mongo `_id`.
- Unapproved genre names are never stored as `Genre` rows. They live only inside the submission revision, so the public vocabulary contains only moderator-approved genres, and a rejected name leaves nothing behind.
- Index `AlbumCatalog` on `{ genres: 1, … }` for browsing and the search filter. Use a partial unique index on `normalizedName` and on `slug` in `Genre`.

### Contributor flow

**Endpoints** (Clerk auth, `COMMUNITY_SUBMISSIONS_ENABLED=true`, `GENRES_ENABLED=true`, and a dedicated `genreSuggestionRateLimit` applied before any write):

- `GET /genres/search?q=` lists active genres matching a name or alias, for the picker's autocomplete.
- `POST /suggestions/genres` creates a suggestion.
- The existing revise and withdraw routes handle the new type.

**Payload:**

```json
{
  "albumId": "11111111-1111-4111-8111-111111111111",
  "add": [
    { "genreId": "22222222-2222-4222-8222-222222222222" },
    { "newGenre": { "name": "Jazz rap", "parentGenreId": "33333333-3333-4333-8333-333333333333" } }
  ],
  "remove": ["44444444-4444-4444-8444-444444444444"],
  "primaryGenreId": "22222222-2222-4222-8222-222222222222",
  "note": "Optional context for the moderator"
}
```

**Validation:**

- Reject unknown fields. Require at least one operation. Allow at most 5 additions, at most 2 new genre names, and a `note` of at most 500 characters. A genre can't appear in both `add` and `remove`.
- Every referenced `genreId` must be active. A `remove` must name a genre the album currently has.
- New names are normalized: NFKC, trimmed, internal whitespace collapsed, 2–40 characters from a letters, digits, space, and `&'-/+.` allowlist. The case-folded result is the matching key.
- If a new name matches an existing active genre's name or alias, the server rewrites the operation to that `genreId` and says so in the response, so the UI can show "Using existing genre *Jazz rap*". A match on a retired genre is rejected with `GENRE_RETIRED`.
- The stored revision keeps a baseline: the album's genre IDs and `genresRevision` at submission time.

**Limits:**

- A user can have one open (pending or needs-changes) genre suggestion per album. A second one returns `409 GENRE_SUGGESTION_EXISTS` with the open `submissionId`, so the UI can send the user to revise that suggestion instead.
- Any contributor can propose new genre names, with at most 10 across all their open suggestions. Moderators gate every name, so no reputation threshold is needed.

**UI:**

- An album page "Suggest genres" button opens a picker that shows the current chips (removable), autocomplete for existing genres, and a "Propose new genre" option when nothing matches.
- Pending suggestions appear in the contributor's existing suggestions list, with the same status badges and revise flow as corrections.
- The submitter sees a "Suggestion pending" note on that album. Nobody else sees pending genres.

### Moderator flow

**Queue.** Add a "Genres" filter to the moderation queue. The detail view shows:

- The album's current genres next to the contributor's baseline, with a stale marker when they differ. This is informational, not blocking, because operations still make sense against the current state.
- Each operation as a `+` or `−` diff.
- For each new name: the closest existing genres (by normalized name, alias, and edit distance), with a parent picker and an editable spelling.

**Approval body.** Each operation gets a decision, mirroring how corrections use `applyFields`:

```json
{
  "operations": [
    { "index": 0, "decision": "apply" },
    { "index": 1, "decision": "apply", "newGenre": { "action": "create", "name": "Jazz rap", "parentGenreId": "33333333-3333-4333-8333-333333333333" } },
    { "index": 2, "decision": "skip" }
  ],
  "primaryGenreId": "22222222-2222-4222-8222-222222222222",
  "reason": "Optional; a standard note is recorded when blank"
}
```

- Each operation receives exactly one decision, so the decisions form a complete partition. At least one operation must be applied. Otherwise the moderator rejects or requests changes, both of which still require a note.
- A moderator may approve their own genre suggestion. The approval event records both the submitter and the approver, so self-approvals stay auditable.
- A new-genre operation resolves as `create` (optionally correcting the spelling and parent), `map` (to an existing `genreId`, optionally recording the proposed spelling as an alias), or `skip`.

**Transaction** (one Mongo transaction, standalone Mongo returns `503 APPROVAL_UNAVAILABLE` with no fallback):

1. Re-read the pending suggestion, its current revision, and the target album.
2. Insert the `Genre` rows marked `create`, with `GenreEvent` records. A slug or name collision returns `409 GENRE_NAME_CONFLICT` and rolls everything back.
3. Apply the operations to the current genres. An addition already present, or a removal already absent, is recorded as a no-op rather than an error. A result over 5 returns `409 GENRE_LIMIT_EXCEEDED`, and the moderator skips some operations.
4. Update the album conditionally on `{ _id, albumId, genresRevision }`, increment `genresRevision`, and set `fieldProvenance.genres`. A concurrent genre approval fails the guard and returns `409 GENRES_CHANGED`. Re-opening the item shows the new current state.
5. Transition the submission and append one `approved` event with an `application` object: applied and skipped indexes, no-ops, created and mapped `genreId`s, and the base and result `genresRevision`. A retry is idempotent and appends nothing.

**Volume.** Genre suggestions will be the highest-volume item in the queue. They are the natural first user of the deferred bulk-approval work, where each item keeps its own transaction and reports its own conflicts. Until then, the detail view gets a one-click "Approve all as proposed" when every new name has an exact or alias match.

### Vocabulary maintenance

- **In the app** (moderator commands, `COMMUNITY_MODERATION_ENABLED`, a transaction plus a `GenreEvent`): rename (the old slug becomes an alias), add an alias, reparent, and retire. Retiring hides a genre from the picker, browsing, and album chips, but doesn't rewrite albums.
- **Operator CLI, dry-run first:** `npm run genres:import` seeds the starting vocabulary (about 100 broad genres and common subgenres, written by hand) from a checked-in, checksummed dataset. `npm run genres:merge` remaps every album from genre A to genre B, because it rewrites many albums and should produce a reviewable report before the apply. Both follow the existing rule that each apply needs explicit authorization for the named database.

### Read surfaces (`GENRES_ENABLED`)

- Album detail gains `genres: [{ genreId, slug, name }]`, resolved from `Genre` at read time, without retired genres. Album cards in boards, feeds, and search can add the primary genre later; it is resolved from the catalog, not snapshotted.
- `GET /genres/:slug` returns the name, parent, children, and album count. It resolves aliases and old slugs, so renamed links still work.
- `GET /genres/:slug/albums` is cursor-paged and sorted by community average (with a minimum review count) or by recent activity. It includes child genres by default ("Hip hop" lists "Jazz rap" albums), and `includeChildren=false` limits it to the genre itself. The browse page has a matching toggle.
- Local catalog search gains a `genre` filter. External discovery candidates never carry genres.
- Stats (plan 2) gains `topGenres`, weighted by the user's listens and reviews.
- The "Recently approved" page shows genre approvals as "Genres updated on *Album*" through the existing public feed serializer. The application object stays private to owners and moderators.

### Error codes (add to [ERROR_CODES.md](ERROR_CODES.md))

`GENRES_DISABLED` (503), `GENRE_NOT_FOUND` (404), `GENRE_RETIRED` (400), `GENRE_SUGGESTION_EXISTS` (409), `GENRE_LIMIT_EXCEEDED` (409), `GENRE_NAME_CONFLICT` (409), and `GENRES_CHANGED` (409). Invalid payloads reuse `INVALID_SUBMISSION`, and wrong-state actions reuse `INVALID_SUBMISSION_STATE`.

### Licensing and provider boundary

- Version 1 doesn't import genres from MusicBrainz. Its core data is CC0, but tags and genres are user-contributed supplementary data under different terms. Confirm the license before any import, and keep any future import behind the catalog importer's provenance rules. It still could not overwrite community-owned genres.
- No new external API is needed.

### Rollout

1. **Model and reads.** Add `Genre`, `GenreEvent`, the new album fields, the seed CLI with a dry run, and the read endpoints and album chips behind `GENRES_ENABLED`. Seed `rescened_dev`. *Built, except seeding `rescened_dev`, which waits for a reviewed dry run and authorization.*
2. **Suggestions.** *Built. Differences from this plan: a pending suggestion can't be revised (as for other submissions), so the 409 tells the user to withdraw it or wait for review; the primary genre can also be set with `add[].primary`; the new-name allowance has its own code, `GENRE_PROPOSAL_LIMIT`; and the existing frontend hides the new-album Revise link for genre suggestions until slice 4.* Originally: Add the `genre_suggestion` type: validation, normalization, alias matching, limits, rate limit, and the revise and withdraw paths. Run `npm test`.
3. **Approval.** *Built. Differences from this plan: decisions are `genreDecisions.add` and `.remove` arrays that line up with the suggestion instead of indexed `operations`, and `primary` is `apply` or `skip` (moderators can't pick a different primary). A concurrent approval on the same album is retried by the transaction against the new state rather than returning `GENRES_CHANGED`. Moderator detail gained `genreReview` (current genres, a stale flag, and name candidates). Both carry-forward points below are done.* Originally: Add the per-operation approval transaction, new-genre resolution, and the application event. Two points to carry forward from slice 1: the conditional update must treat a missing `genresRevision` as `0` (`{ $in: [null, 0] }`), the same way corrections treat a missing `catalogRevision`; and correction approval currently `$set`s `fieldProvenance` as a whole, so switch it to per-field `fieldProvenance.<field>` paths so it can't drop genre provenance written by a concurrent genre approval. Integration tests cover concurrent approvals on one album, a name-collision rollback, idempotent retries, and standalone 503. Run `npm run test:integration`.
4. **Frontend.** *Built, with a small `GET /genres` (top-level genres) added for the parent pickers.* Originally: Add the suggest picker, the contributor list entries, the moderator queue filter, and the review panel. Run lint and build.
5. **Vocabulary commands** in the app, and the merge CLI. *Built, with a `restore` command added so a retire can be undone, a genre `revision` for optimistic concurrency (`GENRE_REVISION_CONFLICT`), and a moderator page at `/moderation/genres`.*
6. **Discovery.** *Built. Albums below the 3-review minimum still appear after the rated ones, rather than being hidden. `topGenres` counts listens only; reviews already show in the stats' review section.* Originally: Add the browse page, the search filter, and `topGenres`. Run `npm run check:catalog-contract`, extended to the genre routes and the `genres` write guard.
7. **Production.** Dogfood on dev, seed production after a reviewed dry run, then turn on `GENRES_ENABLED`.

### Decisions (answered 2026-10-14)

1. **Genres only** in version 1. `Genre.kind` is reserved so mood and texture descriptors ("melancholic", "late-night") can reuse the same pipeline later without mixing into genre browsing.
2. **Seed about 100 genres** by hand through the dry-run-first import, so the picker is useful on day one and new-name proposals are the exception.
3. **At most 5 genres per album**, with the first as the primary genre.
4. **Child genres count when browsing a parent** by default, with a toggle to exclude them.
5. **Moderators may approve their own genre suggestions.** The audit trail records it.
6. **Any contributor may propose new genre names**, within the 10-open-names cap.
