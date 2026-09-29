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
| Threshold | `ceil(0.8 × countable standard positions)` distinct unambiguously matched positions. Countable positions exclude tracks that cannot produce or be matched to a scrobble; see step 2. |
| Repeats/shuffle | Repeats before qualification add no coverage; shuffle is allowed. After qualification, replaying an already-counted position starts a new play (see step 2). |
| Session boundary | Greater than two-hour gap or reaching a 24-hour cap, partitioned by owner and canonical album across approved names. Other albums and unmatched tracks do not extend it. |
| Bonus tracks | Do not count toward missing standard tracks. |
| Publication | First qualifying reconciliation after the fetch window is complete. Later tracks enrich that play and do not create another entry; only a separately qualifying replay play can. |
| Date | Date of the first counted standard-track event of each play in the session's saved IANA timezone. Crossing midnight does not split it. |
| Replay | Back-to-back replays inside one session can qualify as separate plays; manual repeats stay available. |
| Runtime | No listened-runtime claim or threshold. |

Freeze the baseline version, track identities, rule version, and timezone for each session. Duplicate track titles remain unresolved unless additional evidence identifies the position. Recording references do not collapse legitimate repeated positions. Conflicting populated identifiers cannot be rescued by permissive title matching.

Late events that change an already published session's date or boundaries require reconciliation; they must not move or duplicate a listen silently. Threshold/configuration changes apply only to new sessions.

## Implementation map — proposed September 28, 2026

This section is a build plan, not implemented behavior or confirmation of coverage in a deployed database. The code already supplies persistent scrobbles, reviewed name mappings, reviewed standard baselines, and a transactional manual diary. The remaining bridge is **scrobble → baseline position → session → qualified detection → optional diary entry**.

### 1. Match individual tracks

Add a pure production matcher in `lib/listening/trackMatching.js`. Its inputs are normalized retained events, currently valid album mappings, and a reviewed baseline snapshot. It must not fetch providers, discover albums, or approve mappings.

- Resolve the incoming artist/album name through the existing approved mapping first. Group different approved names for the same public `albumId` together.
- Match against baseline positions identified by local `trackId`, preserving disc and track numbers. Use exact normalized track title and track artist as the initial text rule; missing baseline track credits stay unresolved instead of assuming the album artist. Do not strip live/remix/demo/acoustic/edit qualifiers or introduce fuzzy matching.
- Apply a small, versioned set of reviewed matching-key rules before comparison. They build comparison keys only and never rewrite stored scrobble, catalog, or baseline text. Record which rule produced each match in the evidence. A rule that produces more than one candidate position yields `ambiguous_track`, never a best guess. Required rules:
  - **Typography:** fold curly/straight apostrophes and quotes, and dash variants. The current `normalize()` uses NFKC, which leaves `’` and `'` distinct, so MusicBrainz `Don’t` never equals a streaming `Don't`.
  - **Featured artists:** Spotify-sourced scrobbles usually carry only the primary artist and put `(feat. X)` in the title, while baseline `artistDisplayName` carries the full MusicBrainz credit (`A feat. X`). Match the scrobble artist against the primary credited artist, and strip a trailing `(feat. …)`/`[feat. …]` title suffix only when every named guest appears in that position's baseline credit.
  - **Remaster suffixes:** strip only an allowlisted trailing remaster marker such as ` - Remastered 2009` or ` (2011 Remaster)`. Remastered editions otherwise map to the album and then match zero tracks. Other edition and version qualifiers stay significant.
- Featured-artist scrobbles also fragment album mapping. `resolveRow` keys mappings on the scrobble's track artist, so `A feat. X` / `Album` is a separate mapping case from `A` / `Album` and stays unresolved until it is separately approved. Discovery should link such a case to an existing approved mapping as a suggested credit variant when the album name matches exactly and the primary artist matches that mapping's artist. It must remain a moderator approval, never an automatic one. Report unresolved credit variants for already-mapped albums as a pilot diagnostic.
- Use a populated scrobble `trackMbid` only once its type is established. Baselines distinguish release-track and recording MBIDs, while the scrobble field does not. The ID counts as established when it equals exactly one type across the reviewed baseline: a recording MBID or a release-track MBID, never both. An ID that is malformed, absent from the baseline, or present as both types stays unresolved as `unverified_track_id`. It is never guessed, and it is never dropped in favor of a title match. An established ID that identifies one position matches it, even when no text rule does. Text that points only at other positions is `identity_conflict`. A recording shared by several positions cannot distinguish them, so text must narrow it to one position or the result is `ambiguous_track`.
- One event can credit at most one position. Multiple possible positions mean `ambiguous_track`; repeated plays of the same position add no coverage. A shared recording ID cannot distinguish two positions containing that recording.
- Preserve identity conflicts across duplicate deliveries. Current ingestion uses `$setOnInsert`, so a retry with different populated IDs leaves the first values intact. Add a conservative conflict marker and reevaluation before depending on IDs for counting; repeated delivery must neither add a play nor erase conflicting evidence.
- Return a position match or a concrete reason such as `unmatched_track`, `ambiguous_track`, `identity_conflict`, `mapping_unavailable`, or `baseline_unavailable`. Unmatched bonus tracks do not count or extend a session.

