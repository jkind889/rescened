# Artist biographies

Last reviewed: 2026-11-12

Artist pages can show a short "About" excerpt from English Wikipedia. The excerpt is found by an operator command from the artist's MusicBrainz identity, checked conservatively, stored in Rescened's database with its exact source revision, and served from there. Biography reads are local: showing a biography never contacts MusicBrainz, Wikidata, or Wikipedia. (The separately flagged [MusicBrainz discography](ARTIST_IDENTITY.md#musicbrainz-discography-prototype) on the same page is a different, live feature.) Everything here is off unless `ARTIST_BIOGRAPHIES_ENABLED=true`, and nothing runs automatically.

This builds on [artist identity](ARTIST_IDENTITY.md): it uses the registry's public `artistId` and stored MusicBrainz artist MBID. It does not match names, add images, or change listening stats.

## Reading a biography

- `GET /artists/:artistId` adds `features.biography`, which is `true` while the flag is on. The page then asks for the biography; older APIs omit the capability and the page stays unchanged.
- `GET /artists/:artistId/biography` (local search rate limit) returns `{ artistId, biography }`. `biography` is `null` when there is no record, the match is not verified, the article no longer matches, or a moderator suppressed it or rejected the match. While the flag is off the route returns `503 ARTIST_BIOGRAPHIES_DISABLED`.
- A shown biography has `text`, `excerpt: true`, `shortened`, `edited`, `article { title, url, revisionId, revisionUrl }`, `license { name: "CC BY-SA 4.0", url }`, `retrievedAt`, and `checkedAt`.

The page renders the text under "About", followed by: "From Wikipedia: *title* (revision *n*) · Excerpt[, shortened][, edited by Rescened moderators] · Text available under CC BY-SA 4.0", with links to the article, the exact revision, and the license. A missing, hidden, or failed biography renders nothing; the header, releases, and discography are unaffected.

### Reuse terms

Wikipedia's [reuse guidance](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content) requires credit by a hyperlink to the page, a reasonable indication of modifications, and a license notice linking to [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Storing a copy does not change that. The excerpt is always labeled an excerpt, "shortened" when it is not the whole lead, and "edited" when a moderator corrected it. A moderator correction keeps the attribution of the revision it was based on. Displayed excerpts, including shortened or corrected ones, are offered under the same license.

## Matching rules

`lib/artists/biographyResolver.js` accepts a biography only when every check passes. Names are never compared.

1. **MusicBrainz.** `GET /ws/2/artist/<mbid>?inc=url-rels+artist-rels` must return the requested MBID or a validated permanent merge chain (at most three hops, no loops); the final artist is fetched explicitly. The stored catalog MBID never changes. Only current relationships of type `wikidata` with target type `url` count. None: `not_linked`. More than one item: conflict. An unrecognized Wikidata URL: review.
2. **Wikidata.** `wbgetentities` for that item. A missing item goes to review. An explicit Wikidata item redirect is followed through at most three hops, with each destination fetched directly. Cycles and longer chains go to review; inconsistent redirect evidence fails closed as an invalid provider response. The canonical item must pass every remaining check against the original MBID. The original linked QID, ordered redirect path, and returned resolved-entity revision IDs are stored as evidence (these are not revisions of the source redirect pages); no artist MBIDs are rewritten. Its P434 (MusicBrainz artist ID) statements decide:
   - proof is a preferred- or normal-rank value statement equal to the MBID, either unqualified or carrying only valid descriptive name annotations P1810 (subject named as) and P742 (pseudonym). Names are not matched. Only a permanent 301/308 to a different valid HTTPS MusicBrainz artist endpoint proves a merge. The resolver follows the validated identifier, never an arbitrary Location URL, and requires canonical P434/type/article proof. Alternate IDs may collapse only to a P434-listed canonical person on the same verified human item; all original IDs and ordered hops remain evidence. Temporary, same-ID, malformed or unrelated redirects remain provider errors, never identity changes. Empty, malformed, unknown, non-value or oversized qualifiers remain uncertain; classification checks the full raw qualifier set before evidence is bounded;
   - no P434 at all: review (`P434_MISSING`);
   - only a deprecated match: conflict (`P434_DEPRECATED`); only other values: conflict (`P434_MISMATCH`);
   - unsupported qualifiers, unknown ranks, no-value claims or malformed current IDs: review (`P434_UNCERTAIN`), even if another current claim is safe;
   - multiple current IDs require corroborated real-name/stage-name identity: at most eight separately fetched MusicBrainz people, each linking to the same human Wikidata item with reciprocal IDs, connected by current or historical reciprocal performance-name relationships (type ID `dd9886f2-1dfe-4270-97db-283f6839a666`). Both directions must agree on ended status and dates. Known dates must be valid and wholly in the past, with no inverted date range; unknown dates may remain null. Historical name identity is not current band membership. Without this proof: review (`MULTIPLE_P434_IDENTITIES_UNVERIFIED`). Bands and unrelated projects are not automatically collapsed, and no catalog artist IDs or MBIDs are merged.
   Statement IDs, ranks, qualifiers (property and up to five normalized values each), and the item's `lastrevid` are all stored as evidence. An apply compares only the decision-relevant evidence against the reviewed plan: the MusicBrainz type and links, the ordered Wikidata redirect path and canonical ID, the P434 statements (IDs, values, ranks, qualifiers), the P31 classes, nested alias/solo-project evidence, the sitelink, and the page. Relationship direction, dates, qualifiers, member identities and statement IDs are rechecked; only observation revision counters are excluded. A change to the item's `lastrevid` alone, from an unrelated Wikidata edit, does not invalidate a reviewed plan.
3. **Person or group.** The MusicBrainz type (Person; Group, Orchestra, Choir) must agree with the item's P31 classes. Recognized classes are human (Q5) and musical group, musical ensemble, rock band, musical duo, girl group, boy band, musical trio (Q281643), and heavy metal band (Q56816954). Matching uses exact category IDs, not label wording. A class that contradicts a real artist (fictional character or human, disambiguation or list page, record label, album, given or family name, literary work) vetoes the match. Both person and group classes: conflict. Unrecognized classes or MusicBrainz types (Character, Other): review. There is no subclass traversal.
   **Solo-project exception.** A MusicBrainz Person whose matched Wikidata item is a musical group may pass only with a narrow cross-provider bridge. The project must have exact reciprocal P434 proof, exactly one current unqualified P527 member, and one active backward MusicBrainz performance-name relationship to a separately fetched Person. The related person's reciprocal forward relationship, typed Wikidata link to that sole member, human class, exact unambiguous P434, and current unqualified P463 membership back to the project must all agree. The project's article is still validated and used, not the human's article. Wrong directions, ended/future/ambiguous relationships, multiple members, unfamiliar qualifiers or unsupported ranks do not pass. Partial start dates are accepted only when their entire possible date range is in the past; end dates are not assumed current. No artist-name exception or user override is hardcoded. Evidence is stored and rechecked during apply.
4. **Article.** The item's `enwiki` sitelink is queried with `prop=info|pageprops|revisions` and `redirects=1`. It must exist, be in namespace 0, have the same `wikibase_item`, not be a disambiguation page (the Disambiguator page property), and not be a list. A redirect to another item is a cross-entity redirect: conflict. A redirect to the same item is fine.
5. **Exact revision.** The text comes from `action=parse&oldid=<revision>&section=0` for the revision the page query returned. The response must echo that revision and page, so a page edited during retrieval still yields text from the validated revision, never a mix. The parse response's `wikibase_item` and `disambiguation` page properties are rechecked too; they describe the page's current Wikidata linkage, not a historical guarantee about that revision.

Outcomes: `accepted`, `needs_review` (incomplete or unfamiliar evidence; a candidate excerpt is kept for review), `conflict` (evidence contradicts the match), `unsuitable` (no usable article or lead), `no_article`, `not_linked`, or an operational `error`. Operational errors never change identity.

English only for this first pass; other languages would need their own sitelink, attribution wording, and review.

### The excerpt

`lib/artists/biographyText.js` takes the lead section's top-level paragraphs, skipping references, infoboxes and other tables, figures, hatnotes, hidden short descriptions, and anything marked `noexcerpt` or `noprint`. From the first paragraph it keeps the longest run of whole sentences up to **250 grapheme clusters** (user-perceived characters, so emoji sequences and combining marks are never split). When even the first sentence is longer, it cuts at the last whole word that fits and adds "…". Leads shorter than 20 characters are unsuitable. Text, SHA-256 hash, cut type, and extraction version (`en-lead-sentences-v1`) are stored.

The 250 cap follows the product request. A complete sentence or two usually fits; a word cut is labeled, not hidden.

## Storage

`ArtistBiography` holds one record per artist and language, keyed by `(artistId, language)`:

| Part | Written by | Meaning |
| --- | --- | --- |
| `identity` | resolver | State, reasons, QID, evidence, check time, next identity check |
| `accepted` | resolver (first publication only), moderator confirmation, or a moderator accepting a staged revision | The published excerpt with article title, page ID, revision ID and timestamp, URLs, QID, license, hash |
| `candidate` | resolver | An excerpt waiting for review (a new or changed match) |
| `pendingRevision` | refresh | Changed text from a newer revision of the published page, held for a moderator; never shown to readers |
| `dismissedRevision` | moderator | The staged text a moderator declined (revision, text hash, reason, who, when), so refresh does not stage it again |
| `contentCheckedAt`, `nextContentCheckAt` | resolver | Revision checks of the accepted article |
| `fetch` | resolver | Last attempt, last error code and provider, consecutive failures, next attempt |
| `manual` | moderator | Corrected text and the article revision it is based on |
| `moderation` | moderator | Suppression and match verdict |
| `history` | both | Append-only audit events with actor and action |

Every write matches the record's `revision` and advances it. The resolver never writes `manual` or `moderation`. If a refresh read the record before a moderator command landed, its write matches nothing and is discarded; the next run re-reads.

What is shown: nothing when suppressed or the match was rejected; otherwise the accepted excerpt (or the correction) only while identity is `verified` for the same item.

- Neither refresh nor a plan apply replaces published text. When a newer revision of the published page has a different excerpt, refresh stores it as `pendingRevision` and the accepted excerpt (or the correction) keeps showing with its original source revision. If the newer revision's excerpt is identical, only the source revision is moved forward, which changes nothing a reader sees. If Wikipedia later reverts to the published text, or moves to text a moderator dismissed, the staged revision is cleared; dismissed text is not staged again under a later revision. A different new text replaces the staged one. A text-identical revision also refreshes the excerpt's `shortened` flag and extraction metadata. While text is staged, each weekly check re-reads the newest revision and advances the record revision, so a moderator panel left open across a refresh run gets a conflict and reloads.
- A transient error keeps the accepted text and schedules a retry: 1 hour, doubling, at most 7 days.
- A conflict, missing article, or unusable lead found later hides the text until resolved; the accepted copy stays for audit.
- A full resolution that finds a different item or page never switches automatically: it goes to review with `MATCH_CHANGED` and stops showing the old text.

## Operator command

```sh
npm run artists:biographies -- --out ~/rescened-ops/biographies/<db>-<date>.plan.json [--limit 25] [--artist <artistId>]...
npm run artists:biographies -- --apply --plan <plan.json> --plan-sha256 <sha> --confirm-target <db> --report <report.json>
npm run artists:biographies -- --refresh --confirm-target <db> --report <report.json> [--limit 25]
```

Like the other operator commands, it takes `MONGO_URI` from the environment or the root `.env`.

- **Plan** (default) reads the database without writing and connects with automatic collection and index creation off. It resolves at most `--limit` artists (default 25, maximum 200): those never checked or whose identity check is due and not in backoff, or the listed `--artist` IDs. It writes a sealed plan (`planSha256`) that never overwrites a file. Exit code 2 means something needs review or conflicts.
- **Apply** verifies the seal and that `--confirm-target` equals the plan's database before connecting, then that the connected database matches before building the biography indexes. It re-resolves only the planned artists and writes an outcome only if the record revision is unchanged and the new outcome has the same status, QID, revision, and text hash as reviewed. Otherwise it reports `record_changed` or `outcome_changed`; make a new plan. Apply can publish a first biography or move a record into review, but it does not replace the text of an already published biography: like refresh, it stages changed text for a moderator and never re-stages text a moderator dismissed. Plan rows show what is published now (`published`), whether applying would stage changed text (`stagesChangedText`), and whether the result is text a moderator dismissed (`matchesDismissedText`). A planned provider `error` is applied only if the provider still fails: it records the fetch failure and backoff (1 hour, doubling to at most 7 days) and changes no text, identity, or moderation state, so later plans skip that artist until its backoff ends instead of selecting it again. Such a row is reported as `written` with `status: "error"` and its `errorCode`; the report's `statusCounts` separates these backoff records from written biographies. The report path is reserved before any write.
- **Refresh** applies the same target checks, then processes verified records whose content check (weekly) or identity check (every 30 days) is due and not in backoff. Content checks read the page by its stable ID and fetch a pinned revision only when it changed. Refresh never publishes changed text and never accepts a new match: changed text from the same item and page is staged for a moderator (see [Storage](#storage)), and a conflict hides the text. This applies to both the weekly content check and the monthly identity revalidation. Report rows carry the `action` (for example `content:revision_staged`), summarized in `actionCounts`. Once a biography is published, only a moderator can change its text. If the stored page ID now leads to a different page (for example a redirect after a merge), the record goes to review with `MATCH_CHANGED` and `PAGE_CHANGED` and the old text stops showing.

Provider etiquette: an identifying user agent with contact; serial requests (1.1 s between MusicBrainz request starts, 1 s between Wikimedia ones); `maxlag=5` on Wikimedia requests; an 8 s timeout covering the body; at most 2 MiB of decoded body; at most two retries for timeouts, network errors, 408/425/429/5xx, and `maxlag`, honoring `Retry-After` up to 30 s and otherwise stopping with `BIOGRAPHY_PROVIDER_THROTTLED`. Permanent errors are not retried.

The intervals and cap are defaults in `DEFAULT_SETTINGS` (`lib/artists/biographies.js`), not provider requirements.

## Moderation

Moderators (Clerk session in `MODERATOR_USER_IDS`) use `/moderation/artist-biographies`. Reads need `ARTIST_BIOGRAPHIES_ENABLED`; commands also need `COMMUNITY_MODERATION_ENABLED` and use the moderation mutation rate limit.

- `GET /?state=needs_review|revision_pending|conflict|verified|unsuitable|no_article|not_linked|unchecked&limit=` lists records. `revision_pending` lists biographies with staged changed text, whatever their identity state; each row has a `pendingRevision` flag.
- `GET /:artistId` returns the record with evidence, history, and what the page would show.
- `POST /:artistId/<command>` with `{ expectedRevision, ... }`:
  - `suppress` (`reason`) and `unsuppress`;
  - `reject-match` (`reason`) hides the item until `clear-verdict`; refresh keeps it hidden;
  - `confirm-match` publishes a reviewable candidate and remembers the item;
  - `clear-verdict` removes the verdict; clearing a confirmation returns the excerpt to review immediately;
  - `correct-text` (`text`, 20–250 plain characters, optional `note`) shows corrected wording, labeled edited, with the source revision it was based on; `clear-correction` removes it;
  - `accept-revision` publishes the staged `pendingRevision` text with its own revision and license attribution, recorded as accepted by that moderator. It needs a verified identity for the same item and page. Suppression, verdicts, and a correction stay as they are (the correction keeps its own source revision until cleared). Because `expectedRevision` must match, a refresh that staged newer text after the moderator loaded the record makes the accept fail with a conflict instead of publishing text they did not see;
  - `dismiss-revision` (`reason`) keeps the current text, clears the staged revision, and remembers that text so neither refresh nor a plan apply stages it again. A rejected match also clears any staged revision.

A stale `expectedRevision` returns `409 BIOGRAPHY_REVISION_CONFLICT`. The artist page shows a collapsed "Biography moderation" panel to moderators. A staged revision appears there under the published excerpt, with "Publish new text" and "Keep current text" (which needs a reason).

## Rollout

1. Ship with `ARTIST_BIOGRAPHIES_ENABLED` off. Nothing is created until an operator runs the command.
2. Pilot on a development database: plan a small batch (for example `--limit 10`), review every accepted excerpt and attribution, and inspect the review and conflict buckets. Apply only with explicit authorization for that database.
3. Turn the flag on in development with moderation enabled, and check pages and the moderation panel.
4. For production, repeat the plan, review, and apply with explicit authorization for that target; enable the flag only after review. Schedule refresh deliberately; it is not scheduled automatically.

No production or development data has been written by this implementation.

## Verification

- `tests/artistBiographies.test.js`: lead extraction, the 250-grapheme excerpt and word cut, Unicode, every resolver outcome above with fixtures, revision pinning (including a page edited mid-retrieval), content refresh, retries and `Retry-After`, timeouts, size limits, serial gates, display and change notices, transient-versus-conflict handling, moderator confirmation, command validation, and the operator command's argument and target guards.
- `tests/artistBiographies.integration.test.js` (replica set): plan, apply, and the public read; apply refusing changed outcomes and records; refresh behavior; a refresh racing a suppression; moderator corrections, rejection, and audit history surviving refresh; confirmation and immediate revocation; moderator access and flags.
- `tests/artistBiographyModeration.browser.test.js` is opt-in (`RUN_FRONTEND_BROWSER_TESTS=true` with Playwright). It signs out during a pending moderator command and checks that the command is aborted, no stale record or "Saved" appears, and the next user starts with empty form state.
- Fixtures are synthetic, following the documented response shapes; see `tests/fixtures/biographies/README.md`.

## Known limitations

- English Wikipedia only.
- P31 matching uses a short allowlist and veto list without subclass traversal. Solo-project and multiple-name proof is intentionally conservative, so legitimate artists with incomplete provider relationships can remain held.
- Biography text is plain; links and formatting in the lead are dropped.
- Wikidata redirects are bounded and validated, not blanket-approved. MusicBrainz merges require bounded canonical verification; cross-entity Wikipedia redirects remain conflicts.
- The rate gates are per process; do not run several operator commands at once.
