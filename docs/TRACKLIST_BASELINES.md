# Reviewed MusicBrainz standard tracklists

This workflow establishes baseline readiness for future listening detection. It does not count sessions, create diary entries, or create public albums. MusicBrainz core metadata is CC0; artwork, annotations, ratings, and tags are outside this workflow.

## Moderator workflow

Open `/moderation/album-baselines`, a selected catalog album, or the baseline panel on a pending new-album suggestion. Albums, EPs, and mixtapes are eligible for baseline review, queue counts, measurement reporting, and operator enrichment. Other release types remain excluded from this queue. When a MusicBrainz release-group reference is absent, search and explicitly select the group. Discovery searches release-group titles, credited and canonical artist names, and artist aliases. An existing conflicting group reference must be corrected through the catalog correction workflow.

Request a recommendation. The recommender browses up to 150 releases (three pages of 50) and hydrates the top three official candidates. Official releases with an exact title rank first, then releases without special-edition markers in the title or disambiguation (deluxe, expanded, extended, bonus, anniversary, sped-up/slowed, Dolby Atmos/spatial, retailer or platform exclusives, signed, clean/edited, copy-protected, limited, coloured or 180-gram vinyl, remastered, reissue), then releases from the release group's original year, then Digital Media ahead of CD ahead of other formats; date and MBID provide deterministic tie-breakers. Releases ranked equal to the recommendation are its competitors. Hydrated alternatives are returned as `comparisons`, each compared with the recommendation by ordered recording occurrence: `added`, `omitted`, `substituted`, and `moved` tracks, per-disc track counts (`discs`), and `equivalent` when order and disc layout match exactly. Repeated recordings count per position, so equal track counts or recording sets never prove equivalence. A recommendation is ambiguous when a hydrated competitor is not equivalent, or when an uninspected competitor lists a different track count. `coverage.browse` reports unique releases listed against the browse total; duplicate rows, changing totals, or a unique-release count that does not match the total keep browse coverage incomplete; `coverage.hydration` lists inspected, `failed` (with codes), and `uninspected` competitors left by the three-lookup cap. `incomplete` is true when either is partial, so four equally ranked releases with three hydrated are never presented as fully compared. Date and MBID choose a representative only among equivalent competitors. Recommendation is advisory and always requires moderator confirmation. Review the full ordered tracklist, edition details, country, date, format, source link, and incomplete/ambiguous discovery notices. Neither the shortest tracklist nor the artwork release is automatically standard.

Browse alternatives or paste a MusicBrainz release URL/UUID. The server validates and fetches a fixed provider endpoint and checks release-group identity and complete media/track positions. Missing/partial tracklists cannot be confirmed. Repeated recordings at different positions are preserved.

A reason is optional when you confirm, replace, defer, or revoke; a blank one records a standard note for that action (for example "Tracklist revoked by a moderator."). Defer applies only while no current reviewed baseline or selection exists; use revoke to withdraw a reviewed one. A stale review may still be deferred. A confirmed baseline is a versioned snapshot with local track UUIDs, typed upstream references, source retrieval/license metadata, hash, reviewer, and catalog revision. Replacement creates a new version and preserves history. Ordinary catalog tracks do not establish baseline readiness.

Confirmation fills an empty public catalog tracklist and records provenance. It leaves nonempty tracks unchanged; use an explicit catalog correction to change them. Later catalog revisions make baseline readiness stale until reviewed again. Owner event reads check current validity while retained-event reprocessing catches up.

A stale review cannot reuse its earlier selection, because candidate snapshots are bound to the revision they were previewed against. Suggest or preview a release again, then confirm it; confirmation creates the next baseline version.