**Implemented (increment 1):** `lib/listening/trackMatching.js` and `lib/listening/detection.js` are pure and covered by offline fixtures in `tests/listeningDetection.test.js`; nothing calls them yet. Current choices to revisit: non-audio exclusion reads an optional `baseline.media` list that stored baselines do not yet record; and matched excluded positions open and extend sessions without counting toward coverage. Measure the `unverified_track_id` rate in the pilot, since Last.fm IDs from other releases or recordings leave those scrobbles unresolved.

The historical engine in `lib/listeningStudy/core.js` provides fixture ideas, but remains frozen. Its study identities, edition inference, text normalization, and session hash are not production contracts.

### 2. Count sessions with explicit boundaries

Add a pure `lib/listening/detection.js` engine. Supply events, activation windows, baseline/rule snapshots, and a fixed evaluation time rather than reading the clock inside the engine.

1. Exclude now-playing, expired, out-of-consent, unresolved, and ambiguous evidence. Deduplicate with the persistent ingestion identity and sort by playback timestamp with a deterministic tie-breaker.
2. Partition by owner, connection lifecycle, activation window, and canonical album. Pause/resume is a hard boundary even when the pause is shorter than two hours; an ingestion `connectionRevision` alone is not the playback window identity.
3. Within a partition, open a session at the first unambiguously matched standard-track event. Split when the next matched event is **more than two hours** after the previous matched event, or **at least 24 hours** after the session start. Other albums do not close the session, and other albums, bonus tracks, and unmatched events do not extend its timer.
4. Count the set of matched countable positions for each play and require `ceil(4 × countablePositions / 5)`. Never round down or substitute total plays for distinct positions.
5. Preserve `startedAt` separately from `qualifiedAt`, the first event that reaches the threshold. The proposed diary date uses each play's first counted event date in the session's saved IANA timezone, not the threshold-crossing date. Midnight does not split a session; elapsed-time boundaries use UTC.

**Countable positions.** Derive the countable set once per baseline version and rule version and freeze it with the session. Excluded positions still record a match when one arrives, but they never raise the requirement:

- **Positions under 30 seconds.** Last.fm does not scrobble tracks shorter than 30 seconds, so interludes and skits would otherwise make short-track-heavy albums impossible to qualify; for example, a 10-track album with three short interludes reaches at most 7 of 10. Exclude positions whose baseline `durationMs` is known and below 30,000. Positions with unknown duration stay countable and are reported in diagnostics.
- **Non-audio and placeholder tracks.** Exclude tracks on media whose format is non-audio (for example DVD-Video, Blu-ray, or data media) and MusicBrainz special-purpose titles such as `[silence]`, `[untitled]`, and `[data track]`. Baseline review should flag these releases, since the MusicBrainz parser currently includes every medium; update the [tracklist baselines](TRACKLIST_BASELINES.md) guide when that check lands.
- **Duplicate positions.** Group positions that a plain-text scrobble could not tell apart under the matching rules. This covers identical or remaster-only-different titles whose credits share an accepted scrobble artist, such as `Song` by `A` and `Song` by `A feat. B`. Exclude each whole group rather than leave permanently ambiguous positions in the denominator. The same title by unrelated artists stays countable. An established track ID can still identify one member of a group; that match is recorded as an excluded-position credit.

A matched excluded position may still credit a play, but coverage never needs it. If excluded positions exceed 20% of the baseline, or the countable set is empty, mark the album with a `baseline_countability` diagnostic for moderator attention. Detection stays eligible only while at least one countable position remains.

| Countable positions | Required distinct positions | Example |
| --- | --- | --- |
| 4 | 4 | Three tracks are only 75%. |
| 5 | 4 | Four distinct tracks qualify. |
| 10 | 8 | Seven standard tracks plus a bonus track do not qualify. |
| 12 | 10 | Nine tracks are only 75%. |
| 15 | 12 | Twelve shuffled standard tracks qualify. |

