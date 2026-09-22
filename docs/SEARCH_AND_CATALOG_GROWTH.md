# External Search Fallback and Incremental Catalog Growth

Status: Proposed implementation scope

Last reviewed: 2026-09-06

This document defines the smallest useful search fallback and recurring catalog-growth plan for Rescened. The local `AlbumCatalog` remains the authoritative public catalog. MusicBrainz supplies read-only discovery candidates alongside page-one local search results, while the existing community-approval and dataset-import workflows remain the only ways an album becomes public.

The design deliberately favors a few explicit modules over a general provider platform. A second external provider, distributed job system, or fully automated production importer should be justified by observed usage before it is added.

## Decision summary

- Search the local catalog first.
- Use MusicBrainz release-group search for every valid page-one full-results query.
- Keep navbar suggestions and profile album pickers local-only.
- Return MusicBrainz matches as external candidates without a Rescened `albumId`.
- Let a candidate prefill the existing community-suggestion form; search itself never writes catalog data.
- Continue growing the broad catalog through dated, validated, idempotent import datasets.
- Begin recurring imports as an operator-reviewed process. Automate production application only after repeated clean runs.
- Use the existing submission queue for user-requested long-tail albums rather than adding a separate demand-tracking collection.

The resulting flow is:

```text
local search
  -> render normal catalog albums
  -> page 1: query MusicBrainz and append discovery results
       -> existing MBID: render the matching local album when it is not already shown
       -> new MBID: render an external candidate
            -> contributor suggestion
                 -> moderator approval
                      -> public AlbumCatalog record

recurring datasets
  -> validate and dry-run
       -> operator-reviewed import
            -> broader local catalog and fewer external misses
```

## Local search relevance (2.0)

The `2.0` implementation uses the existing `/search/search` endpoint for both navbar autocomplete and paginated results. It matches the normalized phrase across title, display artist, artist credits, and label. Queries with 2–12 distinct space-separated tokens additionally match when every token occurs in the same album's title or artist fields, in any order. For example, `Daft Punk Discovery` and `Discovery Daft Punk` can both find *Discovery*. Longer queries retain phrase matching. Label discovery remains phrase-based.

Matching ignores case, normalizes query whitespace and canonical Unicode, treats straight/curly apostrophes equivalently, and folds common Latin accents (Latin-1 and Latin Extended-A/B), including decomposed accents in stored Latin text. `bjork` can find Björk. It preserves literal regex punctuation and non-Latin scripts; it does not provide typo correction or transliteration.

Reviewed whole-query artist preferences live in `routes/utils/searchArtistAliases.js`: `ye` / `Kanye West` find records credited to either name; `Travis` prioritizes Travis Scott; `Pierre`, `Pierre Bourne`, `Pi'erre`, and `Pi'erre Bourne` prioritize Pi’erre Bourne (including straight/curly/no-apostrophe catalog spellings). These matches rank before ordinary exact matches, while alternative text matches remain available. Expansion applies only to exact display-artist or credited-artist names, never labels or titles. Explicit queries such as `Travis Barker` and `Pierre Henry` keep their own results. Aliases require a complete normalized query, so `yellow` does not activate `ye`, and mixed inputs such as `ye graduation` continue to use ordinary token matching. The table is a small curated set, not a popularity score, catalog rename, or general artist-identity database. Add aliases with competing-artist regression cases; the separate real-route alias suite preserves the original 30-query baseline.

Results rank by exact artist/display credit, exact title, exact label, partial title/artist phrase, then other matches. Artist, title, and immutable public `albumId` break ties. The artist-first choice for ambiguous names such as `Air` is a product rule to revisit with actual usage, not a universal interpretation of intent. Label-intent collisions remain an evaluation limitation.

