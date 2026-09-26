# Last.fm album-listening feasibility study

This standalone experiment compares edition-specific and shared-standard counting without importing catalog data or creating diary entries. It remains isolated from the separate [persistent Last.fm syncing and reviewed mapping pilot](LASTFM_SYNC.md). That pilot does not implement counting or automatic diary publication. The later scope is in [Automatic album listens](AUTOMATIC_ALBUM_LISTENS.md).

## Current evidence — 2026-09-24

The 20 pairs (40 name queries) and 10 controlled-playback pairs were selected before querying Last.fm. All 40 reference releases were retrieved from MusicBrainz and reviewed for artist/release identity, ordered tracks, medium completeness, and edition context. The normalized CC0 tracklists, exact source links, timestamps, review method, and raw-response hashes are in [references.json](../data/listening-study/references.json). This is verification against MusicBrainz, not an additional artist/label audit.

The first live metadata capture is complete: all 40 name queries returned responses. Track counts match in 36/40 cases, but only 13/40 pass the frozen strict count, membership, order, and identity comparison; 12/20 standard baselines pass. No pair passes both strict tracklist comparisons and the edition-distinction gate. These results miss both metadata coverage targets. They do not mean every failed list contains different music: featured-artist placement, punctuation, and version-label differences also fail the deliberately conservative matcher. Do not alter the frozen baseline; evaluate any normalization improvements separately.

Concrete count failures: Ultraviolence deluxe returns 14 tracks against the selected Japanese 15-track reference; After Hours deluxe returns 18 against 17; Lungs deluxe returns 24 against 20. Morning Glory deluxe has no returned tracklist. Separately, MBID lookups pass 11/40 strict comparisons, with seven HTTP 404 results retained as unavailable; these do not rescue name-query scores. No actual controlled sessions have been captured. The overall report remains **incomplete**, and neither approach is ready to ship. Real playback and a separately reviewed matching revision are still needed before a production decision.

The selected releases intentionally include a Japanese Ultraviolence deluxe with “Flipside,” remasters, multi-disc editions, and ambiguous titles. Exact versions matter: After Hours uses the 17-track deluxe; 1989 uses the 19-track Target edition with voice memos; Lungs uses the 20-track UK deluxe. Nevermind's selected standard CD combines the hidden song into its last position. These selections were made before Last.fm results; alternative releases must not replace mismatches. A streaming edition with a different sequence is not the selected control. Keep inaccessible controls incomplete rather than silently substituting another edition.

The sample is intentionally challenging and is not a random estimate of catalog-wide coverage. Reference text varies too: MusicBrainz may use a different title punctuation or artist credit from a player. Report these as matching limitations rather than assuming every mismatch is a missing song.

## Start an external study

Use Node and the repository's existing dependencies. Run one study process at a time; request gating is per process. All writable evidence and credential paths must be outside the checkout, including through symlinks. Files are written with private permissions. Use a durable private directory; `/private/tmp` is suitable only for disposable runs.

```sh
npm run listening:study -- init --output /private/tmp/rescened-lastfm-study
npm run listening:study -- use-reviewed-references --output /private/tmp/rescened-lastfm-study
npm run listening:study -- freeze --output /private/tmp/rescened-lastfm-study
npm run listening:study -- evaluate --output /private/tmp/rescened-lastfm-study
```

`init` never overwrites an existing study. The next command copies the checked-in reviewed references after checksum verification. `freeze` locks all references before any Last.fm requests. The sample and scoring/matching code have separate checksum locks. Changing the rules after scoring requires a separately versioned experiment and separately reported results; never overwrite the baseline to improve its score.

`evaluate` is completely offline. It runs the focused deterministic suite and writes `deterministic-tests.txt`, `correctness.json`, `report.json`, and `report.md`. Exit 2 means evidence is incomplete; exit 1 means an error or deterministic-test failure. A completed study may exit 0 with a **fail** verdict: inspect the report, not merely the exit code.

## Capture album responses

Set `LASTFM_API_KEY` in the invoking shell. Alternatively, place it in a private dotenv file outside the repository and pass `--credentials /absolute/private/lastfm.env`. The command does not automatically load root `.env`. Never commit a key, username, or listening payload.

```sh
npm run test:listening-study-live -- capture-albums --output /private/tmp/rescened-lastfm-study
```

This explicitly opted-in command sets `RUN_LIVE_LASTFM_STUDY=true`. Direct invocation requires the same flag. Each edition is queried by frozen artist/title with autocorrect disabled, and separately by its MusicBrainz **release** MBID. A successful MBID lookup cannot rescue a failing name lookup. Last.fm album MBIDs remain opaque observed identifiers; they are never placed in a Rescened album ID or assumed to be release-group IDs.

