# Mapping and tracklist queue metrics — November 1, 2026

A dated snapshot from `npm run listening:queue-report`, run read-only against `rescened_dev` and production on 2026-11-01. It records the evidence behind putting AI-assisted review on hold ([plan](AI_ASSISTED_MAPPING_PLAN.md)). It is not a description of the current database state; rerun the report for that ([operator notes](LASTFM_SYNC.md#monitoring-and-verification)).

Both environments run the Last.fm pilot behind an allowlist. Dev has one listener, who is also the moderator, so its decision times are not representative.

## Mapping queue (current at run time)

| | Dev | Prod |
|---|---|---|
| Pending cases | 67 | 50 |
| Listeners / encounters on pending cases | 62 / 495 | 50 / 140 |
| Candidates: none / one / several | 5 / 61 / 1 | 5 / 41 / 4 |
| Verified top candidate | 40 | 33 |
| Top candidate with identifier conflicts | 7 | 0 |
| Single clean verified candidate | 38 | 30 |
| Edition-labelled name | 2 | 1 |
| Candidate list capped | 0 | 0 |
| Last discovery incomplete | 5 | 5 |
| Pending age p50 / p90 / max | 8.7 / 32.9 / 33.0 days | 20.0 / 26.9 / 31.6 days |
| Closed as no catalog match | 413 (374 listeners) | 442 (442 listeners) |
| …with an edition-labelled name | 7 | 7 |

## Mapping decisions

| | Dev, 365 days | Prod, 365 days | Prod, 30 days |
|---|---|---|---|
| Approved / rejected / no catalog match | 27 / 2 / 0 | 100 / 0 / 0 | 83 / 0 / 0 |
| Revoked / reconfirmed | 0 / 0 | 0 / 0 | 0 / 0 |
| Seeded approvals | 3 | 0 | 0 |
| First decision p50 / p90 / max | 2.2 / 7.8 / 46.0 hours | 2.9 / 19.1 / 25.2 days | 4.1 / 19.1 / 25.2 days |
| Approved the top candidate | 24 | 58 | 41 |
| Approved another listed candidate | 0 | 0 | 0 |
| Approved an album outside the list | 3 | 42 | 42 |
| Approved a single clean verified candidate | 15 | 34 | 22 |
| Approved an edition-labelled name | 1 | 3 | 3 |

Dev had no mapping or tracklist decisions in the last 30 days.

Approvals are compared with the candidates stored on the case, which come from its last discovery.

### Prod approvals outside the candidate list

A follow-up read-only query broke down the 42 prod approvals of an album outside the list:

- All 42 cases had no candidates when approved, and none had been rediscovered since.
- In 38, the album was added to the catalog after the case's discovery ran. In 4, it already existed but its title differed from the Last.fm name.
- Matching the album against the case: 30 had the same artist and exact title, 3 the exact title under a different artist credit, 7 the same artist with a different title, and 2 differed in both.

This led to the catalog rediscovery scan, which reruns discovery when a matching album is published.

## Tracklist reviews

| | Dev | Prod |
|---|---|---|
| Albums pending / reviewed / stale | 906 / 58 / 0 | 926 / 85 / 4 |
| Album confirms, 365 days | 58 | 77 |
| Album confirms, 30 days | 0 | 54 |
| Submission confirms, 365 days | 0 | 14 |
| Replace / defer / revoke | 0 / 0 / 0 | 0 / 0 / 0 |
| Enrichment-queued albums decided | 20 | 0 |
| …confirmed with the queued release | 20 | — |
| Queue-to-decision p50 / max | 21.9 / 22.0 hours | — |

Only enrichment queue entries store a recommended release, so recommendation acceptance cannot be measured on prod.

## Conclusion

Few cases need judgment once evidence is complete: moderators never rejected a prod case or chose a different listed candidate, and dev accepted every queued tracklist. The work is limited by catalog coverage, discovery timing, and unqueued tracklists, which deterministic changes address. AI-assisted review is on hold. Revisit if the report shows moderators disagreeing with complete evidence more often, or the Last.fm allowlist opens.
