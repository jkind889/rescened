# Rescened performance benchmarks

## Search relevance evaluation

Run `npm run search:evaluate` for a small, deterministic **quality** evaluation of local catalog search. This command does not run k6 or measure capacity, and it does not change matching, ranking, the frontend, or production data.

```sh
npm run search:evaluate
npm run search:evaluate -- --compare benchmarks/search-quality/baseline.json
```

The evaluator seeds only a hand-authored album catalog into a fresh disposable MongoDB replica set, creates the actual catalog indexes, and starts the current Express routes using the isolated benchmark server. `/health` must return `status: "ok"`. No application `.env`, database target, Clerk account, or metadata-provider request is used. The API process blocks writes and external-provider endpoints. As with the performance harness, first-time MongoDB binary provisioning may require a download; local sockets and process execution are required. Cleanup runs after completion, errors, and Ctrl-C/SIGTERM.

The versioned [corpus](search-quality/corpus.cjs) has 30 queries: six each for artists, albums, formatting, labels, and expected misses. Its 64 fixture albums include title/artist/label collisions, credited collaborators, Unicode and literal punctuation, base/deluxe/remix editions, and a synthetic artist with 30 albums plus six tribute distractors. Names and labels are hand-authored test metadata, not a verified imported discography. There is no artwork.

Each case specifies intent, an explanation, relevant public album IDs, and optionally an equally preferred set. The query judgments never call the production matcher. An ambiguous title may have several equally valid answers. Artist- and label-intent cases deliberately judge collisions against their stated intent; they do not establish that an unqualified query always has that intent for real users.

### Reports and metrics

Every run retains `report.json`, `report.md`, and the API log under ignored `.benchmarks/search-quality/<run>/`. Reports identify the corpus version, fixture/query SHA-256 checksums, source hashes, Git revision and dirty state, Node/Mongoose/MongoDB versions, and actual indexes. JSON contains the catalog identity-to-title map, judgments, ordered results, metrics, and diagnostics; Markdown presents ranked albums and explanations. A result's rank is its one-based position in the corresponding ordered ID array.

The evaluator separately requests unpaginated `limit=5` autocomplete results and `page=1&limit=24` full-search results. It also walks remaining pages for diagnosis, with a fixture-size bound and duplicate detection. Those later pages do not contribute extra credit to first-page metrics. Both forms must agree on their first five results.

| Metric | Meaning |
| --- | --- |
| Hit@5 | 1 if at least one judged-relevant album appears in the first five results; otherwise 0. |
| MRR@5 | Reciprocal rank of the first relevant result within five; 0 if none. |
| Recall@24 | Relevant albums in the first page divided by all relevant fixture albums. A 30-album discography has a maximum of 24/30, shown as a per-case ceiling. |
| Empty accuracy | Fraction of expected-miss cases returning zero results. Misses are excluded from Hit/MRR/Recall averages. |
| Preferred@1 | Whether the first result belongs to the preferred set, averaged only over cases specifying a preference. Preferred rank is also recorded per surface. |

Report averages are unweighted per query, with separate category summaries. `null` / `—` means not applicable, not zero. Diagnostics distinguish expected albums not retrieved on **any** page from matches below the first five or beyond the first 24. These are fixture findings, not estimates of real catalog coverage or production quality.

Quality gaps do not fail the command. Invalid corpus data, broken response contracts, incomplete evaluations, and infrastructure errors exit nonzero. Failed/interrupted run reports are explicitly marked and cannot be used for comparison. Failure before run-directory creation (such as an incompatible comparison file) exits before MongoDB starts.

`--compare` accepts a complete JSON report, including the checked-in baseline. It rejects differing corpus versions or fixture/query checksums. Compatible comparisons report per-query, per-category, and overall metric deltas, result-order changes, and newly retrieved/missing albums. Score increases are improvements; a lower preferred rank is better. Comparison does not automatically gate CI.

### Initial baseline and adding cases

The checked-in [initial baseline](search-quality/baseline.json) is the first successful capture on September 18, 2026. On this synthetic corpus, positive queries have Hit@5 **20/24 (83.3%)**, MRR@5 **0.701**, and mean Recall@24 **0.858**. All six expected misses are empty. Only **1/7** preference-bearing queries places a preferred album first. These numbers describe that recorded code and corpus, not the current live database.