The client has an identifying user agent, 1.1-second minimum request spacing, 10-second timeouts, bounded responses, at most three attempts, and bounded `Retry-After` handling. Missing or malformed album results remain failures. Transient outages remain incomplete and can be retried by repeating the command; completed provider responses are preserved. Credentials and raw responses never enter console logs. Run `evaluate` after capture.

## Record and capture actual sessions

Use the explicitly supplied account with scrobbling enabled. Each preselected controlled pair has one standard and one deluxe record in external `study.json.controls`. Record the exact selected release and sequence independently while playing it, before inspecting Last.fm responses. The corresponding reference lists track positions flattened across discs, starting at 1.

Fill these fields for each control:

- `from`, `to`: UTC Unix seconds bracketing the actual session, no longer than 24 hours, entirely in the past at capture time. Windows cannot overlap.
- `recordedAt`: ISO timestamp of the independent playback log.
- `qualifyingTrackPositions`: ordered positions played long enough to be scrobbled, including repeated positions. Do not infer this array from Last.fm.
- `confirmed`: true only after checking the edition and playback log. `id` and `editionId` must stay unchanged.

Retain the original independent player log privately alongside the study, including edition/source URL, sequence, skips, and timing. The machine-readable positions are its transcription, not proof manufactured from provider history. Include below-threshold sessions as well as qualifying ones; include shuffled/repeated/shared-opening-track sessions across the fixed 20 controls. The offline suite supplies exact deterministic boundaries but cannot establish that a real player preserves edition identity.

```sh
npm run test:listening-study-live -- capture-sessions --output /private/tmp/rescened-lastfm-study --username YOUR_EXPLICIT_ACCOUNT --session born-to-die:standard
npm run listening:study -- evaluate --output /private/tmp/rescened-lastfm-study
```

Omit `--session` to capture all confirmed controls. Captures read only those bounded windows, paginate all pages, and reject changing pagination or exceeded budgets. Now-playing rows never count. Repeating a capture can collect delayed scrobbles: previous captures are retained in external `captureHistory`. A changed independent log invalidates its previous capture hash. Same-second identical rows are conservatively deduplicated. This is a snapshot evaluator, not a production polling worker or durable diary receipt system.

## Frozen matching and scoring

Normalization handles Unicode NFC, case, curly apostrophes, and whitespace. Edition qualifiers and punctuation are preserved; there is no fuzzy match, removal of featured artists, or shortest-edition preference. Observed matching track MBIDs can resolve a track; conflicting populated identifiers cannot fall back to text. A textual track must match artist and title uniquely within the tracklist. Typed reference recording/release-track IDs are retained for review, not silently equated with Last.fm IDs.

Edition candidates must agree across a session; shared titles/opening tracks remain unresolved when they fit both editions. Mixed editions do not pick a convenient denominator. Shared-standard mode accepts the sampled edition labels but only distinct tracks matching the standard baseline count. The experimental denominator is the Last.fm-returned tracklist, validated independently against the reference; an eventual fallback would publish only reviewed standard baselines.

A gap **greater than** two hours starts a new album session; reaching 24 hours from its first matched event starts another. Sessionization is per album pair, using matched events. Unmatched rows remain reported and do not extend a session. Repeated tracks never increase coverage. The threshold is `ceil(0.8 × track count)`. Ambiguous duplicate-title positions do not count without resolving evidence. Session IDs are deterministic for a given snapshot; delayed evidence may change them, so they must not be reused as production publication receipts.

| Pilot gate | Edition-specific | Shared-standard |
| --- | --- | --- |
| Correct Last.fm baseline | 38/40 editions | 19/20 standard albums |
| Distinguished pairs | 18/20 | Not applicable |
| Correct actual sessions | 18/20 | 18/20 |
| Wrong-edition / false-positive listens | Zero | Zero false positives |
| Deterministic checks | All pass | All pass |

Missing and unresolved provider results reduce coverage. Outages, missing reference inputs, or unperformed actual sessions leave the result incomplete. No synthetic payload is accepted as evidence of actual playback by the workflow. Report `source: lastfm_live` denotes provenance captured by the CLI, not cryptographic attestation; do not hand-edit it. Evaluate the fallback independently if edition-specific gates fail. If neither passes, collect missing data before shipping.

## Reference-review tooling

The checked-in references suffice for the baseline run. For a separately versioned study, the CLI also supports explicitly gated `candidates --edition PAIR:KIND`, `browse-releases --release-group MBID`, and `reference --edition PAIR:KIND --release MBID --reviewer NAME`. Search results are candidates, never verified automatically; review release country/date/disambiguation and the complete tracklist before registering a release. Group browsing paginates with a 600-release budget and reports completeness.

For an official artist/label source, `reference-file --edition PAIR:KIND --reference-file /private/reference.json --reviewer NAME` registers an independently reviewed JSON object with `source` (HTTPS), `title`, `artist`, and `tracks` (title/artist objects). Include source/fetch provenance and a verified `releaseMbid` only if available. References cannot change after freeze or Last.fm capture.