**Cover backfill carry-forward.** A cover write cannot change the tracklist. After the missing-cover backfill advances an album's `catalogRevision`, a baseline reviewed at the previous revision moves to the new one in place. It is carried forward with the album's active mappings in one transaction ([Last.fm sync](LASTFM_SYNC.md)). The baseline keeps its ID and version, so detections frozen against it are not held as `stale_baseline`. The head's `targetRevision` and revision advance, and a `carry_forward` audit entry records the revision the baseline was reviewed against. Nothing is carried if the album has already moved past the backfill's revision, or if the review was already stale. If the carry fails, the cover stays committed, the baseline stays stale, and the backfill report marks the row `revisionCarryFailed`.

**Known limitation.** Only an approved catalog correction explicitly invalidates a reviewed baseline: it records an `invalidate` audit event, marks the review `stale`, and queues retained-event reprocessing. The catalog importer also advances `catalogRevision` but does not call this path. Readiness remains safe because every read compares the baseline's catalog revision with the current album, so those albums already report `stale` in the queue and `baselineAvailable: false`. However, no `invalidate` audit event is written, and affected events rely on the worker's stale-mapping scan rather than an immediate reprocessing job. Adding explicit invalidation to the importer is deferred.

A pending submission's selection remains private and binds to its revision. Approval of a new album publishes the selected baseline atomically with the album, even if `TRACKLIST_BASELINE_MODERATION_ENABLED` was disabled after the selection was confirmed, because the confirmation already passed that gate; approval without one remains allowed and leaves enrichment pending. Linking an existing album never applies the suggestion's baseline or tracks. Review that catalog album separately.

## Controls and API

`TRACKLIST_ENRICHMENT_ENABLED=true` permits new provider discovery/preview. `TRACKLIST_BASELINE_MODERATION_ENABLED=true` plus `COMMUNITY_MODERATION_ENABLED=true` permits baseline decisions; with either off, a decision returns `503 TRACKLIST_BASELINE_MODERATION_DISABLED` before it uses a moderation rate-limit point. All default disabled; persisted moderator reads remain available. Clerk authentication and the existing `MODERATOR_USER_IDS` allowlist apply to every endpoint. Configure the existing identifying `MUSICBRAINZ_USER_AGENT` server-side.

Moderator API prefix: `/moderation/album-baselines`.

- `GET /`: filtered queue with cursor pagination; pending work additionally accepts `readiness=ready|unprepared` so candidate-backed enrichment can be reviewed separately from targets that still need discovery. `GET /:kind/:id`: target, current review, history, and capability flags. Kind is `albums` or `submissions`; IDs are public UUIDs.
- `GET /groups?q=...`: release-group discovery.
- `POST /:kind/:id/candidates`: suggested release or another browse page.
- `POST /:kind/:id/preview`: alternative release preview.
- `POST /:kind/:id/{confirm,replace,defer,revoke}`: optional reason (string, at most 1,000 characters), expected baseline/target revisions, and request UUID. Confirm/replace reference the server-held release/hash snapshot; clients cannot author tracks or reviewers.

Mutations use MongoDB transactions and optimistic revision checks. Stale commands return 409; unavailable transactions return 503. Provider failures cannot block ordinary album approval without a baseline, catalog reads, or manual diary use. Provider calls are bounded, cached, and share the listening MusicBrainz request gate. Normal tests inject provider fixtures.

## Existing-catalog enrichment

This operator command is independent of Last.fm connections. It scans a bounded, album-ID-ordered batch of albums, EPs, and mixtapes and reports current baselines, missing groups, conflicts, unavailable results, and candidate releases. Supply configuration externally; it does not load repository `.env` files.

```sh
npm run catalog:enrich-tracklists -- --dry-run --environment pilot \
  --limit 20 --output /private/path/tracklist-plan.json
```