**Replays within a session.** A session holds one or more ordered plays, and each play keeps its own set of credited positions. Process matched events in order:

1. Credit the event to the earliest play in the session that has not yet credited that position.
2. If every play already has that position, open a new play only when the newest play has qualified. Otherwise, the event is a pre-qualification repeat and adds no coverage.

Two cases show the rule:

- **Back-to-back replay.** A full play followed by a replay qualifies twice: the replay's first repeated position opens play 2, and the replay fills it.
- **Finishing or repeating a favorite.** Finishing the remaining tracks credits the qualified play. A single repeated favorite opens a play that never reaches the threshold alone. Tracks the first play still lacks go to that play, so a favorite repeat plus the leftover tracks and half a replay cannot qualify.

The tradeoff runs toward misses. A replay that covers only the threshold may lose leftover positions to the earlier play and fall short. Keep that case as a fixture. Each play has its own `qualifiedAt`, diary date, and publication receipt within the session's lineage. The 24-hour cap still closes the session, so continuous looping cannot outlive it.

The two-hour rule is a proposed product tradeoff: it allows breaks and interleaved listening, and can combine separate partial plays. Validate that behavior in the private pilot before changing the versioned rule.

**Accepted limitations** (documented, not pilot blockers):

- **Playlist and radio false positives.** Scrobbles carry each track's original album name, and shuffle, interleaving, and a 24-hour cap are all allowed. Enough tracks from one album on a playlist, artist shuffle, or radio within the gap rules can therefore qualify as an album listen. No density or dominance check is planned.
- **Short releases and long tracks.** Releases with four or fewer countable positions require every position. Last.fm scrobbles after half a track or four minutes, so a one-track long-form release can count after four minutes. This follows from the no-runtime rule.
- **Owner-edited or deleted scrobbles.** Scrobbles an owner edits or deletes on Last.fm are out of scope. `identityKey` includes names, so an edited scrobble arrives as a new event while the original remains. Upstream deletions are never detected. Retained events are treated as recorded, and detection does not defend against owners manipulating their own history.

Assign stable activation-window IDs or freeze equivalent window snapshots in detections; the current connection stores only start/end bounds. This measures scrobbled track coverage, not verified listening duration or whether every second of a track played.

### 3. Persist and reconcile private detections

Add a private detection model and `lib/listening/reconciliation.js`; extend the existing worker with a dedicated detection job. Persist a UUID `sessionId`, owner/connection/window identity, canonical `albumId`, frozen baseline ID/version/hash, mapping revisions used, rule version, frozen countable-position set, timezone, per-play distinct/required/total counts and ordinals, timestamps, processing revision, and reason codes. Store bounded event-to-position evidence separately from any durable publication receipt.

Extend the existing baseline lookup to return its stored version with the ID/hash. Add explicit detection-job support to both the job schema and worker dispatch/feature gating; the existing job types only cover sync, discovery, reprocessing, and cleanup.

Keep lifecycle (`open` or `closed`), coverage (`below_threshold` or `qualified`), and processing holds separate. A qualified session may still be open or held for `sync_incomplete`, `stale_baseline`, `stale_mapping`, `evidence_expired`, or `reconciliation_required`. Missing identity evidence should also appear in aggregate diagnostics even when no album session can be formed.