Public fixtures contain MusicBrainz core metadata and handwritten synthetic data only. Last.fm payloads and user listening evidence remain outside Git; they do not inherit MusicBrainz's CC0 license. No database connection, schema change, account UI, or diary write is part of this command.

## Implementation verification — 2026-09-24

- PASS: 42 focused offline tests, including the live-request opt-in gate and reference checksum/freeze workflow.
- PASS: `npm test` — 287 passed, 51 intentionally skipped, zero failures (338 tests reported).
- PASS: `npm run check:catalog-contract` and `git diff --check`.
- EXPECTED INCOMPLETE: `evaluate` exits 2 with `collect_missing_evidence`; metadata is scored, but all 20 actual controls remain incomplete.
- NOT RUN: MongoDB integration and frontend lint/build; no persistence or frontend code changed. The full release gate was not run. Its additional commands are `npm run test:integration`, `npm --prefix frontend run lint`, and `npm --prefix frontend run build`.

## Separate diagnostic reports

Run the post-hoc analysis against an existing external study, without provider access:

```sh
npm run listening:study -- diagnose --output /private/tmp/rescened-lastfm-pilot-20260924
```

This writes two reports, each in Markdown and JSON:

- `track-matching-report`: frozen versus revised formatting comparisons for all 40 editions, with name and MBID lookups scored separately. Track-level differences show which changes resolve and which remain unresolved.
- `edition-evidence-report`: returned album labels and MBIDs, reference versus returned denominators and 80% thresholds, duplicate-title positions, and actual controlled-session outcomes for both edition and shared-standard counting. Different returned titles are observations, not proof that playback preserves edition identity.

The diagnostic matcher normalizes Unicode hyphen/nonbreaking hyphen and moves explicit featured credits between title and artist fields. Populated guest lists must agree; an absent guest is not invented. It preserves live/remix/remaster/demo/acoustic/bonus qualifiers and does not apply fuzzy matching or unreviewed aliases. Conflicting featured credits remain unresolved. Playback scoring continues to use the frozen study matcher; this revision is **not** silently applied to controlled sessions.

Both outputs record the experiment version, source snapshot hash, frozen rules hash, diagnostic-code hash, and reference hash. Source/capture timestamps are retained. The command never rewrites `study.json`, `report.json`, `report.md`, or frozen checksums. Missing evidence remains visible. Successful report generation is not a feasibility pass; this command deliberately has no automatic production recommendation.

Initial diagnostic result: name-query full matches increase from **13/40 to 17/40**. Newly matched: Random Access Memories standard, both In Utero editions, and Future Nostalgia deluxe. MBID-query matches increase from **11/40 to 13/40**. The remaining differences are unresolved; they are not automatically evidence of different recordings. Actual controlled playback remains **0/20**, so no listening reliability claim follows from these formatting improvements.

### Track-level coverage — diagnostic version 1.1.0

`diagnose` now reports strict and revised unique track matches for every edition and each lookup method. Coverage is independent of track order and requires one-to-one title/artist identities on both sides. Duplicate identities and conflicting credits remain unresolved; matching one repeated title cannot cover multiple positions. JSON contains explicit matched reference/returned positions, unmatched positions, and duplicate positions.

The report shows both denominators: matched/reference tracks and matched/returned tracks. The reference 80% target uses `ceil(0.8 × reference track count)`. Missing tracklists or unavailable inputs have unavailable coverage, not a measured zero. No aliases or additional normalization were introduced for this change, and frozen scores remain unchanged.

On the existing capture, **28/40 name-query editions (70%)** have unique matches covering at least 80% of reference tracks; 39/40 have measurable coverage. Complete revised tracklist matches remain **17/40**. MBID queries separately reach 80% reference coverage in **22/40**, with measurable coverage in 33/40. Examples: 1989 deluxe 16/19; Random Access Memories deluxe 21/22; Hozier standard 12/13.

This is metadata coverage, not actual listening or a new pass gate. For example, Lungs deluxe matches 17/20 reference tracks but returns a different 24-track edition. Such a case exceeds 80% coverage while edition identity and denominator correctness remain unresolved. The 70% coverage result must not be substituted for the proposed 60% complete-tracklist research checkpoint or the original pilot gates. Actual playback remains pending.

### Reviewed aliases — diagnostic version 1.2.0

The diagnostic now reports three separate stages: frozen matching, formatting-only matching, and reviewed edition-specific aliases. The [alias manifest](../data/listening-study/reviewed-aliases.json) contains 17 exact title/artist mappings across four editions, with reference hashes, release-track IDs, source links, review dates, and rationale. These are post-hoc review decisions on this sample, not independently validated general matching rules.

