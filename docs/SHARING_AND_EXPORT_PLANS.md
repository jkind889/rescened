# Plans: link previews and SEO, data exports

Status: October 2026. Decisions confirmed October 30, 2026 and recorded below. Data exports are implemented behind the disabled-by-default flag; see [the maintained data export guide](DATA_EXPORT.md) for the current behavior and rollout. Link previews remain a separate workstream.

| Plan | Size | Depends on |
| --- | --- | --- |
| 1. Link previews and SEO for album and review pages | Medium | — |
| 2. Data exports for reviews, listens, and boards (CSV and JSON) | Medium | — |

The plans are independent. They touch separate files and both start behind disabled flags, so they can be built in parallel.

---

## 1. Link previews and SEO

### Where things stand

- **Hosting.** Vercel builds `frontend/dist` and serves it as a static SPA. Every path is rewritten to `/index.html` (`vercel.json`). The Express API is hosted separately on Railway and does not serve the frontend: `server.js` has no static or catch-all route. No production API URL is committed to the repository (`PC_HANDOFF.md`).
- **Head.** `frontend/index.html` has a fixed `<title>rescened</title>`, favicons, and a preconnect to `coverartarchive.org`. There is no description, no Open Graph or Twitter tags, no canonical link, no `robots.txt`, and no sitemap. No page updates the title.
- **Routes.** Albums are `/album/:albumId` and `/album/:albumId/reviews`. Reviews are `/review/:reviewId` (`frontend/src/App.jsx`).
- **Data.**
  - Albums come from `AlbumCatalog` through `findAlbumByPublicId` (`routes/utils/albumCatalog.js`). Covers are Cover Art Archive URLs (`.../release/<mbid>/front-500`).
  - Reviews have a public UUID `reviewId`, a `rating` from 1 to 5 in half steps, `reviewText` of at most 300 characters, `date`, and `editedAt`. Reviews have no visibility field. Deletion is a hard delete. Deleted accounts' reviews are reassigned to `rescened:deleted-user`.
  - `UserProfile.isPrivate` gates profile reads. Reviews by private profiles are still public on album pages and permalinks.
  - Author names come from Clerk through the cached lookup in `lib/clerkAuthors.js`.

Link-preview crawlers (Discord, Slack, iMessage, X, and others) do not run JavaScript. Per-page tags therefore have to be in the HTML response, and because Vercel serves that HTML, crawler requests have to be routed at Vercel.

### Design

**Crawler-only rewrites to Express-rendered pages.**

- New Express routes in `routes/sharePreview.js`:
  - `GET /share/album/:albumId`
  - `GET /share/review/:reviewId`
  - `GET /share/sitemap.xml`
- `vercel.json` gets rewrites before the catch-all, each with a `has` condition on the `user-agent` header. The pattern covers `facebookexternalhit` (also used by iMessage), `Twitterbot`, `Discordbot`, `Slackbot`, `LinkedInBot`, `TelegramBot`, `WhatsApp`, `Applebot`, `Googlebot`, and `bingbot`. `/sitemap.xml` is proxied for every user agent.
- Each share route returns a small HTML document:
  - `<title>`, description, canonical link, Open Graph and Twitter tags
  - JSON-LD: `MusicAlbum` for albums; `Review` with `reviewRating` and `itemReviewed` for reviews
  - a visible heading and a link to the real page, with the same content the SPA shows, so search engines do not treat it as cloaking
- `/album/:albumId/reviews` canonicalizes to `/album/:albumId`.
- Proxy destinations use the public, credential-free Railway API origin committed in `vercel.json`. Update the `PC_HANDOFF.md` convention when implementing these rewrites; credentials remain server-side.
- Canonical URLs use `https://rescened.com`, and Twitter cards use `summary` for the square 500px covers.

**Cover art.** `og:image` points at the existing Cover Art Archive URL, and only when it is `https:`. Rescened does not proxy, resize, or composite artwork, because linked artwork is not licensed for copying or rehosting. Generated preview images are out of scope for the same reason. Text-only generated cards would need a new rendering dependency and are not worth it yet.

**Content rules.**