- Queue detection in the transaction that finishes a complete sync window, alongside advancing `completedThrough`. Page ingestion can persist evidence before that point and must not trigger publication. Persist the completed window bounds/revision used for evaluation; an old cursor does not prove that a later overlap fetch has finished.
- Add a daily deep sweep per active connection that refetches the trailing 14 days. Last.fm accepts back-dated scrobbles from offline playback, network drops, and later-synced devices; confirm its current acceptance limit when implementing. The regular sync only refetches from `completedThrough − 48h`, so anything that arrives later with an older play time is never fetched. For example, an offline flight on Monday that uploads Wednesday evening lands behind Wednesday's cursor. The sweep reuses `persistPage` identity, activation-window, and retention checks. It never moves `completedThrough` backward, runs at lower priority than regular sync, and queues late-event reconciliation for whatever it adds. Update the [Last.fm sync](LASTFM_SYNC.md) guide, which currently says events delayed beyond the overlap may be missed, when the sweep lands.
- **Rate-limit watch item.** The sweep draws on the same global `lastfm` budget as regular sync (`LASTFM_REQUESTS_PER_MINUTE`, default 45), and its cost grows with connections × scrobble volume, at roughly one request per 200 scrobbles per connection per day. If the pilot shows rising `lastfm_request_budget_exhausted` or `lastfm_rate_limited` errors, provider cooldowns, or growing regular-sync lag, suspect the sweep first. Investigate shortening its lookback, reducing its frequency, or skipping connections with no recent activity before raising the budget.
- Queue reevaluation after each affected connection's mapping/baseline reprocessing completes. Account for both old and new album assignments. Deduplicate jobs and retain the current lease, connection, mapping, and baseline fences.
- Revalidate current mappings and baselines on private detection reads too. Existing reprocessing scans active connections only, so a paused owner's retained preview cannot rely on cached resolution. Mark stale results held while paused; pause continues to block new publication.
- Recompute affected sessions with enough neighboring evidence to recover their boundaries. A 48-hour delayed-event overlap needs earlier session context as well; do not truncate a session at the overlap start. If boundaries propagate into adjacent sessions, expand until stable or hold for reconciliation. A retention gap must not be treated as evidence of inactivity.
- Give persisted sessions stable identities. The study hash includes every event ID and changes whenever another track arrives, so it cannot be a production publication key. Reconcile using retained event membership and predecessor/successor relationships. Before publication, merges/splits may replace private results with explicit lineage; afterward, keep each play's receipt attached to that lineage and hold changes that would move, split, or duplicate a published listen, or reassign credit between plays that affects a published one.
- Treat a published play as a fixed boundary. Late events may join it or start new plays after it, but they never merge two published plays, move credit out of a published play, or shift the 24-hour cap split that produced it. For example, full plays at 20:00 and 23:00 were each published as separate sessions, and late scrobbles at 21:50 would otherwise close the gap. Merging them would move the second play's leftover-track credit to the first and could leave a published listen below threshold. Hold any such change as `reconciliation_required` instead of applying it.
- Freeze the baseline and rule for an existing session. If its baseline is replaced/revoked or its catalog/mapping becomes invalid, hold it; never silently mix positions from two baselines or reinterpret an existing receipt under new rules. New sessions use the current reviewed version.
- Apply the existing 30-day playback-evidence limit to derived detail too. Do not refresh evidence expiry every time a detection is recomputed. Prune per-event evidence as it expires and enforce expiry on reads; retained summary counts cannot authorize a new publication after supporting evidence has expired. Held plays therefore have only the remainder of their 30-day window, so a hold must never expire silently. Store each held play's evidence-expiry date: the date its coverage would drop below the threshold as credited events expire. When that date passes, move the play to a visible `evidence_expired` state that keeps only album, proposed date, and counts. Keep it until the owner dismisses it or 30 days pass. The expired record cannot publish. Disconnect/account deletion cleanup must include private detections and queued work.

### 4. Show the owner what would be logged

Extend the authenticated listening API with an owner-only detected-session list and add a private account view showing the current catalog album, `8 / 10 standard tracks`, required count, proposed date, a plain-language explanation for any hold, and, for held plays, the date their evidence expires. Show expired plays as expired rather than removing them. Owner-resolvable holds, such as manual-duplicate holds and older qualifications awaiting confirmation (step 5), offer a confirm action until expiry. Raw account names, exact timestamps, and evidence never enter public activity responses.

Introduce a disabled-by-default detection flag, using the existing pilot allowlist. Save a validated user-selected IANA timezone for detection; the current connection schema does not store one. Snapshot it per session and apply timezone changes only to later sessions. Existing connections need this setting before detection can produce a proposed diary date.

The first deliverable ends here: repeatable private detections with **zero diary writes**. Compare fixture-backed expectations and owner-reviewed pilot sessions, including missed detections and false positives; historical metadata coverage is not a substitute for this check.

### 5. Enable automatic diary logging separately

Add a second disabled-by-default publication flag and explicit owner opt-in after the private detector is validated. Record its effective start time; existing retained detections do not become a surprise historical import. Publish at the first qualifying reconciliation of a complete fetch window, without waiting for a two-hour session-close timeout. Later evidence can enrich that same detection but cannot publish it again.

Publish automatically only when the play is recent: its qualifying event was played no more than 7 days before the evaluation. Older qualifications become owner-confirmation suggestions in the private view, and confirming one uses the same transactional publication path. Late qualifications come from mapping approvals and baseline confirmations, which reprocess up to 30 days of retained events, and from deep-sweep finds. Without this cutoff, an approval on September 20 would suddenly publish a listen dated September 3. Suggestions follow the evidence-expiry rules in step 3. The cutoff is part of the versioned rule.