Reviewed cases:

- 1989 deluxe: the three voice-memo names are aligned to the corresponding instrument/vocal descriptions. The [alternate MusicBrainz listing](https://musicbrainz.org/release/6bbba9c0-29b0-4f35-adec-1ad6c289e0a9) identifies the three memos and their instrumentation. Studio versions are not aliases of these tracks.
- Origin of Symmetry anniversary edition: 12 exact per-track “XX Anniversary RemiXX” suffixes are aligned within that edition only. The [official Muse announcement](https://www.muse.mu/news/stream-origin-symmetry-xx-anniversary-remixx-now-322396) identifies the remixed edition and lists its tracks without those suffixes.
- Hozier standard: the apparent missing-letter typo “Foregner's God” is mapped to the unique reference title.
- Rumours standard: the shortened “Never Going Back” is mapped to the unique reference title. This and the Hozier correction are explicit, source-reviewed naming inferences, not proof from recording IDs in the Last.fm response.

Application requires the exact reference hash, release MBID, returned album name/artist and track count. Incoming aliases must resolve uniquely; a duplicate incoming title or existing target-title collision is not disambiguated by row position. Aliases modify only a temporary metadata-response copy. They never choose an edition, touch recorded source evidence, or run on actual scrobbles. Generic stripping of remaster/live/remix labels, other deluxe editions, and unreviewed spelling changes remain unsupported.

On the same captured name-query sample, complete matches progress **13 → 17 → 21 of 40**. The alias-assisted result is **52.5%**, still below the proposed 24/40 research checkpoint. Reference coverage of at least 80% progresses from 28/40 formatting-only to **29/40** alias-assisted. Separate MBID lookups reach **16/40** complete alias-assisted matches. Both the formatting-only results and frozen scores remain visible. JSON retains every applied alias and source; the reports hash both the alias manifest and application code. Actual playback remains 0/20.

Deferred review: generic remaster suffixes on Oasis, Radiohead, Blur, and Michael Jackson; live/demo descriptor changes; missing guest credits; and genuine edition substitutions. The available evidence has not been treated as permission to merge those cases merely to reach 60%.

## Reviewed album-name mapping — standard-baseline v1 study

The product direction is now one reviewed standard baseline per album, with edition-specific detection deferred. The new offline command implements the reviewed name-mapping layer without changing the frozen experiment:

```sh
npm run listening:study -- evaluate-mappings --output /private/tmp/rescened-lastfm-pilot-20260924
```

The [mapping registry](../data/listening-study/album-name-mappings.json) initially covers Lana Del Rey's `Born to Die`, `Born to Die (Deluxe Version)`, and `Born to Die (Bonus Track Version)`. These names map to the same study standard identity. This is a study ID, not a public Rescened album ID; catalog binding and production persistence are not implemented.

Mappings are explicit artist/name pairs, normalized only with the frozen text rules. Unknown names, missing names, different artists, and conflicting targets remain unresolved. The recent-track artist is a track artist, not a reliable album artist; guest-credit variations therefore remain unsupported until reviewed explicitly. A mapping never creates a catalog album, strips arbitrary version qualifiers, or resolves an edition.

The denominator comes from the frozen **reviewed standard reference**, not the provider-returned album list. Exact reference and tracklist hashes must match the registry; missing/changed baselines disable their mappings. The Born to Die entry explicitly reviews two core-track name variants (Blue Jeans and Video Games without the reference's remastered suffix). These are scoped to that reference, not a global remaster equivalence rule. Bonus tracks and ambiguous tracks still do not count; repeats count once. Source edition MBIDs are preserved in evidence but are not compared with the target standard album's MBID. Track-ID conflicts still use the conservative frozen matching rules.

Output is `album-name-mapping-report.md` plus JSON with original names, mapping decisions, baseline status, hashes and source provenance. Raw captures, frozen reports, and controlled-session logbooks are not rewritten. No manual or automatic diary records are read or changed. Reports are observational proposed-listen results, not a replacement oracle or a new pilot pass.

An optional `--supplemental /absolute/private/evidence.json` accepts an array of `{control, capture}` records using the existing independent-logbook and complete-capture contracts. Controls need distinct IDs, valid nonoverlapping windows, confirmed sequences, and capture control hashes. Supplemental controls remain labeled outside the frozen 20-session sample. Both isolated-control and combined-window results are reported; combined windows follow actual session gaps rather than treating every test window as a new listen.

Saved playback replay: standard session 12/12 → one proposed listen; deluxe tracks 1–10 → 10/12 and one proposed listen; supplemental nine standard tracks plus three bonus tracks → 9/12 and none. Across all windows, the first two tests merge under the existing two-hour-gap rule, leaving two combined sessions and one proposed listen total. This distinction matters for production session design. No provider requests are made by this command.
