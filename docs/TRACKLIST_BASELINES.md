# Reviewed MusicBrainz standard tracklists

This workflow establishes baseline readiness for future listening detection. It does not count sessions, create diary entries, or create public albums. MusicBrainz core metadata is CC0; artwork, annotations, ratings, and tags are outside this workflow.

## Moderator workflow

Open `/moderation/album-baselines`, a selected catalog album, or the baseline panel on a pending new-album suggestion. Albums and EPs are eligible. When a MusicBrainz release-group reference is absent, search and explicitly select the group. Discovery searches release-group titles, credited and canonical artist names, and artist aliases. An existing conflicting group reference must be corrected through the catalog correction workflow.

Request a recommendation. The recommender browses up to 150 releases (three pages of 50) and hydrates the top three official candidates. Official releases with an exact title rank first, then releases without special-edition markers in the title or disambiguation (deluxe, expanded, extended, bonus, anniversary, sped-up/slowed, Dolby Atmos/spatial, retailer or platform exclusives, signed, clean/edited, copy-protected, limited, coloured or 180-gram vinyl, remastered, reissue), then releases from the release group's original year, then Digital Media ahead of CD ahead of other formats; date and MBID provide deterministic tie-breakers. A recommendation is marked ambiguous only when an equally ranked official release has a different track count. Recommendation is advisory and always requires moderator confirmation. Review the full ordered tracklist, edition details, country, date, format, source link, and incomplete/ambiguous discovery notices. Neither the shortest tracklist nor the artwork release is automatically standard.

Browse alternatives or paste a MusicBrainz release URL/UUID. The server validates and fetches a fixed provider endpoint and checks release-group identity and complete media/track positions. Missing/partial tracklists cannot be confirmed. Repeated recordings at different positions are preserved.

Supply a reason to confirm, replace, defer, or revoke. Defer applies only while no current reviewed baseline or selection exists; use revoke to withdraw a reviewed one. A stale review may still be deferred. A confirmed baseline is a versioned snapshot with local track UUIDs, typed upstream references, source retrieval/license metadata, hash, reviewer, and catalog revision. Replacement creates a new version and preserves history. Ordinary catalog tracks do not establish baseline readiness.

Confirmation fills an empty public catalog tracklist and records provenance. It leaves nonempty tracks unchanged; use an explicit catalog correction to change them. Later catalog revisions make baseline readiness stale until reviewed again. Owner event reads check current validity while retained-event reprocessing catches up.

A stale review cannot reuse its earlier selection, because candidate snapshots are bound to the revision they were previewed against. Suggest or preview a release again, then confirm it; confirmation creates the next baseline version.

**Cover backfill carry-forward.** A cover write cannot change the tracklist. After the missing-cover backfill advances an album's `catalogRevision`, a baseline reviewed at the previous revision moves to the new one in place. It is carried forward with the album's active mappings in one transaction ([Last.fm sync](LASTFM_SYNC.md)). The baseline keeps its ID and version, so detections frozen against it are not held as `stale_baseline`. The head's `targetRevision` and revision advance, and a `carry_forward` audit entry records the revision the baseline was reviewed against. Nothing is carried if the album has already moved past the backfill's revision, or if the review was already stale. If the carry fails, the cover stays committed, the baseline stays stale, and the backfill report marks the row `revisionCarryFailed`.

**Known limitation.** Only an approved catalog correction explicitly invalidates a reviewed baseline: it records an `invalidate` audit event, marks the review `stale`, and queues retained-event reprocessing. The catalog importer also advances `catalogRevision` but does not call this path. Readiness remains safe because every read compares the baseline's catalog revision with the current album, so those albums already report `stale` in the queue and `baselineAvailable: false`. However, no `invalidate` audit event is written, and affected events rely on the worker's stale-mapping scan rather than an immediate reprocessing job. Adding explicit invalidation to the importer is deferred.

A pending submission's selection remains private and binds to its revision. Approval of a new album publishes the selected baseline atomically with the album, even if `TRACKLIST_BASELINE_MODERATION_ENABLED` was disabled after the selection was confirmed, because the confirmation already passed that gate; approval without one remains allowed and leaves enrichment pending. Linking an existing album never applies the suggestion's baseline or tracks. Review that catalog album separately.

## Controls and API

`TRACKLIST_ENRICHMENT_ENABLED=true` permits new provider discovery/preview. `TRACKLIST_BASELINE_MODERATION_ENABLED=true` plus `COMMUNITY_MODERATION_ENABLED=true` permits baseline decisions. All default disabled; persisted moderator reads remain available. Clerk authentication and the existing `MODERATOR_USER_IDS` allowlist apply to every endpoint. Configure the existing identifying `MUSICBRAINZ_USER_AGENT` server-side.

Moderator API prefix: `/moderation/album-baselines`.

- `GET /`: filtered queue with cursor pagination; pending work additionally accepts `readiness=ready|unprepared` so candidate-backed enrichment can be reviewed separately from targets that still need discovery. `GET /:kind/:id`: target, current review, history, and capability flags. Kind is `albums` or `submissions`; IDs are public UUIDs.
- `GET /groups?q=...`: release-group discovery.
- `POST /:kind/:id/candidates`: suggested release or another browse page.
- `POST /:kind/:id/preview`: alternative release preview.
- `POST /:kind/:id/{confirm,replace,defer,revoke}`: reason, expected baseline/target revisions, and request UUID. Confirm/replace reference the server-held release/hash snapshot; clients cannot author tracks or reviewers.

Mutations use MongoDB transactions and optimistic revision checks. Stale commands return 409; unavailable transactions return 503. Provider failures cannot block ordinary album approval without a baseline, catalog reads, or manual diary use. Provider calls are bounded, cached, and share the listening MusicBrainz request gate. Normal tests inject provider fixtures.

## Existing-catalog enrichment

This operator command is independent of Last.fm connections. It scans a bounded, album-ID-ordered batch of albums/EPs and reports current baselines, missing groups, conflicts, unavailable results, and candidate releases. Supply configuration externally; it does not load repository `.env` files.

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

Run `npm test`, `npm run test:integration`, `npm run check:catalog-contract`, frontend lint/build, and browser review checks. Live-provider checks and database applies require separate explicit authorization. Start with a small album/EP pilot. Monitor the review queue, per-batch enrichment summaries, and `listening:metrics`. Its `baselineReviews` block counts albums and pending new-album suggestions by effective review status (`pending`, `reviewed`, `stale`, `deferred`, `revoked`), using the same staleness rule as the queue; `pendingWithCandidate` separates candidates queued by an enrichment apply from untouched albums. `baselineReadyNames` and `baselineUnavailableNames` cover approved observed names. Interactive provider failures in the review panel are returned to the moderator and are not persisted. No production rollout or apply occurred during implementation.

Provider contract references: [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), [data licensing](https://musicbrainz.org/doc/About/Data_License). Recommendations inspect one bounded release page and hydrate at most three official candidates; additional alternatives use explicit pagination/preview. Partial discovery is visible and never implies that all editions were compared.
