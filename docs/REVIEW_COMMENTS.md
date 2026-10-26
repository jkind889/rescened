# Review comments and replies

Signed-in users can comment on any review and reply to comments. Threads are two levels deep: a top-level comment and its replies. A reply to a reply joins the same thread and names whom it answers. The thread lives on the review page (`/review/:reviewId#comments`), and review cards show a comment count that links there.

The logic lives in `lib/reviewComments/`: `common.js` (flag, parsing, cursors, transactions), `read.js` (threads and counts), `commands.js` (create, edit, delete, report), `moderation.js` (report queue and commands), and `cascade.js` (cleanup inside review and account deletion). Routes are `routes/reviewComments.js` (mounted at `/reviews`) and `routes/commentModeration.js` (mounted at `/moderation/comment-reports`).

## Flags and access

| Setting | Effect |
| --- | --- |
| `REVIEW_COMMENTS_ENABLED=true` | Enables create, edit, delete, and report. Default off. With it off, threads stay readable and every write returns `503 COMMENTS_DISABLED`; the page hides the composer and actions, and shows nothing when a review has no comments. |
| `COMMUNITY_MODERATION_ENABLED=true` and `MODERATOR_USER_IDS` | Required for the remove and dismiss commands, like every moderator route. The report queue is readable by moderators with the flag off. |

- Threads follow review visibility: reviews are public, so threads are too. A review whose album no longer resolves is hidden, and so is its thread.
- Only a comment's author can edit or delete it. Review authors cannot delete other people's comments on their review; they report them, and moderators decide.
- Users with private profiles can comment, and their name shows on their comments. The composer says so.
- Authorization is enforced on the server. The page only hides controls.

## Storage

```text
ReviewComment          commentId (public UUID), reviewId → Review, parentCommentId → ReviewComment | null,
                       replyToUserId, userId, body, status, createdAt, editedAt,
                       creationKey (private), interactionRevision (private)
CommentReport          reportId (public UUID), commentId → ReviewComment, reporterUserId,
                       reason, note, status (open | dismissed | actioned), createdAt, resolvedAt
CommentModerationEvent commentId, actorUserId, action (removed | restored | dismissed_reports),
                       reason, reportCount, createdAt — append-only
```

- `status` is `visible`, `deleted_by_author`, or `removed_by_moderator`. Author deletion clears `body`; a moderator removal keeps it for the audit trail. Neither is ever returned.
- `restored` is reserved. There is no restore command yet.
- Comment counts are computed per page with one `$group` over the page's reviews, like like counts. Nothing is stored on `Review`.
- Indexes: threads read `{ reviewId, parentCommentId, createdAt, commentId }`; account deletion and duplicate checks use `{ userId, createdAt }`; the queue reads open reports through a partial `{ status, createdAt }` index; reports are unique per `(commentId, reporterUserId)`. All are new collections, so they build empty.

## Text

Bodies are plain text, 1 to 500 characters after normalization. Line endings become `\n`, control characters, zero-width spaces, and bidirectional overrides are dropped (zero-width joiners are kept for emoji and scripts that need them), runs of spaces become one, each line is trimmed, and runs of blank lines collapse to one. The page renders text as text and links only `https` URLs, with `rel="nofollow ugc noopener noreferrer"`.

## Endpoints

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| `GET` | `/reviews/review/:reviewId/comments?cursor=` | Optional | 20 top-level comments, oldest first. Each has its first 3 replies, `replyCount`, and `repliesCursor` when more remain. The response adds `commentCount`, `commentsEnabled`, and, when signed in, `viewer: { profileIsPrivate }`. |
| `GET` | `/reviews/review/:reviewId/comments/:commentId/replies?cursor=` | Optional | The next 20 replies of one top-level comment. |
| `POST` | `/reviews/review/:reviewId/comments` | Required | `{ body, parentCommentId? }` plus an `Idempotency-Key` UUID header. Returns `201` with the comment, or `200` with the existing one for a retried key or a duplicate. |
| `PATCH` | `/reviews/comments/:commentId` | Author | `{ body }`. Sets `editedAt`. Only while visible. |
| `DELETE` | `/reviews/comments/:commentId` | Author | Returns `{ commentId, status }`: `deleted_by_author` when it left a tombstone, `deleted` when it was removed outright. |
| `POST` | `/reviews/comments/:commentId/report` | Required | `{ reason, note? }`, where `reason` is `spam`, `harassment`, `off_topic`, or `other` and `note` is up to 300 characters. `201` for a new report, `200` for a repeat. Not allowed on your own comment. |
| `GET` | `/moderation/comment-reports?limit=` | Moderator | `{ items, total }`: visible comments with open reports, most reported first, then oldest report. Up to 50 items, each with the comment, review, album, reason counts, and up to 20 reports. |
| `POST` | `/moderation/comment-reports/:commentId/remove` | Moderator | `{ reason }`. Hides the comment, closes its open reports as `actioned`, deletes its notifications, and appends a `removed` event. |
| `POST` | `/moderation/comment-reports/:commentId/dismiss` | Moderator | `{ reason }`. Closes open reports as `dismissed` and appends a `dismissed_reports` event. |