MongoDB performs matching, ranking, sorting, and pagination before the API serializes public catalog fields. Both response shapes and the one-extra-row next-page check remain unchanged. The alphabetic `/albums/catalog` browse endpoint retains its existing phrase matcher. No schema migration, catalog writes, frontend deployment change, or provider request is required for local ranking.

The unchanged 30-query corpus and historical baseline remain the comparison source. Run `npm run search:evaluate -- --compare benchmarks/search-quality/baseline.json`; retain the generated report under `.benchmarks/search-quality/`. Run the normal tests, MongoDB integration suite, and catalog contract check before release. Relevance measurements on this synthetic set do not establish production accuracy or latency. The computed sort adds database work; new capacity measurements are required before reusing earlier performance claims.

## Goals

- Avoid a dead end when the initial catalog does not contain an album.
- Preserve Rescened-owned UUIDs and the current catalog trust boundary.
- Reuse MusicBrainz identity, release-type mapping, Cover Art Archive behavior, community submissions, and catalog imports already present in the repository.
- Keep provider latency and outages isolated from local search.
- Grow the catalog cumulatively without duplicating albums or replacing community-owned metadata.
- Make the first implementation safe to deploy on one API instance without adding infrastructure.

## Non-goals

The first version does not include:

- Automatic insertion of every external search result into `AlbumCatalog`.
- External calls from search-as-you-type suggestions or profile editors.
- Multiple external providers or cross-provider ranking.
- A generic provider registry, plugin interface, or provider-agnostic query language.
- Redis, a message queue, a distributed rate limiter, or background workers.
- A local mirror of the full MusicBrainz database.
- Tracklist or label hydration during interactive search.
- Search-query analytics, user-level search history, or a new demand-signal collection.
- Automatic production import immediately after dataset generation.
- Live provider calls in the normal test suite.

Discogs, Apple Music, TheAudioDB, and other providers remain deferred. MusicBrainz already matches the repository's identity and provenance model; another provider should be considered only after real misses show a repeatable MusicBrainz coverage problem.

## Current baseline

| Area | Current behavior | Relevant implementation |
| --- | --- | --- |
| Local search | Ranked phrase and mixed title/artist matching with common Latin accent folding, equivalent apostrophes, and a maximum page size of 24; see the 2.0 section above. | `routes/search.js` |
| Public album identity | Every usable public album has a Rescened UUID v4; MongoDB IDs stay internal. | `models/AlbumCatalog.js`, `routes/utils/albumCatalog.js` |
| Search UI | Suggestions and local catalog cards use Rescened `albumId` values; external candidates use provider identities and remain separate. | `frontend/src/Components/Searchbar.jsx`, `frontend/src/Pages/SearchResults.jsx` |
| Community publication | A pending suggestion is not public. Moderator approval links or creates the catalog record. | `routes/suggestions.js`, `routes/utils/approval.js` |
| Broad catalog import | A dated ListenBrainz selection is hydrated from MusicBrainz, validated, and imported transactionally. | `lib/catalogImport/`, `scripts/fetchListenBrainzCatalog.js`, `scripts/importCatalogDataset.js` |
| Cover art | Exact MusicBrainz identities can resolve to hotlinked Cover Art Archive images. | `lib/coverArtArchive.js` |

The old Spotify fallback cannot be copied directly. It filled local-result gaps with provider results and wrote those results into the catalog. That would now bypass community moderation, assign catalog status during a read request, and make provider availability part of the public identity path.

### Local search scalability

The catalog model already defines a text index, while the 2.0 route uses unanchored regex matching and a computed relevance sort. A larger catalog may make this query slower. The historical fallback release retained alphabetic ordering; the 2.0 relevance work is a separate change.

Capture catalog size, search latency, and representative query results as imports accumulate. Move to text-score ranking, Atlas Search, or another indexed strategy only through a separate measured change; external discovery does not require that redesign.

## Product behavior

### Local results remain primary

`GET /search/search` keeps its current catalog-only contract. Existing consumers do not receive mixed local and external records.

