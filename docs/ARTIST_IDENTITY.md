# Artist identity (phase 1)

Last reviewed: 2026-11-10

Phase 1 gives artists stable public Rescened IDs and keeps MusicBrainz artist IDs on album credits. It covers identity only. There are no artist pages, artist routes, biographies, aliases, or merges yet. Listening stats still group top artists by display name.

## Data contract

### Artist registry

`models/Artist.js` stores one registry row per known artist:

| Field | Meaning |
| --- | --- |
| `artistId` | Public, immutable, random UUID v4. It is never derived from a provider ID. |
| `name` | The credited name seen when the artist was registered. Album credits keep their own names and stay the display source. |
| `externalReferences` | At most one `musicbrainz` / `artist` reference. A unique partial index allows only one registry artist per MusicBrainz MBID. |
| `fieldProvenance` | Where the registration came from: a dataset and release group, an approved submission, or the backfill plan. |
| `artistSource` | `import`, `community`, or `manual`. |

Mongo `_id` stays internal. The registry has no public endpoint in phase 1.

### Album credits

`AlbumCatalog.artistCredits[]` keeps `name` and `role` and their order. Each credit may also carry:

- `artistId`: the registry artist's public ID.
- `artistMbid`: the MusicBrainz artist MBID.

Both keys are left out, not blank, until an identity is established. A catalog credit with an `artistMbid` must also carry its registry `artistId`; the model rejects an MBID on its own. A name never links a credit: name-only credits stay unlinked until an import, an approved suggestion, or the backfill supplies an MBID or an existing `artistId`.

Catalog responses pass these keys through on `artistCredits`, so album-bearing responses expose `artistId` and, where known, `artistMbid` beside each credit name. Join phrases are not stored on credits. `artistDisplayName` still holds the full credited string.

## Write paths

### Catalog import

`npm run catalog:import` resolves every dataset credit's `artistMbid` through the registry during preflight. A known MBID reuses its `artistId`. An unknown MBID gets one planned registration (`artistSource: "import"`), shared by every row that credits it. Registrations are inserted first, in the same transaction as the catalog writes, so a concurrent registration of the same MBID rolls the whole import back. Only artists credited by inserted or refreshed rows are registered. Quarantined rows and preserved credits do not register artists.

The import report includes `artistRegistry: { registered, reused }`. Re-importing the same dataset is idempotent. Before `--apply`, the CLI builds the registry's unique MusicBrainz index.