The default mode is dry-run. It performs catalog reads and explicit MusicBrainz requests, using private process-local pacing/cache rather than writing provider-budget/cache collections. It never activates baselines or fills tracks. Keep the report and printed SHA-256. The printed summary counts each batch's outcomes (`byStatus`), groups unavailable results by `failureCodes` (`NO_COMPLETE_RELEASE` when MusicBrainz returned no complete official release), and counts incomplete discovery and ambiguous recommendations; it names no albums. These summaries are the pilot's enrichment-failure record, so keep them with the reports. Use the printed `nextAfter` with `--after UUID` to scan another batch.

After inspecting the exact report and receiving explicit authorization for the named target:

```sh
npm run catalog:enrich-tracklists -- --apply --environment pilot \
  --confirm-environment pilot --plan /private/path/tracklist-plan.json \
  --sha256 REVIEWED_SHA256 --reviewer MODERATOR_ID
```

Apply verifies checksum, target fingerprint, and catalog revisions, then queues the captured candidates transactionally. It does not fetch replacement data, confirm baselines, or overwrite tracks. Moderators still inspect and confirm each candidate. Preserve command output with the plan; a committed result is distinct from a rollback.

The moderator workspace opens on **Ready for review**, which contains pending targets with an enrichment-selected candidate snapshot. **Needs discovery** contains the remaining pending albums and suggestions without a selected candidate. Reviewed, stale, deferred, and revoked decisions retain their existing status views. This split changes presentation only: all eligible albums and pending new-album suggestions remain part of the overall baseline backlog.

## Validation and operations

Run `npm test`, `npm run test:integration`, `npm run check:catalog-contract`, frontend lint/build, and browser review checks. Live-provider checks and database applies require separate explicit authorization. Start with a small album/EP/mixtape pilot. Monitor the review queue, per-batch enrichment summaries, and `listening:metrics`. Its `baselineReviews` block counts albums and pending new-album suggestions by effective review status (`pending`, `reviewed`, `stale`, `deferred`, `revoked`), using the same staleness rule as the queue; `pendingWithCandidate` separates candidates queued by an enrichment apply from untouched albums. `baselineReadyNames` and `baselineUnavailableNames` cover approved observed names. Interactive provider failures in the review panel are returned to the moderator and are not persisted. No production rollout or apply occurred during implementation.