Extend `routes/utils/listeningDiary.js` through an internal transactional entry point and store automatic-source metadata on `Listen`. The existing `ListenCreation` receipt establishes the manual retry pattern, but an automatic receipt also needs stable session lineage, suppression, and reconciliation semantics. Do not expose server-authored source/session fields as manual creation input.

Before enabling publication, prove atomic listen/receipt creation, pause/disconnect fencing, concurrent-worker deduplication, and delete suppression even after late-event merges or splits. Keep owner date corrections intact. If an owner has a manual entry for the same album dated within one day of the play's date span, hold every automatic play of that album in that window for owner resolution rather than silently merge, delete, or automatically add a likely duplicate; intentional manual repeats remain allowed. Exact-date matching is not enough. A 23:30–00:40 listen is dated by its first event, while the owner may log it manually as the next day, and manual dates follow the device calendar rather than the saved timezone. In the reverse order, the manual creation form shows a non-blocking notice when an automatic entry for that album already exists in the same window; the server does not reject the manual entry. Coordinate that check with concurrent manual creation inside transactions without a user/album/date unique constraint.

Durable receipts retain only the identity/suppression data needed to prevent recreation, not listening sequences or exact playback timestamps. Existing diary entries can outlive a disconnected provider connection; account deletion removes user-owned receipts along with the user's data. Receipt matching and expiry behavior are publication release gates, not deferred cleanup work.

### Build and verification order

| Increment | Acceptance criterion |
| --- | --- |
| Pure matcher and counter | Offline fixtures prove exact threshold boundaries, aliases, typography/featured-artist/remaster matching keys, countable-position exclusions, shuffle, repeats, back-to-back replay plays, bonuses, duplicate titles/recordings, multi-disc positions, and conflicting IDs. |
| Worker and private persistence | Replica-set tests prove incomplete-window holds, activation boundaries, stable identity on retries/restarts, out-of-order events, deep-sweep late events, merges/splits, frozen published-play boundaries, stale reviews, retention, visible hold expiry, and cleanup. |
| Owner preview and timezone | Owner isolation, explanatory states, midnight/DST behavior, and browser checks pass; diary counts remain unchanged. |
| Optional diary publication | Transactions, concurrent manual/automatic creation, the ±1-day duplicate hold, the 7-day recency cutoff and owner confirmation, late reconciliation, suppression, source labeling, date correction, and undo pass before enabling the flag. |

Run `npm test`, `npm run test:integration`, and `npm run check:catalog-contract` for the backend integration. Add frontend lint/build and browser verification when the owner view changes. No provider call is needed inside the detector; ordinary verification stays offline. Deployment and any named-environment data operation remain separate from this plan.

## Future diary publication

- Extend the internal diary service. Publish the listen and a durable unique session receipt in one transaction, with transaction-or-503 behavior.
- Recheck connection state, mapping and baseline validity, and worker fences at commit. Pause/disconnect stops in-flight future publication.
- Label entries automatically logged and offer owner date correction and undo/delete. Keep minimal suppression receipts so retries, reconnects, or retained-evidence reprocessing cannot resurrect deleted entries.
- Preserve manual entries and intentional repeats. Coordinate concurrent manual/automatic creation without introducing a user/album/date unique constraint or silently merging entries.
- Keep private listening evidence and source-account details out of public feeds. Current catalog display metadata remains authoritative.
- Separate publication from sync behind disabled flags. No catalog creation, board placement, or saved-status mutation occurs as a side effect.

## Acceptance and rollout

Validate threshold boundaries, short albums, shuffle, repeats, multi-disc lists, duplicate titles, bonus tracks, session gaps, midnight/DST, incomplete sync windows, delayed events, restart recovery, concurrent publication, deletion suppression, and privacy/authorization with offline fixtures and replica-set tests. Run the full repository verification gate and browser checks for changed flows.

Start with a small allowlisted pilot and independently measure baseline coverage, unresolved mappings, sync lag, ambiguous tracks, held and expired plays, and Last.fm budget exhaustion/cooldowns (see the deep-sweep watch item) before widening eligibility. Real authorization, worker hosting, webhook delivery, and provider launch requirements remain separate operator checks in the sync runbook.

Defer full-history import, personal thresholds, runtime counting, and edition-specific automatic detection. The [historical listening study](LASTFM_LISTENING_STUDY.md) remains unchanged evidence; its frozen scores and private captures are not production coverage or automatically imported identities.
