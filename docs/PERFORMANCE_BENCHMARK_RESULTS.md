# Local benchmark results — September 8, 2026

The large-dataset mixed workload completed three paired five-minute confirmations. At the user's requested checkpoint, the runner was interrupted during the first focused-search warmup. **No focused-search measurement ran, and the retry did not proceed to the small dataset.** The raw report says `failed` with k6 exit 105 because the intentional SIGINT interrupted that warmup; the six completed mixed-workload runs remain available. The API, database, load generator and checkpoint watcher exited.

## Conditions and evidence

- Synthetic local data: 50,000 albums, 500,000 reviews, 250,000 boards and 250,000 board memberships.
- Apple M5, 10 logical CPUs, 24 GiB RAM; Node 22.21.0, MongoDB 7.0.24, k6 2.2.0.
- Five offered requests/second across the fixed mixed workload, with a separate 30-second warmup before each 300-second measurement. This is total workload traffic, not five search requests/second or five real users.
- Confirmation order: baseline, current, current, baseline, baseline, current. Each search form received 228 requests per run, or 684 per implementation across its three runs.
- Only the search route source changed between variants: the baseline counted all matches; the current implementation fetches the requested rows and, for pagination, one additional row to determine whether another page exists.
- Real public handlers and MongoDB indexes ran locally. Clerk, admission limits, TLS, hosted networking, authenticated flows and external providers were excluded.

Artifacts are retained locally under `.benchmarks/2026-09-08T23-03-58-204Z-Vhqwx4/`: `report.json`, `report.md`, query plans, source snapshots, fixture metadata, per-run summaries, request samples and CPU/RSS samples. The earlier interrupted attempt is not combined with these results.

The working tree was based on `94c6008273b940f883791b2e0003a9a1e3e2286b` with uncommitted implementation changes. The recorded search-source SHA-256 values are:

- Baseline: `fef2e2c262f8eb25a57fe5888310810f87ac55ce8a476a990b0e8995dddd0037`
- Current: `ac6baa593c1540fa2530190af133d1fd9533efb6362b033c741c2d2c3a2b1158`
- Fixture checksum: `b29881a99425c558be437ac779d936cb29cce51895103e9ad5a0b5724a7d8fca`

## Search measurements

Each aggregate below is the **median of three per-run percentiles**, not a percentile recomputed over pooled requests. Parentheses contain the minimum and maximum across those three runs.

| Search form / metric | Baseline, ms (range) | Current, ms (range) | Interpretation |
| --- | ---: | ---: | --- |
| Unpaginated p50 | 186.27 (94.12–263.01) | 12.73 (8.26–13.42) | 93.17% lower median-of-run-p50 |
| Paginated p50 | 222.55 (122.75–237.29) | 24.49 (24.12–29.55) | 89.00% lower median-of-run-p50 |
| Unpaginated p95 | 717.72 (201.40–942.49) | 363.56 (290.97–468.67) | Overlapping ranges; not a repeatable p95 improvement claim |
| Paginated p95 | 491.80 (227.40–704.54) | 325.93 (283.41–658.00) | Overlapping ranges; not a repeatable p95 improvement claim |

All search requests passed their response checks. Both p50 improvements had non-overlapping before/after ranges. The original p95 improvement objective was **not established**: the first pair's p95 became worse, and later pairs varied substantially. The improvement claim therefore applies specifically to the observed p50 values, not all requests or tail latency.

## Reliability and limitations

The six confirmations issued 9,004 requests and recorded zero dropped iterations. The final current run had 12 discovery-request timeouts: six recent-album and six popular-album requests. Each discovery endpoint failed 6 of its 111 requests in that run. All other confirmation requests passed their checks.

No mixed-workload run met the requirement that every endpoint have p95 below 500 ms. Discovery-feed p95 reached approximately 9.9 seconds in the final run. These measurements do not support a production-capacity claim or a blanket sub-500-ms API claim.

This was a shared development laptop. A host snapshot during the run showed about 23 GiB used memory, including about 8.8 GiB in the compressor, with no reported thermal warning. Background workloads and memory pressure were not experimentally isolated; they may contribute to the changing tail latency. The paired runs and complete ranges provide context, but are not a statistical confidence interval. Focused-search testing and the small-dataset retry were stopped at the user's requested boundary and remain unperformed.

## Resume wording supported by the completed evidence

Use a specific local-test qualifier and identify median latency:

> Cut catalog-search database queries from two to one, measuring 93% lower median unpaginated-search latency in three paired local load tests against 50,000 synthetic albums.

An alternative emphasizing the measurement infrastructure:

> Built reproducible load tests for seven public API read workloads over 50,000 synthetic albums and 500,000 reviews, capturing response correctness, latency percentiles, MongoDB query plans and resource use.

Do not describe these as real-user or production-traffic numbers. Do not claim improved p95, zero failures across the entire workload, or proven maximum throughput.

## Implementation verification and tracking

- `npm test`: 223 passed, 27 intentionally skipped, zero failures.
- `npm run test:integration`: 31 passed, no skips or failures.
- `npm run check:catalog-contract`: passed.
- `git diff --check`: passed.
- Frontend lint/build were not run because no frontend code changed.

The work remains uncommitted on `rescened-performance-benchmarks`. A subsequently added `.gitignore` rule currently ignores `benchmarks/` itself, in addition to the intended `.benchmarks/` artifacts directory. That rule was preserved. The harness must be deliberately tracked before committing the new package scripts and tests, which import it; otherwise a fresh checkout will be incomplete.