- Only `AlbumCatalog` records appear. Submissions never reach the catalog until approval, so they never get a preview.
- A missing or deleted review returns `404` with generic site tags and `Cache-Control: no-store`.
- A review by a private profile shows the user's username in its preview: reviews are public community interactions, while access to the profile remains restricted. Keep `noindex` and no review sitemap entry; profile privacy alone must not anonymize the author.
- No Mongo `_id` appears in any output.
- No comment count appears, whatever `REVIEW_COMMENTS_ENABLED` is set to.

**Escaping.** Every attribute value escapes `& < > " '` and drops control characters. Text is truncated before escaping. JSON-LD writes each `<` as the literal Unicode escape sequence `\u003c`, so review text cannot close the `<script>` tag.

**Caching.** Responses use a short public TTL (about 300 seconds) through `routes/utils/cacheHeaders.js`. Platforms cache unfurls on their own side, so deleting a review cannot retract a card that was already shown.

**Rate limiting.** Proxied requests all arrive from Vercel's IP addresses. Mount `/share` before `globalApiRateLimit` in `server.js` and give it its own IP-keyed bucket in `RATE_LIMITS`, so crawler traffic neither shares the API budget nor exhausts it. Confirm the `trust proxy` hop count for the extra Vercel hop.

**Sitemap.** Albums only, from catalog `albumId` and `updatedAt`. The catalog is far below the 50,000-URL limit, so one file is enough.

**Client side.** React 19 hoists `<title>`, `<meta>`, and `<link>` rendered by components, so no helmet library is needed. `AlbumDetail` and `ReviewPermalink` render their own title, description, and canonical link. `index.html` gets a default description. A static `frontend/public/robots.txt` disallows `/account`, `/suggestions`, `/moderation`, `/notifications`, and `/collection`, and points at `https://rescened.com/sitemap.xml` (the `Sitemap:` directive must be an absolute URL).

**Configuration.**

- `SHARE_PREVIEWS_ENABLED`, off by default. When off, the share routes return `404`.
- `PUBLIC_SITE_URL=https://rescened.com`, used for canonical links, `og:url`, and sitemap entries.

### Slices

1. `lib/sharePreview/render.js`: pure escaping, truncation, tag, and JSON-LD builders. Add `lib/sharePreview` to the scan roots in `scripts/checkCatalogContract.js`.
2. `routes/sharePreview.js` behind the flag, with its rate-limit bucket, cache headers, and mount in `server.js`.
3. Sitemap route.
4. Frontend head tags, the default description, and `robots.txt`.
5. `vercel.json` rewrites.
6. Docs: a maintained `docs/SHARE_PREVIEWS.md`, the hosting note in `PC_HANDOFF.md`, `README.md` environment variables, and `docs/PROD_READINESS_2_0.md`.

### Verification

- **Unit tests** (`tests/sharePreview.test.js`, offline, with models and Clerk stubbed):
  - escaping, including a `</script>` breakout in review text
  - a missing or non-`https:` cover
  - private-profile authors retain their username, with `noindex` and no review sitemap entry
  - deleted authors
  - canonical URLs use `https://rescened.com` and Twitter cards use `summary`
  - a deleted review returns `404` with `no-store`
  - no `_id` in any output
  - the flag-off response
- **Rewrite test:** the crawler rules come before the catch-all, and the user-agent pattern matches the listed bots but not desktop or mobile Chrome and Safari.
- **Manual check** after deployment to a preview environment: paste real links into Discord, Slack, and iMessage. `front-500` redirects to archive.org; most unfurlers follow it, but confirm.
- Run `npm test`, `npm run check:catalog-contract`, and frontend lint and build.

### Decisions confirmed October 30, 2026

1. **API origin in `vercel.json`.** Use the public, credential-free Railway API origin in committed rewrites. It is already visible in frontend network requests. Update the "no production API URL committed" convention in `PC_HANDOFF.md` during implementation; this decision does not authorize committing credentials.
2. **Canonical domain.** `https://rescened.com`, configured through `PUBLIC_SITE_URL`.
3. **Private-profile reviews.** Show the user's username in the preview because reviews are public community interactions. Profile access remains restricted. Retain `noindex` and no review sitemap entry.
4. **Reviews in the sitemap.** Albums only for the initial release.
5. **Twitter card type.** `summary`, matching square 500px covers.

