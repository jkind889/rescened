---
name: rescened-provider-integration
description: Add or change Rescened external album-metadata adapters such as MusicBrainz, ListenBrainz, or Cover Art Archive. Use for normalization, remote-call controls, provenance, API/UI failure isolation, and provider tests; not merely operating existing imports, backfills, or migrations.
---

# Integrate an external metadata provider

Keep Rescened's local catalog authoritative while making remote discovery or enrichment bounded, attributable, and replaceable. Read the relevant portions of [the catalog contract](../../../docs/CATALOG_IMPORT.md) and [the search and catalog plan](../../../docs/SEARCH_AND_CATALOG_GROWTH.md) before changing provider behavior. Use the current implementations as patterns, not as APIs that must be copied:

- [batch ListenBrainz and MusicBrainz ingestion](../../../lib/catalogImport/listenBrainz.js)
- [interactive MusicBrainz search](../../../lib/musicBrainzSearch.js)
- [best-effort Cover Art Archive resolution](../../../lib/coverArtArchive.js)

## Preserve the catalog boundary

- Query and reconcile `AlbumCatalog` before presenting remote candidates. A provider result is not a local catalog record and must not silently bypass submission, moderation, or import rules.
- Keep the public album identity provider-neutral. Local `albumId` is public; MongoDB `_id` is internal; upstream IDs belong in normalized `externalReferences` and provenance.
- Normalize provider payloads at an adapter boundary into existing Rescened concepts. Do not spread raw response shapes or provider-specific identity assumptions through routes, models, or React components.
- Validate provider IDs, URLs, response shape, lengths, dates, credits, and enumerations before data reaches persistence or an API response. Reject or omit malformed rows deterministically.
- Preserve local, manual, and community-owned fields during enrichment or refresh. Missing remote fields must not clear trusted local values.
- When a new provider changes the durable dataset or catalog shape, version and validate the contract rather than accepting unknown fields ad hoc.

Run `npm run check:catalog-contract` for catalog-facing changes. Extend [the provider-neutral guard](../../../scripts/checkCatalogContract.js) when a new dependency could otherwise leak into catalog identity or application surfaces.

## Bound every remote call

Choose limits that match both provider policy and the product path:

- Send the provider-required identifying user agent or credentials from server-side configuration. Never expose secrets to the frontend or commit them.
- Apply a timeout with cancellation. Validate configuration values rather than allowing zero, negative, or unbounded limits.
- Put calls behind a shared rate gate so concurrent requests and client instances cannot accidentally multiply the allowed request rate. Also rate-limit public API endpoints independently.
- Cache successful normalized or validated responses. Use a bounded TTL and entry count for interactive traffic, or a validated durable cache for resumable batches. Normalize cache keys and coalesce identical in-flight requests.
- Retry only retry-safe transient failures, with a small fixed maximum attempt count and capped backoff. Do not retry malformed responses, authorization failures, ordinary client errors, or other permanent failures.
- Parse both delta-seconds and HTTP-date forms of `Retry-After`. Honor the value within an explicitly configured retry budget; when it exceeds the maximum delay, either apply the adapter's documented cap or stop retrying and report/defer the upstream throttle rather than sleeping without bound. Keep latency-sensitive interactive paths at zero or very few retries when prompt failure is safer, and cover the chosen cap behavior in tests.
- Expose stable internal error codes while avoiding raw upstream payloads, credentials, or sensitive request details in responses and logs.

## Isolate rollout and failure

- Gate a new user-facing provider path behind an explicit server-side feature flag that is disabled unless set to `true`. Test enabled and disabled behavior.
- A provider outage must not break local search, catalog reads, moderation, or unrelated mutations. Treat optional artwork and enrichment as best effort when the surrounding operation can safely continue.
- Map invalid client input to a stable 4xx response, a disabled feature to a stable 503 response, upstream unavailability to a stable 502/503 response, and inbound rate limits to 429 with `Retry-After` when applicable.
- If the provider affects a user flow, update the API contract and frontend together. Cover loading, empty, disabled, unavailable, rate-limited, retry, and local-match states; abort obsolete browser requests and keep local results usable.
- Keep provider display names at presentation and provenance boundaries. Business logic should depend on normalized capabilities and identities.

## Preserve licensing and provenance

Confirm the current terms and data license for every endpoint and field before importing or redistributing it. Record the upstream identity, fetch time, source URL where appropriate, and field or dataset license in the existing provenance shape.

Do not assume one provider's metadata license covers tags, annotations, ratings, images, or other linked material. Rescened currently treats ListenBrainz listening data and MusicBrainz core metadata as CC0, excludes differently licensed MusicBrainz fields from catalog import, and links Cover Art Archive images without treating their copyrights as cleared. Update documentation and fixture provenance if the source or usage changes. See [the fixture notes](../../../tests/fixtures/catalogImport/README.md) and [the catalog import guide](../../../docs/CATALOG_IMPORT.md#network-and-licensing-behavior).

## Test without normal-suite network access

- During implementation, apply [the pre-review async and lifecycle checklist](../rescened-verify/SKILL.md#check-async-and-lifecycle-cases-before-review) to the changed adapter and UI. In particular, test obsolete search/detail responses, cancellation, shared in-flight requests, and retry outcomes where relevant before independent review; keep these reproductions offline.
- Capture the smallest representative provider responses allowed by the source terms. Trim irrelevant or sensitive fields, document origin/license/date, and check fixtures into the appropriate test fixture directory.
- Inject fetch, time, sleep, rate-gate, and cache dependencies so ordinary tests are deterministic and fast. Never make normal unit or integration tests depend on provider availability.
- Cover valid normalization, malformed payloads, identity mismatches, empty results, timeouts, cache expiry and bounds, in-flight coalescing, pacing, transient retry limits, both `Retry-After` formats, permanent no-retry cases, flag behavior, API status mapping, and failure isolation as applicable.
- If live smoke coverage adds value, put it in an explicitly gated `*.live.test.js` and a separate package command. Default and CI test paths must skip it unless the dedicated environment opt-in is set.
- Finish with relevant unit/fixture tests, `npm run check:catalog-contract`, integration tests when persistence or transactions changed, and frontend lint/build when the user flow changed. Follow [the Rescened verification workflow](../rescened-verify/SKILL.md) for the final evidence report.

Never run a live-provider test merely because provider code changed. Ask for or rely on explicit user direction before making public network requests.
