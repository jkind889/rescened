# Rescened 2.0 production readiness

This file records the audit of the 2.0 branch before its first production push: what was fixed, what must be done before the push, and which performance work can wait. It links to the maintained runbooks and does not repeat them.

## Scope

- Audited: the 27 commits in `main..9c5a08a` on `2.0frontend` (about 12k lines of non-test code). The review covered production harm and performance.
- Spot-checked afterwards: `635acfe`, `ee465a0`, `6f04288`. These are frontend changes plus a small `GET /moderation/album-suggestions/access` endpoint. They add no new risks.
- Commits after `6f04288` have not been audited.

## Fixed during the audit

### Missing indexes

These are all non-unique, so building them cannot fail on existing data.

| Collection (model) | Index | Query it serves |
|---|---|---|
| `notifications` (`Notification`) | `{ actorUserId: 1 }` | Account deletion: notifications the user sent |
| `likes` (`Like`) | `{ userId: 1 }` | Account deletion. The existing userId indexes are partial and cannot serve a plain `userId` query. |
| `userprofiles` (`UserProfile`) | `{ pinnedBoardId: 1 }` | Board deletion and account deletion unpin profiles |
| `reviews` (`Review`) | `{ userId: 1, albumCatalogId: 1 }` | "Waiting for your review" lookup; per-user album review checks |
| `listens` (`Listen`) | `{ userId: 1, createdAt: -1, _id: -1 }` | Home network activity and profile activity. Previously every listen from every followed user was sorted in memory. |
| `listeningscrobbles` (`Scrobble`) | `{ connectionId: 1, playedAt: -1, _id: -1 }` | `GET /connections/lastfm/events` |
| `listeningdetections` (`Detection`) | `{ connectionId: 1, startedAt: -1, _id: -1 }` | Owner detection list |
| `listeningdetections` (`Detection`) | `{ "plays.evidenceExpiresAt": 1 }` | Worker evidence-expiry poll, every loop |
| `listeningalbummappings` (`AlbumMapping`) | `{ status: 1 }` | Worker stale-mapping pass, every loop |
| `listeningjobs` (`Job`) | `{ "payload.connectionId": 1 }`, sparse | Cleanup job retiring a connection's other jobs |

Collection names are Mongoose defaults. Confirm them with `db.getCollectionNames()`.

### Baseline review panel locking moderators out

`BaselineReviewPanel` stayed marked busy in two cases:

- A moderator switched submissions or mapping candidates while a MusicBrainz lookup was still running.
- The panel was unmounted.

While it was busy, approvals and mapping decisions failed with `BASELINE_REVIEW_IN_PROGRESS` until the page was reloaded. The panel now clears its loading state when it aborts, and it tells the parent it is no longer busy when it unmounts. It also clears the reason and release fields when the target changes, so a reason written for one submission can no longer be submitted for another.

## Rolling out the indexes

Mongoose builds the indexes automatically (the default `autoIndex`) when each model first connects.

- **Core indexes** (`notifications`, `likes`, `userprofiles`, `reviews`): built in the background by the API on its first start after the deploy.
- **Listen index:** built during startup, because `startServer` waits for `Listen.init()`.
- **Listening indexes:** built by `npm run listening:worker` when it starts, and by the API only when a Last.fm or listening flag is on.

On MongoDB 4.2 and later, an index build locks the collection only briefly at the start and end. At current collection sizes the builds should finish within seconds. If a collection is large, create the indexes in `mongosh` before deploying.

After the deploy, check that the indexes exist:

```js
db.notifications.getIndexes().map((i) => i.name)   // includes "actorUserId_1"
db.likes.getIndexes().map((i) => i.name)           // includes "userId_1"
db.userprofiles.getIndexes().map((i) => i.name)    // includes "pinnedBoardId_1"
db.reviews.getIndexes().map((i) => i.name)         // includes "userId_1_albumCatalogId_1"
db.listens.getIndexes().map((i) => i.name)         // includes "userId_1_createdAt_-1__id_-1"
```

If a build fails, Mongoose reports it as an `error` event on the model and does not stop the server. Check the API logs after the first boot.

## Before the production push

These findings are still open. Items 1 to 3 need a decision or an operator action before the push.

1. **Supervise the listening worker.** `scripts/listeningWorker.js` has no error handling around its loop. One transient MongoDB error (a failover or a network blip) makes it exit with code 1. Last.fm sync, detection, and the account-deletion evidence cleanup then stop with no alert. Before enabling any Last.fm flag, do one or both of these:
   - Run the worker under a process manager that restarts it.
   - Add a try/catch with backoff around each pass.