The initial gaps include artist-plus-album queries, omitted accents, exact titles losing to alphabetically earlier partial/edition matches, and tribute albums displacing an exact artist's discography. Later ranking work should use per-case evidence rather than optimizing only the aggregate score.

To add a real-world failure, add minimal fixture records and distractors, give the query a stable ID and explicit intent/relevance judgment, and explain why each preferred set is justified. Derive UUIDs with the fixture `id()` helper. Keep each artist/title sort key distinct so equal sort keys cannot create accidental run-to-run variation. No network calls or live database exports belong in this corpus.

Version 1 intentionally requires 30 queries with six per category. Expanding or changing the corpus requires updating its version and validation/count assertions, reviewing the new judgments, and capturing a new baseline. Do not relax expected relevance merely to make current behavior pass. Comparisons across changed corpora are intentionally rejected.

```sh
node --test tests/searchQuality.test.js
npm test
npm run test:integration
npm run check:catalog-contract
```

The integration runner includes real-Mongo tests for result ordering, actual indexes, both API shapes, public IDs, stable repeated evaluation, blocked provider/write routes, and cleanup after failure/cancellation. Normal tests validate metric arithmetic against independently constructed lists; they do not require all desired relevance judgments to pass. Frontend checks and live-provider tests are outside this evaluator's scope.

## Application/database capacity

