# AI-assisted album mapping and tracklist review

Status, October 31, 2026: final planning review complete; moderator-feedback proposal added (revision 6). The bounded first milestone is ready for an implementation brief once building is authorized. Nothing here is implemented, and no flag, model, paid evaluation, or data apply is authorized by this document. Revision 6 adds the proposed reviewed-feedback loop to the advisory-first staged plan without expanding the bounded first milestone; the edition identity project remains parallel work. The [review history](#review-disagreements-and-required-expansions--october-31-2026) preserves the reasons for those changes and distinguishes design resolutions from work still required. The behavior this builds on is described in [automatic album listens](AUTOMATIC_ALBUM_LISTENS.md), the [Last.fm sync runbook](LASTFM_SYNC.md), and [tracklist baselines](TRACKLIST_BASELINES.md).

## Goals

1. **First deliver better evidence and faster individual review.** Truthful discovery/hydration coverage, ordered tracklist comparisons, and bounded public-input tracklist advice can improve current moderator work without a family migration. Measure review time and decision quality rather than promise fewer approvals.
2. **Then enable reliable automatic edition resolution.** An unambiguous name variant can resolve to its existing, supported edition entry after identity, migration, lineage, evaluation, and rollout requirements are met. Missing editions and ambiguous names stay unresolved in that later edition rollout.

Reduced moderator workload is a hypothesis to test. Suggestions may shorten each review, while new edition submissions may add work. Measure queue throughput, time per case, decision quality, and extra submission workload; neither a net improvement nor a net increase is established yet.

Two assistants share the evidence and evaluation infrastructure: a mapping reviewer suggests an existing catalog target for an eligible name alias, and a tracklist reviewer suggests one captured release for a baseline. Tracklist advice is evaluated first; mapping expansion depends on public-input eligibility and measured usefulness.

AI is one tool for these goals, not the goal itself. Deterministic rules come first, and the model handles only what is left that needs judgment. The model advises; it never creates albums, family membership, or tracks.

## Where things stand

- **Edition labels find the standard album, not the edition.** Discovery strips allowlisted edition labels (Deluxe, Expanded, Bonus Track, Anniversary) to find candidates and keeps distinct works (live, remix, acoustic, re-recorded) separate ([`lib/listening/discovery.js`](../lib/listening/discovery.js)). That establishes a candidate, not that a standard entry represents the requested edition. Edition-specific detection is deferred in the listening guide.
- **There is no album family or edition model.** `AlbumCatalog` has a unique, sparse external-reference index, and the importer matches existing albums by MusicBrainz release-group identity ([`models/AlbumCatalog.js`](../models/AlbumCatalog.js), [`lib/catalogImport/persistence.js`](../lib/catalogImport/persistence.js)). Two edition entries cannot both hold the same release-group reference today.
- **Mappings are global artist/title aliases.** Mapping cases and active mappings use provider, normalized artist, and album name, not an event-specific release ID. "Album (Deluxe)", "Album - Deluxe Edition", and "A feat. X / Album" are separate cases, but two releases using the same artist/title share one key. The worker applies that mapping to later events ([key construction](../lib/listening/common.js), [unique mapping schema](../models/Listening.js), [event resolution](../lib/listening/worker.js)). Nothing approves a mapping automatically, and the listening guide says credit variants must "remain a moderator approval, never an automatic one."
- **Approval latency loses automatic listens.** Automatic publication only covers plays whose qualifying event is at most 7 days old. Plays that qualify later, including after a late mapping approval, become owner-confirmation suggestions.
- **The recommender keeps only one release.** `recommend()` in [`lib/baselines/musicBrainz.js`](../lib/baselines/musicBrainz.js) hydrates at most three official releases and returns the first complete one. Its ambiguity check fires only when equally ranked releases have different track counts. Ties fall through to date and MBID, so a first place can come from a tie-breaker rather than strong evidence. Hydrated tracks already carry `recordingMbid` and positions.
- **Successful requests do not establish complete coverage.** An offline review reproduction listed four equally ranked official releases, hydrated three, and returned `incomplete: false` and `ambiguous: false`. The current flag does not account for the hydration cap. Discovery also truncates candidate lists without marking truncation as incomplete ([recommendation](../lib/baselines/musicBrainz.js), [discovery](../lib/listening/discovery.js)).
- **Revocation reopens the case.** Revoking a mapping marks it revoked, returns its case to `pending`, and queues reprocessing ([`lib/listening/moderation.js`](../lib/listening/moderation.js)). Discovery can also reopen rejected or no-match cases when evidence changes. Reconciliation holds affected sessions (`stale_mapping`, `reconciliation_required`) instead of rewriting published listens.
- **Lineage and duplicate checks are per album.** Reconciliation groups shared events by `(albumId, eventId)`, so moving the same events to a different album produces a new session without predecessor lineage. `manualNearby()` checks only the selected album ([`lib/listening/reconciliation.js`](../lib/listening/reconciliation.js), [`lib/listening/publication.js`](../lib/listening/publication.js)).
- **Existing hashes are not decision hashes.** Discovery's `evidenceHash` and `hashCandidateTracklist()` are useful inputs, but the tracklist hash excludes country, date, formats, status, and disambiguation, and an incomplete discovery refresh keeps the previous hash ([`lib/listening/worker.js`](../lib/listening/worker.js)).

## Prerequisite: album families and editions

Separate edition entries linked through an album family are the product direction for the later edition rollout. Develop its technical design in parallel with advisory work; it is not a prerequisite for current-album coverage reporting, ordered comparisons, or tracklist advice. Put the detailed catalog-identity design in a separate maintained document and link it here when it exists; that document has not been created by this revision. Settle its contracts before edition implementation and rollout:

- **Edition granularity.** The proposed edition rollout uses meaningful musical editions, such as standard and deluxe, rather than a public entry for every physical pressing. Multiple releases may belong to one edition only through reviewed equivalence of musical content and ordered recording occurrences. Manufacturing, packaging, or territory differences alone need not create an edition; musical substitutions, alternate recordings, and unresolved differences require explicit review. A shared title or recording set is insufficient.
- **Reference ownership.** The family owns the MusicBrainz release-group reference; each edition owns its release references. A shared release group is family evidence, not edition identity. Family membership remains reviewed.
- **Compatibility and classification.** Preserve existing public `albumId` values, URLs, historical interactions, and mapping audit history. Do not automatically label every legacy entry standard: the importer stores a release group and optional representative release, while baseline validation establishes group membership rather than standard-edition classification. Classify each entry from reviewed evidence; retain an explicit edition-unresolved migration state where evidence is insufficient. Preserve historical mappings without treating them as proof of an exact edition; revalidate eligibility before using them for edition automation. No silent retargeting or historical rewrite.
- **Coordinated reference migration.** Design family-aware reads and writes together across catalog indexes, importer identity lookup, community submission/approval duplicate checks, mapping discovery, and baseline discovery/preview/confirmation. Today these consumers resolve identity through album-level external references ([importer](../lib/catalogImport/persistence.js), [submission duplicate checks](../routes/utils/submissions.js), [approval](../routes/utils/approval.js), [discovery](../lib/listening/discovery.js), [baseline service](../lib/baselines/service.js)). Specify compatibility reads, uniqueness ownership, revisions, cutover order, and rollback before moving references. Any later data apply remains dry-run-first and separately authorized for its named target.
- **Missing editions.** For the later edition rollout, the proposed policy leaves the mapping unresolved and gathers evidence for a separate reviewed community submission. It does not assign the standard edition provisionally or create an album automatically. A later release-based importer remains an explicitly invoked, separately reviewed path. Queue measurement must include the resulting submission workload.
- **Global alias scope.** In the later edition workflow, approve a global artist/title alias only when reviewed evidence establishes one supported edition for that alias. Shared names spanning different musical editions stay unresolved, even if one public provider lookup selects a release or one listener's tracks fit it. Tracks shared by several editions do not establish which edition was heard. Event-specific edition resolution requires a separate evidence-aware mapping contract; it is outside the proposed edition rollout.
- **Cross-edition lineage.** This remains a prerequisite requiring technical design, not a solved property. Define how events move between editions, how published listens and dismissal receipts are preserved, and how manual-entry checks and transaction fences span a family. Use evidence-backed lineage rather than deduplicating every family entry on the same day. Validate reassignment and concurrent publication before edition automation.

This plan does not introduce automatic deluxe-to-standard mappings while the edition design is pending. That would enlarge the later reassignment problem.

## Transition boundary during advisory work

The current mapping workflow, existing active mappings, published history, feature flags, and isolated Last.fm shadow trial remain unchanged during the advisory stages. The edition rules above apply to the future edition rollout; they do not silently replace the maintained listening guide now. Early mapping advice must name a restricted eligible case set under current rules and must not become a new pathway for edition reassignment or automatic approval. Current-album tracklist advice can proceed independently of the eventual mapping cutover.

A freeze on **new deluxe-to-standard approvals** and revocation of **existing active mappings** are different operations. Existing mappings continue to resolve events through [`resolveRow()`](../lib/listening/worker.js) until an explicit state change; stopping new approvals would not itself revoke them. Neither operation is authorized here. The edition cutover design must separately specify the treatment of new approvals, existing mappings, revalidation, and preserved history, including whether any new-approval freeze is needed. Update the maintained listening guide when an approved behavior change is implemented, not by implication from this proposal.

## Design: three tiers

### Tier A — automatic approval by deterministic rule

No model. Not enabled until the prerequisite, a system entry point, a durable veto, and the per-rule evaluation and authorization gates are satisfied. A versioned rule approves a mapping case only when every condition holds:

- The observed title differs from an existing edition entry's title only by allowlisted normalization, and no distinct-work marker is present.
- Exactly one supported edition is established after evidence-based filtering, not merely after top-N truncation. Its release references match the verified release evidence, and the alias meets the global-scope restriction above.
- The explicit discovery, truncation, and hydration coverage contract below is satisfied for this run; no relevant competitor remains uninspected or supported only by retained stale evidence.
- No `identifierConflicts`, no `duplicateTitleAmbiguity`, no artist-credit difference, and no automation veto.
- The edition has a reviewed baseline. Any private event comparisons run locally and may reject or hold resolution; agreement on shared tracks cannot make an ambiguous global alias eligible.

Requirements:

- **A system entry point, not a fake moderator.** Human and system approvals call separate, separately authorized entry points around one shared transactional operation. No system identity joins `MODERATOR_USER_IDS`.
- **A durable automation veto.** A moderator rejection, no-match, or revocation records a veto that persists when discovery reopens the case. Only an explicit moderator release clears it. The write transaction checks the veto together with current revisions.
- **Audit.** The append-only audit records actor type (`human` or `system`), rule version, decision-input hash, and outcome.
- **Rollout.** A disabled-by-default flag. Start on `rescened_dev` in report-only mode, comparing what the rule *would* approve with what moderators approved, before any writes.
- Featured-artist credit variants are a separate, later rule and need an explicit change to the documented "never automatic" decision.

### Tier B — AI suggestion with individual decisions

For cases Tier A does not resolve, the AI reviews the captured evidence and suggests one existing candidate or abstains. Agreement with the top deterministic candidate is shown as a review aid. Both read the same captured evidence, so agreement is not independent verification and can repeat a shared retrieval or metadata error.

Moderators decide individually first. A later bulk action must name a reviewed selection, capture each item's revisions, reject stale items, and report per-item outcomes, like bulk submission approval. Promotion of any pattern to automatic acceptance is a separate product and authorization decision, gated by the evaluation bar below.

### Tier C — full review

Disagreements, abstentions, flagged conflicts, missing editions, and anything else. The AI panel and the side-by-side tracklist view help most here.

### Rule promotion loop

Every Tier B or C decision records the moderator's choice and a reason code. The proposed [feedback loop](#proposed-moderator-feedback-loop) can supply reviewed correction examples to later advisory calls. Recurring patterns become candidates for new deterministic rules. Each candidate requires its own evaluation gate and separate authorization before promotion; recurrence alone never enables automation.

## Tracklist baselines

The first advisory milestone assists current album-level baseline reviews under the existing contract, with explicit moderator confirmation and no new edition assignment. It does not require persisted families. The later edition workflow uses the same tiers with a stricter bar, because confirming a baseline can fill an empty catalog tracklist. Each edition entry must be reviewed against releases of that edition: preferring the standard release is right for the standard entry and wrong for a deluxe one.

**Deterministic work first (useful without AI):**

- Keep the hydrated alternatives from `recommend()` instead of discarding them.
- Compare **ordered recording occurrences**, not sets: track positions, disc boundaries, substitutions, omissions, and repeated recordings at distinct positions. `[A, B, A]` and `[A, B, B]` share a set and a length but are different tracklists.
- Establish edition relationships (bonus-track superset, abridged multi-disc release) through reviewed position correspondences, not net track-count differences. Mark alternate recordings and unresolved correspondences explicitly.
- Raise the recommendation to ambiguous when equally ranked releases differ in ordered occurrences, not only in track count.

**Tier A for baselines:** auto-confirm only when reviewed edition identity and the coverage contract establish one supported tracklist. A first-ranked release, even on substantive criteria, is a recommendation rather than proof. All relevant competing releases must be inspected or excluded through recorded evidence; equally suitable releases must have equivalent ordered recording occurrences. Date or MBID may select a representative only after equivalence is established, never decide musical identity. Same entry point, veto, audit, flag, per-rule gate, and report-only rollout as mappings.

**AI for the remainder:** the model interprets the computed differences and recommends one supplied release, or abstains. It never invents tracks or combines releases. Target cases:

- For a standard entry, prefer a supported standard release over bonus-track releases, not simply the shortest.
- Preserve both discs of an original double album rather than choosing an abridged version.
- Flag regional variants when the evidence doesn't establish one release.

Moderators see the side-by-side difference view, reasons, and source links. Confirmation stays explicit outside Tier A.

## Evidence coverage contract

Persist separate discovery and hydration coverage rather than reusing today's `incomplete` flag as proof:

- **Discovery coverage:** sources and queries searched, pages inspected, reported totals when available, outstanding pagination, failures, freshness, and whether the provider's search scope is bounded or unknown. Record candidate counts before and after every cap and every truncation point. A successful request is not an exhaustive search.
- **Hydration coverage:** discovered relevant release IDs, inspected IDs, failed or pending IDs, and exclusions with evidence IDs and reasons. An exclusion must establish irrelevance to the edition; low rank alone is not enough. Preserve all hydrated alternatives needed for the decision.
- **Budget exhaustion:** retain bounded fetch limits. If a relevant competitor remains uninspected, mark the decision evidence insufficient and abstain from selecting or automatically confirming a winner. Queue a bounded follow-up or human review; do not fetch indefinitely. The AI may explain captured differences but must abstain from a selection while coverage is insufficient.
- **Presentation limits:** the five-candidate AI payload cap is a presentation bound, not uniqueness evidence. If more relevant candidates remain, resolve or inspect them through the controlled workflow before asking for a selection. Hash the coverage state and exclusion evidence with the decision inputs, and revalidate them before acting.

## AI assistant contract

**Public payload allowlist:** public Rescened album IDs, titles, artist credits, publicly exposed reviewed family/edition relationships and release references; captured MusicBrainz release/group/recording identifiers, titles, credits, country, date, formats, status, disambiguation, ordered track occurrences and durations; source URLs and evidence IDs; code-computed differences between those public records; and non-identifying coverage state. The proposed serializer must reject unlisted fields and validate source provenance. No cover images or arbitrary annotations are included. The later feedback stage may add only the separately reviewed, public-safe correction renderings defined in the [feedback loop](#proposed-moderator-feedback-loop).

**Mapping input:** up to five public catalog candidates and their allowed public evidence. A query title or artist may be included only as a source-backed public catalog/MusicBrainz value. Raw observed Last.fm text, custom tags, user/connection/event IDs, event timestamps, listening sequences, encounter counts, private histories, and event-derived correspondences are excluded. Internal catalog revision and case identifiers stay in local freshness/audit bindings, outside the public model payload. Bind the model's advice to the private case locally. If public evidence cannot express the distinction, abstain and leave the case to local moderator review.

**Alias eligibility:** repeated observations from multiple connections do not make raw alias text public or demonstrate that it contains no personal information. Do not use a connection-count threshold as sufficient permission to send it. The existing `listenerCount` is a queue-ranking field refreshed from retained unresolved events, not an export gate ([worker](../lib/listening/worker.js), [schema](../models/Listening.js)). Count public-input-eligible and excluded cases locally, record exclusion reasons, and measure abstention. If the boundary makes mapping advice unhelpful, prioritize tracklist advice; broader alias export requires a separate design decision.

**Tracklist input:** the relevant hydrated public releases with code-computed ordered differences and coverage state. Private event comparisons stay local, including any check of whether an event fits a proposed edition. They never enter the model prompt or its shared cache.

**Output:** a candidate or release ID from the supplied set, or an abstention. Reasons are **reason codes tied to evidence IDs** (for example `verified_release`, `bonus_superset`, `missing_medium`), with optional short prose. A validator checks that every cited ID exists and that the cited evidence says what the code claims. Free-text-only reasons are rejected. The model does not report a confidence score.

## Proposed moderator feedback loop

**Purpose and timing.** Future stateless calls can receive a few relevant, reviewed correction examples in their input. Recording a disagreement does not change model weights or make future calls remember it automatically. Add this after deterministic improvements and initial advisory evidence collection, not to the bounded first milestone. Feedback improves advice; it never releases a veto, approves a mapping, or enables a rule.

**Current versus proposed.** [Mapping audits](../models/Listening.js) already store action, reviewer, free-text reason, revision, and action-dependent details; the [transactional writer](../lib/listening/moderation.js) binds them to a case/mapping. [Baseline audits](../models/AlbumBaseline.js) store actor, reason, revision, target/request/baseline IDs, and details; the [confirmation service](../lib/baselines/service.js) records release/tracklist identity when a snapshot is selected. These are provenance sources, not an existing AI correction store or uniformly complete evidence snapshots. Preserve their history; add separately reviewed correction records rather than export raw audits.

**Correction record.** Locally bind the original suggestion and input hash, model/prompt/schema versions, proposed and moderator-selected IDs (or abstention), structured reason/error type, supporting public evidence IDs and snapshots, decision and target revisions, scope (task, edition relationship, error type), and audit/reviewer provenance. Classify the change as a model mistake on the original evidence, new or corrected evidence, product preference, or unresolved disagreement. A later discovery is not proof the model was wrong on its earlier inputs; preferences require an approved policy before becoming instructions.

**Review and lifecycle.** A moderator can propose a correction while deciding a case; reuse requires a separate evidence-and-scope review, not merely disagreement. Check the original inputs and alternative explanation, and use a second reviewer for disputed corrections. Conflicting examples with overlapping scope are quarantined pending resolution rather than settled by vote count or last write. Version corrections append-only with proposed/approved/superseded/retracted states, review provenance, expiry/revalidation conditions, and replacement links. Changed source evidence, target identity, or policy requires revalidation. Retraction removes future eligibility without deleting the original decision trail.

**Bounded retrieval and privacy.** Retrieve only approved, current examples relevant to the task and evidenced edition/error scope; deduplicate and cap both example count and tokens within the pilot's total input limit. Record selected correction versions and retrieval-policy version locally for reproducibility. No applicable example means no added example. Export only a separately reviewed, schema-validated rendering using the public evidence allowlist, controlled reason labels, and bounded public-safe explanatory text. Raw moderator prose, identities, private case IDs, events, and histories are never automatically exported. If the explanation depends on private evidence and cannot be supported by the public rendering, keep it local. Give exported examples request-local labels; internal correction IDs and review metadata stay local.

Treat example text as untrusted data, isolated from instructions: no browsing, tools, arbitrary instructions, or permission changes from feedback. Output choices must still come from the current case's candidates, never an example's candidate IDs. Current evidence, coverage checks, deterministic validation, freshness, approval gates, and vetoes still apply. Example: a verified two-disc release was wrongly treated as abridged because disc two was overlooked; show the public ordered-disc evidence and correction to a relevant case, not a universal instruction to choose the longest release.

**Evaluation and promotion.** Freeze feedback and retrieval versions for each evaluation. Keep development examples, validation families, and held-out test families separate, including all related editions and retrieved corrections; never retrieve a held-out decision or same-family correction into its test prompt. A test outcome used to tune examples becomes development material and needs a fresh held-out evaluation. Compare advice with and without feedback on the same eligible cases, measuring harmful mistakes, abstentions, review time, and added token cost; include counterexamples where overgeneralizing a correction would be wrong. Turn reproducible corrections into fixture regressions. Reusable prompt changes or deterministic rules require human review, versioning, regression checks, and the existing evaluation/authorization gates; one disagreement never becomes a universal policy.

## Safeguards

- Use captured, allowlisted public evidence only; no model browsing. Enforce the payload contract before every request, including evaluation and retries.
- Treat all allowed provider text as untrusted data. Use a closed output schema with supplied IDs, bounded reason codes/prose, and deterministic evidence validation; prompt instructions alone are not a security boundary.
- Put the model behind its own adapter and a disabled-by-default flag, with bounded timeouts and no automatic UI retries. When the model is unavailable, the panel is absent and nothing is blocked.
- Normal tests use captured model responses as fixtures. `npm test` never calls a live model.
- **Decision-input hash.** Hash all decision-relevant metadata the model saw (including country, date, formats, status, and disambiguation), candidate membership, coverage and exclusion evidence, reviewed edition relationships, and the model, prompt, schema, and rule versions. When feedback is used, include the exact sanitized examples and retrieval-policy version; bind selected correction IDs/versions locally. Coalesce identical requests and reuse results for unchanged inputs; retrieval timestamps alone never force another call.
- **Freshness is checked separately.** Before showing an actionable suggestion or accepting one, validate current target revisions, source freshness, discovery completeness, and candidate expiry. For feedback-backed advice, also revalidate selected correction versions and eligibility; expired, superseded, or retracted examples make the suggestion stale until reevaluated under current inputs. An unchanged retained hash is not a successful refresh. Stale evaluations stay in the audit but are never shown as current recommendations.
- Audit every suggestion alongside the moderator's actual decision.
- Use a separate advisory queue. The running Last.fm shadow trial stays untouched.

## Pilot spend and execution limits

Fixture replay is the first evaluation and makes no model calls. Any paid pilot requires explicit approval of a named configuration with finite numeric limits; this document approves no dollar amount, model, or calls. Available credits do not authorize spending.

**First paid evaluation: a single-worker operator CLI.** Use a fixed, checksummed manifest of eligible public-input cases, one active process, and sequential requests. The manifest identifies the model/version, prompt/schema versions, case/input hashes, and pilot ID. This stage does not need distributed worker reservations.

| Required limit | Single-worker enforcement |
| --- | --- |
| Model/version, applicable pricing, and hard total pilot spend cap | Before dispatch, check the worst-case cost of the next attempt against the remaining local cap. Account for every billed token category and retain the maximum charge for uncertain outcomes. |
| Maximum cases, input/output tokens per request, and total token allowance | Validate the fixed manifest and each request; set the provider output limit, including any billed reasoning allowance. Oversized cases abstain; do not silently truncate decision evidence. |
| Maximum total attempts and attempts per case | Count every attempt, including SDK retries and operator resumes, against the same pilot limits. Disable hidden retries or account for them explicitly. |
| Timeout and retry bounds | Retry only classified transient failures within the remaining attempt/token/spend limits and provider backoff. Do not automatically retry invalid input/schema, exhausted limits, or an uncertain prior outcome. |

Persist a small append-only attempt log before dispatch and record result, usage, and outcome afterward. Resume the same pilot from that log rather than resetting counters. Reconcile uncertain outcomes or keep their worst-case charges; stop if the log cannot be trusted. Reuse valid cached results, stop on missing/invalid limits, and provide an operator stop switch. This bounded local accounting preserves a hard pilot budget without a distributed scheduling system.

**Provider controls are secondary.** Verify the selected provider's actual enforcement semantics before using its limits as backup; provider and model remain unselected. For example, OpenAI distinguishes alerts from enforced organization/project limits and documents possible enforcement lag and slight overspend ([official example, checked during the final review](https://developers.openai.com/api/docs/guides/spend-limits)). This example is not a provider choice. No account-specific setting has been verified or changed. Do not substitute a monthly provider setting for a per-pilot worst-case cost check.

**Before concurrent or background scheduling:** add durable shared reservations and settlement, worker leases, and aggregate spend/token/job/concurrency limits. These are later requirements for multiple dispatchers, not a prerequisite for fixture replay or the sequential pilot. None of these controls is claimed to be implemented.

## Evaluation

**Entry criterion for a model pilot:** after deterministic coverage and comparison work, separate remaining cases into complete-evidence judgment cases, evidence-insufficient cases, and already-resolved cases with measurable review effort. Count the eligible public-input cases and estimate potential review-time savings before building the model adapter or paying for evaluation. A small useful population may justify stopping with the deterministic tools. Incomplete evidence is not a problem the model can repair: those cases need bounded retrieval or human review and remain selection-abstentions. Missing evidence alone does not justify a paid call.

**Replay fixture source:** existing reviewed album heads can identify provisional examples through `activeBaselineId` and `Baseline.candidate.releaseMbid`; submission selections use `selectedSnapshotId` ([models](../models/AlbumBaseline.js), [read/confirmation service](../lib/baselines/service.js)). Check the target revision and baseline identity. A reviewed status alone is not proof of a correct label, and a chosen release alone is not a complete historical candidate set. Preserve available alternatives and coverage from the original decision; if evidence is reconstructed later, label it as a newly assembled evaluation case rather than historical replay. Strip reviewer IDs, private reasons, and other non-allowlisted fields from model inputs. Keep expected selections outside prompts. Independently re-review the held-out quality set because original decisions may have been anchored by the existing recommender. No database fixtures have been extracted or validated for availability by this plan.

- Build an independently labeled, held-out case set before any model work, **grouped by album family** so related editions never span training examples and test cases. Early offline datasets may use reviewed family groupings without introducing production family records. Include dedicated difficult-edition and missing-candidate cases, plus re-recordings, credit variants, regional releases, and double albums.
- Compare Tier A rules, the AI, and the current deterministic ranking on that set.
- Measure recommendation precision on non-abstained cases, abstention rate, harmful mistakes (wrong edition or family, re-recording mapped to the original, abridged release confirmed), retrieval coverage (was the right answer among the candidates at all), anchoring, and review time.
- **Define the independent evaluation unit before sampling.** Split by album family and treat within-family cases as correlated. Either sample one prespecified eligible case per independently sampled family for a rule, or use a documented family-clustered uncertainty method. Report families, cases, and eligible decisions separately; hundreds of related variants are not hundreds of independent safety observations.
- **Define per-rule promotion gates before evaluating.** Specify the eligible population, supported edition types, minimum independent sample, acceptable harmful-error upper bound, recommendation precision, abstention/retrieval coverage, and review-time target for each mapping or baseline rule. Do not pool easy cases to approve a rule for difficult editions. The approximate 3/*n* upper bound at 95% confidence applies to zero failures among appropriately independent observations; it is not an approved gate or a justification for treating correlated cases as independent. Promotion still requires separate authorization.
- **Separate advisory usefulness from automation proof.** Count eligible independent families per proposed rule during queue measurement. If the required bound cannot be supported, the rule stays advisory; do not weaken the gate or count correlated variants as independent. An unreachable automation gate does not prevent evaluating review time and quality for an advisory tool. Numeric gates remain to be selected; the illustrative bound is not a universal launch requirement.
- Measure public-input eligibility, exclusions by reason, and abstention before claiming mapping coverage. Measure review time, decision quality, throughput, and additional edition-submission workload to test the workload hypothesis.
- Measure anchoring with a blind sample in which moderators decide before seeing the suggestion.

## Build order

1. **Measure and define the first milestone.** Count queue types, missing edition entries, public-input-eligible/excluded cases, and eligible independent families per prospective rule. Establish current review time, decision quality, throughput, and expected extra submission workload. These measurements have not been performed by this document update.
2. **Ship truthful evidence coverage and ordered comparisons first.** Retain hydrated alternatives, expose discovery/truncation/hydration coverage, compare ordered occurrences, and abstain on uninspected relevant competitors. This is useful without AI or family migration. Carry the coverage distinctions into moderator presentation; the current panel only warns when the provider flags do ([baseline panel](../frontend/src/Components/Community/BaselineReviewPanel.jsx)).
3. **Gate and evaluate public-input tracklist advice.** First measure residual complete-evidence judgment work and review effort after step 2; separate evidence-insufficient cases, which require retrieval or human review. Proceed only if the useful eligible population warrants an adapter/pilot. Define the allowlisted payload and held-out manifest, using independently checked provisional baseline examples where suitable, then replay captured fixtures. Paid evaluation requires the separately approved sequential pilot. Measure advisory benefit; no automatic confirmation or catalog identity changes.
4. **Add individual advisory panels if evaluation supports them.** Start with current-album tracklist reviews. Include current-album mapping advice only for an explicitly bounded eligible case set and only if public inputs provide useful advice; ambiguous edition reassignment stays out. Retain moderator decisions and blind-sample measurement behind disabled flags. After initial advisory evidence collection, separately scope the reviewed-feedback loop and evaluate its added benefit before enabling example retrieval.
5. **Enable edition workflows only after the parallel identity project is ready.** Require reviewed legacy classification, coordinated reference migration, an explicit cutover for new and existing mappings, cross-edition lineage, family-wide duplicate protection, and relevant transactional validation. Data applies and workflow enablement require their own named authorization.
6. **Consider automatic rules and bulk actions separately.** Require the authorized system entry point, durable veto, concurrency safeguards, and reachable per-rule evaluation gates. Start proposed automatic rules in report-only mode before any approved writes. Patterns without enough independent evidence remain advisory.
7. **Add background scheduling only after usefulness is measured.** Introduce shared reservations and aggregate limits before multiple dispatchers; scheduling does not itself authorize automatic acceptance.

**Parallel identity design:** develop the separate family/edition technical design alongside steps 1–4. It must cover meaningful-edition equivalence, reference ownership, compatibility reads, unresolved legacy classification, rollback/cutover, alias scope, and lineage. Specify validation for reassignment, shared names, overlapping events, manual entries on another edition, mixed labels, reprocessing, concurrent publication, and genuinely separate plays. Creating the design does not authorize implementation or a data apply.

The first milestone serves the review-efficiency goal. Exact edition rollout and new automatic approvals arrive later, after their own prerequisites; they are not promised by the advisory MVP.

### Bounded first milestone and acceptance criteria

The first implementation brief covers discovery/recommendation coverage, retained hydrated alternatives, pure ordered-occurrence differences, and their existing moderator presentation. Integration points are [mapping discovery](../lib/listening/discovery.js), [baseline recommendation](../lib/baselines/musicBrainz.js), [baseline response shaping](../lib/baselines/service.js), and [the baseline panel](../frontend/src/Components/Community/BaselineReviewPanel.jsx). Agree the response shape and compatibility handling as routine implementation work; the product direction needs no additional decision for this scope.

- Every browse/search/hydration cap or failure is represented separately from musical ambiguity. Four relevant releases with only three hydrated cannot be presented as fully inspected.
- Ordered comparisons preserve repeated recording occurrences, positions, and disc boundaries; equal-length lists with different occurrences or substitutions are not equivalent.
- Moderator presentation exposes missing evidence and inspected alternatives. Rankings remain advisory, missing evidence never becomes identity proof, and existing explicit approval/confirmation boundaries stay intact.
- Fixture-based checks cover capped and failed retrieval, equal-count differing releases, repeated recordings, multi-disc differences, and stale evidence. Tests make no live provider/model calls. Run the relevant repository backend, catalog-contract, and frontend checks for the touched surfaces; add transaction integration checks only if the implementation changes that boundary.
- The milestone adds no model adapter/calls, family records, catalog import/migration, automatic approval, or trial/configuration changes. It does not require a live database apply. Any queue measurement must use a separately identified readable source and must not silently turn into data-changing operator work.

These are acceptance criteria for a future build, not a claim that the implementation or checks are complete.

## Decisions and readiness

The settled requirements for this proposal are: advisory-first delivery; unchanged current workflow and trial during advisory work; public-only model payloads; honest evidence coverage; bounded pilot spending; and separate gates for identity migration and automation. Independent work can proceed without waiting for the family design. Document maintenance does not authorize implementation, data changes, or spending.

The proposed later edition workflow uses meaningful musical editions grouping reviewed equivalent physical releases, leaves missing editions unresolved with evidence for reviewed submissions, and limits global aliases to unambiguous supported editions. It introduces neither provisional standard assignment nor event-specific edition disambiguation. Treatment of legacy mappings at cutover still requires the technical contract described above.

Pending choices belong to their stage:

1. **Before paid evaluation:** the selected model and explicit numeric case/token/attempt/spend limits. Fixture replay needs neither a paid model nor distributed reservations.
2. **Before mapping advisory expansion:** the eligible current-album case set and evidence of usefulness within the public-input boundary. A broader alias-export policy, if ever proposed, needs separate review; connection count alone cannot establish it.
3. **Before edition rollout:** the new-approval policy, treatment of existing mappings, migration/lineage contracts, and whether to add a release-based importer alongside reviewed submissions. A freeze on new approvals is distinct from revocation or rewriting history.
4. **Before automatic approval:** numeric per-rule gates with independent sampling, enough eligible evidence, and explicit rollout authorization. Featured-artist automation would also reverse an existing documented decision.
5. **Before wider release:** suggestion timing outside blind samples and whether incorrect automatic approvals should notify affected owners as well as hold affected listens.

General agreement need not wait on these later-stage choices. After each requested review round, reconcile the findings into this document while preserving review rationale. This maintenance instruction does not start additional review rounds or authorize code, commits, deployment, paid calls, or data operations.

## Review disagreements and required expansions — October 31, 2026

The following history preserves the original disagreements and their reasons. References to earlier proposals describe superseded text; the operative sections above incorporate the resolutions. A design resolution does not mean the code is implemented or a technical prerequisite is complete. This history does not authorize automation, publication, or data changes.

### 1. Resolve the exact edition instead of collapsing deluxe entries

**Verified:** `AlbumCatalog` has a unique external-reference index, and the importer matches existing albums by MusicBrainz release-group identity. Discovery's edition-label simplification finds candidates; it does not establish that a standard entry represents the requested deluxe edition. See [catalog indexes](../models/AlbumCatalog.js), [import identity handling](../lib/catalogImport/persistence.js), and [mapping discovery](../lib/listening/discovery.js).

**Disagreement with revision 1:** its goal and Tier A conditions collapsed edition names into a standard target, while the revised product direction is separate edition entries linked through an album family. A shared release group establishes family evidence, not an exact edition. Likewise, preferring a standard release is inappropriate when reviewing a deluxe entry.

**Recommendation:** define family ownership of release-group references and edition ownership of release references before implementing these rules. Preserve existing public IDs, URLs, historical interactions, and reviewed mappings. Match only an existing, supported edition; when it is absent, prepare evidence for a separate reviewed submission and leave the mapping unresolved. Ambiguous editions remain unresolved. AI must not create albums or invent family membership.

**Resolution (revision 3):** operative edition targeting is retained. The second review removed the unsafe blanket conversion of legacy entries to standard editions: reviewed classification and an unresolved migration state replace it. Coordinated reference migration, meaningful musical editions, unambiguous global aliases, and missing-edition submissions are now explicit prerequisites. Existing IDs and history are preserved without assuming that a historical mapping proves exact edition identity.

### 2. Compare recording occurrences and positions, not sets alone

**Verified:** `recommend()` hydrates at most three official releases, returns one complete candidate, and flags equally ranked alternatives only when track counts differ. `compareRecommendation()` eventually uses date and MBID to break ties. See [release recommendation and ordering](../lib/baselines/musicBrainz.js).

**Disagreement:** identical recording sets do not establish equivalent tracklists. `[A, B, A]` and `[A, B, B]` have the same set and length but different recording occurrences. Sets also discard order and disc boundaries. A uniquely sorted first result can reflect an arbitrary tie-breaker or missing alternatives rather than strong identity evidence.

**Recommendation:** retain the hydrated alternatives and compare ordered recording occurrences, track positions, disc boundaries, substitutions, and omissions. Establish edition relationships through reviewed position correspondences; do not infer them from net track-count differences. Treat alternate recordings and unresolved correspondences explicitly. Incomplete discovery or hydration must prevent automatic confirmation. Preserve repeated recordings at distinct positions.

**Resolution (revision 3):** ordered occurrence comparison remains the design. The second review reproduced four listed releases with only three hydrated while the current API reported complete and unambiguous. Explicit discovery/truncation/hydration coverage and abstention replace reliance on that flag; rank alone cannot establish identity. Relevant competitors must be inspected or excluded with evidence.

### 3. Treat AI/rule agreement as a review aid, not independent verification

**Verified:** both proposed reviewers consume the same captured candidate set and provider evidence. Existing deterministic ranking is a candidate ordering, not an approval decision; see [candidate ranking](../lib/listening/discovery.js).

**Disagreement:** agreement can reproduce a shared retrieval or metadata error. It does not justify an unbounded "accept all agreeing" action or promotion to automation on its own. Zero observed harmful mistakes also needs a defined sample size and uncertainty bound.

**Recommendation:** start with individual moderator decisions. Any later bulk action should name a reviewed selection, capture revisions, reject stale items, and report per-item outcomes. Use independently labeled, held-out evaluation grouped by album family, with dedicated difficult-edition and missing-candidate cases. Measure recommendation precision, abstentions, harmful mistakes, retrieval coverage, anchoring, and review time. Define promotion gates before evaluation; keep automated acceptance a separate product and authorization decision.

**Resolution (revision 3):** Tier B still starts with individual decisions. Evaluation now defines independent units and per-rule gates explicitly; family splitting alone does not make within-family examples independent. Rule promotion remains separately authorized. Public payload enforcement and hard pilot limits are required before any paid evaluation.

### 4. Separate system authorization and preserve moderator vetoes

**Verified:** `moderate()` requires an allowlisted moderator. Revocation marks the mapping revoked but returns its case to `pending`; discovery can also reopen rejected or no-match cases after changed evidence. See [mapping commands](../lib/listening/moderation.js) and [`discoveryJob()`](../lib/listening/worker.js).

**Disagreement:** putting `system:auto_rule:v1` in `reviewer` is not an authorization design. A pending-case filter cannot enforce the promise never to override revocation or an earlier moderator decision.

**Recommendation:** if automated writes are separately approved, expose distinct authorized human and system entry points around a shared transactional operation. Do not add a fake system identity to the moderator allowlist. Persist a durable automation veto with explicit moderator release semantics, and check it together with current revisions inside the write transaction. Record actor type, rule version, evidence identity, and outcome in the append-only audit. Reopening discovery must not silently clear the veto.

**Resolution (revision 3):** the design requires separate system authorization and a durable veto. Revision 1's pending-case criterion could have permitted reapproval after revocation; no such automatic path is implemented today.

### 5. Hash the complete decision input and revalidate freshness separately

**Verified:** `hashCandidateTracklist()` excludes country, date, formats, status, and disambiguation. Changing those edition-relevant fields leaves that hash unchanged. `discoveryJob()` retains older candidates and evidence hashes during an incomplete refresh. See [candidate hashing](../lib/baselines/musicBrainz.js) and [discovery persistence](../lib/listening/worker.js).

**Disagreement:** the listed cache keys alone cannot prove that an edition recommendation is current. An unchanged retained hash is not a successful provider refresh.

**Recommendation:** hash all supplied decision-relevant metadata, candidate membership, reviewed edition relationships, and model/prompt/schema/rule versions. Validate current target revisions, source freshness, discovery completeness, and candidate expiry independently before displaying an actionable suggestion or accepting it. Coalesce identical requests and reuse unchanged semantic inputs; retrieval timestamps alone should not force another model call. Preserve stale evaluations for audit without presenting them as current recommendations.

**Resolution (revision 3):** the safeguards require a full public decision-input hash and separate freshness checks, now including explicit coverage and exclusion evidence. Private event comparisons remain local and outside the model/shared cache. These are proposed contracts, not claims about the existing hashes.

### 6. Establish cross-edition lineage and diary duplicate protection

**Verified:** reconciliation groups shared events by `(albumId, eventId)`. A pure-function reproduction moving the same events between albums produced a new insertion without predecessor lineage and a hold on the old session. `manualNearby()` checks only the selected catalog album. Existing publication receipts may suppress some cases, so this reproduction does not establish an end-to-end duplicate publication. See [`components()` and `planReconciliation()`](../lib/listening/reconciliation.js), [publication checks](../lib/listening/publication.js), and [receipt/fence models](../models/AutomaticListen.js).

**Disagreement:** safe revocation within the existing model is not sufficient evidence that moving between standard and deluxe targets is safe. New edition IDs can bypass album-specific lineage and manual-entry checks.

**Recommendation:** define edition reassignment and publication suppression before enabling edition automation. Test standard-to-deluxe reassignment, overlapping source events, manual entries on another edition, mixed edition labels, reprocessing, and genuinely separate plays. Preserve existing published history and dismissal receipts. Use evidence-backed lineage and transactional checks rather than deduplicating every family entry on the same day.

**Resolution (revisions 3–4):** cross-edition lineage and family-wide duplicate protection remain mandatory before edition rollout, with technical design and transactional validation still required. They move into the parallel identity design; they do not block current-album advisory work. The proposed edition rollout avoids new provisional standard assignments, while existing workflow behavior remains unchanged until an explicit cutover.

### Revised sequencing recommendation

The earlier sequence placed family/edition design ahead of all advisory work to protect identity and lineage. The subsequent review identified coverage reporting, ordered comparisons, and current-album tracklist advice as independent deliverables.

**Resolution (revision 4):** the operative build order now delivers those independent improvements first and develops the identity design in parallel. Edition rollout still requires migration and lineage validation; paid evaluation requires a bounded approved pilot; automation retains its separate gates. The isolated Last.fm shadow trial remains unchanged.

## Review of revision 3 — October 31, 2026

Revision 3's code claims were checked: mapping keys are `mappingKey(artist, album)` aliases, `recommend()` does not mark its three-release hydration cap as incomplete, and discovery truncates candidates without marking it. The notes below preserve that review's deliverability concerns. Revision 4 resolves or qualifies each concern in the operative plan; the original hypotheses are not measurements or implemented behavior.

### R3-1. Name the first stage that delivers value

The review objected that new automatic edition approvals were outside the MVP and that added edition submissions might outweigh review savings. Manual approvals do remain, but suggestions and computed differences could reduce time per review. Net workload change has not been measured.

**Resolution (revision 4):** the first milestone is truthful evidence and faster, higher-quality individual review. Automatic edition resolution is a later goal. Measure review time, quality, throughput, and added submission workload instead of asserting that workload improves or worsens.

### R3-2. Separate the current workflow from edition cutover

The maintained [listening guide](AUTOMATIC_ALBUM_LISTENS.md) permits recognized edition names to map to the current album. The earlier review offered keeping that behavior or freezing it, but conflated stopping new approvals with revoking active mappings.

**Resolution (revision 4):** advisory work preserves the current workflow and trial. A freeze on new approvals would not itself revoke active mappings; [`resolveRow()`](../lib/listening/worker.js) still uses them. The edition cutover must separately define new approvals, existing mappings, revalidation, and preserved history. Update the maintained guide when an approved behavior change is implemented. No freeze or revocation is authorized here.

### R3-3. Give the family and edition model its own technical design

The prerequisite touches catalog indexes, the importer, submission duplicate checks, approval, discovery, baselines, reconciliation, and publication. It is a catalog-identity project larger than the AI adapter.

**Resolution (revision 4):** develop a separate maintained technical design in parallel and link it here once created. This plan retains its boundary requirements without making that design a dependency for independent advisory work. The separate document and migration are not claimed to exist.

### R3-4. Decouple work that does not depend on families

Coverage flags can omit relevant uninspected releases, and the current moderator panel only shows warnings when those flags are set. Ordered comparisons and truthful coverage are useful without families or AI ([recommender](../lib/baselines/musicBrainz.js), [discovery](../lib/listening/discovery.js), [panel](../frontend/src/Components/Community/BaselineReviewPanel.jsx)). This establishes an evidence-presentation gap, not a demonstrated incorrect automatic publication.

**Resolution (revision 4):** coverage/comparisons come first, followed by current-album tracklist evaluation and individual panels. Tracklist advice is independent of the deluxe mapping cutover. Any early mapping advice has a bounded eligible set under current rules and does not authorize edition reassignment.

### R3-5. Measure the public-input boundary's effect on mapping usefulness

Without a source-backed public version of an unfamiliar alias, the model may lack the question it needs to resolve. The review suggested exporting aliases after enough distinct connections had produced them. Repetition does not make text public or establish that it lacks personal information; the existing listener count is also a queue-ranking field, not an export gate. Claims that public sources usually cover edition aliases or that mapping advice would mostly abstain were not measured.

**Resolution (revision 4):** retain the public-only payload, measure eligible/excluded cases and abstention locally, and prioritize tracklist advice if mapping benefit is weak. Connection count alone cannot permit export. Any broader policy is a separate design decision, not an implied exception.

### R3-6. Size pilot controls to the stage without losing the hard bound

The review correctly challenged requiring distributed reservations for an operator CLI. Provider settings alone, however, do not establish an exact pilot cap: alerts do not halt requests, and enforced limits can lag ([official guidance](https://developers.openai.com/api/docs/guides/spend-limits)).

**Resolution (revision 4):** fixture replay first, then a separately approved sequential pilot with a fixed manifest, bounded cases/tokens/attempts, a worst-case cost check, and a persistent attempt log. Count retries and resumes; handle uncertain outcomes conservatively. Provider limits supplement local accounting. Defer distributed reservations until multiple dispatchers or background scheduling. No approved numerical limits are invented.

### R3-7. Check that automation gates are reachable

There may be too few independent eligible families to support a desired harmful-error bound for a particular rule. The illustrative 3/*n* bound is not a universal launch requirement, and correlated variants do not increase the independent sample in the same way as new families.

**Resolution (revision 4):** count eligible independent families per rule early. If evidence cannot support its chosen promotion gate, keep that rule advisory. This limits automated promotion rather than blocking evidence-based assessment of advisory usefulness.

## Review of revision 4 — October 31, 2026

Revision 4's panel claim was checked against [`BaselineReviewPanel.jsx`](../frontend/src/Components/Community/BaselineReviewPanel.jsx): warnings depend on the API flags. The freeze/revocation distinction and public-input boundary remain accepted. The final review below qualifies the residual-work and fixture proposals; its resolutions are incorporated above. No blocking product contradiction remains for the bounded first milestone.

### R4-1. Step 2 is ready to build

Coverage reporting and ordered comparisons address a current moderator evidence gap without a model, spend, family records, or live data apply.

**Resolution (revision 5):** proceed to a bounded implementation brief when authorized, using the acceptance criteria above. API response shape, compatibility handling, and focused fixtures remain routine implementation details; the earlier phrase "fully specified" did not mean code or interface design was complete. Later-stage speculation should not delay this independent milestone.

### R4-2. Gate the model adapter on residual ambiguity

The review proposed measuring residual ambiguity before investing in the adapter. It also grouped coverage-insufficient cases into that opportunity, which conflicts with the captured-evidence abstention rule.

**Resolution (revision 5):** gate step 3 on useful complete-evidence judgment cases and measurable review effort. Keep missing-evidence cases on the retrieval/human-review path; the model cannot resolve unseen alternatives. Already-resolved cases may still have review-time value, so residual ambiguity is not the only possible benefit. If the useful eligible population is small, retain deterministic tools and defer the model pilot.

### R4-3. Reuse reviewed baselines as replay fixtures

Reviewed heads and chosen releases are useful sources of provisional decisions, but not automatically complete or unbiased replay fixtures.

**Resolution (revision 5):** album heads resolve through `activeBaselineId` to the stored baseline candidate; submission selections use `selectedSnapshotId` ([models](../models/AlbumBaseline.js), [service](../lib/baselines/service.js)). Validate revisions and available evidence, distinguish historical replay from later reconstruction, keep expected answers outside prompts, and independently review the held-out quality labels. Actual dataset availability and size remain unverified; no extraction was performed.

### R4-4. Keep provider references neutral

The pilot section cited one provider while leaving model selection open.

**Resolution (revision 5):** the operative control requirement is provider-neutral and the OpenAI link is explicitly an example. The final review checked the official page's distinction between alerts and enforced limits and its enforcement-lag caveat. No provider, account setting, or budget is selected by this reference.

### R4-5. Move resolved history into Git

Review history is substantial; once reliably versioned, a short decision log could make the plan easier to scan.

**Resolution (revision 5):** retain the rationale here because the document is currently untracked. Do not delete it on the assumption that Git already preserves it. A later expressly authorized documentation cleanup can shorten the history after verifying it is retained; this review does not commit or push anything.


## Final review outcome — October 31, 2026

Revision 5 is coherent enough to begin the bounded first milestone once implementation is authorized. No unresolved product choice blocks coverage reporting and ordered comparisons. Model usefulness, actual evaluation-case availability, model/budget selection, edition cutover and lineage design, and automatic-promotion gates remain stage-specific work, not reasons to expand this milestone.

The final review read the full updated proposal, checked the relevant recommender/discovery/panel and baseline-storage paths, and verified remote-main provenance. It corrected the incomplete-evidence model opportunity, clarified fixture provenance and label independence, added first-milestone acceptance criteria, marked the provider reference as an example, and preserved uncommitted review history. It did not run a model, inspect a live dataset, implement features, alter the trial, or authorize building.

Revision 6 adds the proposed moderator-feedback loop after checking the existing mapping and baseline audit schemas/writers. It preserves the first milestone and all approval boundaries; correction capture, review, retrieval, and evaluation remain proposed work.
