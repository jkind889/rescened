# Automatic album listens: first release scope

Status: Persistent Last.fm syncing and reviewed name-mapping pilot implemented behind disabled flags. Automatic diary publication remains unimplemented. No deployment or data import is implied.

Last reviewed: 2026-09-26.

The current release verifies Last.fm accounts, retains future scrobbles privately, and builds moderator-reviewed album-name coverage. **It creates no diary entries and performs no album-completion counting.** See the [persistent pilot runbook](LASTFM_SYNC.md) for its contracts, controls, and rollout requirements.

The later automatic-listening release will use **80% of one reviewed standard tracklist per album**, with automatic logging and undo/delete. Recognized edition names map to the existing album; bonus tracks cannot substitute for standard tracks. Manual entries stay independent. Edition-specific automatic detection is deferred.

Approved mappings certify album identity only. Nonempty catalog tracks do not certify a reviewed standard baseline. Study mappings and IDs are never automatically promoted into production; seed candidates require explicit public catalog bindings and a reviewed environment-specific dry-run.

## Current v1 decision — 2026-09-25

Reviewed artist-specific edition-name mappings now run in the standalone study, using a hash-pinned standard reference. The first entry maps three Born to Die names to one standard baseline. The [study runbook](LASTFM_LISTENING_STUDY.md#reviewed-album-name-mapping--standard-baseline-v1-study) covers commands and the three captured playback windows. Unknown/ambiguous mappings remain unresolved. This does not add catalog/schema changes, account UI, or diary writes.

Manual entries remain independent: a user may deliberately add a separate manual entry after an automatic standard-album listen. Automatic syncing must not merge, overwrite, remove, or suppress it merely because album/date overlap. Explicit deluxe labels in the manual UI are separate future work. Automatic session receipts still prevent retries from duplicating automatic entries.

The earlier edition-model discovery and architecture proposals below are retained as later-phase context, not prerequisites for this standard-baseline v1. The current v1 decision supersedes edition-specific threshold and manual-overlap assumptions in that earlier proposal. The frozen pilot scores remain historical evidence and are not retroactively relabeled as passes.

The frozen pilot scores remain historical evidence, not production coverage estimates. The current priority is safe ingestion and reviewed name coverage; counting stays a separate release. The [study runbook](LASTFM_LISTENING_STUDY.md) retains the original sample, gates, diagnostic revisions, and subsequent playback results.

## Historical proposal: later counting and edition work

The sections below preserve earlier design exploration, not the current sync-only release contract. Their proposed flags, publication steps, session storage, and edition prerequisites are not implemented by the persistent mapping pilot. Current operations are documented only in [LASTFM_SYNC.md](LASTFM_SYNC.md).

### Phase 0: resolve edition identity and tracklist acquisition

The two prerequisites are connected: a release group represents the album concept, while its releases can have different tracklists. We need the denominator for the edition being played. A ten-track edition requires eight qualifying tracks; an eighteen-track edition requires fifteen. A listener whose first eight tracks appear on both editions has not supplied enough evidence to choose the ten-track denominator.

Repository inspection established that:

- The importer identifies catalog albums by MusicBrainz release group and initializes `tracks: []`.
- The optional `representativeReleaseMbid` is taken from ListenBrainz `caa_release_mbid`/cover candidates. It is a cover-associated release, not a verified standard edition or the user's playback edition. Keep artwork-source selection separate from tracklist selection.
- Existing embedded tracks have local IDs, positions, titles, durations, and artist display names, but no per-track external recording/release-track references or edition relation.
- Existing listens relate to the public catalog album only. Changing the catalog from release groups to releases would affect established diary/social references and is not required merely to support edition-aware listening.

### Proposed model to evaluate

Preserve each existing public `albumId` as the album identity used by reviews, boards, and diary entries. Add subordinate edition data rather than creating a competing album page for every pressing. A candidate `AlbumEdition` model would relate to `AlbumCatalog` and carry a local UUID `editionId`, typed MusicBrainz release reference(s), medium/track structure, source provenance, completeness/review state, and a revision. Final schema and the treatment of equivalent regional/format releases remain discovery decisions.

Each edition needs stable local track identities and separate typed external references for MusicBrainz release tracks and recordings. A recording can occur on multiple releases and albums; a recording match alone does not identify the edition. Preserve legitimate repeated track positions, and do not collapse an edition's denominator merely because multiple positions link to the same recording.

An eventual automatic session and listen must retain the selected edition and a versioned tracklist/counting snapshot. Existing manual listens can remain album-level with no edition selected. Determine how the current `AlbumCatalog.tracks` field will serve existing UI/community corrections without destructive replacement or automatic overwrites of owned metadata.

### Discovery and later implementation prerequisites

1. **Catalog audit:** an environment-specific read-only report of release-group/release references, nonempty versus verified-complete tracklists, manual/community ownership, and conflicting identities. Repository inspection is not this report.
2. **Release sampling:** inspect a bounded representative sample spanning standard/deluxe, regional bonus tracks, remasters, multi-disc sets, duplicate titles, and missing data. Compare paginated MusicBrainz release discovery and complete release lookups. Record completeness, source identity, and selection ambiguity; do not assume the first, shortest, earliest, or cover-associated release is correct.
3. **Playback evidence assessment:** determine which normalized Last.fm fields reliably distinguish those sampled editions. Test missing MBIDs, misleading edition titles, and shared track sequences. Use provided/authorized anonymized evidence or permitted fixtures; do not assume Last.fm always supplies an exact release identity.
4. **Decision record:** settle edition representation, equivalent-release handling, completeness validation, ownership/refresh rules, and an evidence hierarchy for selecting an edition. Exact edition identifiers, when present, must be resolved and verified against the album; text/sequence evidence needs explicit ambiguity handling.
5. **Tracklist acquisition scope:** define the versioned artifact contract and reviewable dry-run/apply process needed to populate edition data from MusicBrainz while preserving local IDs and manual/community fields. Assess provider request volume and refresh costs. Any later apply still requires explicit authorization for its named target.

**Edition-specific rule:** counting needs a verified complete edition tracklist and sufficient evidence that the session used that edition. Ambiguous sessions remain unresolved; never select the shortest matching edition. A shared-standard product rule is permitted only if the separately evaluated fallback passes its own pilot gates. It is not a per-session shortcut for ambiguous edition-specific evidence.

Last.fm may be insufficient for fully automatic edition identification in some cases. Quantify that limitation before committing to it as the first playback source. The accepted 80% rule is a product requirement; a provider must supply enough evidence to support it.

## Existing foundations and the main prerequisite

- `models/Listen.js` already records an album relation, public `listenId`, and `listenedOn` calendar date. Multiple listens per album per day are allowed.
- `routes/utils/listeningDiary.js` already handles transactional creation, date correction, deletion, and current catalog serialization. `ListenCreation` receipts survive deletion so retries cannot recreate deleted listens.
- `routes/utils/listenActivity.js` exposes listens through existing activity feeds. Boards are optional attachments; an automatic listen should create neither a board membership nor an explicit save.
- `frontend/src/Pages/EditProfile.jsx` is the existing account-settings entry point. The existing diary API has edit/delete support, but the inspected album/board listening interfaces do not provide the complete automatic-listen management experience.
- `AlbumCatalog.tracks` supports local track IDs, disc/track positions, and optional durations, but an array's presence does not certify its completeness. The [current importer](CATALOG_IMPORT.md#dataset-contract) deliberately creates albums with empty tracklists and matches MusicBrainz release groups, not a complete catalog of editions.

**Tracklist and edition readiness are prerequisites.** After Phase 0 settles the model and acquisition plan, begin with a reviewed set of catalog albums and their complete edition tracklists. Produce a read-only readiness report first; no claim about current production coverage follows from inspecting repository code. Any catalog corrections use existing approved workflows. Broad population is a separately reviewed prerequisite workstream, not an implicit side effect of connecting Last.fm.

Any pilot eligibility manifest must reference both public album and edition IDs, relevant revisions, complete tracklist hashes, and edition/source evidence. It cannot substitute for resolving the edition model. A changed revision requires re-review before starting new sessions. Existing sessions retain their baseline; revalidate eligibility before publication and hold sessions whose track identity changed. This avoids treating an arbitrary nonempty or partial tracklist as a complete album.

## User experience

1. In account settings, connect a Last.fm account and explicitly enable automatic album logging. Explain the 80% rule, the need to scrobble from their player, supported catalog coverage, and that logged entries follow existing profile privacy.
2. Confirm an IANA timezone for automatic dates. Track future listening from activation; do not import the user's entire history.
3. Sync in the background while the site is closed. Show the last successful sync, paused/unavailable status, and a bounded manual retry action.
4. Show a private list of recent detected album sessions with progress such as “7 of 10 tracks” and understandable reasons for holds: unknown album, ambiguous edition/track, unavailable complete tracklist, or interrupted sync.
5. When a session qualifies, create its diary entry automatically. Label it “Automatically logged” and let the owner inspect the reason, correct its date, or undo/delete it. Deletion suppresses re-creation from the same source session.
6. Pause or disconnect stops future ingestion and publication, including in-flight work. Retain existing diary entries. Resuming starts a new activation window; paused-period history is excluded in this first version.

Manual logging stays available. Use “album listen” or “automatic listen”; do not imply that scrobbles prove every second of the album was heard.

## Proposed counting rules: version 1

| Decision | First-release rule |
| --- | --- |
| Eligible releases | Reviewed catalog albums and EPs; other release types deferred for the pilot. |
| Evidence | A timestamped, recorded scrobble. Ignore `nowplaying` rows even if they include other useful metadata. |
| Threshold | `ceil(0.8 × total tracks on the reviewed standard baseline)` distinct matched standard track positions/local IDs. |
| Repeats | One track contributes once per session, regardless of repeats. Shuffle is allowed. |
| Session boundary | Proposed two-hour gap and 24-hour cap. Partition by user and canonical album across recognized edition names; unknown album mappings stay unresolved. Other albums do not extend this session. |
| Publication | At the first qualifying reconciliation, after the bounded fetch window is complete; do not wait two hours to publish. Later tracks extend coverage without creating another entry. |
| Listening date | Calendar date of the session's first qualifying track event, in its saved timezone. Crossing midnight does not split a session. |
| Replay limitation | Back-to-back repeats within the same session produce one automatic entry in v1. Separate sessions can produce multiple same-day listens; manual logging can record additional replays. |
| Runtime | No listened-runtime threshold in v1. Track durations do not tell us how long the person actually listened. |

For a ten-track album, seven different scrobbled tracks do not qualify, eight do, and playing one track ten times counts as one. For a three-track EP the threshold rounds up to all three. A one-track album can qualify from one scrobble; that is an explicit consequence of track coverage, not proof of full runtime.

Freeze the edition identity, complete edition tracklist snapshot, counting-rule version, and timezone for each session. Later configuration or catalog changes must not silently rewrite previously logged listens. Threshold changes apply only to new sessions. Late events that would change a published session's date, edition, or boundaries are held for reconciliation rather than moving or duplicating that entry automatically.

## Matching and duplicate handling

- Match only to existing `AlbumCatalog` records and approved edition tracklists/local track identities. Imported scrobbles never create public albums or overwrite catalog metadata.
- Prefer verified, correctly typed external identities where available. Last.fm IDs may be missing; do not assume a track MBID is a Rescened track ID or that a release MBID identifies a release group.
- A fallback may use conservative normalized artist, album, and track text only when it resolves uniquely within a reviewed baseline. Preserve edition qualifiers and track version distinctions. Do not strip “deluxe,” “live,” or “remaster” to force a match.
- Hold ambiguous editions, duplicate track titles, missing album names, and unknown albums without counting them. Replaying the same evidence must not move it to a different album automatically.
- Persist normalized event fingerprints using source account, timestamp, and stable normalized track identity; test page overlap and restarts. Last.fm does not document a unique scrobble ID in this response, so identical events at the same timestamp must be handled conservatively. Metadata corrections can also change fingerprints; do not promise perfect source-event identity.
- Give each persisted session a stable public UUID and a unique publication receipt. Event fingerprints alone are not the diary idempotency key. Reprocessing or deleting evidence must not mint a new identity for an already handled session.
- Manual entries are independent of automatic sessions. Do not merge or suppress them because album/date overlap. Preserve intentional manual repeats and never impose a user/album/date unique index.
- For manual logging after an automatic entry exists, show the existing entry and require an explicit choice to log another. Check concurrent manual/automatic creation under a shared per-user/album/date coordination mechanism; a query alone is insufficient to prevent races. Scope this coordination without changing manual request idempotency or silently merging entries.

## Deferred automatic-listening implementation slices

These slices begin only after Phase 0 decisions and the necessary edition/tracklist foundation are resolved. They are not authorization to bypass those prerequisites.

### 1. Eligibility and counting engine

Add a read-only readiness report and a pure, versioned session/counting module under a focused `lib/listeningImport/` directory. Feed it small synthetic or permitted captured fixtures. Produce detected sessions and reasons without publishing diary entries. Validate the reviewed baseline/manifest before accepting it.

After the edition foundation exists, demonstrate that full edition tracklists, repeated tracks, ambiguous shared sequences, session gaps, and threshold boundaries behave predictably before wiring a live account.

### 2. Last.fm connection and ingestion

Add a small Last.fm adapter and private connection API. Use Last.fm's authorization flow to verify control of the selected account; typing another person's public username is not sufficient for automatic diary attribution. Bind the one-time connection attempt to the authenticated Clerk user with expiry, callback validation, and replay protection. Store provider credentials only on the server; never log callback tokens or secrets.

The public recent-tracks method does not require a user session key. Minimize retained credentials after identity verification; specify whether to discard the returned session key during implementation. If it is discarded, Last.fm-side authorization revocation cannot be treated as a detectable stop signal for public reads: Rescened's own pause/disconnect controls must be explicit. Do not claim private-history access without verifying supported provider behavior.

Add one private connection per Rescened user with verified source account, activation windows, timezone, status, sync cursor, and revision. Add normalized event storage and persisted sessions with rule/baseline versions, track coverage, stable IDs, publication outcome, and suppression state. Keep source usernames, raw events, and matching diagnostics out of public profile responses.

Start with a proposed five-minute sync cadence, subject to the shared provider request budget. Use a separately runnable worker with durable Mongo leases and fencing, not browser polling or an unguarded timer in every API process. Support bounded work per run, restart recovery, and deployment supervision; no new queue infrastructure is required for the pilot.

Read bounded `from`/`to` windows, paginate all pages before marking a window complete, and use an overlap for delayed scrobbles. Proposed late-arrival horizon: 48 hours. Resume partial windows durably; never advance past unprocessed pages after a failure or page budget. Entries arriving outside the horizon may be missed and must be documented. Exclude events outside activation windows. Use provider-aware timeouts, a shared request gate, bounded retry/backoff, and `Retry-After`; errors must not affect the manual diary.

### 3. Transactional diary publication

Extend the internal diary service rather than making the worker impersonate a browser request. Add minimal origin/session and edition linkage to `Listen`, treating existing records without origin as manual and permitting existing manual entries without an edition. Keep public Rescened IDs and current-catalog display metadata.

Atomically publish the listen and its durable session receipt, with a unique session constraint. Reuse existing transaction-or-503 behavior and deletion receipts. Check connection revision, pause/disconnect state, catalog baseline, and manual overlap at commit time. Guard against worker lease expiry, concurrent workers, late data, and a user deleting or correcting a listen during reconciliation.

Deleting an automatic entry must leave a minimal suppression receipt. Reconnect, worker retries, and overlap fetches cannot resurrect it. Source-side scrobble edits/deletions do not automatically delete diary entries in v1. Local date corrections remain authoritative.

### 4. Settings and listen management

Add a focused connection/settings component from `EditProfile`, plus an owner-only recent-session/automatic-entry view. Reuse existing diary date-edit/delete endpoints and add the minimal private endpoints for connection management, sync status, sessions, and resolving manual overlap. Final route names are implementation details.

Update diary serialization and relevant album/profile/activity presentations for source labeling. Expose only a safe origin label publicly if needed; coverage and source-account details stay owner-only. Apply Clerk authorization, mutation rate limits, strict request validation, existing privacy rules, and disabled-feature handling server-side.

### 5. Pilot rollout and operations

Gate ingestion and publication separately behind disabled-by-default server flags, provisionally `LASTFM_LISTEN_SYNC_ENABLED` and `AUTOMATIC_LISTEN_LOGGING_ENABLED`. With publication disabled, development fixtures and permitted pilot evidence can validate detection without creating diary entries. This is an implementation verification phase; the user-facing release remains automatic.

Set finite private-evidence retention, provisionally 30 days, while keeping minimal publication/suppression receipts for the lifetime needed to prevent resurrection. Ensure retention cannot destroy active reconciliation state. Disconnect removes connection credentials and schedules private raw-evidence cleanup; account deletion must include new private records and receipts. Do not expose listening payloads in logs.

Measure unmatched/ambiguous albums, missing tracklists, sync lag, held manual overlaps, duplicate prevention, and user-deleted automatic entries before widening eligibility. Broader release depends on measured tracklist coverage, not just a successful worker startup.

## Acceptance checks

- Threshold boundaries, repeats, shuffle, short albums, session gaps, midnight/DST, edition mismatches, duplicate titles, and empty/partial tracklists have deterministic fixture coverage.
- Now-playing rows never count; malformed timestamps and unknown provider fields cannot author workflow state.
- Multiple pages, overlapping windows, delayed events, worker restarts, and incomplete fetches do not skip or multiply supported evidence.
- Concurrent workers publish once; delete/undo stays deleted after resync and reconnect. Manual overlaps and manual/automatic races follow the stated rule while intentional repeat entries remain possible.
- Pause/disconnect fences in-flight writes; owner/privacy checks cover status, evidence, and source details. Disabled flags and provider failures leave manual diary operations usable.
- No existing diary entry is reclassified as automatic, and no catalog record, board membership, or saved status is created as a side effect of detection.
- Run `npm test`, `npm run test:integration`, `npm run check:catalog-contract`, frontend lint/build, and browser checks for connect/failure/progress/delete flows during implementation. Extend the catalog guard's scan roots as needed. Normal suites use fixtures; live-provider tests remain explicit opt-in.

## Deferred work and dependencies

Defer direct Spotify integration, live now-playing UI, full-history backfill, configurable personal thresholds, runtime-based completion, exact back-to-back replay detection, and automatic board placement. The standalone Last.fm study precedes edition modeling and catalog population; its outcome determines whether separate editions or one reviewed standard baseline is appropriate. Direct Spotify credentials also conflict with the current repository boundary and need a separately considered change.

Before a public Last.fm rollout, resolve application credentials, provider data-use terms, attribution, and any required permission for public/commercial use. Last.fm's published terms explicitly address those uses; this is a provider-launch dependency, not a reason to defer the offline engine and UI work. Worker hosting and the actual pilot catalog readiness report are also release prerequisites. No production data writes are authorized by this scope document.

## Provider references

Checked 2026-09-24:

- [MusicBrainz release groups](https://musicbrainz.org/doc/Release_Group) and [releases](https://musicbrainz.org/doc/Release): album concepts versus specific issues with medium tracklists, which may themselves be incomplete.
- [MusicBrainz recordings](https://musicbrainz.org/doc/Recording): one recording can be associated with multiple release tracks.
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API): release discovery, pagination, and release lookups with recordings/artist credits.
- [Last.fm recent tracks](https://www.last.fm/api/show/user.getRecentTracks): timestamp filters, pagination, optional now-playing row, and public read authentication behavior.
- [Last.fm web authentication](https://www.last.fm/api/webauth): verification flow and server-side token exchange.
- [Last.fm scrobbling](https://www.last.fm/api/scrobbling): distinction between now-playing and recorded scrobbles, including the partial-track listening threshold.
- [Last.fm API terms](https://www.last.fm/api/tos): data use and attribution requirements. Do not treat Last.fm data as covered by the existing MusicBrainz/ListenBrainz CC0 documentation.
- [Last.fm's Spotify explanation](https://support.last.fm/t/spotify-has-stopped-scrobbling-what-can-i-do/3184): confirms Spotify API integration, without establishing the precise update mechanism or latency.

## Separate matching and identity diagnostics

The offline study now produces separate track-matching and edition/playback reports through `listening:study -- diagnose`. A post-hoc hyphen/featured-credit revision raises full name-query matches from 13/40 to 17/40; the frozen score remains 13/40. Edition selection and actual playback remain separate questions, with all 20 controlled sessions still pending. See the [study runbook](LASTFM_LISTENING_STUDY.md#separate-diagnostic-reports) for reproducible commands and limits. This result does not authorize catalog or diary changes.