- Bodies are strict: unknown or client-owned fields such as `commentId`, `userId`, and `status` return `400 INVALID_COMMENT_REQUEST`. IDs and cursors are public `commentId` values; Mongo IDs never appear.
- A visible comment serializes as `{ commentId, parentCommentId?, status, body, author, replyTo, createdAt, editedAt }`, where `replyTo` is `{ userId, username }` or `null`. A tombstone serializes as `{ commentId, status, createdAt, replyCount }` (plus its replies) with no body and no author.
- A top-level tombstone with no visible replies is hidden. Pages keep reading past hidden rows (up to five reads) so they are not cut short.
- The queue has no cursor: handled items leave it, so the next ones surface.
- Errors and limits are in [the error code reference](ERROR_CODES.md#review-comments). Create is limited to 20 per 10 minutes per user, edit and delete share 60 per 10 minutes, and reports get 10 per 10 minutes. Moderator commands use the moderation-mutation limit.

## Transactions and lifecycle

Every write except an edit runs in a transaction. Standalone MongoDB returns `503 COMMENT_WRITE_UNAVAILABLE` with nothing written; there is no fallback.

- **Create** claims the review's `interactionRevision` (so a concurrent review deletion conflicts), claims the visible comment being answered and its thread, checks for a duplicate, inserts the comment, and writes its notifications. A deleted review returns `404 REVIEW_NOT_FOUND`; a parent that is gone, not visible, or on another review returns `404 COMMENT_NOT_FOUND`.
- **Idempotency and duplicates.** A retried `Idempotency-Key` returns the first comment. The same author posting the same normalized text in the same place (same review and parent) within 10 minutes also gets the existing comment, with no new notification.
- **Edit** is one conditional write that claims the comment's revision only while it is visible, so an edit that loses to a moderator removal returns `409 COMMENT_STATE_CONFLICT`.
- **Delete.** A top-level comment with replies becomes a tombstone; anything else is deleted with its reports, events, and notifications. When a reply is deleted and its thread's author-deleted tombstone has no replies left, the tombstone goes too. A moderator-removed comment stays for the audit trail, hidden while it has no visible replies.
- **Review deletion** removes the review's comments, reports, moderation events, and comment notifications inside `deleteOwnedReview`'s transaction.
- **Account deletion** (`removeAccountData`) deletes the user's replies, turns their top-level comments that others replied to into anonymous tombstones with no text, deletes the rest, removes reports they filed, and clears `replyToUserId` on replies that named them. Unlike reviews, comment text is never kept under an anonymous author.

## Notifications

Comment notifications use the types and mute settings from [the notifications guide](NOTIFICATIONS.md): `review_comment` goes to the review's author for a top-level comment, and `comment_reply` goes to the thread's top-level author and to the author of the reply being answered. Nobody is notified about their own comment. Deleting or removing a comment deletes its notifications in the same transaction.

## Frontend

- `frontend/src/features/comments/ReviewComments.jsx` renders the thread on `ReviewPermalink`: replies indented once, "Show N more replies", inline reply and edit composers, Delete for authors, and Report with a reason form for everyone else. Links to `#comment-<commentId>` scroll to that comment, or to the thread when it is not loaded.
- Composers keep a local draft per review and per thread (`rescened:comment-draft:v1:`), and reuse their `Idempotency-Key` while the text is unchanged, so a retry after a lost response cannot post twice. Comments posted on the page stay last while older pages load in.
- `CommentCountLink` shows the count next to the like button on album, profile, activity, own-review, and dispatch cards; the home and community dispatch lists show it as text.
- `/moderation/comment-reports` (`Pages/CommentReports.jsx`) is the moderator queue, linked from the suggestion queue. Both actions require a reason, and Remove asks for confirmation because there is no restore yet.

## Rollout

1. Deploy with `REVIEW_COMMENTS_ENABLED` unset. Threads read empty and the composer is hidden.
2. Enable it on dev and check the review page, the notification rows, and the moderator queue.
3. Enable it in production once a moderator is watching the queue. Production (Atlas) already supports transactions.

## Tests

- Unit: `tests/reviewComments.test.js` covers normalization, strict fields, cursors, tombstone serialization, and the route permission, flag, and rate-limit order. `tests/reviewCommentsClient.test.js` covers the page's thread helpers and link parsing. `tests/reviewPublicIdContract.test.js` covers comment notification IDs.
- Integration: `tests/reviewComments.integration.test.js` covers notifications, idempotent and concurrent creates, concurrent review deletion, tombstones and cleanup, account deletion, an edit racing a removal, the report queue and commands, thread paging past hidden comments, and `429` with `Retry-After`.