---

## 2. Data exports

### Where things stand

- **Reviews** (`models/Reviews.js`): public `reviewId`, `rating`, `reviewText`, `date`, `editedAt` (null means never edited), and an internal `albumCatalogId`. The internal fields `interactionRevision`, `creationKey`, and `followedReviewFanoutAt` are never public. Track rankings are a separate model (`models/TrackRanking.js`): one per user and album, holding catalog `trackId`s, with no public ID of its own.
- **Listens** (`models/Listen.js`): a listen is a diary entry, not a play. Fields are `listenId`, `albumCatalogId` (required), `listenedOn` as a `YYYY-MM-DD` date, `source` (`manual` or `automatic`), and timestamps. There is at most about one per album per day, so volume is small. `listListens` drops listens whose album no longer resolves (`routes/utils/listeningDiary.js`).
- **Scrobbles** (`models/Listening.js`) are separate. They are private, expire after 30 days, and hold raw provider text with no catalog album when unresolved. They are not part of a user's library.
- **Boards** (`models/Board.js`): `boardId`, `title`, `description`, `isDefault`, `orderMode`, `displayStyle`, and an `albumOrder` of at most 100. Membership is an explicit `BoardItem` or a linked `BoardListen`. `collectionEntries`, `formatBoards`, and `savedAlbums` in `routes/utils/boardLibrary.js` already apply ordering, live-membership validation, and the deduplicated saved-shelf union.
- **The listen queue** holds at most 15 albums embedded in `UserProfile` (`docs/LISTEN_QUEUE.md`).
- **Patterns to reuse:**
  - the per-router Clerk `auth` with `code: "UNAUTHORIZED"` (`routes/diary.js`)
  - `RATE_LIMITS` with `createRateLimitMiddleware` and `getAuthenticatedUserRateLimitKey`, which set `Retry-After` (`routes/utils/rateLimit.js`)
  - flag helpers in the style of `isGenresEnabled` (`routes/utils/serverConfig.js`)
  - `CATALOG_ALBUM_FIELDS` for catalog lookups
- **Nothing to build on.** There is no CSV, `Content-Disposition`, streaming, or file-download code anywhere, and no CSV or zip library in the root `package.json`. CORS exposes no response headers.

### Design

**Endpoint.** `GET /profile/me/export/:dataset.:format`, where `dataset` is `reviews`, `listens`, or `boards`, and `format` is `csv` or `json`. It lives in a new `routes/dataExport.js`, mounted in `server.js` before `/profile`. There is one endpoint per dataset and no zip archive, which would need a new dependency.

**Access.** Owner-only through Clerk, whatever the profile's `isPrivate` setting. There is no way to export another user's data.

**Synchronous, buffered response.**

- Read in batches of 500 by the existing user indexes, and resolve catalog albums per batch.
- Build the whole body in memory, then send it once with `Cache-Control: no-store`. Errors stay clean JSON, and a failure never leaves a truncated file.
- Above 50,000 rows in one dataset, return `413 EXPORT_TOO_LARGE`. Background export jobs are deferred until someone hits the cap.

**JSON shape.**

```text
{ schemaVersion: 1, dataset, exportedAt, items: [...] }
```

Listens JSON also includes `omitted` alongside `items`, counting listens excluded because their album no longer exists (zero when none are excluded):

```text
{ schemaVersion: 1, dataset: "listens", exportedAt, omitted: 0, items: [...] }
```

Public IDs only, ISO-8601 UTC timestamps, `listenedOn` kept as a date. Album title and artist come from `AlbumCatalog` at export time.

| Dataset | Fields |
| --- | --- |
| Reviews | `reviewId, albumId, albumTitle, albumArtist, rating, reviewText, reviewedAt, editedAt` |
| Listens | `listenId, albumId, albumTitle, albumArtist, listenedOn, source, loggedAt` |
| Boards | `boardId, boardTitle, boardDescription, isDefault, orderMode, displayStyle, position, albumId, albumTitle, albumArtist, savedAt, explicitlySaved` |