Provider contract references: [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), [data licensing](https://musicbrainz.org/doc/About/Data_License). Recommendations inspect one bounded release page and hydrate at most three official candidates; additional alternatives use explicit pagination/preview. Partial discovery is visible and never implies that all editions were compared. The review panel names browse gaps, uninspected competitors, and failed lookups separately from ambiguity, and lists compared releases with their differences. Enrichment dry-run counts of incomplete recommendations now include hydration gaps, not only browse gaps.


## Contributor edition proposals (v1)

New-album suggestions can select a MusicBrainz edition and propose its **unedited** tracklist. `CONTRIBUTOR_EDITIONS_ENABLED=true` and `COMMUNITY_SUBMISSIONS_ENABLED=true` enable contributor discovery; both default disabled. This is independent of moderator discovery (`TRACKLIST_ENRICHMENT_ENABLED`). No browser-side provider credentials or additional frontend flag are needed: the editor reads authenticated capabilities. When discovery is unavailable, ordinary metadata suggestions and persisted reads remain available. The new-album form shows tracks read-only; contributor track editing and edited listening baselines are deferred to v2. Existing catalog-correction behavior is unchanged.

Contributor API, under `/suggestions/editions`:

- `GET /capabilities`: authenticated `{enabled}`; no provider request.
- `GET /groups?q=...`: bounded release-group search.
- `POST /candidates`: `{releaseGroupMbid, offset?}` browses twenty editions, with explicit pagination. It does not run multi-request recommendations or create moderator review episodes.
- `POST /preview`: `{releaseGroupMbid, releaseMbid}` validates a fixed provider endpoint, group identity, complete ordered tracks, hash and provenance; returns `{previewId, candidate, expiresAt}`. UUID or canonical MusicBrainz release URL is accepted. The preview is private to its owner and expires after one hour. Unsupported submission track lengths return `409 EDITION_TRACKS_UNSUPPORTED` without truncation.

These provider endpoints require Clerk authentication, both contributor flags, and a dedicated limit of ten requests per minute per user before provider work. They reuse the existing MusicBrainz cache, shared gate/budget, identifying user agent, bounded response/timeout handling and `Retry-After`. There are no automatic UI retries. Upstream failure does not prevent manual metadata submission.

Create/revise accepts an optional `editionPreviewId` alongside the existing suggestion contract. With it, omit `proposedMetadata.tracks` entirely: any supplied tracks property returns `400 EDITION_TRACKS_READ_ONLY`. The server resolves an unexpired owner-bound preview, checks any supplied release/group references, authors canonical references and copies tracks. Client-authored candidates, hashes, reviewer state and unknown fields are rejected. `409 EDITION_PREVIEW_UNAVAILABLE` requires another explicit preview. Previewing does not create a public album, moderator candidate/head, review history or reviewed baseline.

The exact provider candidate (release/recording references, retrieved timestamp, CC0 license, source URL and hash) is embedded in `editionProposal` on the submission and its append-only revision snapshot, alongside the ordinary proposed track metadata. No migration is required for existing suggestions. The persisted current proposal can be retained by its owner in a `needs_changes` revision after the temporary preview expires or contributor discovery is disabled (community submissions must still be enabled); selecting a different edition requires a fresh owned preview. Existing conditional revision writes still reject concurrent changes. Public catalog/feed serialization does not expose the private proposal; owner/moderator submission reads preserve it. Temporary previews use a TTL collection; application expiry checks do not rely on timely TTL deletion.

Moderators see **Contributor edition** in the existing baseline panel. **Review proposed edition** calls `POST /moderation/album-baselines/submissions/:submissionId/proposal` with `expectedTargetRevision`. This requires moderator authorization, baseline moderation flags and the moderation mutation rate limit. It validates the retained candidate and binds a moderator candidate snapshot to that exact submission revision without a live provider call. It does not confirm anything. The selected edition’s complete ordered tracklist and source remain visible independently of the discovery flag; Confirm/Replace stays disabled without both track and source evidence. Inspect the read-only preview and use the existing explicit Confirm/Replace decision to accept it. Existing discovery controls select another edition when moderator discovery is enabled; Defer remains available under its existing state rules. Proposal preparation fails with 409 after a revision change, and final decisions continue to check both review and target revisions transactionally.

Approval without an explicit confirmation may publish ordinary proposed catalog tracks but leaves listening baseline readiness pending. Confirmed selection publication remains atomic with album approval; linking an existing catalog album never applies the proposal. Changing the baseline edition does not overwrite nonempty proposed/catalog display tracks; the existing catalog-correction workflow remains responsible for those changes. Disabling contributor discovery does not prevent moderators from reviewing already retained proposals.

V2 is deferred: editable contributor tracks need a distinct audited proposal/baseline contract, source-versus-edit comparison and explicit moderator acceptance. Do not reinterpret client-edited tracks as a provider snapshot or reuse its hash.


**Offline moderator browser regression.** With frontend dependencies, Playwright and Chromium already available, run `RUN_FRONTEND_BROWSER_TESTS=true node --test tests/baselineProposal.browser.test.js`. Optional `PLAYWRIGHT_MODULE` selects an existing Playwright module and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects an existing Chromium executable. The test starts a temporary local Vite fixture, mocks authentication/API only inside that fixture, and blocks external requests. Normal test runs skip this explicit browser check. It covers discovery on/off, preserved selections, missing evidence and disabled moderation.

Contributor discovery preserves shared gate exhaustion as `503 MUSICBRAINZ_BUDGET_EXHAUSTED` with a sanitized message. A finite positive retry deadline is forwarded as `Retry-After` when supplied; the current shared gate supplies none, so no deadline is invented. Unknown plain server errors remain generic failures.
