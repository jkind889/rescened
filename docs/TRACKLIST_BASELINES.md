# Reviewed MusicBrainz standard tracklists

This workflow establishes baseline readiness for future listening detection. It does not count sessions, create diary entries, or create public albums. MusicBrainz core metadata is CC0; artwork, annotations, ratings, and tags are outside this workflow.

## Moderator workflow

Open `/moderation/album-baselines`, a selected catalog album, or the baseline panel on a pending new-album suggestion. Albums and EPs are eligible. When a MusicBrainz release-group reference is absent, search and explicitly select the group. An existing conflicting group reference must be corrected through the catalog correction workflow.

Request a recommendation. Official releases with matching identity and without deluxe/expanded/bonus/anniversary qualifiers rank ahead of alternatives; date and MBID provide deterministic tie-breakers. Recommendation is advisory and always requires moderator confirmation. Review the full ordered tracklist, edition details, country, date, format, source link, and incomplete/ambiguous discovery notices. Neither the shortest tracklist nor the artwork release is automatically standard.

Browse alternatives or paste a MusicBrainz release URL/UUID. The server validates and fetches a fixed provider endpoint and checks release-group identity and complete media/track positions. Missing/partial tracklists cannot be confirmed. Repeated recordings at different positions are preserved.

Supply a reason to confirm, replace, defer, or revoke. A confirmed baseline is a versioned snapshot with local track UUIDs, typed upstream references, source retrieval/license metadata, hash, reviewer, and catalog revision. Replacement creates a new version and preserves history. Ordinary catalog tracks do not establish baseline readiness.

Confirmation fills an empty public catalog tracklist and records provenance. It leaves nonempty tracks unchanged; use an explicit catalog correction to change them. Later catalog revisions make baseline readiness stale until reviewed again. Owner event reads check current validity while retained-event reprocessing catches up.

A stale review cannot reuse its earlier selection, because candidate snapshots are bound to the revision they were previewed against. Suggest or preview a release again, then confirm it; confirmation creates the next baseline version.

**Known limitation.** Only an approved catalog correction explicitly invalidates a reviewed baseline: it records an `invalidate` audit event, marks the review `stale`, and queues retained-event reprocessing. The catalog importer and the missing-cover backfill also advance `catalogRevision` but do not call this path. Readiness remains safe because every read compares the baseline's catalog revision with the current album, so those albums already report `stale` in the queue and `baselineAvailable: false`. However, no `invalidate` audit event is written, and affected events rely on the worker's stale-mapping scan rather than an immediate reprocessing job. Adding explicit invalidation to those writers is deferred.

A pending submission's selection remains private and binds to its revision. Approval of a new album publishes the selected baseline atomically with the album; approval without one remains allowed and leaves enrichment pending. Linking an existing album never applies the suggestion's baseline or tracks. Review that catalog album separately.

## Controls and API

`TRACKLIST_ENRICHMENT_ENABLED=true` permits new provider discovery/preview. `TRACKLIST_BASELINE_MODERATION_ENABLED=true` plus `COMMUNITY_MODERATION_ENABLED=true` permits baseline decisions. All default disabled; persisted moderator reads remain available. Clerk authentication and the existing `MODERATOR_USER_IDS` allowlist apply to every endpoint. Configure the existing identifying `MUSICBRAINZ_USER_AGENT` server-side.

Moderator API prefix: `/moderation/album-baselines`.

- `GET /`: filtered queue with cursor pagination; `GET /:kind/:id`: target, current review, history, and capability flags. Kind is `albums` or `submissions`; IDs are public UUIDs.
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

The default mode is dry-run. It performs catalog reads and explicit MusicBrainz requests, using private process-local pacing/cache rather than writing provider-budget/cache collections. It never activates baselines or fills tracks. Keep the report and printed SHA-256. Use the printed `nextAfter` with `--after UUID` to scan another batch.

After inspecting the exact report and receiving explicit authorization for the named target:

```sh
npm run catalog:enrich-tracklists -- --apply --environment pilot \
  --confirm-environment pilot --plan /private/path/tracklist-plan.json \
  --sha256 REVIEWED_SHA256 --reviewer MODERATOR_ID
```

Apply verifies checksum, target fingerprint, and catalog revisions, then queues the captured candidates transactionally. It does not fetch replacement data, confirm baselines, or overwrite tracks. Moderators still inspect and confirm each candidate. Preserve command output with the plan; a committed result is distinct from a rollback.

## Validation and operations

Run `npm test`, `npm run test:integration`, `npm run check:catalog-contract`, frontend lint/build, and browser review checks. Live-provider checks and database applies require separate explicit authorization. Start with a small album/EP pilot. Monitor the review queue, stale/deferred/unavailable baselines, and `listening:metrics` baseline-ready/unavailable observed-name counts. No production rollout or apply occurred during implementation.

Provider contract references: [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API), [data licensing](https://musicbrainz.org/doc/About/Data_License). Recommendations inspect one bounded release page and hydrate at most three official candidates; additional alternatives use explicit pagination/preview. Partial discovery is visible and never implies that all editions were compared.
