# Artist identity (phase 1)

Last reviewed: 2026-11-12

Phase 1 gives artists stable public Rescened IDs and keeps MusicBrainz artist IDs on album credits. A flagged [artist pages prototype](#artist-pages-prototype) builds on it with local artist pages, credit links, and multilingual search aliases, and a separately flagged [MusicBrainz discography](#musicbrainz-discography-prototype). A separately flagged, cached [biography](ARTIST_BIOGRAPHIES.md) can add a short Wikipedia excerpt. The page header shows a cycle of the artist's stored release cover art (see [Header cover art](#header-cover-art)); there are no artist photos and no merges. Listening stats still group top artists by display name.

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

Catalog responses pass these keys through on `artistCredits`, so album-bearing responses expose `artistId` and, where known, `artistMbid` beside each credit name. MusicBrainz artist MBIDs are public identifiers, not secrets: album responses, artist headers (`musicBrainzUrl`), external MusicBrainz candidates, and moderator detail all show them. They are never used as a Rescened ID; `artistId` is the only public artist identity Rescened issues, and Mongo `_id` stays internal. Artist page release cards return the compact `{ name, role, artistId }` credit shape; that is a payload choice, not a privacy rule. Join phrases are not stored on credits. `artistDisplayName` still holds the full credited string.

## Write paths

### Catalog import

`npm run catalog:import` resolves every dataset credit's `artistMbid` through the registry during preflight. Newly fetched datasets retain the underlying MusicBrainz `artist.name` as optional `artistName`, separately from the credited `name`. New registrations use that verified name with `nameSource: "musicbrainz-artist"`; old datasets without it retain provisional `nameSource: "artist-credit"`. Conflicting canonical names for one MBID stop import preflight. A known MBID reuses its `artistId` without silently renaming it. An unknown MBID gets one planned registration (`artistSource: "import"`), shared by every row that credits it. Registrations are inserted first, in the same transaction as the catalog writes, so a concurrent registration of the same MBID rolls the whole import back. Only artists credited by inserted or refreshed rows are registered. Quarantined rows and preserved credits do not register artists.

The import report includes `artistRegistry: { registered, reused }`. Re-importing the same dataset is idempotent. The CLI connects with automatic collection and index creation off, so a dry run creates no collection or index. `--apply` builds the catalog and registry indexes, including the registry's unique MusicBrainz index, before it writes.

**Rollout order matters.** The first import after this change would refresh every previously imported row, because its credits gain identities. An import refresh advances `catalogRevision` without carrying reviewed baselines or active Last.fm mappings forward, so those would go stale, and pending corrections would fail with `CATALOG_CHANGED`. To avoid that, run the [backfill](#backfill) first, against the same datasets. For a re-import of the same dataset, the importer enforces this order: the dry-run report lists these albums as `identityRelinks`, and `--apply` refuses with `IDENTITY_RELINK_NEEDS_BACKFILL`, before building indexes or writing, unless the operator passes `--allow-identity-relink`. Albums the backfill leaves for review or flags will keep appearing there until they are resolved or deliberately allowed; `--allow-identity-relink` applies to the whole run, so check the listed albums before using it. A newer dataset already refreshes every row through its provenance (as before artist identity), so those refreshes are not listed. The backfill carries baselines and mappings forward. The import merge also keeps the backfill's `fieldProvenance.artistIdentity` while credit identities are unchanged, so a later re-import of the same dataset reports those albums as `unchanged`.

### Suggestions and corrections

New-album suggestions, revisions, and artist corrections accept optional `artistId` and `artistMbid` on each credit. The server validates their formats and lowercases them. Blank strings are treated as absent. On submission and revision, a supplied `artistId` must exist, and if the credit also has an `artistMbid`, it must match the artist's registered MBID. Otherwise the request fails with `400 INVALID_SUBMISSION`. An MBID the registry has not seen yet is accepted.

The MusicBrainz suggestion prefill (`GET /search/musicbrainz/release-group/:mbid`) now includes each credit's `artistMbid`. External search candidates carry it too; they remain discovery candidates, not catalog albums.

The frontend keeps a credit's identity only while its name is unchanged. If a contributor renames a credit, it is submitted as a plain credit. The correction form shows one editable row per credit (name and role) with add and remove controls, so a name containing a comma, such as "Tyler, The Creator", stays one credit. Each row keeps its role, position, and identity while its name is unchanged, and the form submits the rows as a structured credit list. A stored correction draft keeps its rows the same way; a draft saved by the earlier comma-separated field is ignored for credits (the other fields restore) because that text cannot be split reliably, and the draft notice says so when credit edits were lost. The catalog has no credit limit, but a correction can carry at most 20: an album with more loads every credit, and the form blocks submitting the Artists group with a message instead of truncating, so credits are only removed by an explicit Remove. Other field groups are unaffected. Moderators see a MusicBrainz artist link beside identified credits in submission details.

### Approval

Inside the approval transaction, new-album publication and approved artist corrections resolve every proposed identity against the registry. A known MBID reuses its artist. An unknown MBID registers a `community` artist whose provenance names the submission, its revision, and the approving moderator. Its name is provisional (`nameSource: "artist-credit"`), because a contributor's display wording is not trusted canonical metadata. Client-supplied `artistName` is rejected, and approval never performs a live lookup inside its transaction. An `artistId`-only credit gains the artist's registered MBID. An unknown `artistId`, or an `artistId` whose registered MBID differs from the credit's, blocks approval with `409 ARTIST_IDENTITY_CONFLICT`. Nothing is published and the suggestion stays pending. Linking a suggestion to an existing album does not change that album's credits.

### Artist proposals (contract only)

`lib/artists/proposals.js` defines the private identity proposals that attach to a parent suggestion revision. New-album suggestions, catalog corrections, and standalone artist suggestions use them (see [Artist links on album suggestions](#artist-links-on-album-suggestions), [Artist links on catalog corrections](#artist-links-on-catalog-corrections), and [Standalone artist suggestions](#standalone-artist-suggestions)).

- **Request shape.** `artistProposals` lists `{ proposalKey, kind: "musicbrainz", artistMbid }` or `{ proposalKey, kind: "community", canonicalName, evidence: [{ url, description? }] }`. `artistSelections` links credit positions with `{ position, kind: "existing", artistId }` or `{ position, kind: "proposal", proposalKey }`. Both are strict. Clients cannot send names, observations, or identity keys for MusicBrainz proposals. Each list holds at most 20 entries. A community proposal needs one to five private HTTPS evidence links without credentials, and the server never fetches them.
- **Reuse is explicit.** One proposal key may link several positions. Two MusicBrainz proposals for the same MBID are refused (`DUPLICATE_ARTIST_PROPOSAL`), and same-name community proposals stay distinct artists. Every proposal must be linked by at least one selection (`UNATTACHED_ARTIST_PROPOSAL`).
- **Observations before approval.** Preparation validates each MusicBrainz MBID through an injected exact-ID lookup and stores a bounded snapshot: name, sort name, disambiguation, type, and `observedAt`. A missing artist, a different returned MBID (`ARTIST_MBID_REDIRECTED`), or a nameless record is refused, and redirects are never followed as merges. The adapter is `lookupMusicBrainzArtist` in `lib/musicBrainzSearch.js` (see [Artist picker discovery](#artist-picker-discovery)); suggestion create and revise call preparation.
- **Resolution at approval.** `resolveArtistSelections` runs inside the caller's transaction and never calls a provider. An existing selection must name a registered artist and gains its registered MBID. A MusicBrainz proposal reuses the artist registered for that exact MBID, without renaming it, or registers one from the reviewed observation (`nameSource: "musicbrainz-artist"`, with `observedAt`). A community proposal always registers a new `community` artist with no external reference (`nameSource: "community-proposal"`). Selected credits must not already carry an identity (`CREDIT_ALREADY_LINKED`). Each credit's wording, role (including a missing role), and position stays unchanged, and unselected credits are untouched. A unique-index collision is reported as `ARTIST_REGISTRATION_RACE`, while transient write conflicts propagate so the caller's transaction can retry and reuse the committed artist. The result includes one resolution per selection for the approval receipt.

### Artist picker discovery

`ARTIST_SUGGESTIONS_ENABLED` (default off, independent of artist pages) gates two signed-in reads for the shared artist picker. The flag is not set in any environment by this change.

- `GET /artist-discovery/local?q=&limit=` runs the same registry search as artist pages (registry names, reviewed aliases, linked credit spellings) and adds each artist's registered `artistMbid`. Same-name artists are separate results.
- `GET /artist-discovery/musicbrainz?q=` returns up to 10 external MusicBrainz artist candidates (`kind: "external"`, MBID, name, sort name, disambiguation, type, country, MusicBrainz link). A candidate whose exact MBID is already registered carries `registeredArtistId` and that artist's `registeredName`, which can differ from the MusicBrainz wording. Choosing it selects the Rescened artist under its registry name. Names are never matched.

Each source is rate-limited per user and fails on its own, so local results keep working while MusicBrainz is unavailable. MusicBrainz artist search and the exact-ID lookup use the interactive client in `lib/musicBrainzSearch.js`, not the operator disk-cache workflow. They share its identifying user agent, the process-wide 1.1 s request gate, the 3 s timeout, the 2 MB body limit, the bounded 60 s cache, and in-flight coalescing, and they never retry automatically. On top of that, at most four uncached artist requests may wait at once, and an upstream 429 or 503 starts a cooldown (its `Retry-After`, 10 s by default, capped at 120 s) during which artist requests are refused locally. The cooldown is checked again when a request reaches the front of the shared rate gate, so requests already queued when the throttle arrives are refused, not sent. Error codes are listed in [error codes](ERROR_CODES.md#artist-picker-discovery).

`frontend/src/features/artists/ArtistPicker.jsx` is the reusable picker; the album suggestion form renders it on credit rows. It renders no `<form>` of its own, so it can sit inside other forms. A person searches explicitly. The picker shows "On Rescened" results and dashed "From MusicBrainz" candidates in separate lists and links a credit only when the person chooses a result or proposes a new community artist (canonical name plus one to five private HTTPS links of at most 2,048 characters, validated locally with the server's limits and never fetched). The credit keeps its own wording, and the picker says so when it differs from the chosen artist's name. Pending searches are aborted, and their answers ignored, after a newer search, a query edit, a selection, unmount (row removal, a reset that changes the picker's key, navigation), or sign-out, which unmounts the panel. MusicBrainz failures show a manual "Try MusicBrainz again" action and are not retried by themselves. The live status line describes the outcome, including a failed or empty search, rather than always inviting a choice.

### Artist links on album suggestions

With `ARTIST_SUGGESTIONS_ENABLED` on, the album suggestion form (create and revise) shows the picker on every credit row that does not already carry an identity from a MusicBrainz prefill or an earlier revision; the form asks `GET /artist-discovery/capabilities` first. Links are sent only after the answer is yes. A form holding links never drops them implicitly. While the check is pending or after it fails, it refuses to submit and says why. On a confirmed no, a revision whose suggestion has stored links is refused outright (the server refuses it too, see below), and links that exist only in a local draft must be removed with each credit's explicit "Remove artist link" button before the suggestion can be sent. A suggestion without links is never held up. A chosen artist adds `artistProposals` and `artistSelections` beside the credits, which keep their wording, roles and order. Sharing is explicit, never by name: links restored from a stored revision keep their `proposalKey`, so credits that shared one proposal still share it; one MusicBrainz MBID always shares one proposal; and each community artist chosen in the picker is its own proposal, with a key that never reuses a restored one. A new suggestion with links carries a `requestKey`, reused only for the identical payload, so a retry after a lost response returns the original suggestion.

Revising a suggestion that has stored links fails closed while `ARTIST_SUGGESTIONS_ENABLED` is off: the server returns `503 ARTIST_SUGGESTIONS_DISABLED` whatever the body, so turning the feature off can never clear stored links. The contributor can revise once linking is back on, or withdraw. With linking on, a revision is a complete snapshot, and leaving the links out removes them; the form does that only after explicit removal on each credit. On create, the server first validates the body shape and links with no database, preview or provider read, and compares a `requestKey` against a digest of that normalized client input (strings trimmed, keys ordered; the client's genre choice rather than resolved genre names, the edition preview ID rather than its tracks). A saved request with the same key therefore replays even after a referenced genre is renamed or an edition preview expires, and only the contributor who saved it can replay it. A new request then normalizes the links against the normalized credits, refuses a selected credit that already has an identity and an unknown existing artist, and prepares MusicBrainz proposals through the exact-ID lookup. A revision keeps the observation of an MBID already observed on the previous revision. Proposals, observations and evidence are stored on the submission and on each revision snapshot. They appear only in owner and moderator detail, never in summaries, the queue, the approved feed, the catalog, or the registry. Nothing is registered before approval.

Moderator detail adds `artistProposalRegistry` (which proposed MBIDs approval will reuse) and registry names for existing-artist selections. The UI shows each credit's link, the observation date, and the private evidence links. Every new-album approval sends the displayed `expectedRevision`. A suggestion with links can only be approved as a new album, is excluded from bulk approval (`artist_links`), and needs the flag on to be approved.

Approval resolves the links inside the publication transaction, then resolves any remaining credit identities as before. Artists created by the approval, the album, the submission transition, the approval event, the receipt (one resolution per link), and the notification all commit together; a failure at any of those writes leaves none of them. An approval retry returns the receipt's result without creating anything.

### Artist links on catalog corrections

A catalog correction can carry an `artistLinks` field group: identity-only links for an existing album's credits. Each link names a credit position and an existing artist or a proposal, using the same contract and picker as album suggestions. It never carries credit wording and cannot be combined with the `artists` group, which replaces credits. Up to twenty links per correction may name any stored credit, including credits past the twenty-credit edit limit, and every selected credit must have no identity yet. The correction form lists every stored credit and offers the picker on the unlinked ones, with the same capability rules as the suggestion form: links stored on a revision are never dropped while linking is pending, failed or off (the server refuses to revise such a correction while the flag is off).

The baseline is the album's credits read raw from the collection, with its `catalogRevision`. Approval of the `artistLinks` group needs the flag on, rechecks the revision and the raw credits byte-for-byte, then registers or reuses the artists in the approval transaction. It adds `artistId`/`artistMbid` to the selected credits only, through the raw collection like the backfill, so wording, roles (including a missing role), order and `artistDisplayName` are unchanged. It records `fieldProvenance.artistIdentity` (`source: "community"`, `method: "artist-link-correction"`, the positions, submission, revision and moderator) and leaves `fieldProvenance.artistCredits` with whoever owns the wording. A partial approval that skips the group registers nothing. An identity backfill and an artist-link correction both advance the revision, so whichever commits second is a conflict.

A catalog re-import keeps credits whose `fieldProvenance.artistIdentity` is community- or manually owned, because refreshing them from the dataset would drop those links; dataset-derived identities refresh as before. An identity backfill that later links other credits on such an album keeps that community or manual record and nests its own record under `fieldProvenance.artistIdentity.backfill`, so the protection survives a fresh backfill followed by a re-import. On albums without a person-owned record, the backfill writes its record as before.

### Standalone artist suggestions

`models/ArtistSubmission.js` is a separate suggestion lifecycle for one artist, with no album: a MusicBrainz artist (validated through the exact-ID lookup, with a stored observation) or a new community artist (canonical name plus one to five private HTTPS links). States are `pending`, `needs_changes`, `approved`, `rejected`, `duplicate`, and `withdrawn`. Revisions and moderation history are append-only, with one event per accepted command. There is no bulk approval, notification, or biography work in v1.

- **Contributors** (`/artist-suggestions`, signed in): `POST /` needs a `requestKey`, replays the original suggestion for the same normalized request before any registry or provider read, and conflicts with `REQUEST_KEY_CONFLICT` otherwise. `GET /mine` lists the contributor's summaries (without evidence or notes) newest first, 20 per page by default and at most 50 (`limit`), with a `nextCursor` that continues the same contributor's list, so older suggestions, including ones needing changes, stay reachable; the page has "Show older suggestions". `GET /:submissionId` returns the owner's detail (moderators can read it too; anyone else gets `404`). `POST /:submissionId/revise` (only `needs_changes`) and `POST /:submissionId/withdraw` (`pending` or `needs_changes`) both require `expectedRevision`. A MusicBrainz MBID already on Rescened is refused with `409 ARTIST_ALREADY_EXISTS` and the existing artist, and choosing an existing Rescened artist in the picker points to that artist instead of suggesting it.
- **Moderators** (`/moderation/artist-suggestions`, allowlisted): queue and detail. Detail adds advisory context: the artist an exact MBID would reuse, and registry artists with the same name as possible duplicate targets. `approve`, `request-changes`, `reject`, and `mark-duplicate` all require `expectedRevision`; reasons are required to request changes or reject. `mark-duplicate` names any existing public `artistId`, including imported artists with no originating submission, and creates nothing.
- **Approval** runs in one transaction: it registers a community artist, or registers the observed MusicBrainz artist, or reuses the artist already registered for that exact MBID without renaming it; then it records the approval, receipt (`created` or `reused`), and audit event. A retry at the approved revision returns the original result, and any other revision returns `APPROVAL_CONFLICT`. Same-name community suggestions stay separate artists unless a moderator marks one as a duplicate. An approved artist has a public registry record even with no albums.
- **Gates:** contributor mutations need `COMMUNITY_SUBMISSIONS_ENABLED` and `ARTIST_SUGGESTIONS_ENABLED`; moderator commands need `COMMUNITY_MODERATION_ENABLED` and `ARTIST_SUGGESTIONS_ENABLED`. Reads keep working with any of them off. Evidence and notes appear only in owner and moderator detail, never in the registry, summaries, or queue.

The contributor page (`/artist-suggestions`) uses the shared picker. The suggestions page links to it while linking is on. The moderator page is `/moderation/artist-suggestions`. Every command sends the revision of the detail on screen. A command that finishes after the person opened another suggestion is dropped (success or error); the contributor page remounts per route, and the moderator page ties command feedback to the suggestion it was sent for.

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
- Credit provenance is automated, unless the plan opts in to user-owned credits. Credits whose `fieldProvenance.artistCredits.source` is `community` or `manual`, and non-import albums with no credit provenance, are user-owned. By default they go to `review`. With `--link-user-owned` (plan mode only, recorded as `options.linkUserOwnedCredits` in the sealed plan), exact matches among them are linked the same additive way. Each such update is marked `userOwnedCredits` with its `creditProvenance`, and `counts.userOwnedLinks` totals them. Every other rule above still applies. Their wording is never rewritten.

Apply refuses any plan that marks user-owned updates without that sealed option, or whose count disagrees. It copies the option into the apply report and marks each such outcome. It also records `userOwnedCredits` and `creditProvenance` in the album's `fieldProvenance.artistIdentity`, while `fieldProvenance.artistCredits` keeps its original owner.

Linking adds only `artistId` and `artistMbid`. Every existing credit key and value, including name, role, and order, is preserved. `fieldProvenance.artistCredits` is unchanged. A separate `fieldProvenance.artistIdentity` entry records the plan checksum, datasets, release group, and time.

### Plan buckets

| Bucket | Meaning |
| --- | --- |
| `albumUpdates` | Exact matches to link, with `beforeCredits`, `afterCredits`, and the expected catalog revision. |
| `artistRegistrations` | Full registry documents to insert, one per new MBID, with pre-assigned `artistId` values. |
| `reusedArtists` | Existing registry artists the plan relies on. |
| `review` | `USER_OWNED_CREDITS`: exact matches on contributor- or moderator-owned credits, with the proposed MBIDs. They link only through a reviewed correction or a plan made with `--link-user-owned`. |
| `flagged` | `MULTIPLE_RELEASE_GROUPS`, `SOURCE_CONFLICT` (input datasets disagree), `INVALID_SOURCE_CREDIT`, `CREDIT_COUNT_MISMATCH`, `CREDIT_NAME_MISMATCH`, `EXISTING_IDENTITY_CONFLICT`, and, for [enrichment](#enrichment-from-musicbrainz-release-groups) plans, `ENRICHMENT_UNRESOLVED`. |
| `unchanged` | Already linked to the same identities. |
| `noSource` | A release-group reference with no row in any input dataset (for enrichment plans, no result in the evidence). |

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

   Apply refuses to run if the checksum differs, the plan was edited, or the connected database, the plan target, and `--confirm-target` do not all match. It also refuses, before any write, a plan whose album updates change anything besides adding an `artistId`/`artistMbid` pair that the plan registers or reuses, or that would replace an identity a credit already carries, even if the edited plan was re-sealed with a valid checksum.

### Enrichment from MusicBrainz release groups

Albums whose release group appears in no reviewed import dataset land in `noSource`. For those albums, an operator-only fetcher can collect the missing artist credits by exact release-group MBID, without connecting to MongoDB. The backfill then plans from that evidence, using the same matching rules, ownership protection, and apply as any other source. This tooling is not wired into any user-facing path, and nothing runs automatically.

**1. Fetch evidence** (makes MusicBrainz requests; run it only when explicitly authorized):

```sh
npm run catalog:enrich-identities -- \
  --from-plan ~/rescened-ops/artist-identity/<database>-<date>.plan.json --plan-sha256 <planSha256> \
  --cache-dir ~/rescened-ops/artist-identity/musicbrainz-release-group-cache \
  --out ~/rescened-ops/artist-identity/<date>.credits-evidence.json
```

Pass the import-dataset plan to `--from-plan`; an enrichment plan is rejected, because its `noSource` also lists every album linked from other sources. `--ids-file <ids.json>` takes a JSON array of release-group MBIDs instead. IDs are validated, lowercased, sorted, and deduplicated before any request, with at most 5,000 unique IDs per run. `--from-plan` checks the plan's seal and `--plan-sha256`, then uses its `noSource` release groups.

- **Requests.** Each ID fetches only `release-group/<mbid>?inc=artist-credits&fmt=json`; there is no search by name or title. Every request in the process shares one gate (at least 1.1 seconds between request starts). Requests use an identifying user agent, an eight-second timeout that covers the response body, and a 256 KiB streamed size limit.
- **Retries.** Network errors, timeouts, and HTTP 408/425/429/500/502/503/504 get at most three attempts. `Retry-After` is honored in both formats. A pause over 30 seconds stops the run. Any pause still in force when a run ends is written to the cache as a cooldown, and later runs with that `--cache-dir` refuse to start before it expires.
- **No retries.** Malformed or oversized responses, identity mismatches, redirects, and other client errors are not retried. Redirects are never followed; the result records only a validated destination release-group MBID for review.
- **Stops.** The run stops if five consecutive IDs exhaust their retries, if the time budget (`--budget-minutes`, default 30) runs out, or if it is interrupted. A stopped run keeps its cache and publishes no evidence.
- **Resuming.** Rerun the same command. Only successful results are cached, so each rerun looks up every unresolved ID again; if many IDs stay unresolved, raise `--budget-minutes` or narrow the run with `--ids-file`. Successful results are cached per ID for seven days, in private files written atomically and validated by version, identity, timestamp, shape, and size. An exclusive lock prevents concurrent runs on one cache; a lock is removed only when its owning process on the same host no longer exists.
- **Coordination.** The gate does not coordinate separate processes, and MusicBrainz rate-limits by source IP. Run one fetch at a time, after other operators such as the biography fetch have finished, and account for other clients on the same network address.

Exit `0` means every ID resolved. `2` means evidence was written with unresolved or deferred IDs. `1` means nothing was written.

The evidence (`rescened-musicbrainz-release-group-credits`, schema `1.0.0`) holds exactly one result per requested ID:

- `resolved` results carry the release-group MBID, observation time, title, and ordered credits (`name`, `joinPhrase`, `artistMbid`, `artistName`). Credits use the catalog importer's normalization, and each one must have a valid canonical artist name.
- `unresolved` results carry a reason: `NOT_FOUND`, `REDIRECTED`, `ID_MISMATCH`, `INVALID_RESPONSE`, `INVALID_CREDITS`, or `HTTP_ERROR`.
- `deferred` results (`TRANSIENT_FAILURE`) record the number of attempts and the last failure.

The artifact records the request digest, any originating plan digest, MusicBrainz as the source with its CC0 license, counts, and failure reasons, all under `evidenceSha256`. It is published atomically and never overwrites an existing file. It contains no ListenBrainz rankings or album metadata, and `catalog:import` and `catalog:validate` refuse it (`UNSUPPORTED_ARTIFACT`).

**2. Review the evidence**, especially every unresolved and deferred category. The seal proves integrity, not authorship; anyone can reseal an edited file. The plan step therefore pins the exact digest you reviewed.

**3. Plan from the evidence**, separately for each database:

```sh
npm run catalog:backfill-artists -- \
  --enrichment ~/rescened-ops/artist-identity/<date>.credits-evidence.json \
  --enrichment-sha256 <evidenceSha256> \
  --out ~/rescened-ops/artist-identity/<database>-<date>.enrichment.plan.json
```

`--enrichment` replaces `--input`; the two cannot be combined, and `--resolve-artist-names` is rejected because the evidence already carries verified names. The evidence and its pinned digest are validated before any database connection.

- **Unsuccessful lookups.** An album whose release group was unresolved or deferred is flagged `ENRICHMENT_UNRESOLVED`, with the specific reason, any HTTP status, and any redirect destination. The details add `userOwned` for community or manual credits and `alreadyIdentified` when every credit already carries an identity. Flagged albums do not reappear in `noSource`. To retry deferred IDs, rerun the original fetch, reusing its cache, or list them in an `--ids-file`, then plan from the new evidence.
- **Provenance.** The plan's `inputs` entry records the evidence kind, `evidenceSha256`, and the unresolved and deferred counts. Album updates list their `sourceObservations`. New registry artists take the verified canonical name, and their provenance records the observation time and evidence digest. Existing registry names are never changed.
- **Name conflicts.** If two resolved release groups report different canonical names for one artist MBID (for example, an artist renamed during a long fetch), the affected albums are flagged `SOURCE_CONFLICT`.
- **noSource coverage.** An enrichment-only plan reports every album outside its evidence as `noSource`, including albums already linked by an earlier backfill. `noSource` describes the plan's source coverage, not missing identities.
- **Apply.** It is unchanged. Plan version `1.0.0`, the stored-revision and raw-credit checks, per-album transactions, carrying revisions forward, idempotent reruns, and partial-commit reporting all apply as described below.

Generate a fresh plan per database from the same evidence. Registry artist IDs differ between databases, so never reuse a dev plan elsewhere. Apply to shared dev or production still needs explicit authorization for the named target and the exact reviewed plan.

### Apply semantics

- **Report first.** Before connecting, apply reserves the report path. If it cannot write the final report after commits, it prints the report and `databaseCommitted` to the console.
- **Registry first.** It validates the sealed plan and confirmed target before connecting, then verifies the connected database before building the registry's unique index. One transaction then inserts the planned artists and confirms that each reused artist still exists. If the registry now maps a planned MBID to a different `artistId`, the apply stops with `ARTIST_REGISTRY_CHANGED` before any album changes. In that case, create a new plan.
- **One transaction per album.** Inside its transaction, each album is read through the raw collection and compared with its planned stored revision and exact `beforeCredits`. This avoids Mongoose casting, which would trim legacy names such as `Alpha & ` or add default roles. It sets the new credits, advances `catalogRevision` by one, and carries the album's reviewed baseline and active Last.fm mappings to the new revision, as the cover backfill does.
- **Album outcomes.** A changed album is reported as `conflict` and left untouched. An album that already has the planned credits at the planned revision is `already_applied`. Rerunning the same plan is therefore safe.
- **Pending corrections.** Pending corrections created before an album was linked become stale (`CATALOG_CHANGED`), because its revision advances. This is more likely for user-owned albums linked with `--link-user-owned`. Such a plan therefore records each update's pending corrections as `pendingCorrections`, with `counts.linkedAlbumsWithPendingCorrections` and `counts.pendingCorrectionsMadeStale`, so they can be reviewed before apply. A needs-changes correction is rebased on the current album when it is revised, so linking does not make it stale. A correction approved after planning makes that album a `conflict`, and the correction's credits are kept.
- **Unused registrations.** Planned artists are registered before album updates. An album that then conflicts can leave its new artists unused in the registry. This is harmless, and a new plan reuses them.
- **Partial commits.** Registry and album transactions commit independently. A failed run writes its report with `databaseCommitted` and `completed`, so a partial commit is never mistaken for a rollback. Apply exits `2` if any album conflicted.

## Artist pages (prototype)

`ARTIST_PAGES_ENABLED=true` (server-side, default off) enables everything in this section. While it is off, `/artists` returns `503 ARTIST_PAGES_DISABLED`, album responses omit `artistPages`, catalog search does not expand by identity, and no artist name links anywhere. The flag gates these reads only. Credit identities are not flag-gated: imports, approvals, the backfill, and suggestion or correction forms (including a MusicBrainz prefill) record `artistId`/`artistMbid` and register artists regardless, and album responses carry them. With the flag off, credit link checks and the search page's artist matches stop for five minutes after the first disabled answer, remembered for the tab (see [Artist links across the app](#artist-links-across-the-app)). Opening an `/artist/:id` URL directly still asks for the header and gets the `503`. Every read uses the local `Artist` registry and `AlbumCatalog`; no request contacts a provider. Error codes are in [ERROR_CODES.md](ERROR_CODES.md#artist-pages).

Before enabling it in production, run verified-name backfill planning (see [Verified registry names](#verified-registry-names)). Otherwise headings show provisional credit-derived names.

### Routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/artists/:artistId` | Header: `artist { artistId, name, aliases, creditedAs, musicBrainzUrl }`, `releaseCounts { all, album, ep, single, mixtape, other }`, and `features { discography }`. `other` covers soundtrack, compilation, live, remix, and other. |
| `GET` | `/artists/:artistId/releases?type=&limit=&cursor=` | Linked catalog releases, newest first (year, then release date, then title and `albumId`). Keyset-paged with an opaque cursor that holds no Mongo IDs; `limit` 1–48, default 24. Local search rate limit. |
| `GET` | `/artists/links?ids=` | Which of up to 100 comma-separated `artistId` values have an artist page: `{ artistIds }`, in request order, deduplicated, lowercase. Unknown IDs are left out. Any entry that is not a Rescened artist ID, a list over 100, or any other query field is `400 INVALID_ARTIST_LINKS`. An empty list returns `{ artistIds: [] }` without reading the registry. Read-only; its own `artistLinks` rate limit (120 per minute per IP) plus the global limit. |
| `GET` | `/artists/search?q=&limit=` | Artists whose registry name, reviewed alias, or credited spelling contains the query. `limit` 1–12, default 6. Local search rate limit. |

`GET /albums/album/:albumId` adds `artistPages: { artistIds }`: the credited `artistId` values that resolve to a registry artist. The frontend links only those credits to `/artist/:artistId`. Name-only and unresolved credits stay plain text.

### Artist links across the app

Artist names link to `/artist/:artistId` wherever the app shows a local catalog album's artist line: search and genre results, the home page (new, popular, featured, ranked, community lead, and review queue), profile pins, favorites, saved albums, reviews, activity, rankings, top albums and the diary calendar, queue, board items, review permalinks, and the approved feed. A credit becomes a link only when all three hold:

1. The album response carries a credit with an `artistId`. Name-only credits never link, and a display name is never split or matched, so homonyms stay separate.
2. The API confirmed that `artistId` has a registry artist. Album detail does this with `artistPages.artistIds`. Every other surface asks `GET /artists/links` once for the credits on screen (batched within about 25 ms, up to 100 per request) and caches the answers for the page session.
3. Artist pages are enabled. While the flag is off, or on an API without the route (`503 ARTIST_PAGES_DISABLED`, or an uncoded 404/503), the first check ends link lookups for five minutes and every credit stays plain text. That stop is remembered in the tab's `sessionStorage`, so later page loads in the tab do not ask again during those five minutes; the search page's artist matches read and set the same stop. A stored value is trusted only up to five minutes ahead, and blocked storage falls back to the in-memory stop. A later page render asks again after that, so a passing proxy `503` cannot disable links for a whole visit. A failed or rate-limited check leaves its credits unlinked and is not retried for 60 seconds. Nothing retries on its own.

Until a check finishes, and whenever it fails, the line is exactly the stored display name. When some credits link, the line keeps the display name's own wording and punctuation ("A & B feat. C") if every credit appears in it, in order, as a whole name; otherwise the credits are listed by name, comma-separated, in stored order. Credits without an ID inside a mixed line stay plain text.

Anchors cannot nest, so a card that opens an album is a container (`CardLink`) and only its title is the album link (`CardTitleLink`). The title link's `::after` stretches over the whole card, and artist links sit above it. The card still opens the album from anywhere except an artist name, keyboard focus reaches the album link and each artist link separately, the album link's name is the visible title, and artist links are underlined rather than marked by color alone. Draggable lists (the owner's queue and board items) pass `draggable={false}` to every link so a drag still reorders.

Album-bearing summaries that feed these surfaces now include the album's `artistCredits`: listening stats top albums, track-ranking entries, board picks, the diary calendar, and genre browse cards. The credits are the same public shape other album responses already return.

Not linked, by design: MusicBrainz external candidates ("Not in Rescened"), contributor suggestion and correction forms and moderation queues (proposed text, not catalog identity), pickers and selection lists (profile favorites editor, board pick, search suggestions, Last.fm detections), the listening log's expandable button rows, notification sentences, and track-level artists (tracks carry no artist identity).

### Linked releases

A release is on an artist's page only when one of its credits carries that artist's `artistId`. A release with no stored `releaseType` counts and filters as an album. A release credited to several identified artists appears on each of their pages. Cards keep the album's own credits, in order, and mark a featured role or a collaboration. A card is a collaboration only when the release credits another party: a credit with a different `artistId`, or an unresolved credit, which stays plain text. Several credits that share the page's `artistId`, such as two spellings of one performer, are not a collaboration. Names are never compared, so an unresolved credit spelled like the artist still counts as another party. Display names are never split, and homonyms remain separate artists. The page lists catalog releases only. It is not a complete discography.

`creditedAs` lists up to 20 credited spellings on linked releases that differ from the registry name, most used first. The header lists them; album credits keep their own wording, and the registry name is not changed.

### Header cover art

The header picture is **release cover art that is already stored in the Rescened catalog**, not an artist photo. Rescened does not fetch artist images from Wikidata, Wikimedia Commons, or any other provider, so no image licensing, attribution, or refresh pipeline is involved; covers carry the same status they already have on release cards.

`GET /artists/:artistId` returns `covers`: up to 8 `{ albumId, title, releaseYear, cover }` entries (public fields only, no Mongo `_id`). They come from one bounded `AlbumCatalog` query (the newest 60 releases credited by `artistId` that have a stored cover), then:

- a release qualifies only when this artist's credit, matched by `artistId` and never by name, has the role `main` (a missing role counts as `main`); a featured or guest credit does not put that release's art in the artist's header;
- releases with no other credited party come first, then collaborations; each group stays newest first;
- the cover must be an `https` URL without credentials and at most 2,048 characters; releases sharing one image count once.

The list is empty when nothing qualifies. An older API that omits `covers`, or an empty list, leaves the header as it was.

The page (`ArtistCoverCycle`) shows one cover at a time with a caption that links to the release (`/album/:albumId`). The carousel has an accessible release-art label; secondary explanatory header copy is omitted. Behavior:

- Several covers advance every 6 seconds with a short fade. Previous and next buttons always work and wrap.
- It stops advancing while the pointer is over it, while keyboard focus is inside it (mouse clicks do not count), while the tab is hidden, and after the person presses Pause. Play resumes it. A Pause control is provided because the content moves for more than five seconds (WCAG 2.2.2).
- With `prefers-reduced-motion: reduce` it never advances by itself, does not fade, and has no Play/Pause control; previous and next remain. The preference is followed live.
- The caption is a polite live region only while the cycle is not advancing by itself, so a screen reader is not interrupted every turn. A group of several covers is announced as a carousel of slides ("2 of 5"); a single cover is plain.
- A cover that fails to load is dropped from the cycle. One cover shows no controls and never moves. With no usable cover the component renders nothing and the header returns to its text layout (the two-column layout applies only while the cycle is rendered, via `:has()`). Below 640 px the title and About section come first, followed by the cover.

There is no new flag: the data is local and rides the already flagged artist page. Images are loaded by the visitor's browser from the stored cover URLs, exactly as release cards load them, and the artist route makes no provider request.

### Search aliases

Aliases attach to one stable `artistId` and never merge artists. They come from two sources:

- **Credited names.** Every spelling under which an `artistId` is credited, such as a Hangul credit on one release and a Latin one on another.
- **Reviewed aliases.** `lib/artists/reviewedAliases.js` is a small reviewed table of native-script and alternative names with optional BCP 47 `locale` tags. It is keyed by MusicBrainz artist MBID, because each database assigns its own random `artistId`. At read time an entry attaches to the registry artist with that MBID; an MBID absent from the registry is unused. Entries are validated at load: lowercase MBIDs, NFC names, no duplicates. Add an entry only with a reviewed source and tests.

Matching uses the catalog search normalization: case-insensitive, canonical Latin accents and apostrophes folded, and other scripts compared exactly, with no transliteration. Artist search ranks an exact registry name first, then an exact alias or credited name, then prefix and substring matches, then by linked release count. Same-named artists stay separate results and show release counts and up to two release titles.

While the flag is on, `GET /search/search` also includes releases linked to any registry artist whose name or reviewed alias equals the whole query. For example, `방탄소년단` finds releases credited to `BTS`. These releases rank with exact artist matches, after the curated preferences in `routes/utils/searchArtistAliases.js`, which are unchanged. Partial queries never expand.

The full results page shows matching artists above album results on page one, without a genre filter. Any artist search failure, including the disabled flag, omits that section.

### Indexes and cost

`AlbumCatalog` gains a sparse index on `artistCredits.artistId`, which serves the header, release, and album-detail reads. Artist search scans registry names, and the catalog's credit names, with regular expressions, as catalog search already does. It orders the capped candidate lists by exact, prefix, then substring match, so a common short query cannot crowd out an exactly named artist. With the flag on, every catalog search page also runs a case-insensitive anchored regex over registry names; `Artist.name` has no index, so this scans the registry. Measure both before relying on them for a large catalog.

On page one, the results page calls both `/search/search` and `/artists/search`, so it spends two points of the shared local-search rate limit. Credit links add at most one `/artists/links` request per batch of newly shown credits, from a separate bucket. While the flag is off, the first disabled answer from either request stops both for the tab for five minutes. On a first search both can already be in flight, so that first search may send both before either answer arrives. The header route `GET /artists/:artistId` uses the shared local-search rate limit (90 per minute per IP), like the releases and biography routes; an artist page view costs about three points (header, biography, first releases page) plus one per further page.

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

- `tests/artistEnrichmentEvidence.test.js` covers the evidence contract: ID normalization and limits, plan-derived IDs, sealing and tamper detection, exact result accounting, per-reason outcome rules, canonical-name and normalization checks, digest pinning, atomic no-overwrite publication, and importer refusal.
- `tests/artistIdentityEnrichment.test.js` covers the release-group fetcher with injected fetch, clock, and gate: endpoint and headers, shared pacing, retry limits, both `Retry-After` formats, persisted cooldowns, redirects, malformed or oversized bodies, body timeouts, interruption, the breaker, the budget, cache validation and resume, locking, and CLI exit codes. A trimmed CC0 MusicBrainz fixture is the only provider payload.
- `tests/artistIdentityEnrichmentPlan.test.js` covers `--enrichment` and `--link-user-owned` argument rules, opted-in linking of user-owned credits with every other safeguard in place, planning from evidence (verified names, legacy join phrases, community protection, `ENRICHMENT_UNRESOLVED`, existing registry names), and CLI validation before connecting.
- `tests/artistNames.test.js` covers exact-ID lookup, rate limits, bounded retries/timeouts, response validation, private-cache reuse/resume, and credited-name preservation. All provider responses are fixtures.
- `tests/artistIdentity.test.js` covers the identity helpers, model invariants, submission validation, importer planning, backfill classification and sealing, the checked-in seed dataset as a source, and the frontend credit helpers.
- `tests/artistPages.test.js` covers the collaboration badge (duplicate same-ID credits, distinct and homonymous artists, unresolved credits), reviewed-alias validation, search-key folding, query parsing, the search pipeline expansion, the feature flag, and the frontend credit and release helpers.
- `tests/musicBrainzDiscography.test.js` covers the browse URL, a captured CC0 browse fixture, artist-credit verification, type filtering, raw-offset paging with empty filtered pages, the offset cap, caching and in-flight sharing, the shared rate gate, the streamed response-size limit, cursor binding, catalog reconciliation, and suggestion availability. `tests/artistPages.test.js` covers the discography route flag, safe 502 diagnostics, and the count wording.
- `tests/artistDiscography.browser.test.js` is opt-in (`RUN_FRONTEND_BROWSER_TESTS=true` with Playwright). It checks repeated clicks, filter changes and unmount during in-flight requests, empty batches, the hidden suggestion action, and 390 px overflow, with fetch stubbed in the page.
- `tests/artistCovers.test.js` covers cover selection (main credit by identity, solo before collaboration, https-only, de-duplication, the cap, public fields only), the cycle helpers (wrapping, dropping failed covers, auto-advance conditions), and the component and style contract.
- `tests/artistCoverCycle.browser.test.js` is opt-in (`RUN_FRONTEND_BROWSER_TESTS=true` with Playwright). With images stubbed and time controlled, it checks advancing and wrapping, stopping on hover, keyboard focus, a hidden tab, and Pause, reduced motion, the fade, and broken, single, and missing covers.
- `tests/artistLinks.test.js` covers link-query validation, the flag on `/artists/links`, credited-ID collection, display-line segmentation (wording kept, whole-name matching, homonyms, name-only credits), the link store (batching, caching, cool-down without self-retry, the disabled stop), and a source guard that no `ArtistCredits` sits inside another link and external candidates stay plain. `tests/artistLinks.component.test.js` renders the real credits, card, ranked list, and review queue to static markup (it skips without `npm --prefix frontend ci`) and asserts the links, their text, and that no anchor nests.
- `tests/artistPages.integration.test.js` covers artist headers, keyset release paging and type filters (including untyped rows and equal-title ties), multi-credited releases, homonyms, the search candidate cap, alias and credited-name search, identity search expansion with the flag on and off, album-detail link resolution, stored main-credit header cover selection, and `/artists/links` (unknown IDs, duplicates, homonym IDs, bounds, the flag). It fails if any request leaves the test server.
- `tests/artistIdentity.integration.test.js` covers the transactional paths on a replica set: import registration and idempotency, approval resolution and conflicts, and backfill planning without writes, target refusal, guarded apply, mapping carry-forward, rerun, and registry drift. Two enrichment scenarios plan from evidence and apply (new and reused artists, provenance, unchanged credit wording, community protection, carrying revisions forward, rerun), and show that a correction approved between planning and apply is a conflict. A third scenario links community and manual credits under `--link-user-owned`: it keeps their credit provenance and wording, lets a later correction win, and checks that a rerun is idempotent.
- `tests/artistProposals.test.js` covers the proposal and selection contract (unknown and client-owned fields, keys, positions, explicit reuse, unattached proposals, evidence rules), observation preparation (missing, redirected, and nameless artists, bounded fields, provider failures), community and observed-MusicBrainz construction, resolution with a fake registry (wording and role preservation, no rename on reuse, same-name community artists, already-linked credits, tampered stored proposals, registration races), request-key digests and collisions, `expectedRevision` validation, approval-retry matching, and receipt model invariants.
- `tests/artistDiscovery.test.js` covers the MusicBrainz artist adapter with injected fetch and clock (URL escaping, identifying header, mapping and bounds, empty and malformed responses, timeout without retry, throttle cooldown and cap, the pending bound and coalescing, cache expiry and eviction, exact lookup including not-found caching and redirect refusal through proposal preparation) and the picker routes (sign-in, flag off by default and independent of artist pages, same-name artists, exact registered MBIDs, throttle and outage responses without provider URLs, local results during an outage).
- `tests/artistPicker.browser.test.js` is in `npm run test:browser`; see [verification](VERIFICATION.md#explicit-synthetic-browser-suite).
- `tests/artistSuggestions.integration.test.js` runs the contributor and moderator routers on a replica set with a fixture MusicBrainz adapter: mixed existing, reused, new and same-name community links published by one approval with wording intact; no artist before approval; evidence absent from summaries, the queue, the catalog and the registry; bulk exclusion; required and stale `expectedRevision`; link-existing refusal; idempotent approval retry; request-key replay, conflict and concurrent creates; invalid links, redirects and provider throttling storing nothing; flag-off refusal with legacy creates, reads, rejection and approval still working; revisions keeping observations; rollback at each approval write; concurrent approvals; and a deterministic stale correction-approval interleaving.
- `tests/artistSubmissions.test.js` covers the standalone request contracts, summaries without evidence or notes, and model invariants. `tests/artistSubmissions.integration.test.js` runs the routers on a replica set: privacy, `401`/`403`/`404`, missing and stale revisions, the transition matrix with one audit event per command, request-key replay and concurrent creates, observation and exact-MBID reuse without renaming, `ARTIST_ALREADY_EXISTS`, duplicates of imported artists, same-name separation, gates with reads intact, rollback at the artist and transition writes, concurrent approve/reject and withdraw/approve races, zero-album artists, and one artist when a standalone and an album suggestion approve the same MBID at once. `tests/artistSubmissions.browser.test.js` is in `npm run test:browser`.
- `tests/correctionLinks.test.js` covers `artistLinks` normalization against raw credits (positions past twenty, duplicates, out of range, already linked, more than twenty links, wording fields, combination with `artists`), summaries without evidence, the advisory diff, re-import protection, bulk exclusion, and the required correction `expectedRevision`. The integration suite approves links on a raw 25-credit legacy album with byte-for-byte credit checks, a partial approval, flag-off refusal and fail-closed revision, and a raw-credit change without a revision bump; `tests/artistIdentity.integration.test.js` runs the identity backfill against an artist-link correction in both orders, and a correction followed by a fresh additive backfill and a re-import that tries to replace the moderator-approved identity (plus the same for a manually owned identity).
- `tests/artistLinkPayload.test.js` covers the client mapping (exact-MBID proposal sharing, separate community proposals, restored links keeping explicit shared keys, fresh keys never colliding with restored ones or across kinds, and the real `SuggestionForm` payload with linking on and off). The integration suite also round-trips a shared community proposal through a revision with the frontend mapping and replays saved requests after a genre rename and an expired edition preview; the browser fixture checks that a pending or failed capability check holds back a linked revision instead of dropping its links. `tests/artistSuggestionForm.browser.test.js` is in `npm run test:browser`.
- `tests/artistProposals.integration.test.js` runs on a replica set: community artists persist without references, artists created in an aborted transaction roll back, an exact-MBID registration race retries and reuses the committed artist, a concurrent burst leaves one artist per MBID, approvals write receipts and enforce the reviewed revision (including corrections' applied fields), stale moderation commands are refused, and request keys deduplicate concurrent creates per contributor.

## Known limitations

- Older datasets and community-only registrations may still have provisional credit-derived names. Provenance distinguishes those from verified MusicBrainz artist names. Existing registry names are not renamed automatically.
- Surfaces that render an album from a response without `artistCredits` (an older API) show plain text. Link checks run in the browser after a page renders, so a credit becomes a link a moment after its text. A credit already checked on the page costs no further request.
- Credits without an MBID stay unlinked. There is no name matching, and the suggestion and correction forms have no artist search or picker. Contributors can propose identity only through a MusicBrainz prefill or by keeping an existing credit's name.
- Moderator details show a credit's `artistId` and MusicBrainz link. They do not show the registry artist's own name.
- User-owned credits are linked only when a plan is made with `--link-user-owned`. Otherwise, link them through reviewed corrections.
- Legacy migration and the importer's provider adapters still drop join phrases from credits.
- Listening stats and activity still use credit names. Catalog search expands by identity only for exact registry names and reviewed aliases, and only while artist pages are enabled.
- Reviewed aliases are a checked-in table, not stored registry data. There is no alias editor or MusicBrainz alias import yet.
- Artist pages have no artist photo; the header shows stored release cover art, which is not a portrait (see [Header cover art](#header-cover-art)). Cached, flagged Wikipedia excerpts are described in [artist biographies](ARTIST_BIOGRAPHIES.md). The MusicBrainz discography is flagged off by default, reads its total before local filtering, and has no persisted cache.