Boards JSON nests each board's albums in display order. Boards CSV has one row per membership, and an empty board gets one row with blank album columns. Board membership and order come from the existing `boardLibrary` helpers, not a reimplementation.

**CSV safety.**

- Quote every field (RFC 4180), use CRLF line endings, and start with a UTF-8 byte order mark, so Excel opens it correctly.
- Prefix `'` on text cells that start with `=`, `+`, `-`, `@`, tab, or carriage return, so spreadsheets do not run them as formulas. Numeric columns are not prefixed.

**Excluded from v1.** Track rankings, album likes, the listen queue, authored comments, other users' comments on your reviews, scrobbles, and listens whose album no longer exists (no public album ID is left to export). Track rankings are the first planned addition after v1. Missing-album listens contribute to the JSON `omitted` count.

**Flag, rate limit, and errors.**

- `DATA_EXPORT_ENABLED`, off by default. When off, the endpoint returns `503 DATA_EXPORT_DISABLED`.
- A new `dataExport` bucket of 10 exports per hour per user, applied after authentication, with `Retry-After`.
- `400 INVALID_EXPORT_REQUEST` for an unknown dataset, format, or query parameter, and `500 EXPORT_FAILED`.

**Frontend.** A data export section in the owner-only Settings tab of `frontend/src/Pages/Account.jsx`, as `frontend/src/features/export/DataExport.jsx`. It has three rows (Reviews, Listens, Boards), each with CSV and JSON buttons, and no helper text. A button fetches with `Authorization: Bearer` from Clerk's `getToken()`, saves the blob through a temporary link, and builds the filename on the client (`rescened-reviews-2026-10-28.csv`). Errors go through `getApiErrorMessage`. The section hides itself on `503`. Signed download URLs are out, because they would need a token store and put access in a URL.

### Slices

1. `lib/dataExport/csv.js`, `serializers.js`, and `collect.js`. Add `lib/dataExport` to the scan roots in `scripts/checkCatalogContract.js`.
2. `routes/dataExport.js`, the flag, `RATE_LIMITS.dataExport`, and the mount in `server.js`.
3. The Settings section.
4. Docs: a maintained `docs/DATA_EXPORT.md` with the field schemas, plus the new codes and rate-limit row in `docs/ERROR_CODES.md`.

### Verification

- **Unit tests** (offline):
  - CSV quoting, CRLF, the BOM, and formula-prefix cases
  - edited and never-edited reviews
  - an empty board
  - the schema version
  - listens JSON includes `omitted` alongside `items`, including zero and missing-album cases
  - no `_id` or internal fields in any output
- **Route tests** with Clerk and models stubbed, as `tests/reviewEdit.test.js` does:
  - unauthenticated requests
  - the flag-off response
  - invalid dataset and format
  - the row cap
  - the rate limit and `Retry-After`, extending `tests/routeRateLimits.test.js`
- **Integration test** (`tests/dataExport.integration.test.js`, registered in `scripts/runIntegrationTests.js`): board order and the saved-shelf union, and a listen whose album was deleted. No transactions are involved, so this is recommended rather than required.
- Run `npm test`, `npm run check:catalog-contract`, frontend lint and build, and `npm run test:integration` if the integration test is added.

### Decisions confirmed October 30, 2026

1. **Datasets in v1.** Reviews, diary listens, and boards only, with track rankings as the first addition after v1.
2. **Omitted-row count.** Listens JSON includes the count of listens left out because their album was deleted as `omitted` next to `items`.
3. **Filename.** Build it on the client; no `Content-Disposition` CORS exposure is needed.
4. **Limits.** 10 exports per hour per user and a 50,000-row cap per dataset.

### Risks

- Album titles reflect the catalog at export time, not at review time.
- The rate limiter is in memory per server instance, so the budget is per instance.
- The formula guard also changes legitimate text that starts with `-`. The prefix is visible and reversible, and the JSON export is unchanged.
