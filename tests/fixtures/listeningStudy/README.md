# Listening-study fixtures

`synthetic.js` is handwritten fictional data for deterministic offline tests, not a captured account or evidence that a real player preserves edition identity. Report-gate tests intentionally mock live provenance to test scoring; these mocks must never enter a pilot report.

The public preselected sample and reviewed MusicBrainz references live in `data/listening-study/`. Each reference retains source URL, retrieval/review timestamps, exact release/group/recording/release-track identities, and the checksum of its private raw source response. Only normalized MusicBrainz core metadata is retained here, under CC0; no cover art, biography, credentials, or listening history is included. Reference review is against MusicBrainz official release records, not a second label audit.

See `docs/LASTFM_LISTENING_STUDY.md` for the frozen rules, reference choices, limitations, and operator commands. Raw Last.fm payloads and actual listening logs must stay outside the repository.
