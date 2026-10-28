# Community genres

Albums carry a small, ordered set of genres from a vocabulary that the community grows and moderators approve. The design and its remaining rollout slices are in [plan 3 of the feature plans](NEXT_FEATURE_PLANS.md#3-community-genres). This guide is the maintained contract for what is built.

Built so far:

- **Slice 1:** the vocabulary model, the seed import, the read endpoints, and the album chips.
- **Slice 2:** contributor genre suggestions through the API. See [Genre suggestions](#genre-suggestions).
- **Slice 3:** moderator approval through the API, which is the only way an album's genres change. See [Moderator approval](#moderator-approval).
- **Slice 4:** the contributor and moderator UI. See [Frontend](#frontend).
- **Slice 5:** moderator vocabulary commands and the operator merge. See [Vocabulary maintenance](#vocabulary-maintenance).
- **Slice 6:** the genre browse page, the search filter, and top genres in stats. See [Endpoints](#endpoints) and [Frontend](#frontend).

What's left is the production rollout (slice 7 in the plan).

## Feature flag

`GENRES_ENABLED=true` (server-side, default off) enables everything on this page:

- The `/genres` routes. While the flag is off they return `503 GENRES_DISABLED`.
- The `genres` field on `GET /albums/album/:albumId`. While the flag is off the field is omitted, and the album page shows no chips.
- An explicit index build for `Genre` and `GenreEvent` before the server listens.

The flag does not stop index creation. Any process that loads the album routes loads the `Genre` model, so with Mongoose's default `autoIndex` the first deploy creates two empty collections, `genres` and `genreevents`, with their indexes. It also adds a sparse `{ genres: 1 }` index on `albumcatalogs`, which is small because untagged albums have no `genres` field. The data stays empty until a seed apply.

The seed command does not read the flag. It writes to whichever database `MONGO_URI` names. It connects with `autoIndex` and `autoCreate` off, so a dry run creates nothing; only `--apply` creates the collections and indexes.

## Data model

`Genre` (`models/Genre.js`):

| Field | Notes |
| --- | --- |
| `genreId` | Public UUID v4, immutable. APIs expose this, never `_id`. |
| `slug` | Unique and URL-facing. A rename will move the old slug into `aliases`. |
| `name` | The display name, with case preserved. |
| `normalizedName` | Unique matching key (see [Name rules](#name-rules)). |
| `aliases` | `[{ name, normalizedName, slug }]`: alternative spellings and retired slugs, used by search and slug lookups. |
| `parent` | Optional broader genre. There is one level only: a parent has no parent. |
| `status` | `active` or `retired`. Retired genres are hidden from search, detail, children lists, and album chips, but stay referenced by albums until a reviewed merge remaps them. They don't count toward an album's 5-genre cap or decide its primary genre. |
| `revision` | Concurrency token for vocabulary commands, a merge, and approval's alias additions. A missing field counts as `0`. |
| `kind` | Always `genre` in version 1. It is reserved so descriptors can reuse the pipeline later. |
| `origin` | `{ source: "seed" \| "community", datasetId, submissionId }`. |

`GenreEvent` is the append-only vocabulary audit: `genre`, `genreId`, `action` (`create`, `rename`, `alias_add`, `reparent`, `retire`, `restore`, `merge`), `actorUserId`, `reason`, `before`, `after`, `datasetId`, `datasetSha256`, `submissionId`, and `createdAt`. Nothing updates or deletes these records. The seed writes one `create` event per genre, with actor `operator:genres-import`.

`AlbumCatalog` gains:

| Field | Notes |
| --- | --- |
| `genres` | Ordered `Genre` references, with the primary genre first. At most 5, with no duplicates. Absent rather than `[]` on albums that have never had genres. |
| `genresRevision` | Internal genre concurrency token. A missing field counts as `0`. Never returned by the API. |
| `fieldProvenance.genres` | Community provenance, which approval will write. |

### Ownership and the revision exception

Only the genre service writes `genres`, `genresRevision`, and `fieldProvenance.genres`. Because no other catalog writer touches them, genre changes advance `genresRevision` instead of `catalogRevision`. This is a deliberate exception to the [catalog revision rule](PHASE_2_SUBMISSIONS.md#catalog-revision-token): genre approvals don't stale pending corrections, and corrections, imports, and cover backfills don't stale pending genre suggestions.

Two safeguards keep this sound:

- **The catalog importer never writes genres.** A refresh `$set`s only its own data fields. Because it replaces `fieldProvenance` as a whole, it copies the existing `fieldProvenance.genres` forward. `tests/catalogImport.test.js` covers this.
- **`npm run check:catalog-contract` fails** if a file outside `models/` and `lib/genres/` mentions `genresRevision`, writes `genres` with an update operator, or sets `fieldProvenance.genres`.

## Name rules

`lib/genres/vocabulary.js` is shared by the seed and, later, by suggestion validation.

- **Display name:** NFKC, trimmed, internal whitespace collapsed. 2–40 characters from letters, digits, space, and `&'-/+.`.
- **Matching key** (`normalizedName`): the display name lowercased, with hyphens and underscores treated as spaces and apostrophes and periods dropped. "Hip-Hop", "hip hop", and "Hip  hop" collide. "Drum & bass" and "Drum and bass" don't, so the vocabulary records one as an alias of the other.
- **Slug:** ASCII-folded, `&` becomes `and` and `+` becomes `plus`, and everything else is hyphenated. "R&B" becomes `r-and-b`, and "Reguetón" becomes `regueton`. Two spellings of one genre may share a slug. A slug owned by a different genre is a conflict.

## Seed vocabulary

The seed is [`data/genres/genres-v1.json`](../data/genres/genres-v1.json): 128 hand-written genres, 20 of them top-level, with a reviewed `genres-v1.json.sha256` sidecar. Each row is `{ name, parent?, aliases? }`, where `parent` names another top-level row. The envelope is `{ schemaVersion: "1.0.0", datasetId, genres }`, and unknown fields are rejected.

The workflow is dry-run first, like the catalog import:

```bash
npm run genres:import -- --input data/genres/genres-v1.json --dry-run
```

The dry run verifies the sidecar checksum, validates every row, compares the rows with the current vocabulary, and writes `<input>.import-report.json` (or `--report <path>`). The report names the `database`, the `datasetSha256`, and four lists:

- **`create`:** new genres that the apply will insert.
- **`unchanged`:** genres that already exist as written.
- **`drift`:** genres that exist by name but differ in spelling, parent, aliases, or status. Drift is reported only; the seed never modifies an existing genre, because moderators own the vocabulary once a genre exists.
- **`conflicts`:** rows whose name, slug, or alias belongs to a different existing genre. A child whose parent is blocked is listed too.

After someone reviews the report, an apply for the named database needs explicit authorization, then:

```bash
npm run genres:import -- --input data/genres/genres-v1.json --apply --expect-sha256 <datasetSha256 from the report>
```

The apply refuses a checksum mismatch, refuses any conflict, and re-plans inside one transaction. If the number of genres to create changed since the dry run, it aborts with `GENRE_SEED_PLAN_CHANGED`. It then inserts parents before children, with one `create` event each. Re-running it on a seeded database creates nothing.

Exit codes follow the [shared meanings](ERROR_CODES.md#workflow-statuses-and-command-exit-codes): `0` success, `1` fatal, and `2` for a dry run that found drift or conflicts. Standalone MongoDB returns `TRANSACTION_UNAVAILABLE`. If the report can't be written after a commit, the command prints `GENRE_SEED_COMMITTED_REPORT_FAILED`. The database changed, so don't treat that as a rollback.

Keep the report with the dataset checksum. To change the vocabulary later, add a new dataset version with its own sidecar, rather than editing a seeded file. Rename, retire, and merge are planned moderator commands and a merge CLI, not seed edits.

## Vocabulary maintenance

### Moderator commands

`/moderation/genres` needs a Clerk session, membership in `MODERATOR_USER_IDS`, and `GENRES_ENABLED`. The commands also need `COMMUNITY_MODERATION_ENABLED` and share the moderation-mutation rate limit. The logic is in `lib/genres/vocabularyCommands.js`.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/moderation/genres?status=active\|retired\|all&q=` | Genres by name, filtered by status and by name or alias. Each has `genreId`, `slug`, `name`, `status`, `revision`, `parent`, `aliases`, `origin.source`, `albumCount`, `childCount`, and `updatedAt`. |
| `GET` | `/moderation/genres/:genreId` | `{ genre, events }`, with the latest 50 `GenreEvent`s. |
| `POST` | `/moderation/genres/:genreId/rename` | `{ name }`. The old name becomes an alias, keeping its slug as a redirect, unless only its case changed. A name that was an alias is promoted instead of duplicated. |
| `POST` | `/moderation/genres/:genreId/aliases` | `{ name }`. Adds an alternative name. |
| `POST` | `/moderation/genres/:genreId/parent` | `{ parentGenreId }`. An active top-level genre, or `null` for top-level. A genre with active sub-genres can't get a parent (`GENRE_HAS_CHILDREN`), and the parent must be top-level (`GENRE_NOT_TOP_LEVEL`). |
| `POST` | `/moderation/genres/:genreId/retire` | `reason` required. Refused while the genre has active sub-genres. Albums keep their reference; the genre stops appearing anywhere public. |
| `POST` | `/moderation/genres/:genreId/restore` | Makes a retired genre active again. Refused with `409 GENRE_NAME_CONFLICT` when another genre now owns its name, an alias, or a slug (always the case after a merge, whose target holds the source's names), and with `409 GENRE_RETIRED` or `GENRE_NOT_TOP_LEVEL` when its parent is retired or no longer top-level. |

Every command body needs the genre's current `expectedRevision`; a stale one returns `409 GENRE_REVISION_CONFLICT`. `reason` is optional except for retiring. A blank reason records a standard note.

Each command checks the revision, writes the genre (incrementing `revision`), and appends one `GenreEvent` with `before` and `after`, all in a single transaction. Standalone MongoDB returns `503 GENRE_COMMAND_UNAVAILABLE`.

Names share one namespace across all genres, active or retired: a rename or alias that matches another genre's name, alias, or slug returns `409 GENRE_NAME_CONFLICT` with that genre in `details`. Only an active genre can be renamed, aliased, reparented, or retired (`GENRE_RETIRED` otherwise), and only a retired genre can be restored (`INVALID_GENRE_STATE`). No command rewrites albums.

The moderator page is `/moderation/genres`, linked from the suggestion queue. It has a searchable list, the genre's facts, one form per command, and the history. On a revision conflict it reloads the genre and asks the moderator to try again.

### Merging genres

Merging rewrites many albums, so it's an operator command rather than a moderator button, and it follows the dry-run-first rule:

```bash
npm run genres:merge -- --from <slug> --into <slug> --dry-run
```

The dry run connects with `autoIndex` and `autoCreate` off and changes nothing. It writes `data/genres/merges/<from>-into-<into>.merge-report.json` (or `--report <path>`) with:

- the `database` and a `planSha256`
- every affected album's genres before and after
- the aliases that will move
- how many open genre suggestions reference the source genre

For each album, the source genre is replaced by the target in the same position; if the album already has the target, the source is dropped. The source's name and aliases become the target's aliases (except spellings the target already has), so its links redirect to the target. The source is then retired.

After someone reviews the report, an apply for the named database needs explicit authorization:

```bash
npm run genres:merge -- --from <slug> --into <slug> --apply --expect-plan-sha256 <planSha256 from the report>
```

The apply re-plans inside one transaction and refuses (`GENRE_MERGE_PLAN_CHANGED`) unless the plan checksum matches the reviewed one. The checksum covers both genres' revisions, every album's `genresRevision` and before and after genres, and the aliases to move. The apply then:

- conditionally updates each album's `genres`, `genresRevision`, and `fieldProvenance.genres` (a whole `fieldProvenance` object on legacy albums where it isn't one) (`source: "manual"`, `reason: "genre merge"`, both genre IDs, and the plan checksum)
- adds the aliases to the target, with an `alias_add` event
- retires the source, with a `merge` event

The actor is `operator:genres-merge`. The merge refuses a source with active sub-genres (`GENRE_HAS_CHILDREN`), a retired target (`GENRE_RETIRED`), and more than 5,000 albums in one transaction (`GENRE_MERGE_TOO_LARGE`). Open suggestions that reference the source aren't changed; approving them later returns `GENRE_RETIRED` for the source, so a moderator skips that operation.

Exit codes: `0` success, `1` fatal. If the report can't be written after a commit, the command prints `GENRE_MERGE_COMMITTED_REPORT_FAILED`; the database changed, so don't treat it as a rollback.

## Endpoints

All of these are public, read-only, and return `503 GENRES_DISABLED` while the flag is off.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/genres` | Active top-level genres by name, as `{ results }`. These are the parent choices for a new genre. |
| `GET` | `/genres/search?q=` | Up to 10 active genres whose name or alias starts with the query, or has a word that starts with it. Ranking: exact name, exact alias, name prefix, then word match, alphabetical within each group. A result found through an alias carries `matchedAlias`. An empty query returns `[]`. Uses the IP `search` rate limit. |
| `GET` | `/genres/:slug` | `{ genre, canonical, aliases, parent, children, albumCount }`. Resolves current slugs and alias slugs; `canonical: false` means the client should switch to `genre.slug`. Retired or unknown genres return `404 GENRE_NOT_FOUND`. `albumCount` counts albums tagged with this genre directly, not its children. |
| `GET` | `/genres/:slug/albums?sort=rating\|recent&includeChildren=true\|false&limit=&cursor=` | The genre's albums, including active sub-genres unless `includeChildren=false`. Each album is `{ albumId, title, artistDisplayName, releaseYear, releaseType, cover, reviewCount, averageRating }`. See [Browsing](#browsing). Uses the IP `search` rate limit. |
| `GET` | `/albums/album/:albumId` | Adds `genres: [{ genreId, slug, name }]` in stored order (primary first), with retired genres omitted. |

Genre objects are always `{ genreId, slug, name }`.

## Browsing

`lib/genres/browse.js` computes each album's review count, average, and latest review date in one aggregation, using the `Review { albumCatalogId }` indexes.

- **`sort=rating`** (the default): albums with at least 3 reviews (`minimumReviews` in the response) come first, by average, then review count. The rest follow in the same order, with unreviewed albums last.
- **`sort=recent`:** by the most recent review; albums nobody reviewed come last.

Both orders are keyset-paged with an opaque `nextCursor`, and `_id` breaks ties internally; responses never contain it. `limit` is 1–48 (default 24). A cursor from the other sort, or a malformed one, returns `400 INVALID_GENRE_CURSOR`. Other bad query fields return `400 INVALID_GENRE_BROWSE`.

The aggregation looks up reviews for every album in the genre before sorting. That's fine at the current catalog size. Precompute per-album review stats if a genre grows to many thousands of albums.

### Search filter

`GET /search/search` accepts an optional `genre` (a slug or alias slug). It limits local catalog results to that genre and its active sub-genres, for both the paginated and the plain response shapes. The paginated response adds `genre: { genreId, slug, name }`. An unknown or retired genre returns `404 GENRE_NOT_FOUND`, and `genre` while genres are disabled returns `503 GENRES_DISABLED`. Search without `genre` is unchanged, and external discovery candidates never carry genres.

### Top genres in stats

While `GENRES_ENABLED` is on, profile stats add `topGenres`: up to 10 `{ genre, listenCount, albumCount }`. Every active genre on a listened album gets that album's listens, the same way artists are counted. See [LISTENING_STATS.md](LISTENING_STATS.md).

## Genre suggestions

A genre suggestion is an `AlbumSubmission` with `submissionType: "genre_suggestion"`. It shares the submission workflow (pending, needs changes, rejected, withdrawn), the append-only revisions and moderation history, owner and moderator detail, and the moderation queue (`?submissionType=genre_suggestion`). It needs no supporting sources; it has an optional note instead. The validation lives in `lib/genres/suggestions.js`.

### Endpoints

| Method | Path | Requires | Behavior |
| --- | --- | --- | --- |
| `POST` | `/suggestions/genres` | Sign-in, `COMMUNITY_SUBMISSIONS_ENABLED`, `GENRES_ENABLED`, the genre suggestion rate limit | Creates a pending suggestion. Returns `201` with the serialized suggestion plus `resolvedNewGenres`. |
| `GET` | `/suggestions/genres/open?albumId=` | Sign-in, `GENRES_ENABLED` | `{ suggestion }`: the viewer's own pending or needs-changes genre suggestion for the album, or `null`. |
| `POST` | `/suggestions/:submissionId/revise` | As for corrections, plus `GENRES_ENABLED` | Replaces a needs-changes suggestion with a new revision and baseline, and returns it to pending. Like other suggestions, a pending one can't be revised: withdraw it and submit again. |
| `POST` | `/suggestions/:submissionId/withdraw` | As for other suggestions | Withdraws the suggestion and frees the album slot. |

### Request

```json
{
  "albumId": "11111111-1111-4111-8111-111111111111",
  "add": [
    { "genreId": "22222222-2222-4222-8222-222222222222", "primary": true },
    { "newGenre": { "name": "Lo-fi hip hop", "parentGenreId": "33333333-3333-4333-8333-333333333333" } }
  ],
  "remove": ["44444444-4444-4444-8444-444444444444"],
  "primaryGenreId": "55555555-5555-4555-8555-555555555555",
  "note": "Optional context for the moderator"
}
```

- **`add`:** at most 5 entries. Each has exactly one of `genreId` (an active genre not already on the album) or `newGenre` (`name`, plus an optional `parentGenreId` naming an active top-level genre). One entry may set `primary: true`.
- **`remove`:** at most 5 genre IDs, each currently on the album. A retired genre can be removed even though it can't be added.
- **`primaryGenreId`:** an alternative to `add[].primary` for promoting a genre the album keeps. Promoting the current primary genre changes nothing.
- **`note`:** at most 500 characters.

Unknown fields are rejected. The suggestion must change something.

### Validation

- **Existing names are reused.** A `newGenre` whose name matches an active genre's name or alias, under the [name rules](#name-rules), is stored as a reference to that genre. The response lists each such rewrite in `resolvedNewGenres` (`{ name, matchedBy: "name" | "alias", genre }`), so the UI can say "Using existing genre *Hip hop*". A match on a retired genre returns `GENRE_RETIRED`.
- **At most 2 genuinely new names per suggestion,** counted after that rewrite. A user can have at most 10 new names across all their open genre suggestions (`409 GENRE_PROPOSAL_LIMIT`). A revision doesn't count against its own earlier names.
- **The album can end with at most 5 genres** (`409 GENRE_LIMIT_EXCEEDED`). A suggestion can swap genres by removing some while adding others. Only active genres count, matching what the album page shows; for the same reason, the primary genre is the first active one.
- **One open suggestion per user per album** (`409 GENRE_SUGGESTION_EXISTS`). The submission stores `openGenreSuggestionKey` (`<userId>:<album _id>`) under a unique sparse index while the suggestion is pending or needs changes. Withdrawal, rejection, and approval unset it, so two simultaneous creates can't both succeed.

### Stored value

Each revision stores:

- **`genreBaseline`:** the album's genres as `{ genreId, slug, name }` snapshots, plus its `genresRevision`, at submission time.
- **`genreChanges`:** `additions` (each `{ genre }` or `{ newGenre: { name, normalizedName, slug, parent } }`), `removals`, `primary` (`{ genre }` or `{ addIndex }`), and `note`.

The stored lists are named `additions` and `removals`, because Mongoose reserves `remove`. Responses use `add` and `remove`, matching the request.

Responses add `baseGenres` and `genreChanges: { add, remove, primary, note }`, built from those genre snapshots, which keep the names as they were at submission. They never include Mongo IDs, the album's `genresRevision`, or `openGenreSuggestionKey`.

## Moderator approval

Moderators approve through the existing `POST /moderation/album-suggestions/:submissionId/approve`, which needs `COMMUNITY_MODERATION_ENABLED`, a Clerk session, and membership in `MODERATOR_USER_IDS`. For a genre suggestion, the body takes only `genreDecisions` and an optional `reason`. A blank reason records "Genre suggestion approved." Sending `albumId`, `confirmPossibleDuplicate`, or `applyFields` returns `400`, and other submission types reject `genreDecisions`. The approval itself is in `lib/genres/approval.js`.

### Decisions

```json
{
  "genreDecisions": {
    "add": [
      { "decision": "apply" },
      { "decision": "apply", "resolution": { "action": "create", "name": "Lo-fi hip hop", "parentGenreId": "33333333-3333-4333-8333-333333333333" } },
      { "decision": "apply", "resolution": { "action": "map", "genreId": "66666666-6666-4666-8666-666666666666", "addAlias": true } }
    ],
    "remove": [{ "decision": "skip" }],
    "primary": "apply"
  },
  "reason": "Optional"
}
```

- **One decision per operation.** `add` and `remove` have exactly one entry for each proposed addition and removal, in order, each `apply` or `skip`. `primary` (`apply` or `skip`) is required when the suggestion sets a primary genre, and not allowed otherwise. A primary that points at a skipped addition can't be applied. At least one operation must be applied; otherwise reject or request changes.
- **A new genre name needs a resolution to apply:**
  - `create` adds it to the vocabulary. `name` corrects the spelling, and `parentGenreId` changes the parent (or `null` for top-level); omitted fields keep what the contributor proposed.
  - `map` uses an existing active genre instead. With `addAlias: true`, it records the proposed spelling as an alias of that genre.
- **No moderator-authored changes.** A moderator can only accept, skip, or resolve what was proposed, the same limit corrections have. Additions of existing genres take no resolution.

### What approval does

One transaction (standalone MongoDB returns `503 APPROVAL_UNAVAILABLE`):

1. **Re-read and check.** It re-reads the suggestion (pending, same revision) and the album, and re-checks the decisions against the stored suggestion.
2. **Apply removals, then additions, then the primary.** Removals go first so a swap fits under the cap.
   - Operations apply to the album's current genres, not the contributor's baseline. An accepted addition that's already present, or a removal that's already gone, is recorded as `noop` instead of failing.
   - A `create` inserts the `Genre` (`origin.source: "community"`, with the `submissionId`) and a `create` event.
   - A `map` with `addAlias` pushes the alias and appends an `alias_add` event.
   - Created or mapped names that collide with any genre's name, alias, or slug (active or retired) return `409 GENRE_NAME_CONFLICT` with that genre in `details`.
   - Adding a genre retired since the suggestion was made returns `409 GENRE_RETIRED`; mapping onto one that no longer exists returns `409 GENRE_NOT_FOUND`.
   - A result over 5 active genres returns `409 GENRE_LIMIT_EXCEEDED`; skip some additions and approve again. Retired genres don't count, but the stored list holds at most 5 in all, so retired genres that no longer fit are dropped, last first, and listed in `retiredRemoved`. Retired genres that still fit stay for a later merge.
3. **Write the album, if the list changed.** The write is conditional on `genresRevision`; a missing field counts as `0`, so it matches `{ $in: [null, 0] }`. It sets `genres`, increments `genresRevision`, and sets `fieldProvenance.genres` (`source: "community"`, `submissionId`, `revision`, `approvedByUserId`, `approvedAt`) as a dotted path. `catalogRevision` is untouched. If every accepted operation was a no-op, the album isn't written and its revision stays the same.
4. **Close the suggestion.** It sets the suggestion to `approved` with `approvalPublicationType: "genres_updated"` and `approvedAlbumCatalogId`, unsets `openGenreSuggestionKey`, and appends one `approved` event with a `genreApplication` record.

Any failure rolls back everything, including genres created earlier in the same approval.

**Concurrency.** Two approvals on the same album conflict at the database. `withTransaction` retries the loser against the newly committed genres, which the operation lists are designed for, so both land. A writer outside a transaction changing `genresRevision` between the read and the write returns `409 GENRES_CHANGED`.

**Retries.** An approval retried after it succeeded returns the same result with `idempotent: true` and writes nothing.

The response keeps the approval shape `{ suggestion, album, albumUrl, idempotent }`, and `album` includes its resolved `genres`.

### Approval record

`moderationHistory[].genreApplication`, visible in owner and moderator detail only:

| Field | Contents |
| --- | --- |
| `add` | Per addition: `decision` (`applied`, `skipped`, `noop`), the resulting `genre`, and `resolution` (`existing`, `created`, `mapped`). |
| `remove` | Per removal: `decision` and `genre`. It is stored as `removals`. |
| `primary` | `applied`, `skipped`, `noop`, or `null`. |
| `createdGenres` | New genres created by this approval. |
| `aliasesAdded` | Aliases added, as `{ genre, alias }` pairs. |
| `retiredRemoved` | Retired genres dropped to keep the stored list within the cap. |
| `resultGenres` | The album's genres afterwards. |
| `baseGenresRevision`, `resultGenresRevision` | The album's genre revision before and after. |

The public `/suggestions/approved` feed includes genre approvals, with `publicationType: "genres_updated"`, but not this record.

### Review context

The moderator detail response (`GET /moderation/album-suggestions/:submissionId`) adds `genreReview` for genre suggestions:

- `currentGenres`: the album's genres now, with `status`.
- `stale`: `true` when they differ from the contributor's baseline. This is informational only, because operations apply to the current state.
- `albumMissing`: `true` if the album no longer exists.
- `newGenreCandidates`: per addition, `null` for an existing genre, or up to 5 existing genres that look like the proposed name, for mapping. Each candidate has a `match` (`exact`, `spelling`, `contains`, or `word`). The matching is in `lib/genres/review.js`.

### Bulk approval

[Bulk approval](MODERATOR_IMPLEMENTATION_GUIDE.md#bulk-approval) approves a genre suggestion as proposed: it applies every addition, removal, and primary change, and maps each new name to the active genre whose name or alias matches it exactly, without adding an alias. A suggestion with a new name that has no exact match returns `BULK_REVIEW_REQUIRED` (`unmatched_genre_name`) and needs the single approval, because only a moderator decides whether to create a genre. Once one suggestion's new name has been created, other pending suggestions for the same name become bulk-approvable. Each item is its own transaction, so two items for one album apply in order and the second can return `GENRE_LIMIT_EXCEEDED`.

### Corrections and genre provenance

Correction approval now writes provenance as dotted `fieldProvenance.<field>` paths for the fields it changes, rather than replacing `fieldProvenance` whole. A correction approved after a genre approval therefore keeps `fieldProvenance.genres`. A legacy album whose `fieldProvenance` isn't an object still gets the whole patched object.

## Frontend

The frontend treats an `album.genres` array on album detail as the signal that genres are enabled. When the field is absent, no genre UI appears. Shared logic (previews, payloads, and decision bodies) is in `frontend/src/features/community/genres.js`, and the styles are in `Components/Community/GenreSuggestion.css`.

- **Album page:**
  - The Genres tab contains the genre chips (primary genre filled), the suggestion action, and any pending/revision notice. Each chip links to `/genre/:slug`; untagged albums show “No genres yet.” The tab is absent when genres are disabled.
  - Signed-in users get a "Suggest genres" action inside that tab; signed-out users get the sign-in prompt. The album tab bar supports Left/Right, Home/End, and Tab keyboard navigation, including on the album reviews route.
  - If the viewer has an open genre suggestion for the album (`GET /suggestions/genres/open`), the action is hidden. A note links to the suggestion, or to "Revise it" when a moderator asked for changes.
- **Suggestion form:** `/suggestions/genres/:albumId`, and `/suggestions/:submissionId/revise` for a genre suggestion, both use `GenreSuggestionForm`. A contributor can:
  - mark current genres for removal
  - search and add existing genres (an alias match shows "also called …")
  - propose up to 2 new names, each with an optional broader genre from `GET /genres`
  - pick the primary genre from an "after approval, N of 5" preview
  - add a note

  Revising starts from the stored suggestion, checked against the album's genres now. After sending, the confirmation names any proposed name that turned out to be an existing genre.
- **Suggestion details:** these show the proposed genre changes and each revision's changes in place of release metadata and evidence. Approval events show a one-line summary of what was applied.
- **Genre page:** `/genre/:slug` (`Pages/GenrePage.jsx`) shows the name, alternative names, a link to the broader genre, and sub-genre links. It has the two sort orders, an "Include sub-genres" toggle, a "Show more albums" button, and a search box that opens `/search?q=…&genre=<slug>`. An alias or old slug redirects to the current slug.
- **Search page:** with `genre` set, it says which genre results are limited to, offers "Search all genres", and skips external candidates.
- **Stats tab:** shows "Top genres" with links to each genre page.
- **Moderation:**
  - The queue has a "Genre suggestions" filter.
  - Genre suggestions use `GenreModeratorDecision`: approve, request changes, or reject (no duplicate marking).
  - Approving shows a checkbox per proposed addition, removal, and primary change.
  - Each new name can be created (spelling and parent editable), mapped onto a candidate from `genreReview` or a searched genre (optionally keeping the proposed spelling as an alias), or skipped.
  - A note appears when the album's genres changed after the suggestion, and a preview shows the resulting genres.
  - A new name defaults to mapping when a candidate is an exact or close-spelling match, and to creating otherwise.

## Tests

- `tests/genreBrowse.integration.test.js` covers the rating and recent orders, sub-genres, paging through both cursors, cursor and query validation, alias slugs, the search filter (including the disabled flag), and `topGenres`.

- `tests/genreVocabulary.test.js` covers command and merge-argument validation.
- `tests/genreVocabulary.integration.test.js` covers moderator access and flags, rename with alias promotion and slug redirects, name conflicts, stale revisions, parents and sub-genres, retire and restore, and a merge from dry run to apply (checksum refusal, remapping, alias transfer, and refusing to re-apply the same plan).

- `tests/genreApproval.test.js` covers the decision rules and the candidate matching.
- `tests/genreApproval.integration.test.js` covers the approval end to end: applying and retrying idempotently; creating and mapping with aliases; rollback on a name conflict; operations against a changed album; no-op approvals; concurrent approvals on one album; the cap, retired genres, and bad decisions; the public feed; and a correction keeping genre provenance.

- `tests/genreSuggestions.test.js` covers the request shape, alias resolution, references, limits, the stored and serialized shape, and the model's type rules.
- `tests/genreSuggestions.integration.test.js` (in `npm run test:integration`) covers the routes end to end: the open-suggestion slot under concurrent creates, flags, revise with re-baselining, reject and withdraw freeing the slot, the new-name allowance, the queue filter, and the refused approval.

- `tests/genres.test.js` covers name rules, the album model's limits, dataset validation and checksums, seed planning, CLI argument rules, and the disabled flag.
- `tests/genres.integration.test.js` (in `npm run test:integration`) covers dry run versus apply, checksum enforcement, idempotent re-runs, conflict rollback, search, detail, alias slugs, retired genres, and album detail.
