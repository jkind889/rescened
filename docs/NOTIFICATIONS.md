# Notifications

Signed-in users get notifications when someone likes their review, follows them, reviews an album on one of their boards, comments on their review or replies to their comment, or when a moderator decides on their suggestion. Each user can mute every type except suggestion updates. The logic lives in `routes/utils/notifications.js`; the routes are `routes/notifications.js` and the preference routes in `routes/profile.js`.

## Types

| Type | Recipient | Trigger | Actor | Dedup key |
| --- | --- | --- | --- | --- |
| `review_like` | The review's author | Someone likes their review. Written inside the like transaction. | The liker | `(recipient, actor, review)` |
| `follow` | The followed user | Someone follows them. An idempotent upsert after the follow write. | The follower | `(recipient, actor)` |
| `suggestion_status` | The contributor | A moderator requests changes, rejects, marks duplicate, or approves their suggestion (new album, correction, or genre suggestion). | `rescened:moderation`, never the moderator | `(recipient, submission, revision, status)` |
| `followed_review` | Each follower of the reviewer who has the album on one of their boards | A new review is created. | The reviewer | `(recipient, review)` |
| `review_comment` | The review's author | Someone posts a top-level comment on their review. Written inside the comment creation transaction. | The commenter | `(recipient, comment, type)` |
| `comment_reply` | The thread's top-level author, and the author of the reply being answered | Someone replies in their thread or answers their reply. Same transaction. | The replier | `(recipient, comment, type)` |

Each key is a partial unique index on `Notification`. Followed-review delivery also records a private receipt on the review, so clearing notifications cannot make a creation retry deliver again. No one is notified about their own action; a moderator acting on their own suggestion is not notified either. A thread whose top-level comment was deleted or removed no longer notifies that author. See [review comments](REVIEW_COMMENTS.md).

### Suggestion updates

`suggestion_status` rows are inserted in the same transaction as the status change and its audit event. Approval already ran in a transaction. Request changes, reject, and mark duplicate now do too (`applyModerationCommand` in `routes/utils/moderationCommands.js`), and return `503 MODERATION_UNAVAILABLE` on standalone MongoDB instead of writing without the notification. Bulk approval runs each item through the same approval, so each approved item gets its own notification and a failed item gets none. See the [moderator guide](MODERATOR_IMPLEMENTATION_GUIDE.md).

The key includes the moderated revision, so approving twice or concurrently writes one row, while a decision on a later revision of the same suggestion notifies again. Non-approval commands retain their first observed revision across transaction retries; if a contributor revises the suggestion meanwhile, the stale command returns `409 STATE_CONFLICT`. Notifications name the fixed actor `rescened:moderation`, which the page shows as "Rescened moderators". A moderator's account deletion never matches it, so contributors keep their notifications. The suggestion's detail page keeps the full history; the notification only points to it.

### Followed reviews

After `POST /reviews/review` creates a review, the API fans out to the reviewer's followers, most recent follow first (`Follow.createdAt`). A follower is a recipient when the album is on one of their boards through an explicit save (`BoardItem`) or a live listen membership (`BoardListen`, validated with `liveMembershipStages`), and they have not muted the type.

- **Best effort, atomic delivery.** Review creation remains independent of delivery. Fan-out claims the review’s `interactionRevision` and writes its notifications plus a private `followedReviewFanoutAt` receipt in one transaction. A failed delivery rolls back both notifications and receipt, is logged, and never fails review creation. Retrying the same `Idempotency-Key` retries only an uncommitted delivery. A completed delivery, including one with no eligible recipients, is never replayed after clearing, new follows, board changes, or preference changes. No migration is required; missing receipts mean delivery has not completed. Standalone MongoDB cannot deliver followed-review notifications and logs the failure while still accepting the review.
- **Bounds.** At most 500 recipients per review, selected from at most the 5,000 most recent follow edges. One extra edge is read only to detect truncation. Eligible recipients beyond the write cap within that scan are counted as skipped; this is not a count of all older eligible followers. Hitting the write cap logs `[notifications] followed_review fan-out hit its cap`; truncating the scan logs `[notifications] followed_review follower scan hit its limit`. Both include the public `reviewId`. Followers beyond the scan limit receive no notification for that review. These fixed bounds limit synchronous eligibility work; move delivery to a worker if either warning occurs regularly.
- **Privacy.** Private reviewers are not excluded, because reviews are already public. Recipients only learn about albums on their own boards.

## Preferences

`UserProfile.notificationPreferences` holds one boolean per mutable type: `review_like`, `follow`, `followed_review`, `review_comment`, and `comment_reply`. Missing values read as on, so existing profiles need no migration.

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
| `review_comment`, `comment_reply` | `{ review: { reviewId, rating }, album, comment: { commentId, excerpt } }`, or `null` if the review or comment is gone. `excerpt` is up to 140 characters and empty once the comment is no longer visible. The page links to `/review/:reviewId#comment-:commentId`. |
| `suggestion_status` | `{ submissionId, submissionType, status, title, albumId? }` |
| `follow` | `null` |

For `suggestion_status`, `actor` is `{ userId: null, username: "Rescened moderators", imageUrl: "", isSystem: true }` and `actorUserId` is `null`. Responses carry public IDs only. The older `reviewId`, `albumId`, and `review` fields are still sent for older clients.

The Notifications page invalidates pending page loads when clearing or changing its authenticated view. A late page response cannot restore cleared rows or a stale cursor. Load more is disabled during mutations; Mark all read is disabled while another page is loading. A failed clear preserves the existing rows and permits a new load attempt.

## Cleanup

- **Comment deletion and moderator removal** delete that comment's notifications in the same transaction. Review deletion removes them with the review's comments.
- **Review deletion** removes the review's `review_like` and `followed_review` rows inside its deletion transaction. Fan-out and deletion both claim the same review document. A losing fan-out observes the deletion on retry and writes nothing; a losing deletion retries its cleanup after delivery commits.
- **Account deletion** removes every row the user sent or received. Reviewer anonymization and fan-out claim the same review document, so concurrent delivery cannot recreate the deleted author’s identity. The moderation actor is never a real account, so it is never matched.
- A suggestion submitted by an account that was later deleted keeps its `submittedByUserId`, so a later decision can still write a row for that ID. Nothing reads those rows.

## Rollout

- New indexes build on the API's first start: on `notifications`, the two new partial unique indexes, `{ recipientUserId, createdAt, notificationId }` for paging, and `{ reviewId, type }` for cleanup; on `follows`, `{ followingId, createdAt, _id }`. The unique indexes cover only the new types, which have no rows yet, so they cannot fail on existing data.
- Moderation commands now need a transaction-capable deployment. Production (Atlas) already is one, because approval requires it.
- There is no feature flag: the new types start with the deploy. Older frontends keep working and show the new types with generic copy.

## Tests

- Unit: `tests/notifications.test.js` covers preference and selection validation, cursors, recipient selection, and route rejections. `tests/moderation.test.js` covers transition notifications and the `503`.
- Integration: `tests/notifications.integration.test.js` covers muting, moderation rollback and stale-revision retries, concurrent approvals, atomic delivery/receipt rollback, clearing and recipient stability across retries, bounded scanning, overlapping review/account deletion, and paging.
- UI handlers: `tests/notificationPage.test.js` exercises delayed success/error responses after clearing and recovery after a failed clear. Rendered-browser verification remains a separate QA step.
