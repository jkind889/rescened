# Community genres

Albums carry a small, ordered set of genres from a vocabulary that the community grows and moderators approve. The design and its remaining rollout slices are in [plan 3 of the feature plans](NEXT_FEATURE_PLANS.md#3-community-genres). This guide is the maintained contract for what is built.

Built so far: slice 1. That covers the vocabulary model, the seed import, the read endpoints, and the album chips. Contributor suggestions, moderator approval, vocabulary commands, browsing, and the search filter are not built yet, so the only way genres reach an album today is a direct database write in a test.

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
- **`npm run check:catalog-contract` fails** if a file outside `models/AlbumCatalog.js` and `lib/genres/` mentions `genresRevision`, writes `genres` with an update operator, or sets `fieldProvenance.genres`.

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

## Frontend

The album page renders `album.genres` as chips under the title line, with the primary genre highlighted. The chips aren't links yet: `/genre/:slug` arrives with the browse page in slice 6.

## Tests

- `tests/genres.test.js` covers name rules, the album model's limits, dataset validation and checksums, seed planning, CLI argument rules, and the disabled flag.
- `tests/genres.integration.test.js` (in `npm run test:integration`) covers dry run versus apply, checksum enforcement, idempotent re-runs, conflict rollback, search, detail, alias slugs, retired genres, and album detail.
