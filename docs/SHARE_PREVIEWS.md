# Share previews and SEO

Album and review links unfurl with their own title, description, and cover in Discord, Slack, iMessage, X, and other apps, and search engines see the same metadata. The design and its confirmed decisions are in [the sharing and export plans](SHARING_AND_EXPORT_PLANS.md#1-link-previews-and-seo); this guide covers how the shipped feature works and how to operate it.

## How it works

Link-preview crawlers do not run JavaScript, and Vercel serves the SPA as one static `index.html`. So crawlers are routed at Vercel to small HTML pages rendered by Express:

```text
crawler ──GET /album/:albumId──▶ Vercel ──user-agent matches?──▶ Railway API  GET /share/album/:albumId
browser ──GET /album/:albumId──▶ Vercel ──no match──────────────▶ index.html (the SPA)
```

| Piece | File |
| --- | --- |
| Pure builders: escaping, truncation, meta tags, JSON-LD, sitemap XML | `lib/sharePreview/render.js` |
| Express routes under `/share` | `routes/sharePreview.js` |
| Crawler rewrites and the sitemap proxy | `vercel.json` |
| SPA head tags for album and review pages | `frontend/src/utils/pageMeta.js`, `frontend/src/Components/PageMeta.jsx` |
| Default description and crawl rules | `frontend/index.html`, `frontend/public/robots.txt` |
| Tests (offline; models and Clerk stubbed) | `tests/sharePreview.test.js` |

## Configuration

| Variable | Where | Effect |
| --- | --- | --- |
| `SHARE_PREVIEWS_ENABLED=true` | API (Railway) | Serves the `/share` routes. **Default off**: every `/share` path returns `404` with generic site tags, `noindex`, and `Cache-Control: private, no-store`, and reads nothing from the database. |
| `PUBLIC_SITE_URL` | API (Railway) | Origin for canonical links, `og:url`, and sitemap entries. Defaults to `https://rescened.com`. Paths are dropped, and anything other than an `http(s)` origin falls back to the default. |

The SPA's canonical links and `robots.txt` name `https://rescened.com` directly; they are not configurable.

## Routes

| Route | Success | Missing or invalid |
| --- | --- | --- |
| `GET /share/album/:albumId` | `200` HTML, `public, max-age=300` | `404`, `no-store` |
| `GET /share/review/:reviewId` | `200` HTML, `public, max-age=300` | `404`, `no-store` (also when the review's album no longer resolves) |
| `GET /share/sitemap.xml` | `200` XML, `public, max-age=300` | — |

A failed database read returns `500` with `no-store` and generic tags. IDs must be public UUIDs; anything else is a `404` without a database read.

Each page has a `<title>`, description, canonical link, Open Graph and Twitter tags (`twitter:card` is always `summary`, which suits square 500px covers), JSON-LD (`MusicAlbum` for albums; `Review` with `reviewRating` and `itemReviewed` for reviews), and a visible heading, text, and link to the real page. The visible content matches what the SPA shows, so search engines do not treat the page as cloaking.

### Content rules

- Only `AlbumCatalog` records appear. Submissions are not in the catalog until approval, so they never get a preview.
- `/album/:albumId/reviews` renders the album page, whose canonical link is `/album/:albumId`.
- Covers are the existing Cover Art Archive links, used only when they are `https:`. Rescened never proxies, resizes, copies, or composites artwork, and generates no preview images.
- A review by a user with a private profile shows their username, because reviews are public, but the page is `noindex`. Profile privacy does not anonymize review authors.
- A review by a deleted account shows "deleted user", with no Clerk or profile lookup.
- No Mongo `_id`, Clerk user ID, or comment count appears in any output.
- Text is truncated (by code point) before escaping. Every attribute and text value escapes `& < > " '` and drops control characters. JSON-LD writes each `<` as `<`, so review text cannot close the `<script>` tag.

### Sitemap

Albums only, from each catalog record's `albumId` and `updatedAt`, in one file capped at 50,000 URLs (the server logs a warning if the cap is reached; split into a sitemap index then). Review permalinks are never listed. The XML is built at most once per 15 minutes per API process.

## Vercel rewrites

`vercel.json` lists the crawler rules before the SPA catch-all:

- `/sitemap.xml` proxies to `/share/sitemap.xml` for every user agent.
- `/album/:albumId`, `/album/:albumId/reviews`, and `/review/:reviewId` proxy to the share routes when the `user-agent` header contains one of: `facebookexternalhit` (also used by iMessage), `Twitterbot`, `Discordbot`, `Slackbot`, `LinkedInBot`, `TelegramBot`, `WhatsApp`, `Applebot`, `Googlebot`, or `bingbot`.

The destinations use the public, credential-free Railway API origin. Matching is case-sensitive, using each crawler's own spelling. To add a crawler, extend the `user-agent` pattern in every rule and add a sample to the rewrite test in `tests/sharePreview.test.js`, which also checks that desktop and mobile Chrome and Safari never match. If the Railway domain changes, update `vercel.json` and the frontend's `VITE_API_URL` together.

## Rate limiting and proxies

Proxied requests arrive from Vercel's addresses rather than the crawler's, so `/share` is mounted in `server.js` before the global API limiter and has its own `sharePreview` bucket: 600 requests per 5 minutes per IP (see the [rate-limit reference](ERROR_CODES.md#rate-limit-reference)). The flag check runs first, so disabled requests consume nothing.

`TRUST_PROXY_HOPS` should stay at the value that matches Railway's own edge. Do not add a hop for Vercel: direct API requests do not pass through Vercel, so an extra trusted hop would let any direct caller choose its IP key with `X-Forwarded-For`. As a result, proxied share requests are keyed by Vercel's egress address, and many crawlers can share one key. That is why the bucket is separate and generous; crawlers back off on `429` and `Retry-After`.

## SPA head tags

React 19 hoists a component's `<title>` and `<link>` into `<head>`. `AlbumDetail` and `ReviewPermalink` render `PageMeta`, which sets the page title and a canonical link to `https://rescened.com`, and updates the default `<meta name="description">` from `index.html` rather than adding a second one. Titles and descriptions match the share pages. Other pages keep the default title and description.

`robots.txt` disallows `/account`, `/suggestions`, `/moderation`, `/notifications`, and `/collection`, and names `https://rescened.com/sitemap.xml`.

## Rollout

1. Make sure `https://rescened.com` serves the frontend. Moving to that domain also requires adding `https://rescened.com` to the API's `CORS_ALLOWED_ORIGINS` (or `FRONTEND_URL`) and to Clerk's allowed origins and redirect URLs, or sign-in and API calls fail there.
2. **Before the `vercel.json` rewrites deploy**, set `SHARE_PREVIEWS_ENABLED=true` (and `PUBLIC_SITE_URL` if not the default) on the Railway API. Merging to `main` deploys the rewrites at once; with the flag off, crawlers, including Googlebot, would get `404 noindex` pages for every album and review. Setting the variable early is harmless: nothing calls `/share` until the rewrites exist. If Vercel finishes deploying before Railway, crawlers get the old API's plain `404` for those few minutes.
3. Check the API directly: `GET <api origin>/share/album/<albumId>` returns `200` HTML, and `/share/sitemap.xml` lists albums.
4. After the frontend deploys, paste real album and review links into Discord, Slack, and iMessage. Cover URLs (`front-500`) redirect to archive.org; most unfurlers follow the redirect, but confirm the image appears.
5. Submit `https://rescened.com/sitemap.xml` in Google Search Console if wanted.

To turn previews off, set `SHARE_PREVIEWS_ENABLED=false`. Crawlers then get `404` pages until the rewrites are removed from `vercel.json`, so remove them too if previews will stay off.

## Limits

- Platforms cache unfurls on their side, so deleting a review cannot retract a card already shown. The share pages themselves cache for 5 minutes.
- Crawlers outside the user-agent list get the SPA shell with the default title and description.
- The rate limiter and sitemap cache are in process memory, so each API instance has its own.
