# Rescened 1.0 bug list

Community suggestions marks the completion of the 1.0 release scope. Collect remaining bugs here before starting 2.0.

- [ ] Pinned reviews do not show the album cover. Expected: each pinned review displays its associated album artwork.
- [ ] Continue validating local search relevance with actual usage. The historical synthetic [search-quality baseline](benchmarks/search-quality/baseline.json) puts a preferred result first for 1 of 7 preference-bearing queries and misses artist-plus-album input. The `2.0` branch now implements exact-match ranking, mixed artist/title matching, and common Latin accent folding; see [the behavior guide](docs/SEARCH_AND_CATALOG_GROWTH.md#local-search-relevance-20). Keep the baseline unchanged and compare new evaluations against it. This small, deliberately challenging fixture set is not a production accuracy estimate; queries such as `Air` still have ambiguous artist-versus-title intent, and label collisions remain. Collect concrete examples of the query, expected album, and returned order to guide further changes, and measure ranked-search capacity before release.