The `2.0` search route now ranks results in MongoDB; see the [search behavior guide](../docs/SEARCH_AND_CATALOG_GROWTH.md#local-search-relevance-20). Use `npm run search:evaluate -- --compare benchmarks/search-quality/baseline.json` to compare relevance against the preserved baseline. The old capacity comparison requires identical response manifests and will reject intentional ranking changes. Use `--mode explore --variant current` for capacity exploration of the new behavior. Existing performance figures do not establish the capacity of ranked search. Explain reports retain the historical count/find plans and also include `ranked24` and `rankedLookahead25` for the actual new pipelines.

These are synthetic **local application/database capacity** measurements. The real Express handlers and MongoDB indexes execute in separate API and database processes. k6 generates load in a third process on the same machine. Clerk, admission throttling, TLS and deployment networking are excluded; measured RPS does not establish production capacity or real-user counts.

## Run

Install root dependencies with `npm ci` and install k6 (`brew install k6` on macOS). The existing `mongodb-memory-server` dependency supplies a real disposable WiredTiger replica set; its first launch may download a MongoDB binary. No application `.env`, production database URI, live metadata provider or Clerk account is needed.

```sh
npm run benchmark:smoke
npm run benchmark -- --mode explore --datasets main --variant baseline
npm run benchmark
npm run benchmark:explain -- --datasets main
npm run benchmark:report -- .benchmarks/<run>/report.json
```

The default command compares both implementations on `small` and `main`. Allow roughly 2–3 hours, depending on exploration, seeding and hardware. Keep the machine plugged in and avoid running tests, builds, other load generators or heavy applications during measurements. Multiple databases are never benchmarked concurrently.

On macOS the runner holds a `caffeinate -i` assertion for its own lifetime to prevent idle system sleep. Keep the lid open; this does not override lid-close or explicit sleep. A resource-sampling pause longer than five seconds or a backwards clock jump aborts the run and leaves its artifacts marked failed. Retry starts a fresh dataset and complete comparison; interrupted runs are never combined into resume evidence.

For a shorter harness validation (not the five-minute resume evidence):

```sh
npm run benchmark -- --datasets small --warmup 2 --stage 10 --duration 10 --rates 5
```

Options are `--mode smoke|explore|compare|explain`, `--datasets small,main`, `--variant baseline|current` (explore only), `--baseline <git-ref>`, `--warmup <seconds>`, `--stage <seconds>`, `--duration <seconds>`, and `--rates <ascending-comma-separated-RPS>`. Defaults: comparison mode, both datasets, baseline search from `94c6008`, 30-second warmup, 120-second exploration, 300-second confirmation, rates 5/10/25/50/100.

The baseline swaps **only** `routes/search.js` with the file from the recorded revision. All other code is the same working tree for both variants. This is a controlled search-change comparison, not a complete historical application comparison. The runner saves both search sources and its harness sources. Do not use this baseline mechanism to compare unrelated application changes.

## Fixtures and scenarios

| Dataset | Albums | Reviews | Board memberships | Boards / synthetic users |
| --- | ---: | ---: | ---: | ---: |
| smoke | 100 | 1,000 | 500 | 500 / 250 |
| small | 10,000 | 100,000 | 50,000 | 50,000 / 25,000 |
| main | 50,000 | 500,000 | 250,000 | 250,000 / 125,000 |

Fixtures use deterministic UUID-v4-shaped public IDs, internal relation IDs, timestamps, ratings, labels and 6–14 tracks per album. They are synthetic test identities, not imported catalog records. Each user owns two boards containing the same album, deliberately exercising distinct saved-user counts. Eight of every ten activity assignments target the first 20% of albums. The saved report contains verified collection counts, indexes, a fixture checksum and MongoDB version. Popular discovery uses `window=all`, avoiding date-window drift.

The request mix is 15% unpaginated search, 15% paginated search, 20% catalog browse, 20% album detail, 15% anonymous social summary, 7.5% recent albums and 7.5% popular albums. Focused search runs split requests evenly between its two forms. Search covers broad/rare matches, misses, substrings, ASCII/typographic apostrophes, composed/decomposed Unicode, literal regex punctuation and labels. Browsing includes deep pages; album requests use 40 deterministic IDs.

Each k6 iteration sends one request at a fixed arrival rate with 100 preallocated virtual workers and a ceiling of 500. The API uses a 100-connection MongoDB pool. Every scenario gets a separate excluded warmup. Preflight checks response structures and public IDs; every measured response must match the preflight body hash. Baseline and current preflight manifests must agree before a comparison continues. Hashing full response bodies adds some load-generator CPU cost, recorded in resource samples.

## Interpretation

Exploration stops at the first failing rate for each variant. A rate qualifies only if each endpoint's p95 is below 500 ms, response errors are below 1%, all endpoints have samples and no iterations were dropped. These are chosen test criteria, not guarantees. A result at the top of the configured range is a tested lower bound, not maximum capacity.

Confirmation uses the highest common passing rate, or the lowest configured rate if neither implementation qualifies. Both mixed and focused-search workloads receive three five-minute runs per variant. Variant order alternates between pairs. Failed mixed confirmations remain in the report; they do not produce a capacity resume claim. Search improvement is marked repeatable only when all six runs have zero response errors and dropped iterations for the comparison and the entire current p95 range is below the baseline range. This conservative range check is not a statistical confidence interval.

`report.json` includes per-endpoint p50/p95/p99, successful-response p95, success RPS, error rates, dropped iterations, source/fixture/harness hashes and machine details. Successful RPS uses k6's actual run duration, including final-request drain. `samples.json` retains request-level metrics and status/error tags; `resources.json` records API/MongoDB/generator PIDs, `ps` CPU percentages and RSS KiB once per second. The platform defines `ps` CPU averaging; these are diagnostic samples, not precise one-second CPU deltas. Query plans are collected outside timed load stages.

All artifacts live under gitignored `.benchmarks/` and remain after success or failure. Reports contain synthetic response metadata, not application credentials. The runner accepts no database target, creates a fresh loopback-only database, rejects non-benchmark database names in its API child, exposes an exact read-only route allowlist and terminates its own child processes on completion or error. Interrupt with Ctrl-C; the current load stops and cleanup runs. Do not deploy the benchmark server.

## Verification

```sh
node --test tests/benchmarks.test.js
npm test
npm run test:integration
npm run check:catalog-contract
```

The integration suite validates real-Mongo pagination against an independent count/find oracle, exact page boundaries, empty/out-of-range results, matching semantics, public IDs, duplicate save counts, blocked mutation/provider routes and startup-failure cleanup. The unit suite tests report qualification and compatibility, deterministic data, database guards and the real limiter's 429/Retry-After contract. Normal tests never launch k6 or contact live metadata providers. Sustained performance results belong to explicit benchmark runs, not timing assertions in CI.

## Resume use

The generated report supplies wording only when the main dataset has complete qualifying five-minute evidence. Keep the dataset size, offered load and local/synthetic qualifiers. Do not describe k6 workers as real users, claim production capacity, or reuse results after changing the workload or hardware without rerunning. Publish only a compact reviewed summary and keep the underlying artifacts available for interview follow-up.