**Rollout order matters.** The first import after this change would refresh every previously imported row, because its credits gain identities. An import refresh advances `catalogRevision` without carrying reviewed baselines or active Last.fm mappings forward, so those would go stale, and pending corrections would fail with `CATALOG_CHANGED`. To avoid that, run the [backfill](#backfill) first, against the same datasets. The backfill carries baselines and mappings forward. The import merge also keeps the backfill's `fieldProvenance.artistIdentity` while credit identities are unchanged, so a later re-import of the same dataset reports those albums as `unchanged`.

### Suggestions and corrections

New-album suggestions, revisions, and artist corrections accept optional `artistId` and `artistMbid` on each credit. The server validates their formats and lowercases them. Blank strings are treated as absent. On submission and revision, a supplied `artistId` must exist, and if the credit also has an `artistMbid`, it must match the artist's registered MBID. Otherwise the request fails with `400 INVALID_SUBMISSION`. An MBID the registry has not seen yet is accepted.

The MusicBrainz suggestion prefill (`GET /search/musicbrainz/release-group/:mbid`) now includes each credit's `artistMbid`. External search candidates carry it too; they remain discovery candidates, not catalog albums.

The frontend keeps a credit's identity only while its name is unchanged. If a contributor renames a credit, it is submitted as a plain credit. The correction form's comma-separated name field reuses the role and identity of a current credit with exactly the same name. Moderators see a MusicBrainz artist link beside identified credits in submission details.

### Approval

Inside the approval transaction, new-album publication and approved artist corrections resolve every proposed identity against the registry. A known MBID reuses its artist. An unknown MBID registers a `community` artist whose provenance names the submission, its revision, and the approving moderator. An `artistId`-only credit gains the artist's registered MBID. An unknown `artistId`, or an `artistId` whose registered MBID differs from the credit's, blocks approval with `409 ARTIST_IDENTITY_CONFLICT`. Nothing is published and the suggestion stays pending. Linking a suggestion to an existing album does not change that album's credits.

## Backfill

`npm run catalog:backfill-artists` links existing catalog credits using the artist MBIDs recorded in reviewed catalog import datasets, such as `data/catalog-import/seeds/listenbrainz-2026-08-14.json`. Planning is the default. It writes a sealed plan and never writes to MongoDB. Apply reads only that plan.

### Matching rules

An album is considered only through its single `musicbrainz` / `release-group` reference, matched to a dataset row with the same `releaseGroupMbid`. Its credits link only when they meet all of these conditions:

- The album has the same number of credits as the dataset row.
- Each credit name exactly equals the dataset credit name at the same position after Unicode NFC normalization and trimming. The legacy-migration form, with the join phrase folded into the name (for example, `V with`), is also accepted. There is no case-folding or fuzzy matching.
- No credit already carries a different MBID or `artistId`.
- Credit provenance is automated. Credits whose `fieldProvenance.artistCredits.source` is `community` or `manual` are never rewritten. A non-import album with no credit provenance is treated as user-owned.

Linking adds only `artistId` and `artistMbid`. Every existing credit key and value, including name, role, and order, is preserved. `fieldProvenance.artistCredits` is unchanged. A separate `fieldProvenance.artistIdentity` entry records the plan checksum, datasets, release group, and time.

### Plan buckets

| Bucket | Meaning |
| --- | --- |
| `albumUpdates` | Exact matches to link, with `beforeCredits`, `afterCredits`, and the expected catalog revision. |
| `artistRegistrations` | Full registry documents to insert, one per new MBID, with pre-assigned `artistId` values. |
| `reusedArtists` | Existing registry artists the plan relies on. |
| `review` | `USER_OWNED_CREDITS`: matches that a reviewed catalog correction would need to link. Includes the proposed MBIDs. |
| `flagged` | `MULTIPLE_RELEASE_GROUPS`, `SOURCE_CONFLICT` (input datasets disagree), `INVALID_SOURCE_CREDIT`, `CREDIT_COUNT_MISMATCH`, `CREDIT_NAME_MISMATCH`, `EXISTING_IDENTITY_CONFLICT`. |
| `unchanged` | Already linked to the same identities. |
| `noSource` | A release-group reference with no row in any input dataset. |

`counts.withoutReleaseGroup` counts albums that have no MusicBrainz release-group reference, such as most community suggestions. Plan mode exits `2` when anything is flagged or needs review, and `0` otherwise.

### Runbook

Keep plans and reports outside the repository, for example in `~/rescened-ops/artist-identity/`. Never apply to production without explicit authorization for that named target.

1. Point `MONGO_URI` at the intended database. Create a plan:

   ```sh
   npm run catalog:backfill-artists -- \
     --input data/catalog-import/seeds/listenbrainz-2026-08-14.json \
     --out ~/rescened-ops/artist-identity/<database>-<date>.plan.json
   ```

   Every input is fully validated, and its SHA-256 is recorded, before any database connection. `--input` may repeat. The command prints `planSha256` and the target database name. An existing plan file is never overwritten.
2. Review the plan, including the `flagged` and `review` buckets and every `artistRegistrations` name. Resolve flagged albums through catalog corrections, not by editing the plan. Any edit breaks the seal.
3. Apply only after explicit authorization for that database:

   ```sh
   npm run catalog:backfill-artists -- --apply \
     --plan <plan.json> --plan-sha256 <planSha256> \
     --confirm-target <database> --report <new-report.json>
   ```

   Apply refuses to run if the checksum differs, the plan was edited, or the connected database, the plan target, and `--confirm-target` do not all match.

### Apply semantics

- **Report first.** Before connecting, apply reserves the report path. If it cannot write the final report after commits, it prints the report and `databaseCommitted` to the console.
- **Registry first.** It builds the registry's unique index. One transaction then inserts the planned artists and confirms that each reused artist still exists. If the registry now maps a planned MBID to a different `artistId`, the apply stops with `ARTIST_REGISTRY_CHANGED` before any album changes. In that case, create a new plan.
- **One transaction per album.** Inside its transaction, each album is read through the raw collection and compared with its planned stored revision and exact `beforeCredits`. This avoids Mongoose casting, which would trim legacy names such as `Alpha & ` or add default roles. It sets the new credits, advances `catalogRevision` by one, and carries the album's reviewed baseline and active Last.fm mappings to the new revision, as the cover backfill does.
- **Album outcomes.** A changed album is reported as `conflict` and left untouched. An album that already has the planned credits at the planned revision is `already_applied`. Rerunning the same plan is therefore safe.
- **Pending corrections.** Pending corrections created before an album was linked become stale (`CATALOG_CHANGED`), because its revision advances.
- **Unused registrations.** Planned artists are registered before album updates. An album that then conflicts can leave its new artists unused in the registry. This is harmless, and a new plan reuses them.
- **Partial commits.** Registry and album transactions commit independently. A failed run writes its report with `databaseCommitted` and `completed`, so a partial commit is never mistaken for a rollback. Apply exits `2` if any album conflicted.

## Verification

- `tests/artistIdentity.test.js` covers the identity helpers, model invariants, submission validation, importer planning, backfill classification and sealing, the checked-in seed dataset as a source, and the frontend credit helpers.
- `tests/artistIdentity.integration.test.js` covers the transactional paths on a replica set: import registration and idempotency, approval resolution and conflicts, and backfill planning without writes, target refusal, guarded apply, mapping carry-forward, rerun, and registry drift.

## Known limitations

- The registry `name` is the first credited name seen, not a canonical MusicBrainz artist name. Phase 1 does not fetch artist records.
- Credits without an MBID stay unlinked. There is no name matching, artist search, or picker UI. Contributors can propose identity only through a MusicBrainz prefill or by keeping an existing credit's name.
- The correction form's comma-separated credit field still splits names that contain commas, such as "Tyler, The Creator". This is a pre-existing problem. Those pieces no longer match the current credit, so the correction submits them without identity.
- Moderator details show a credit's `artistId` and MusicBrainz link. They do not show the registry artist's own name.
- User-owned credits are not backfilled. Link them through reviewed corrections.
- Legacy migration and the importer's provider adapters still drop join phrases from credits.
- Listening stats, search, and activity still use credit names.
