# Notifications

Signed-in users get notifications when someone likes their review, follows them, reviews an album on one of their boards, or when a moderator decides on their suggestion. Each user can mute every type except suggestion updates. The logic lives in `routes/utils/notifications.js`; the routes are `routes/notifications.js` and the preference routes in `routes/profile.js`.

## Types

| Type | Recipient | Trigger | Actor | Dedup key |
| --- | --- | --- | --- | --- |
| `review_like` | The review's author | Someone likes their review. Written inside the like transaction. | The liker | `(recipient, actor, review)` |
| `follow` | The followed user | Someone follows them. An idempotent upsert after the follow write. | The follower | `(recipient, actor)` |
| `suggestion_status` | The contributor | A moderator requests changes, rejects, marks duplicate, or approves their suggestion (new album, correction, or genre suggestion). | `rescened:moderation`, never the moderator | `(recipient, submission, revision, status)` |
| `followed_review` | Each follower of the reviewer who has the album on one of their boards | A new review is created. | The reviewer | `(recipient, review)` |

Each key is a partial unique index on `Notification`, so a retried write inserts nothing. No one is notified about their own action; a moderator acting on their own suggestion is not notified either.

### Suggestion updates

`suggestion_status` rows are inserted in the same transaction as the status change and its audit event. Approval already ran in a transaction. Request changes, reject, and mark duplicate now do too (`applyModerationCommand` in `routes/utils/moderationCommands.js`), and return `503 MODERATION_UNAVAILABLE` on standalone MongoDB instead of writing without the notification. See the [moderator guide](MODERATOR_IMPLEMENTATION_GUIDE.md).

The key includes the moderated revision, so approving twice or concurrently writes one row, while a decision on a later revision of the same suggestion notifies again. Notifications name the fixed actor `rescened:moderation`, which the page shows as "Rescened moderators". A moderator's account deletion never matches it, so contributors keep their notifications. The suggestion's detail page keeps the full history; the notification only points to it.

### Followed reviews

After `POST /reviews/review` creates a review, the API fans out to the reviewer's followers, most recent follow first (`Follow.createdAt`). A follower is a recipient when the album is on one of their boards through an explicit save (`BoardItem`) or a live listen membership (`BoardListen`, validated with `liveMembershipStages`), and they have not muted the type.

- **Best effort.** Review creation is not transactional, so a failed fan-out is logged and never fails the review. A retry with the same `Idempotency-Key` returns the existing review and re-runs the upserts, which insert nothing new.
- **Cap.** At most 500 recipients per review. Past the cap, the API logs `[notifications] followed_review fan-out hit its cap` with the public `reviewId`, the cap, and the number skipped. If that warning fires in practice, move the fan-out to the listening worker service rather than raising the cap.
- **Privacy.** Private reviewers are not excluded, because reviews are already public. Recipients only learn about albums on their own boards.

## Preferences

`UserProfile.notificationPreferences` holds one boolean per mutable type: `review_like`, `follow`, and `followed_review`. Missing values read as on, so existing profiles need no migration.

| Method | Path | Body | Behavior |
| --- | --- | --- | --- |
| `GET` | `/profile/me/notification-preferences` | — | `{ preferences, locked }`. `preferences` lists every type; `locked` is `["suggestion_status"]`. |
| `PATCH` | `/profile/me/notification-preferences` | A partial object of booleans, such as `{ "follow": false }` | Updates the listed types and returns the same shape. Creates the profile if it does not exist. |

Unknown keys, non-boolean values, and an empty body return `400 INVALID_NOTIFICATION_PREFERENCES`. Turning `suggestion_status` off returns `400 NOTIFICATION_PREFERENCE_LOCKED`; sending it as `true` is accepted and changes nothing.

Preferences are checked **on write**: a muted type never creates rows, so the unread count stays exact. Rows created before muting stay until the user clears them.

## Reading and read state

| Method | Path | Body | Behavior |
| --- | --- | --- | --- |
| `GET` | `/notifications/unread-count` | — | `{ unreadCount }` |
| `GET` | `/notifications?cursor=&markRead=false` | — | The newest 30, then older pages by `nextCursor`. |
| `POST` | `/notifications/read` | `{ notificationIds }` or `{ all: true }` | Marks the caller's matching unread rows read. Returns `{ updated, unreadCount }`. |
| `POST` | `/notifications/clear` | `{ notificationIds }` or `{ all: true }` | Deletes the caller's matching rows. Returns `{ cleared, unreadCount }`. |

- `notificationIds` lists 1 to 100 public UUIDs. Anything else, including both keys at once, returns `400 INVALID_NOTIFICATION_REQUEST`. Rows that belong to someone else are never matched.
- Pages are ordered by `(createdAt, notificationId)`, newest first, so equal timestamps never repeat or skip a row. A malformed cursor returns `400 INVALID_NOTIFICATION_CURSOR`.
- `POST /read` and `POST /clear` share the `notificationMutation` rate limit (60 per 10 minutes per user), applied after authentication. The `PATCH` preference route uses it too.

**Transitional read behavior.** `GET` no longer changes state when the client sends `markRead=false`, which the current Notifications page always does. A first-page `GET` without it still marks that page read, for clients built before `POST /read` existed. Remove that branch once no older client remains.

### Response shape

```json
{
  "notifications": [{
    "notificationId": "…",
    "type": "followed_review",
    "actor": { "userId": "user_…", "username": "…", "imageUrl": "…" },
    "actorUserId": "user_…",
    "subject": { "review": { "reviewId": "…", "rating": 4 }, "album": { "albumId": "…", "title": "…" } },
    "readAt": null,
    "createdAt": "2026-10-23T12:00:00.000Z"
  }],
  "nextCursor": "…"
}
```

`subject` depends on the type, and is how a client renders a type it does not know:

| Type | `subject` |
| --- | --- |
| `review_like`, `followed_review` | `{ review: { reviewId, rating }, album }`, or `null` if the review is gone |
| `suggestion_status` | `{ submissionId, submissionType, status, title, albumId? }` |
| `follow` | `null` |

For `suggestion_status`, `actor` is `{ userId: null, username: "Rescened moderators", imageUrl: "", isSystem: true }` and `actorUserId` is `null`. Responses carry public IDs only. The older `reviewId`, `albumId`, and `review` fields are still sent for older clients.

## Cleanup

- **Review deletion** removes the review's `review_like` and `followed_review` rows inside its deletion transaction. A fan-out that finishes after its review was deleted removes the rows it wrote.
- **Account deletion** removes every row the user sent or received. The moderation actor is never a real account, so it is never matched.
- A suggestion submitted by an account that was later deleted keeps its `submittedByUserId`, so a later decision can still write a row for that ID. Nothing reads those rows.

## Rollout

- New indexes build on the API's first start: on `notifications`, the two new partial unique indexes, `{ recipientUserId, createdAt, notificationId }` for paging, and `{ reviewId, type }` for cleanup; on `follows`, `{ followingId, createdAt, _id }`. The unique indexes cover only the new types, which have no rows yet, so they cannot fail on existing data.
- Moderation commands now need a transaction-capable deployment. Production (Atlas) already is one, because approval requires it.
- There is no feature flag: the new types start with the deploy. Older frontends keep working and show the new types with generic copy.

## Tests

- Unit: `tests/notifications.test.js` covers preference and selection validation, cursors, recipient selection, and route rejections. `tests/moderation.test.js` covers transition notifications and the `503`.
- Integration: `tests/notifications.integration.test.js` covers muting on write, rollback of a failed transition, one notification across retried and concurrent approvals, fan-out eligibility, the cap and its log, deletion cleanup, and paging.
