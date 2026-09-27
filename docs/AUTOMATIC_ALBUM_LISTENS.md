# Automatic album listens

Status: Last.fm sync, reviewed name mappings, and MusicBrainz standard-baseline review are implemented behind disabled flags. Session counting and automatic diary publication remain future work. No deployment or data apply is implied.

## Current boundary

`AlbumCatalog` remains the public album identity. Last.fm scrobbles resolve through exact moderator-approved artist/album-name mappings. A mapping certifies album identity; it does not certify a tracklist. A nonempty `AlbumCatalog.tracks` array is also not a reviewed baseline.

The next counting release will use **80% of one reviewed standard tracklist per album**, rather than infer the exact edition played. Recognized edition names can map to that album, but bonus tracks cannot replace missing standard tracks. The standard-baseline decision supersedes the earlier edition-specific design exploration. Manual diary entries remain independent.

See [Last.fm sync](LASTFM_SYNC.md) for ingestion and mapping operations, and [tracklist baselines](TRACKLIST_BASELINES.md) for source selection, moderator review, enrichment, and backfill.

## Reviewed standard foundation

MusicBrainz supplies a specific release's complete ordered tracklist. The moderator confirms that release as the standard baseline or chooses an alternative within the album's release group. Cover-associated representative releases, shortest lists, and earliest releases are not automatically accepted as standard editions.

Baseline versions retain source release/group IDs, typed release-track and recording references, local track UUIDs, a tracklist hash, catalog revision, and review provenance. Catalog corrections invalidate readiness conservatively; replacement creates another baseline version. Ordinary catalog tracks remain independently owned metadata. Confirmation can fill an empty catalog tracklist but cannot overwrite an existing one.

Last.fm metadata may help compare album names with reviewed baselines; it does not determine the counting denominator. Matching track names alone never approves an album mapping. The LOONA / 이달의 소녀 case is an album-specific reviewed mapping, not a global artist rename.

## Next release: private detection before publication

Build a pure, versioned counting engine and private detected-session view before connecting it to diary writes. Use synthetic fixtures and explicitly permitted captured playback, never live providers in ordinary tests. Validate actual pilot coverage separately from historical study scores.

| Decision | Proposed first counting release |
| --- | --- |
| Eligibility | Existing catalog albums/EPs with a current reviewed standard baseline and approved incoming name mapping. |
| Evidence | Recorded timestamped scrobbles; exclude now-playing rows. |
| Threshold | `ceil(0.8 × standard track positions)` distinct unambiguously matched positions. |
| Repeats/shuffle | Repeats contribute once per session; shuffle is allowed. |
| Session boundary | Greater than two-hour gap or reaching a 24-hour cap, partitioned by owner and canonical album across approved names. Other albums and unmatched tracks do not extend it. |
| Bonus tracks | Do not count toward missing standard tracks. |
| Publication | First qualifying reconciliation after the fetch window is complete. Later tracks do not create another entry. |
| Date | Date of the first qualifying track event in the session's saved IANA timezone. Crossing midnight does not split it. |
| Replay limitation | Back-to-back repeats inside one session count as one automatic entry; manual repeats stay available. |
| Runtime | No listened-runtime claim or threshold. |

Freeze the baseline version, track identities, rule version, and timezone for each session. Duplicate track titles remain unresolved unless additional evidence identifies the position. Recording references do not collapse legitimate repeated positions. Conflicting populated identifiers cannot be rescued by permissive title matching.

Late events that change an already published session's date or boundaries require reconciliation; they must not move or duplicate a listen silently. Threshold/configuration changes apply only to new sessions.

## Future diary publication

- Extend the internal diary service. Publish the listen and a durable unique session receipt in one transaction, with transaction-or-503 behavior.
- Recheck connection state, mapping and baseline validity, and worker fences at commit. Pause/disconnect stops in-flight future publication.
- Label entries automatically logged and offer owner date correction and undo/delete. Keep minimal suppression receipts so retries, reconnects, or retained-evidence reprocessing cannot resurrect deleted entries.
- Preserve manual entries and intentional repeats. Coordinate concurrent manual/automatic creation without introducing a user/album/date unique constraint or silently merging entries.
- Keep private listening evidence and source-account details out of public feeds. Current catalog display metadata remains authoritative.
- Separate publication from sync behind disabled flags. No catalog creation, board placement, or saved-status mutation occurs as a side effect.

## Acceptance and rollout

Validate threshold boundaries, short albums, shuffle, repeats, multi-disc lists, duplicate titles, bonus tracks, session gaps, midnight/DST, incomplete sync windows, delayed events, restart recovery, concurrent publication, deletion suppression, and privacy/authorization with offline fixtures and replica-set tests. Run the full repository verification gate and browser checks for changed flows.

Start with a small allowlisted pilot and independently measure baseline coverage, unresolved mappings, sync lag, ambiguous tracks, and held sessions before widening eligibility. Real authorization, worker hosting, webhook delivery, and provider launch requirements remain separate operator checks in the sync runbook.

Defer full-history import, exact back-to-back replay detection, personal thresholds, runtime counting, and edition-specific automatic detection. The [historical listening study](LASTFM_LISTENING_STUDY.md) remains unchanged evidence; its frozen scores and private captures are not production coverage or automatically imported identities.