2. **Account deletion depends on the worker.** The Clerk `user.deleted` webhook deletes the account's social data in one transaction. For Last.fm, it only marks connections disconnected and queues a `cleanup` job. The connection document, which holds the Last.fm username, stays until the worker processes that job. TTLs remove scrobbles after about 30 days and detections after about 60, but the connection document is never removed without the worker. Either the worker is a required part of the deploy, or the webhook must delete the connection rows itself.
3. **Configure the webhook deliberately.** `/webhooks/clerk/listening` is mounted without a feature flag and performs full account deletion (see [the Last.fm sync guide](LASTFM_SYNC.md#account-and-privacy-contracts)). Set `CLERK_WEBHOOK_SIGNING_SECRET` and point the Clerk destination at this route, knowing it removes the whole account and not just Last.fm data. If the secret is not set, every delivery returns 400.
4. **Production must be a replica set.** Several existing features now need transactions or snapshot reads, and fail with 503 on a standalone MongoDB:
   - Saving to a board, removing from a board, deleting a board, and pinning a board on a profile (`BOARD_WRITE_UNAVAILABLE`).
   - Popular-sorted review pages (`POPULAR_REVIEWS_UNAVAILABLE`).
   - Account deletion (`CLEANUP_UNAVAILABLE`).

   A popular-review cursor expires after `minSnapshotHistoryWindowInSeconds` (300 s by default) and returns `400 INVALID_REVIEW_CURSOR`. The frontend has no special handling for this, so the user sees the server's reload message.
5. **"People to follow" scans every review.** `GET /profile/suggestions` (`routes/utils/peopleSuggestions.js`) groups the entire `reviews` collection on every Community page view. The endpoint needs no login and has no rate limit, cache, or `maxTimeMS`. Recommended fix: only rank reviews newer than a cutoff date, cache the ranked list for a few minutes, and add `searchRateLimit`.

## Performance follow-ups

These can wait until after launch. The cost of each grows with data.

| Area | Issue | Suggested fix |
|---|---|---|
| `GET /boards`, album save (`routes/utils/boardLibrary.js`) | Loads every album on every board with populate, plus a BoardListen aggregation, where it used to load 4 previews and a count | Separate summary query; save returns only the saved item |
| `/reviews/circle/popular-reviews` | No date window: every review by the circle gets catalog and likes `$lookup`s before the top 3 are picked | 30–90 day window; catalog `$lookup` after `$limit` |
| Album detail saved count | A BoardListen aggregation with two `$lookup`s on every album view, where it used to be one `distinct` | Cache it or keep a counter |
| Catalog search (`routes/utils/catalogSearch.js`) | Ranks every regex match; no `maxTimeMS`; no cap on the query length | `maxTimeMS`; cap `q` at about 200 characters |
| Listening worker | Schedules scans every 5 s when idle; the stale-mapping pass runs even with every flag off | Slower timer for the schedule passes; gate on the flags |
| Last.fm owner reads | Baseline lookups run one album at a time (up to 50 round trips) | Batch them or use `Promise.all` |
| `listeningjobs` | Finished jobs are never removed | Decide on retention; jobs are keyed and reopened, so a TTL needs care |
| Account deletion | One transaction; a very heavy account could reach the 60 s transaction limit even with the new indexes | Batch deletes of user-owned rows if this happens |
| Frontend bundle | Main chunk is 508.6 kB (137 kB gzip), over Vite's 500 kB warning. `AlbumMappings` (moderator-only) and `Community` load eagerly. | `lazy()` them like `AlbumBaselines` |
| `LastfmConnectionPanel` | Re-fetches matches after every settings save because the effect depends on the `connection` object | Depend on `connection?.state` |

Smaller correctness items:

- **Board error code:** board routes reject unknown body fields with the code `INVALID_DIARY_REQUEST`.
- **Reviewer length:** `enrichAlbumTracklists` accepts a reviewer name up to 200 characters, but the apply step rejects anything over 128.
- **Try again:** the button on `AlbumMappings` does not reload the case.
- **Board saved state:** adding a listen to a board marks that board "Saved" in `AlbumDetail` until the page is reloaded.

## Checked and fine

- **Flags off by default:** every Last.fm, listening, and tracklist feature flag defaults off (`=== "true"`). The worker is a separate process and never starts inside the API.
- **No secrets committed:** no secrets or `.env` files are in the diff. The frontend uses only `VITE_API_URL` and `VITE_CLERK_PUBLISHABLE_KEY`.
- **Last.fm OAuth:** the state is 32 random bytes, stored hashed, bound to the Clerk user, single-use, and expires after 10 minutes. The Last.fm session key is discarded and never stored.
- **Authorization:** every new mutation authenticates with Clerk on the server, checks the pilot allowlist, flags, and moderator membership, and has a rate limit.
- **Transactions:** publication, moderation, cleanup, and seed apply are transactional and return 503 when transactions are unavailable, with no standalone fallback.
- **Provider adapters** (Last.fm and MusicBrainz):
  - Timeouts and bounded retries.
  - `Retry-After` handling, request gates, and response size caps.
  - Identifying user agents.
- **Public IDs:** no Mongo `_id` or provider ID is exposed as a public identifier. Pagination cursors are encrypted.
- **Frontend safety:** no `dangerouslySetInnerHTML`, and the Last.fm callback has no open redirect.
- **Benchmarks:** `benchmarks/` refuses anything but a loopback `rescened_bench_*` database.

## Verification

Run on 2026-09-30 after the fixes above:

| Check | Result |
|---|---|
| `npm test` | 424 passed, 80 skipped, 0 failed |
| `npm run test:integration` | 128 passed, 0 failed (temporary replica sets) |
| `npm --prefix frontend run lint` | Clean |
| `npm --prefix frontend run build` | Succeeds, with the existing warning that a chunk is over 500 kB |

The checks do not cover index builds against production data, live Last.fm authorization, real webhook delivery, or worker hosting. Those are operator checks for the target environment.
