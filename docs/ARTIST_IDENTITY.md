# Artist identity (phase 1)

Last reviewed: 2026-11-11

Phase 1 gives artists stable public Rescened IDs and keeps MusicBrainz artist IDs on album credits. A flagged [artist pages prototype](#artist-pages-prototype) builds on it with local artist pages, credit links, and multilingual search aliases, and a separately flagged [MusicBrainz discography](#musicbrainz-discography-prototype). There are still no biographies, artist images, or merges. Listening stats still group top artists by display name.

## Data contract

### Artist registry

`models/Artist.js` stores one registry row per known artist:

| Field | Meaning |
| --- | --- |
| `artistId` | Public, immutable, random UUID v4. It is never derived from a provider ID. |
| `name` | The verified MusicBrainz artist name when available, otherwise a provisional credited name. Album credits always keep their own wording. |
| `externalReferences` | At most one `musicbrainz` / `artist` reference. A unique partial index allows only one registry artist per MusicBrainz MBID. |
| `fieldProvenance` | Where the registration came from: a dataset and release group, an approved submission, or the backfill plan. |
| `artistSource` | `import`, `community`, or `manual`. |

Mongo `_id` stays internal. The only public registry endpoints are the flagged [artist pages](#artist-pages-prototype).

### Album credits

`AlbumCatalog.artistCredits[]` keeps `name` and `role` and their order. Each credit may also carry:

- `artistId`: the registry artist's public ID.
- `artistMbid`: the MusicBrainz artist MBID.

Both keys are left out, not blank, until an identity is established. A catalog credit with an `artistMbid` must also carry its registry `artistId`; the model rejects an MBID on its own. A name never links a credit: name-only credits stay unlinked until an import, an approved suggestion, or the backfill supplies an MBID or an existing `artistId`.

Catalog responses pass these keys through on `artistCredits`, so album-bearing responses expose `artistId` and, where known, `artistMbid` beside each credit name. Join phrases are not stored on credits. `artistDisplayName` still holds the full credited string.

## Write paths

### Catalog import

`npm run catalog:import` resolves every dataset credit's `artistMbid` through the registry during preflight. Newly fetched datasets retain the underlying MusicBrainz `artist.name` as optional `artistName`, separately from the credited `name`. New registrations use that verified name with `nameSource: "musicbrainz-artist"`; old datasets without it retain provisional `nameSource: "artist-credit"`. Conflicting canonical names for one MBID stop import preflight. A known MBID reuses its `artistId` without silently renaming it. An unknown MBID gets one planned registration (`artistSource: "import"`), shared by every row that credits it. Registrations are inserted first, in the same transaction as the catalog writes, so a concurrent registration of the same MBID rolls the whole import back. Only artists credited by inserted or refreshed rows are registered. Quarantined rows and preserved credits do not register artists.

The import report includes `artistRegistry: { registered, reused }`. Re-importing the same dataset is idempotent. Before `--apply`, the CLI builds the registry's unique MusicBrainz index.

**Rollout order matters.** The first import after this change would refresh every previously imported row, because its credits gain identities. An import refresh advances `catalogRevision` without carrying reviewed baselines or active Last.fm mappings forward, so those would go stale, and pending corrections would fail with `CATALOG_CHANGED`. To avoid that, run the [backfill](#backfill) first, against the same datasets. The backfill carries baselines and mappings forward. The import merge also keeps the backfill's `fieldProvenance.artistIdentity` while credit identities are unchanged, so a later re-import of the same dataset reports those albums as `unchanged`.

### Suggestions and corrections

New-album suggestions, revisions, and artist corrections accept optional `artistId` and `artistMbid` on each credit. The server validates their formats and lowercases them. Blank strings are treated as absent. On submission and revision, a supplied `artistId` must exist, and if the credit also has an `artistMbid`, it must match the artist's registered MBID. Otherwise the request fails with `400 INVALID_SUBMISSION`. An MBID the registry has not seen yet is accepted.

The MusicBrainz suggestion prefill (`GET /search/musicbrainz/release-group/:mbid`) now includes each credit's `artistMbid`. External search candidates carry it too; they remain discovery candidates, not catalog albums.

The frontend keeps a credit's identity only while its name is unchanged. If a contributor renames a credit, it is submitted as a plain credit. The correction form's comma-separated name field reuses the role and identity of a current credit with exactly the same name. Moderators see a MusicBrainz artist link beside identified credits in submission details.

### Approval

Inside the approval transaction, new-album publication and approved artist corrections resolve every proposed identity against the registry. A known MBID reuses its artist. An unknown MBID registers a `community` artist whose provenance names the submission, its revision, and the approving moderator. Its name is provisional (`nameSource: "artist-credit"`), because a contributor's display wording is not trusted canonical metadata. Client-supplied `artistName` is rejected, and approval never performs a live lookup inside its transaction. An `artistId`-only credit gains the artist's registered MBID. An unknown `artistId`, or an `artistId` whose registered MBID differs from the credit's, blocks approval with `409 ARTIST_IDENTITY_CONFLICT`. Nothing is published and the suggestion stays pending. Linking a suggestion to an existing album does not change that album's credits.

## Backfill

`npm run catalog:backfill-artists` links existing catalog credits using the artist MBIDs recorded in reviewed catalog import datasets, such as `data/catalog-import/seeds/listenbrainz-2026-08-14.json`. Planning is the default. It writes a sealed plan and never writes to MongoDB. The CLI disables automatic Mongoose collection and index creation on connection. Apply reads only that plan.

### Verified registry names

Album credit names and artist names are different MusicBrainz fields. A release can credit one person as a longer alias or a combined cast string. Never split those strings or use punctuation to infer identities.

For old datasets, add `--resolve-artist-names --artist-name-cache <private-directory>` during planning. This explicitly enables an operator-only lookup of every **new** registry artist by exact MusicBrainz MBID. It does not alter album credit wording or rename existing registry records. Each resolved name records the artist MBID, source URL, and observation time in `fieldProvenance.name`; the sealed plan includes all names and an `artistNameResolution` summary listing changes.

The resolver uses an identifying user agent, at least 1.1 seconds between request starts, eight-second request timeouts, at most three attempts, a 256 KiB response limit, and a fifteen-minute run budget. It honors `Retry-After` up to thirty seconds and stops on longer throttles. Redirects and returned-ID mismatches are not followed as artist merges. Invalid, unavailable, or unresolved names stop planning before the final plan is written. Successfully verified names remain in a seven-day private disk cache so a later run can resume. A lock prevents concurrent resolvers using that cache; inspect a crashed operator before removing a stale lock.

Only planning performs these lookups. Apply uses the exact sealed names without network access. Ordinary planning without this option remains offline with respect to providers; old datasets may then produce provisional credit-derived names. Use verified-name planning before publishing artist-page headings. Existing provisional registry names require a separately reviewed name correction; they are not overwritten automatically by import or backfill.

### Matching rules

An album is considered only through its single `musicbrainz` / `release-group` reference, matched to a dataset row with the same `releaseGroupMbid`. Its credits link only when they meet all of these conditions:

- The album has the same number of credits as the dataset row.
- Each credit name exactly equals the dataset credit name at the same position after Unicode NFC normalization and trimming. The legacy-migration form, with the join phrase folded into the name (for example, `V with`), is also accepted. There is no case-folding or fuzzy matching.
- No credit already carries a different MBID or `artistId`.
- Credit provenance is automated. Credits whose `fieldProvenance.artistCredits.source` is `community` or `manual` are never rewritten. A non-import album with no credit provenance is treated as user-owned.

Linking adds only `artistId` and `artistMbid`. Every existing credit key and value, including name, role, and order, is preserved. `fieldProvenance.artistCredits` is unchanged. A separate `fieldProvenance.artistIdentity` entry records the plan checksum, datasets, release group, and time.

### Plan buckets

| Bucket | Meaning |
| --- | --- |
| `albumUpdates` | Exact matches to link, with `beforeCredits`, `afterCredits`, and the expected catalog revision. |
| `artistRegistrations` | Full registry documents to insert, one per new MBID, with pre-assigned `artistId` values. |
| `reusedArtists` | Existing registry artists the plan relies on. |
| `review` | `USER_OWNED_CREDITS`: matches that a reviewed catalog correction would need to link. Includes the proposed MBIDs. |
| `flagged` | `MULTIPLE_RELEASE_GROUPS`, `SOURCE_CONFLICT` (input datasets disagree), `INVALID_SOURCE_CREDIT`, `CREDIT_COUNT_MISMATCH`, `CREDIT_NAME_MISMATCH`, `EXISTING_IDENTITY_CONFLICT`. |
| `unchanged` | Already linked to the same identities. |
| `noSource` | A release-group reference with no row in any input dataset. |

`counts.withoutReleaseGroup` counts albums that have no MusicBrainz release-group reference, such as most community suggestions. Plan mode exits `2` when anything is flagged or needs review, and `0` otherwise.

### Runbook

Keep plans and reports outside the repository, for example in `~/rescened-ops/artist-identity/`. Never apply to production without explicit authorization for that named target.

1. Point `MONGO_URI` at the intended database. Create a plan:

   ```sh
   npm run catalog:backfill-artists -- \
     --input data/catalog-import/seeds/listenbrainz-2026-08-14.json \
     --resolve-artist-names \
     --artist-name-cache ~/rescened-ops/artist-identity/musicbrainz-name-cache \
     --out ~/rescened-ops/artist-identity/<database>-<date>.plan.json
   ```

   Every input is fully validated, and its SHA-256 is recorded, before any database connection. `--input` may repeat. The command prints `planSha256` and the target database name. An existing plan file is never overwritten.
2. Review the plan, including the `flagged` and `review` buckets and every `artistRegistrations` name. Resolve flagged albums through catalog corrections, not by editing the plan. Any edit breaks the seal.
3. Apply only after explicit authorization for that database:

   ```sh
   npm run catalog:backfill-artists -- --apply \
     --plan <plan.json> --plan-sha256 <planSha256> \
     --confirm-target <database> --report <new-report.json>
   ```

   Apply refuses to run if the checksum differs, the plan was edited, or the connected database, the plan target, and `--confirm-target` do not all match.

### Apply semantics

- **Report first.** Before connecting, apply reserves the report path. If it cannot write the final report after commits, it prints the report and `databaseCommitted` to the console.
- **Registry first.** It validates the sealed plan and confirmed target before connecting, then verifies the connected database before building the registry's unique index. One transaction then inserts the planned artists and confirms that each reused artist still exists. If the registry now maps a planned MBID to a different `artistId`, the apply stops with `ARTIST_REGISTRY_CHANGED` before any album changes. In that case, create a new plan.
- **One transaction per album.** Inside its transaction, each album is read through the raw collection and compared with its planned stored revision and exact `beforeCredits`. This avoids Mongoose casting, which would trim legacy names such as `Alpha & ` or add default roles. It sets the new credits, advances `catalogRevision` by one, and carries the album's reviewed baseline and active Last.fm mappings to the new revision, as the cover backfill does.
- **Album outcomes.** A changed album is reported as `conflict` and left untouched. An album that already has the planned credits at the planned revision is `already_applied`. Rerunning the same plan is therefore safe.
- **Pending corrections.** Pending corrections created before an album was linked become stale (`CATALOG_CHANGED`), because its revision advances.
- **Unused registrations.** Planned artists are registered before album updates. An album that then conflicts can leave its new artists unused in the registry. This is harmless, and a new plan reuses them.
- **Partial commits.** Registry and album transactions commit independently. A failed run writes its report with `databaseCommitted` and `completed`, so a partial commit is never mistaken for a rollback. Apply exits `2` if any album conflicted.

## Artist pages (prototype)

`ARTIST_PAGES_ENABLED=true` (server-side, default off) enables everything in this section. While it is off, `/artists` returns `503 ARTIST_PAGES_DISABLED`, album responses omit `artistPages`, and catalog search behaves as before. Every read uses the local `Artist` registry and `AlbumCatalog`; no request contacts a provider. Error codes are in [ERROR_CODES.md](ERROR_CODES.md#artist-pages).

Before enabling it in production, run verified-name backfill planning (see [Verified registry names](#verified-registry-names)). Otherwise headings show provisional credit-derived names.

### Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/artists/:artistId` | Header: `artist { artistId, name, aliases, creditedAs, musicBrainzUrl }`, `releaseCounts { all, album, ep, single, mixtape, other }`, and `features { discography }`. `other` covers soundtrack, compilation, live, remix, and other. |
| `GET` | `/artists/:artistId/releases?type=&limit=&cursor=` | Linked catalog releases, newest first (year, then release date, then title and `albumId`). Keyset-paged with an opaque cursor that holds no Mongo IDs; `limit` 1–48, default 24. Local search rate limit. |
| `GET` | `/artists/search?q=&limit=` | Artists whose registry name, reviewed alias, or credited spelling contains the query. `limit` 1–12, default 6. Local search rate limit. |

`GET /albums/album/:albumId` adds `artistPages: { artistIds }`: the credited `artistId` values that resolve to a registry artist. The frontend links only those credits to `/artist/:artistId`. Name-only and unresolved credits stay plain text.

### Linked releases

A release is on an artist's page only when one of its credits carries that artist's `artistId`. A release with no stored `releaseType` counts and filters as an album. A release credited to several identified artists appears on each of their pages. Cards keep the album's own credits, in order, and mark a featured role or a collaboration. A card is a collaboration only when the release credits another party: a credit with a different `artistId`, or an unresolved credit, which stays plain text. Several credits that share the page's `artistId`, such as two spellings of one performer, are not a collaboration. Names are never compared, so an unresolved credit spelled like the artist still counts as another party. Display names are never split, and homonyms remain separate artists. The page lists catalog releases only. It is not a complete discography.

`creditedAs` lists up to 20 credited spellings on linked releases that differ from the registry name, most used first. The header lists them; album credits keep their own wording, and the registry name is not changed.

### Search aliases

Aliases attach to one stable `artistId` and never merge artists. They come from two sources:

- **Credited names.** Every spelling under which an `artistId` is credited, such as a Hangul credit on one release and a Latin one on another.
- **Reviewed aliases.** `lib/artists/reviewedAliases.js` is a small reviewed table of native-script and alternative names with optional BCP 47 `locale` tags. It is keyed by MusicBrainz artist MBID, because each database assigns its own random `artistId`. At read time an entry attaches to the registry artist with that MBID; an MBID absent from the registry is unused. Entries are validated at load: lowercase MBIDs, NFC names, no duplicates. Add an entry only with a reviewed source and tests.

Matching uses the catalog search normalization: case-insensitive, canonical Latin accents and apostrophes folded, and other scripts compared exactly, with no transliteration. Artist search ranks an exact registry name first, then an exact alias or credited name, then prefix and substring matches, then by linked release count. Same-named artists stay separate results and show release counts and up to two release titles.

While the flag is on, `GET /search/search` also includes releases linked to any registry artist whose name or reviewed alias equals the whole query. For example, `방탄소년단` finds releases credited to `BTS`. These releases rank with exact artist matches, after the curated preferences in `routes/utils/searchArtistAliases.js`, which are unchanged. Partial queries never expand.

The full results page shows matching artists above album results on page one, without a genre filter. Any artist search failure, including the disabled flag, omits that section.

### Indexes and cost

`AlbumCatalog` gains a sparse index on `artistCredits.artistId`, which serves the header, release, and album-detail reads. Artist search scans registry names, and the catalog's credit names, with regular expressions, as catalog search already does. It orders the capped candidate lists by exact, prefix, then substring match, so a common short query cannot crowd out an exactly named artist. With the flag on, every catalog search page also runs a case-insensitive anchored regex over registry names; `Artist.name` has no index, so this scans the registry. Measure both before relying on them for a large catalog.

On page one, the results page calls both `/search/search` and `/artists/search`, so it spends two points of the shared local-search rate limit. While the flag is off, it still sends the artist search request and ignores the `503`. The header route `GET /artists/:artistId` has only the global rate limit, like `GET /genres/:slug`.

## MusicBrainz discography (prototype)

`ARTIST_DISCOGRAPHY_ENABLED=true` (server-side, default off, and only with `ARTIST_PAGES_ENABLED`) adds an "On MusicBrainz" section below "On Rescened". It is the only artist route that contacts a provider. The page loads it after the local header, and its loading, errors, and retries stay inside the section. The header response includes `features: { discography }`, which is `true` only while the flag is on and the artist has a MusicBrainz identity. The page mounts the section only when it is `true`. An older API that omits `features`, the flag being off, or an artist without an MBID leaves the page without the section. While the flag is off, `GET /artists/:artistId/discography` returns `503 ARTIST_DISCOGRAPHY_DISABLED`. As a fallback, the section also hides itself on that code or on an uncoded 404 or 503, such as a missing route, but not on the coded `ARTIST_DISCOGRAPHY_NOT_AVAILABLE`.

### Request

`GET /artists/:artistId/discography?type=&cursor=` resolves the registry artist's MusicBrainz MBID and makes one provider request per call:

```
GET https://musicbrainz.org/ws/2/release-group?artist=<mbid>&type=<album|ep|single>&release-group-status=website-default&inc=artist-credits&limit=100&offset=<n>&fmt=json
```

- **Browse, not search.** Browsing by artist reads MusicBrainz's database directly. `release-group-status=website-default` matches the artist overview on musicbrainz.org: it leaves out release groups whose releases are all promotional, bootleg, or pseudo-releases. That is not an official-only filter, and poorly tagged groups can remain. In one-off manual probes, Radiohead's album-type groups fell from 389 (all statuses) to 29. An earlier design used the search index with `arid:<mbid>`; its rows embed release lists, and in an earlier run of the experiment script its album pages for the five sampled artists were 2.7–15 times larger (43–181 kB, against 9–28 kB for browse). The committed script now measures only the browse design.
- **Types.** `album` (the default), `ep`, and `single` send that MusicBrainz primary type and then keep only rows with no secondary type: no live, compilation, remix, soundtrack, demo, DJ-mix, and so on. These are labeled as MusicBrainz album, EP, or single groups, not as guaranteed studio releases. `other` is the complement and `all` keeps everything; both browse without a type and filter locally.
- **Verified identity.** A row is kept only if its own artist credit names the requested MBID. Collaborations therefore appear on each credited artist's discography, and an index or provider mistake cannot attach another artist's release. `filteredOut` counts returned rows dropped because the artist credit did not verify, the type did not match the filter, or the row could not be normalized. Duplicates within a page are not counted.
- **Counts.** `providerCount` is MusicBrainz's raw browse total for the request, described by `providerScope`. For `album`, `ep`, and `single` it counts every website-default group of that primary type, including secondary types. For `other` and `all` it is the whole website-default discography. It is not the number of rows matching the filter. The UI shows it as "MusicBrainz's default view has N …" and separately counts the verified rows shown.
- **Order.** Browse results arrive in MusicBrainz's internal order, not by date. Each page is sorted newest first. When a filter spans more than one page, the UI says "newest first within each batch of up to 100".

### Reconciliation

Each returned release group is matched against `AlbumCatalog` by its `musicbrainz` / `release-group` reference. A match is returned as `kind: "catalog"` with its public `albumId` and the catalog's own title, credits, type, year, and cover, linking to `/album/:albumId`. Every other row stays a `kind: "external"` candidate with no `albumId`, shown with "Not in Rescened". Nothing is imported, and provider IDs never become `albumId` values.

"Suggest this album" prefills from `GET /search/musicbrainz/release-group/:mbid`, which `EXTERNAL_ALBUM_SEARCH_ENABLED` gates. The response's `suggestionsAvailable` mirrors that flag. While it is off, external cards show only their MusicBrainz link, so the section never advertises a suggestion it cannot start. Submitting a suggestion still needs `COMMUNITY_SUBMISSIONS_ENABLED`; this feature does not enable either flag.

### Paging and bounds

- **Cursor.** The opaque cursor names the artist, the type, and the raw provider offset (1–1,000). It cannot be replayed against another artist or type. The next offset advances by the rows MusicBrainz returned, not by the rows kept, so filtering never skips or repeats provider rows. A page can be empty after filtering and still have a next page; the UI keeps "Load more from MusicBrainz" and says the batch had no new verified matches. Paging stops at the provider total, after an empty provider page, or at offset 1,000 (`truncatedAtOffsetCap`).
- **De-duplication.** Duplicates are removed within a page on the server and across pages in the UI.
- **Requests.** The first page loads with the section on each artist view; further pages load only when someone clicks "Load more". There is no crawl and no automatic retry. The shared rate gate queues requests without a bound, and time spent waiting there is not covered by the timeout. A browser abort does not cancel a provider request already in progress. Under heavy use, waits can therefore grow; the per-IP route limit and the cache are the current protections. Each provider page is one request, behind the same per-process 1.1 s rate gate, in-flight de-duplication, and bounded in-memory cache as external search. Discography pages stay cached for 10 minutes. The timeout is 6 s with no retries. Response bodies are limited to 2 MiB of decoded bytes as they are read. The route uses the 30-per-minute external-search rate limit.
- **Failures.** A MusicBrainz error, timeout, invalid response, or 503 returns `502 EXTERNAL_DISCOGRAPHY_UNAVAILABLE` with allowlisted diagnostics. MusicBrainz documents a limit of one request per second per client; a 503 can mean throttling or general server load, so the UI offers "Try again" without blaming either.
- **Cache.** The cache is in memory and per process. There is no persisted discography cache and no database write; restarting the API empties it, and several API instances each keep their own cache and rate gate.

MusicBrainz core data is CC0. The section credits MusicBrainz and links to the artist there. Covers are hotlinked from the Cover Art Archive and are not copied.

## Verification

- `tests/artistNames.test.js` covers exact-ID lookup, rate limits, bounded retries/timeouts, response validation, private-cache reuse/resume, and credited-name preservation. All provider responses are fixtures.
- `tests/artistIdentity.test.js` covers the identity helpers, model invariants, submission validation, importer planning, backfill classification and sealing, the checked-in seed dataset as a source, and the frontend credit helpers.
- `tests/artistPages.test.js` covers the collaboration badge (duplicate same-ID credits, distinct and homonymous artists, unresolved credits), reviewed-alias validation, search-key folding, query parsing, the search pipeline expansion, the feature flag, and the frontend credit and release helpers.
- `tests/musicBrainzDiscography.test.js` covers the browse URL, a captured CC0 browse fixture, artist-credit verification, type filtering, raw-offset paging with empty filtered pages, the offset cap, caching and in-flight sharing, the shared rate gate, the streamed response-size limit, cursor binding, catalog reconciliation, and suggestion availability. `tests/artistPages.test.js` covers the discography route flag, safe 502 diagnostics, and the count wording.
- `tests/artistDiscography.browser.test.js` is opt-in (`RUN_FRONTEND_BROWSER_TESTS=true` with Playwright). It checks repeated clicks, filter changes and unmount during in-flight requests, empty batches, the hidden suggestion action, and 390 px overflow, with fetch stubbed in the page.
- `tests/artistPages.integration.test.js` covers artist headers, keyset release paging and type filters (including untyped rows and equal-title ties), multi-credited releases, homonyms, the search candidate cap, alias and credited-name search, identity search expansion with the flag on and off, and album-detail link resolution. It fails if any request leaves the test server.
- `tests/artistIdentity.integration.test.js` covers the transactional paths on a replica set: import registration and idempotency, approval resolution and conflicts, and backfill planning without writes, target refusal, guarded apply, mapping carry-forward, rerun, and registry drift.

## Known limitations

- Older datasets and community-only registrations may still have provisional credit-derived names. Provenance distinguishes those from verified MusicBrainz artist names. Existing registry names are not renamed automatically.
- Credits without an MBID stay unlinked. There is no name matching, and the suggestion and correction forms have no artist search or picker. Contributors can propose identity only through a MusicBrainz prefill or by keeping an existing credit's name.
- The correction form's comma-separated credit field still splits names that contain commas, such as "Tyler, The Creator". This is a pre-existing problem. Those pieces no longer match the current credit, so the correction submits them without identity.
- Moderator details show a credit's `artistId` and MusicBrainz link. They do not show the registry artist's own name.
- User-owned credits are not backfilled. Link them through reviewed corrections.
- Legacy migration and the importer's provider adapters still drop join phrases from credits.
- Listening stats and activity still use credit names. Catalog search expands by identity only for exact registry names and reviewed aliases, and only while artist pages are enabled.
- Reviewed aliases are a checked-in table, not stored registry data. There is no alias editor or MusicBrainz alias import yet.
- Artist pages have no biography or image. The MusicBrainz discography is flagged off by default, reads its total before local filtering, and has no persisted cache.
