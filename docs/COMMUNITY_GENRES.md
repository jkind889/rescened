# Community genres

Albums carry a small, ordered set of genres from a vocabulary that the community grows and moderators approve. The design and its remaining rollout slices are in [plan 3 of the feature plans](NEXT_FEATURE_PLANS.md#3-community-genres). This guide is the maintained contract for what is built.

Built so far:

- **Slice 1:** the vocabulary model, the seed import, the read endpoints, and the album chips.
- **Slice 2:** contributor genre suggestions through the API. See [Genre suggestions](#genre-suggestions).

Moderator approval, the suggestion and review UI, vocabulary commands, browsing, and the search filter are not built yet. Moderators can request changes on or reject a genre suggestion, but approving one returns `503 GENRE_APPROVAL_UNAVAILABLE`, so nothing changes an album's genres yet.

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
| `status` | `active` or `retired`. Retired genres are hidden from search, detail, children lists, and album chips, but stay referenced by albums until a reviewed merge remaps them. |
| `kind` | Always `genre` in version 1. It is reserved so descriptors can reuse the pipeline later. |
| `origin` | `{ source: "seed" \| "community", datasetId, submissionId }`. |

`GenreEvent` is the append-only vocabulary audit: `genre`, `genreId`, `action` (`create`, `rename`, `alias_add`, `reparent`, `retire`, `merge`), `actorUserId`, `reason`, `before`, `after`, `datasetId`, `datasetSha256`, `submissionId`, and `createdAt`. Nothing updates or deletes these records. The seed writes one `create` event per genre, with actor `operator:genres-import`.

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

## Endpoints

All of these are public, read-only, and return `503 GENRES_DISABLED` while the flag is off.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/genres/search?q=` | Up to 10 active genres whose name or alias starts with the query, or has a word that starts with it. Ranking: exact name, exact alias, name prefix, then word match, alphabetical within each group. A result found through an alias carries `matchedAlias`. An empty query returns `[]`. Uses the IP `search` rate limit. |
| `GET` | `/genres/:slug` | `{ genre, canonical, aliases, parent, children, albumCount }`. Resolves current slugs and alias slugs; `canonical: false` means the client should switch to `genre.slug`. Retired or unknown genres return `404 GENRE_NOT_FOUND`. `albumCount` counts albums tagged with this genre directly, not its children. |
| `GET` | `/albums/album/:albumId` | Adds `genres: [{ genreId, slug, name }]` in stored order (primary first), with retired genres omitted. |

Genre objects are always `{ genreId, slug, name }`.

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
- **The album can end with at most 5 genres** (`409 GENRE_LIMIT_EXCEEDED`). A suggestion can swap genres by removing some while adding others.
- **One open suggestion per user per album** (`409 GENRE_SUGGESTION_EXISTS`). The submission stores `openGenreSuggestionKey` (`<userId>:<album _id>`) under a unique sparse index while the suggestion is pending or needs changes. Withdrawal, rejection, and (later) approval unset it, so two simultaneous creates can't both succeed.

### Stored value

Each revision stores:

- **`genreBaseline`:** the album's genres as `{ genreId, slug, name }` snapshots, plus its `genresRevision`, at submission time.
- **`genreChanges`:** `additions` (each `{ genre }` or `{ newGenre: { name, normalizedName, slug, parent } }`), `removals`, `primary` (`{ genre }` or `{ addIndex }`), and `note`.

The stored lists are named `additions` and `removals`, because Mongoose reserves `remove`. Responses use `add` and `remove`, matching the request.

Responses add `baseGenres` and `genreChanges: { add, remove, primary, note }`, built from those genre snapshots, which keep the names as they were at submission. They never include Mongo IDs, the album's `genresRevision`, or `openGenreSuggestionKey`.

## Frontend

The album page renders `album.genres` as chips under the title line, with the primary genre highlighted. The chips aren't links yet: `/genre/:slug` arrives with the browse page in slice 6.

## Tests

- `tests/genreSuggestions.test.js` covers the request shape, alias resolution, references, limits, the stored and serialized shape, and the model's type rules.
- `tests/genreSuggestions.integration.test.js` (in `npm run test:integration`) covers the routes end to end: the open-suggestion slot under concurrent creates, flags, revise with re-baselining, reject and withdraw freeing the slot, the new-name allowance, the queue filter, and the refused approval.

- `tests/genres.test.js` covers name rules, the album model's limits, dataset validation and checksums, seed planning, CLI argument rules, and the disabled flag.
- `tests/genres.integration.test.js` (in `npm run test:integration`) covers dry run versus apply, checksum enforcement, idempotent re-runs, conflict rollback, search, detail, alias slugs, retired genres, and album detail.