- Navbar autocomplete continues to return up to five local albums.
- The profile editor continues to offer only albums that can be saved by Rescened `albumId`.
- The full results page requests up to 12 external candidates for every valid page-one query, after the local page has loaded.
- Later pages never trigger external search.

Keeping the existing route local-only avoids adding result-type branches to every current search consumer.

### External candidate state

When local results are empty, the page shows a separate state such as:

> No albums in Rescened matched this search. These MusicBrainz results are not in the catalog yet.

Each candidate may show:

- Representative cover or the existing cover placeholder.
- Album title.
- Credited artist display name.
- First release year when available.
- Release type.
- A visible `Not in Rescened` label.
- A `Suggest this album` action.

An external candidate must not link to `/album/:albumId`, appear saveable or reviewable, or use an upstream identifier in the `albumId` field.

When local results exist, the same external sections append below the local catalog cards. The empty-local introduction is omitted in that case. Catalog identities already displayed in the local results are deduplicated from the appended known-identity section. A provider empty or unavailable message remains visible below usable local results.

### Candidate selection

`Suggest this album` opens `/suggestions/new` with the MusicBrainz release-group MBID. The editor requests one normalized draft from the API and initializes the existing form with:

- Title and artist credits.
- Artist display name.
- Release type.
- First release date, precision, and year when available.
- A canonical MusicBrainz supporting source.
- A `musicbrainz` / `release-group` external reference.

Tracks, label, country, catalog number, and barcode remain empty unless a later dedicated source supplies them. A missing release date or other required submission field remains visible for the contributor to complete. The user reviews and submits the normal form; selecting a result does not create a submission automatically.

The existing submission validation, duplicate detection, rate limits, privacy rules, and moderator workflow remain authoritative. Approval remains the point where a public Rescened UUID is linked or created.

### Failure behavior

- A MusicBrainz timeout, rate limit, malformed response, or outage never turns a completed local search into a server error.
- Because the external endpoint is separate, the results page can retain its normal empty state and add a short `External results are temporarily unavailable` message.
- Broken or missing Cover Art Archive thumbnails fall back to the existing placeholder.
- The UI does not retry automatically in a loop. A user-initiated retry is sufficient for the first version.

## HTTP boundaries

### Search candidates

Add a public, read-only endpoint:

```http
GET /search/external?q={query}&limit={limit}
```

Rules:

- Trim and normalize whitespace before cache lookup.
- Require a small non-empty query and enforce the same bounded string length used by the server adapter.
- Default to 12 results and cap the requested limit at 12, shared across `catalogMatches` and `candidates`. Retrieve an internal pool of 50 MusicBrainz candidates before applying this public limit.
- Search MusicBrainz release groups, not individual releases.
- Use core MusicBrainz fields only: identity, title, artist credits, first release date, and release-group types.
- Rank by title/artist relevance, then upstream score and provider position; deduplicate by release-group MBID before applying the public limit. See the relevance rules below.
- Query `AlbumCatalog.externalReferences` for returned MBIDs. Move known identities into `catalogMatches` and remove them from `candidates`.
- Never mutate MongoDB.

Example response:

