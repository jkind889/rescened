# ListenBrainz catalog import

Rescened's catalog bootstrap is an offline, two-stage process. It selects ranked release groups from ListenBrainz, hydrates their core metadata from MusicBrainz, writes a versioned JSON artifact, and then imports only rows that satisfy the catalog-import contract.

See the [central error and status code reference](./ERROR_CODES.md) for validation, fetch, import, report, and exit-code meanings.

The importer writes `AlbumCatalog` and `Artist` registry records only. It never creates community submissions, moderation history, reviews, likes, boards, profiles, or approved-feed entries.

## Checked-in artifacts

- [Draft-07 dataset schema](../data/catalog-import/catalog-import.schema.json)
- [Two-album valid sample](../data/catalog-import/catalog-import.sample.json)
- [Dated 500-album seed](../data/catalog-import/seeds/listenbrainz-2026-08-14.json)
- [Seed SHA-256 checksum](../data/catalog-import/seeds/listenbrainz-2026-08-14.json.sha256)
- [Fetch report](../data/catalog-import/seeds/listenbrainz-2026-08-14.json.fetch-report.json)
- [Validation report](../data/catalog-import/seeds/listenbrainz-2026-08-14.validation-report.json)

These are ordinary repository files and can be viewed or downloaded directly. The schema and sample are intended for anyone preparing another compatible dataset; the importer rejects unknown fields and quarantines invalid rows before any database operation is constructed.

## Commands

Generate the default blended catalog of 500 albums:

```sh
npm run catalog:fetch -- --output data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json
```

The default mix is 300 `all_time`, 150 `year`, and 50 `month` release groups, with at most five selected albums per primary credited artist. The fetcher writes the dataset, a SHA-256 checksum, and a fetch report. A failed or underfilled run does not publish the final dataset file.

Validate a dataset without connecting to MongoDB:

```sh
npm run catalog:validate -- --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json
```

Preflight an import against the configured database without writing:

```sh
npm run catalog:import -- --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json --dry-run
```

Apply the accepted rows:

```sh
MONGO_URI='mongodb://...' npm run catalog:import -- --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json --apply
```

`--apply` is always explicit; omitting it keeps the command in dry-run mode. Import reports distinguish inserted, refreshed, unchanged, quarantined, and conflicting rows. They also list `identityRelinks`: refreshed albums whose only change is artist credit identity. `--apply` refuses (`IDENTITY_RELINK_NEEDS_BACKFILL`, before building indexes or writing) while that list is non-empty; run the [artist identity backfill](ARTIST_IDENTITY.md#backfill) first, or pass `--allow-identity-relink` to re-version those albums deliberately. Exit code `0` means a clean run, `2` means the run completed with quarantined/conflicting rows, and `1` means a fatal error or transaction rollback.

## Dataset contract

The machine-readable contract is `data/catalog-import/catalog-import.schema.json`, and `data/catalog-import/catalog-import.sample.json` is a two-album valid example. The envelope is versioned and records generation time, selection ranges, quotas, upstream timestamps, source licenses, and the album array.

Album rows contain only source identity and normalized core metadata:

- MusicBrainz release-group identity and optional representative release identity.
- ListenBrainz range, rank, and listen-count selection signals.
- Title, credited display name, artist credits, release type, and partial release date.
- Optional Cover Art Archive image identity and a 500-pixel HTTPS URL.
- ListenBrainz and MusicBrainz source timestamps.

Version 1 deliberately excludes tracklists and labels. New catalog records receive empty track and label fields. Local Rescened UUIDs, catalog source, external references, and field provenance are created by the importer rather than trusted from a dataset file.

Every schema object rejects unknown properties. File size, row counts, string lengths, MBIDs, URLs, dates, enums, and numeric values are bounded. Additional semantic checks require release date, precision, and year to agree. A malformed JSON document, invalid envelope, unsupported schema version, or empty valid set is fatal. Invalid album rows and duplicate source identities are quarantined and never become database operations.

## Mapping and refresh behavior

MusicBrainz secondary types take precedence in this order: soundtrack, mixtape/street, live, remix, compilation. Otherwise Album, EP, and Single map directly, and all remaining types become `other`.

An album is matched by its `musicbrainz` / `release-group` external reference. New rows receive a UUID v4 and `catalogSource: "import"`. Reruns may refresh existing imported rows while preserving their public UUID, tracks, label, non-MusicBrainz references, and fields explicitly owned by manual or community provenance. A missing incoming cover never clears an existing cover. Manual or community catalog collisions are reported and left unchanged. Albums absent from a later file are never deleted.

Each dataset credit's MusicBrainz artist MBID is resolved through the Artist registry. Known artists keep their Rescened `artistId`. New ones are registered in the same transaction as the catalog writes. Imported credits therefore carry both `artistId` and `artistMbid`, and the import report adds `artistRegistry: { registered, reused }`. See [ARTIST_IDENTITY.md](ARTIST_IDENTITY.md).

Accepted writes run in one MongoDB transaction, so a persistence error rolls the accepted batch back. This requires a replica-set or sharded MongoDB deployment, matching the transaction requirement already used by community approval.

Report destinations are checked and both reports are fully staged before `--apply` can mutate MongoDB. If an exceptional filesystem failure prevents the final atomic report rename after MongoDB has committed, the CLI explicitly reports that committed state instead of describing it as a rollback; the import remains safe to preflight and rerun idempotently.

## Network and licensing behavior

The generator calls the public ListenBrainz sitewide release-group statistics endpoint and the MusicBrainz release-group lookup endpoint. MusicBrainz requests are serialized to at most one per second, use an identifying Rescened user agent, cache successful responses, time out, and retry only a bounded number of times while honoring `Retry-After`.

ListenBrainz listening data and MusicBrainz core metadata are CC0. MusicBrainz tags, genres, annotations, and ratings are not imported. Cover Art Archive images are linked, not copied; their copyrights are not cleared by the metadata license and use remains at the application's risk. Source and rights information is retained in both the dataset envelope and catalog provenance.

## Rollout

Generate one dated dataset and keep its checksum with it. Validate it, run a database-aware dry-run, apply it to development or staging, and smoke-test catalog listing, search, album detail, review, like, and board-save behavior. Then repeat the dry-run and apply steps against production using the identical file and checksum. The importer is manual and does not schedule recurring synchronization.

## Verification

The normal test suite uses captured provider responses and skips live-network access. Transactional behavior is verified with the repository's replica-set test harness:

```sh
npm test
npm run test:integration
npm run check:catalog-contract
```

An additional provider smoke test is available only when explicitly enabled:

```sh
npm run test:catalog-live
```

Normal test runs use the checked-in, CC0 ListenBrainz and MusicBrainz response fixtures under `tests/fixtures/catalogImport`; they never contact either provider.

The provider-neutral guard covers the catalog model, application surfaces, and all importer/fetcher modules so catalog identity cannot silently regress to a Spotify dependency.

### Artist names versus credited display names

Fetched dataset credits retain MusicBrainz's underlying `artist.name` as optional `artistName`; `name` and `joinPhrase` remain the original credit display text. The optional field is backward-compatible with version 1.0.0 datasets. Import uses `artistName` only for new artist registry names and records its provider provenance. It never copies the canonical name over album credit wording or silently renames an existing registry artist. Older datasets without the field produce provisional credit-derived names unless a verified-name backfill is run first. See [Artist identity](ARTIST_IDENTITY.md#verified-registry-names) for the reviewed operator workflow.