```json
{
  "query": "imaginal disk",
  "provider": "musicbrainz",
  "catalogMatches": [],
  "candidates": [
    {
      "kind": "external",
      "provider": "musicbrainz",
      "entityType": "release-group",
      "externalId": "00000000-0000-0000-0000-000000000000",
      "title": "Imaginal Disk",
      "artistDisplayName": "Magdalena Bay",
      "artistCredits": [
        {
          "name": "Magdalena Bay",
          "role": "main"
        }
      ],
      "releaseType": "album",
      "releaseDate": "2024-08-23",
      "releaseDatePrecision": "day",
      "releaseYear": 2024,
      "cover": "https://coverartarchive.org/release-group/00000000-0000-0000-0000-000000000000/front-250",
      "sourceUrl": "https://musicbrainz.org/release-group/00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

`catalogMatches` uses the existing normalized catalog-album representation and therefore contains valid Rescened `albumId` values. The response does not expose provider scores; ranking is an implementation detail.

### External search relevance

Each uncached query generates one structured MusicBrainz release-group search, requesting 50 rows. Full-query phrases search `releasegroup`, `artistname`, `artist`, and `alias` with boosts of 8, 4, 4, and 2 respectively. An additional clause requires every normalized query token to occur in at least one of those fields. This lets artist and title terms occur together in either order without guessing a split, for example `Magdalena Bay Imaginal Disk`.

All user-derived phrases and tokens are individually escaped and quoted; only application-generated syntax controls fields, operators, and boosts. The 200-character input limit remains unchanged. There are no fuzzy queries, artist-resolution calls, or type/status filters.

Valid candidates are ordered by these tiers:

1. Exact normalized album title.
2. Exact normalized combined artist display name or individual credited/canonical artist name.
3. Every query token occurs across title and artist fields as a whole token.
4. Remaining provider matches, including alias-only matches.

Within a tier, descending MusicBrainz score wins, then original provider position. Missing or invalid scores are zero; valid scores are finite numbers or decimal numeric strings between 0 and 100. Matching normalizes Unicode decomposition/diacritics, case, punctuation (including apostrophe variants), and whitespace consistently. Empty normalized text cannot qualify for an exact or token-coverage tier. Display metadata is preserved, and canonical artist names used for comparison remain internal.

The complete ranked pool is deduplicated by release-group MBID, cached independently of the requested display limit, and sliced to at most 12 results before catalog reconciliation. Known identities move into `catalogMatches`; reconciliation does not fetch replacement candidates. Existing request coalescing, cache bounds/TTL, timeout, zero retries, shared request gate, and external-search flag remain in effect. Local catalog search, frontend contracts, and catalog persistence are unchanged.

Deterministic regressions cover these rules in this release. Broad empirical relevance improvements remain unmeasured until the post-deployment evaluation described below.

### Suggestion draft lookup

Add a second read-only endpoint for durable prefill links:

```http
GET /search/musicbrainz/release-group/:mbid
```

Rules:

- Reject an invalid MBID before making a provider call.
- Return the existing catalog album if its release-group MBID is already known locally.
- Otherwise look up and normalize the release group into the existing suggestion input shape.
- Include the canonical MusicBrainz source and external reference.
- Do not create a submission or catalog record.
- Leave `coverSourceUrl` empty; approval can use the existing identity-based Cover Art Archive resolver.

This endpoint avoids putting a full metadata payload into query parameters or trusting client navigation state after a reload.

### Errors and feature flag

See the [central error and status code reference](./ERROR_CODES.md) for the complete public and internal provider-code vocabulary.

Add a server-only flag:

```dotenv
EXTERNAL_ALBUM_SEARCH_ENABLED=true
```

When disabled, both external endpoints return `503` with a stable `EXTERNAL_SEARCH_DISABLED` code. The frontend treats that response as an unavailable optional enhancement, not as a failure of local search.

Expected error classes are:

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `INVALID_EXTERNAL_SEARCH` | Invalid query, limit, or MBID. |
| `429` | `RATE_LIMITED` | The Rescened external-search limit was exceeded. |
| `502` | `EXTERNAL_SEARCH_UNAVAILABLE` | MusicBrainz failed, timed out, or returned an invalid response. |
| `503` | `EXTERNAL_SEARCH_DISABLED` | The feature flag is off. |

## Module boundaries

### Provider adapter

Add one focused module, for example `lib/musicBrainzSearch.js`. It owns:

- Query normalization and MusicBrainz search URL construction.
- Lucene-special-character escaping.
- Release-group search and exact release-group lookup.
- Identifying `User-Agent` behavior.
- Response validation.
- Mapping MusicBrainz data to provider-neutral candidate and suggestion-draft shapes.
- Release-type and partial-date normalization consistent with catalog import.
- One process-wide MusicBrainz request gate.
- A bounded in-memory query cache and in-flight request deduplication.

Do not introduce a base provider class or provider registry. If a second provider is approved later, the shared behavior can be extracted from two concrete implementations rather than predicted now.

The adapter may duplicate a small amount of proven request or rate-gate logic from the offline importer. Refactoring all existing MusicBrainz clients into one abstraction is deferred because it expands the change surface without improving the first release.

### Search route

Keep the two external endpoints in `routes/search.js`. The route owns:

- HTTP query and parameter validation.
- Feature-flag enforcement.
- Rescened rate-limit middleware.
- Catalog reconciliation by MusicBrainz external reference.
- Public response and error serialization.

It does not own provider response parsing or suggestion-form mapping.

### Frontend

Keep orchestration in `frontend/src/Pages/SearchResults.jsx`:

1. Fetch the normal local page.
2. If page 1 is empty, fetch `/search/external` with the same abort lifecycle.
3. Render returned `catalogMatches` as normal album cards.
4. Render remaining candidates in a clearly separate section.

A small `ExternalAlbumCard` component is reasonable if it keeps candidate-only behavior out of the normal catalog card. No new search state library or data-fetching dependency is required.

`frontend/src/Pages/SuggestionEditor.jsx` reads the MBID query parameter, loads the suggestion draft, and passes it through the form's existing `initialValue` boundary. The current form and submission request remain unchanged.

### Rate limiting and cache

MusicBrainz requires an identifying user agent and no more than one request per second per application. The first implementation should use:

- `MUSICBRAINZ_USER_AGENT`, falling back to the repository's existing identifying value.
- One module-level gate with at least 1,100 milliseconds between upstream request starts.
- One short interactive timeout.
- No automatic retry in the user request path.
- A normalized-query in-memory cache with a short TTL and fixed maximum entry count.
- In-flight deduplication so simultaneous identical misses share one upstream promise.
- A stricter external-search limiter in `routes/utils/rateLimit.js`, separate from ordinary local search.

This is intentionally a single-instance design. Before running multiple API instances, replace the process-local upstream gate and cache with a shared mechanism or use an appropriate MetaBrainz service plan. Do not add that infrastructure preemptively.

## Incremental catalog growth

### Keep imports artifact-driven

"Recurring" means producing and reviewing dated batches, not writing to production continuously from search traffic.

Every broad import continues to follow the existing workflow:

1. Generate a dated dataset and fetch report.
2. Validate its schema and semantic rules.
3. Run a database-aware dry-run.
4. Review inserted, refreshed, unchanged, quarantined, and conflicting counts.
5. Apply the exact reviewed artifact transactionally.
6. Retain the dataset checksum and reports.
7. Smoke-test catalog search and album actions.

The importer already provides the desired persistence behavior:

- Match by MusicBrainz release-group identity.
- Preserve an existing Rescened UUID.
- Insert new rows as `catalogSource: "import"`.
- Avoid overwriting manual or community-owned fields.
- Never delete an album merely because it is absent from a later dataset.

### Growth versus refresh

The current default dataset selects 500 albums from fixed ListenBrainz all-time, year, and month pools. Repeating that exact selection will increasingly refresh existing records instead of adding new ones.

Use this progression:

1. Run updated dated datasets manually and measure their inserted-to-unchanged ratio.
2. Increase or rotate the existing ListenBrainz selection within its supported candidate ranges before adding another source.
3. Let MusicBrainz-backed community suggestions cover user-requested long-tail albums.
4. Add a known-MBID exclusion manifest to dataset generation only when repeated hydration of existing rows becomes a measurable cost.
5. Consider a recent-release-specific input only after the year/month ranges prove insufficient.

Do not add a search-demand collection in the first version. Approved suggestions already convert user demand into catalog growth with provenance and moderation. Aggregate miss telemetry can be designed later if the moderation queue does not provide enough signal.

### Scheduling

Start with an operator-owned cadence, such as weekly or biweekly. Run at least three clean, reviewed production batches before automating any part of the workflow.

The first useful automation may generate, validate, and dry-run an artifact, then stop for operator review. Production `--apply` remains explicit. Fully unattended imports are deferred until alerting, artifact retention, transaction behavior, and rollback expectations have been exercised in production.

## Data, licensing, and privacy boundaries

- Interactive search imports only MusicBrainz core metadata. Do not add tags, genres, ratings, or annotations through this feature.
- MusicBrainz core metadata is CC0, but use of the hosted API remains subject to MetaBrainz service terms and rate limits. Confirm the appropriate service tier before enabling a revenue-generating public product.
- Cover Art Archive images are hotlinked and remain subject to image-specific rights. A successful URL does not grant Rescened a copyright license.
- External search does not store raw queries in the first version.
- Server logs should avoid user IDs, authorization headers, cookies, and full upstream response bodies.
- External candidates do not become public Rescened records until an existing publication workflow accepts them.

Official references:

- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API)
- [MusicBrainz release-group search](https://musicbrainz.org/doc/MusicBrainz_API/Search)
- [MusicBrainz data license](https://musicbrainz.org/doc/About/Data_License)
- [Cover Art Archive API](https://musicbrainz.org/doc/Cover_Art_Archive/API)
- [MetaBrainz service tiers](https://metabrainz.org/supporters/account-type)

## Implementation sequence

### Slice 1: server adapter and read API

- Add the MusicBrainz adapter, mapping, cache, request gate, and tests.
- Add feature-flag parsing and external-search rate limiting.
- Add candidate search and exact draft endpoints.
- Reconcile candidate MBIDs against the local catalog.
- Verify that provider failures do not affect the existing local endpoint.

### Slice 2: results UI and suggestion prefill

- Fetch candidates only after a page-1 local miss.
- Render catalog matches and external candidates distinctly.
- Handle missing artwork and optional provider failure.
- Load a candidate draft into the existing suggestion editor.
- Confirm that an external candidate cannot be saved, reviewed, liked, or opened as a public album.

### Slice 3: recurring catalog batches

- Produce and review new dated datasets using the current pipeline.
- Record inserted, unchanged, quarantined, and conflicting ratios across runs.
- Adjust existing selection ranges only when the reports show a need.
- Document the chosen operator cadence in `CATALOG_IMPORT.md` after it has been exercised.

### Slice 4: evidence-based follow-up

Only after launch data exists, decide whether to add:

- A known-MBID exclusion manifest.
- A recent-release-specific dataset input.
- Shared cache/rate-limit infrastructure for multiple API instances.
- External-search telemetry.
- A measured local-search indexing or relevance change if catalog growth makes the current regex query inadequate.
- Another provider for a demonstrated coverage gap.
- Automated production import application.

## Expected file changes

| File | Expected responsibility |
| --- | --- |
| `lib/musicBrainzSearch.js` | Provider requests, mapping, caching, and upstream request pacing. |
| `routes/search.js` | External endpoints, catalog reconciliation, flag, and response boundary. |
| `routes/utils/rateLimit.js` | External-search request limit. |
| `frontend/src/Pages/SearchResults.jsx` | Page-one local orchestration and appended external results state. |
| `frontend/src/Components/ExternalAlbumCard.jsx` | Optional candidate-only presentation and suggestion link. |
| `frontend/src/Pages/SuggestionEditor.jsx` | MBID draft loading and existing form initialization. |
| `tests/musicBrainzSearch.test.js` | Captured-response mapping, cache, rate, timeout, and invalid-response tests. |
| `tests/search.test.js` | Route contracts, local reconciliation, disabled flag, and provider-failure tests. |

The first two slices should not require a new production dependency, schema migration, database model, background service, or frontend state library.

## Acceptance criteria

### Search

- Every valid page-one full-results query can return bounded MusicBrainz release-group candidates, whether or not local albums match.
- Navbar suggestions, profile album selection, and later result pages never call external search.
- Local catalog cards render before appended MusicBrainz sections and remain usable while optional external search loads or fails.
- External results use `externalId`, never a fabricated Rescened `albumId`.
- A catalog identity already displayed in the local page is not rendered a second time in the appended known-identity section.
- A returned MBID already present in the catalog becomes a normal catalog match rather than a duplicate candidate.
- Repeated normalized queries use the bounded cache.
- Simultaneous identical queries share one upstream request.
- Upstream requests respect the application pacing rule.
- An upstream failure leaves local search usable and reports the optional external failure beneath it.
- Disabling the feature requires no frontend rollback.
- No search request creates or updates `AlbumCatalog` or `AlbumSubmission`.

### Suggestions

- Selecting a candidate loads an editable draft with MusicBrainz evidence and identity.
- The user must explicitly submit the existing form.
- Server validation and duplicate detection still run normally.
- Approval still links or creates the catalog album transactionally.
- Rejection, withdrawal, and change requests behave exactly as documented for community submissions.

### Catalog growth

- Reimporting a MusicBrainz release-group identity preserves its Rescened UUID.
- Dataset imports remain validate-first, dry-run-first, report-producing, and transactional.
- Existing manual and community provenance remains protected.
- A later dataset never deletes an album simply by omission.
- Normal tests use checked-in fixtures and require no internet access.

## Explicitly deferred

Do not build these as part of the initial feature:

- Spotify-compatible write-through caching.
- Multi-provider aggregation or fallback chains.
- Popularity enrichment and systematic relevance evaluation, scoped below for post-deployment work.
- A permanent external-candidate database.
- One-click submission or approval.
- Tracklist hydration for every search card.
- Cover-image proxying, downloading, or rehosting.
- Shared infrastructure for hypothetical horizontal scale.
- A scheduler that applies unreviewed datasets to production.
- Search personalization or recommendation logic.

These constraints are part of the design, not missing work. They keep external discovery replaceable, catalog publication auditable, and the first release small enough to verify thoroughly.

### Post-deployment follow-up 3: ListenBrainz popularity enrichment

**Not implemented in this release.** Batch candidate release-group MBIDs through [ListenBrainz's release-group popularity endpoint](https://listenbrainz.readthedocs.io/en/latest/users/api/popularity.html). Evaluate unique-listener counts as the primary popularity signal and play counts as secondary. Popularity must have bounded influence within comparable relevance groups, so it cannot displace a stronger title/artist match.

The follow-up requires server-side caching, a disabled-by-default feature flag, bounded requests, and unchanged text ranking when counts are missing or enrichment fails. It excludes MusicBrainz ratings, public popularity badges, and catalog persistence. Choose weights using the evaluation below; none are specified or applied by this release.

### Post-deployment follow-up 4: Relevance evaluation

**Not implemented in this release.** Build a reviewed query set with expected release-group MBIDs covering titles, artists, mixed input, ambiguous names, punctuation, non-Latin text, obscure releases, and specifically requested singles/live releases. Compare the previous plain-title search and 12-row retrieval, the current 50-row structured search and reranking, and later popularity enrichment.

Measure top-result accuracy, top-12 coverage, reciprocal rank, latency, and provider request count. Retain sufficiently broad captured responses for each retrieval strategy so offline comparisons do not mistake absent baseline candidates for ranking failures; record source, capture date, and fixture licensing. Live captures require explicit authorization. Use the results to set improvement thresholds and tune ranking. Search-query history collection and personalized ranking remain outside scope. This evaluation does not replace the deterministic adapter and route regression tests required for this release.
