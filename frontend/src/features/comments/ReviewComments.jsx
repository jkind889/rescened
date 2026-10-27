import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { SignInButton, useAuth } from "@clerk/react";
import { clearDraft, readDraft, useDraftAutosave } from "../community/drafts";
import {
  MAX_COMMENT_LENGTH,
  REPORT_REASONS,
  addComment,
  appendReplies,
  appendThreadPage,
  commentDraftKey,
  deleteComment,
  editComment,
  fetchReplies,
  fetchThread,
  includeFocusedThread,
  linkSegments,
  hasReplyContent,
  postComment,
  removeComment,
  reportComment,
  updateComment,
} from "./comments";
import "./comments.css";

const TOMBSTONE_COPY = {
  deleted_by_author: "Deleted comment",
  removed_by_moderator: "Removed by a moderator",
};

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function CommentText({ comment }) {
  return (
    <p className="review-comment-body">
      {comment.replyTo && <span className="review-comment-mention">@{comment.replyTo.username} </span>}
      {linkSegments(comment.body).map((segment, index) => (segment.type === "link"
        ? <a key={index} href={segment.href} target="_blank" rel="nofollow ugc noopener noreferrer">{segment.value}</a>
        : <span key={index}>{segment.value}</span>))}
    </p>
  );
}

// Text entry shared by new comments, replies, and edits. A draft key keeps
// unsent text in this browser; the idempotency key is reused while the text
// is unchanged, so retrying after a lost response cannot post twice.
function Composer({ draftKey = "", initialText = "", placeholder, submitLabel, pendingLabel = "Posting...", onSubmit, onCancel, autoFocus = false, note = "" }) {
  const [text, setText] = useState(() => readDraft(draftKey)?.value?.text ?? initialText);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef({ text: null, key: "" });
  const trimmed = text.trim();
  useDraftAutosave(draftKey, { text }, trimmed === initialText.trim());

  async function submit(event) {
    event.preventDefault();
    if (!trimmed || isSaving) return;
    if (attempt.current.text !== trimmed) attempt.current = { text: trimmed, key: crypto.randomUUID() };
    setIsSaving(true);
    setError("");
    try {
      await onSubmit(trimmed, attempt.current.key);
      clearDraft(draftKey);
      attempt.current = { text: null, key: "" };
      setText("");
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className="review-comment-composer" onSubmit={submit}>
      <textarea
        aria-label={placeholder}
        placeholder={placeholder}
        rows={3}
        maxLength={MAX_COMMENT_LENGTH}
        value={text}
        autoFocus={autoFocus}
        onChange={(event) => setText(event.target.value)}
      />
      {note && <p className="review-comment-note">{note}</p>}
      {error && <p className="review-comment-error" role="alert">{error}</p>}
      <div className="review-comment-composer-actions">
        {text.length > MAX_COMMENT_LENGTH - 50 && <span className="review-comment-count">{text.length}/{MAX_COMMENT_LENGTH}</span>}
        {onCancel && <button className="review-comment-link" type="button" onClick={onCancel} disabled={isSaving}>Cancel</button>}
        <button className="review-comment-submit" type="submit" disabled={!trimmed || isSaving}>{isSaving ? pendingLabel : submitLabel}</button>
      </div>
    </form>
  );
}

function ReportForm({ onSubmit, onCancel }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    try {
      await onSubmit({ reason, note: note.trim() });
    } catch (reportError) {
      setError(reportError.message);
      setIsSaving(false);
    }
  }

  return (
    <form className="review-comment-report" onSubmit={submit}>
      <fieldset>
        <legend>Report this comment</legend>
        {REPORT_REASONS.map((option) => (
          <label key={option.value}>
            <input type="radio" name="reason" value={option.value} checked={reason === option.value} onChange={() => setReason(option.value)} />
            {option.label}
          </label>
        ))}
      </fieldset>
      <textarea aria-label="Details for moderators" placeholder="Details for moderators" rows={2} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} />
      {error && <p className="review-comment-error" role="alert">{error}</p>}
      <div className="review-comment-composer-actions">
        <button className="review-comment-link" type="button" onClick={onCancel} disabled={isSaving}>Cancel</button>
        <button className="review-comment-submit" type="submit" disabled={!reason || isSaving}>{isSaving ? "Sending..." : "Report"}</button>
      </div>
    </form>
  );
}

function Avatar({ author }) {
  const name = author?.username || "";
  return author?.imageUrl
    ? <img className="review-comment-avatar" src={author.imageUrl} alt="" loading="lazy" decoding="async" />
    : <span className="review-comment-avatar" aria-hidden="true">{(name.trim()[0] || "?").toUpperCase()}</span>;
}

function CommentItem({ comment, viewerId, canInteract, onReply, onEdit, onDelete, onReport }) {
  const [mode, setMode] = useState("");
  const [message, setMessage] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [reported, setReported] = useState(false);

  if (comment.status !== "visible") {
    return (
      <div className="review-comment review-comment-tombstone" id={`comment-${comment.commentId}`}>
        <p>{TOMBSTONE_COPY[comment.status] || "Unavailable comment"}</p>
      </div>
    );
  }

  const author = comment.author || {};
  const isOwn = Boolean(viewerId) && author.userId === viewerId;

  async function remove() {
    if (!window.confirm("Delete this comment?")) return;
    setIsDeleting(true);
    setMessage("");
    try {
      await onDelete(comment);
    } catch (deleteError) {
      setMessage(deleteError.message);
      setIsDeleting(false);
    }
  }

  return (
    <article className="review-comment" id={`comment-${comment.commentId}`}>
      <Avatar author={author} />
      <div className="review-comment-main">
        <p className="review-comment-meta">
          {author.userId ? <Link to={`/profile/${encodeURIComponent(author.userId)}`}>{author.username}</Link> : <span>{author.username}</span>}
          <time dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time>
          {comment.editedAt && <span title={`Edited ${formatDate(comment.editedAt)}`}>edited</span>}
        </p>
        {mode === "edit" ? (
          <Composer
            initialText={comment.body}
            placeholder="Edit your comment"
            submitLabel="Save"
            pendingLabel="Saving..."
            autoFocus
            onCancel={() => setMode("")}
            onSubmit={async (body) => { await onEdit(comment, body); setMode(""); }}
          />
        ) : (
          <CommentText comment={comment} />
        )}
        {canInteract && mode !== "edit" && (
          <div className="review-comment-actions">
            <button className="review-comment-link" type="button" onClick={() => onReply(comment)}>Reply</button>
            {isOwn && <button className="review-comment-link" type="button" onClick={() => setMode("edit")}>Edit</button>}
            {isOwn && <button className="review-comment-link" type="button" onClick={remove} disabled={isDeleting}>{isDeleting ? "Deleting..." : "Delete"}</button>}
            {!isOwn && !reported && mode !== "report" && <button className="review-comment-link" type="button" onClick={() => { setMode("report"); setMessage(""); }}>Report</button>}
          </div>
        )}
        {mode === "report" && (
          <ReportForm
            onCancel={() => setMode("")}
            onSubmit={async (report) => { await onReport(comment, report); setMode(""); setReported(true); setMessage("Thanks. A moderator will take a look."); }}
          />
        )}
        {message && <p className="review-comment-status" role="status">{message}</p>}
      </div>
    </article>
  );
}

export function ReviewComments({ reviewId }) {
  const { getToken, isSignedIn, userId } = useAuth();
  const { hash } = useLocation();
  const [thread, setThread] = useState(null);
  const [error, setError] = useState("");
  const [pageError, setPageError] = useState("");
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadingReplies, setLoadingReplies] = useState("");
  const [replying, setReplying] = useState(null);
  const scrolledTo = useRef("");
  const focus = /^#comment-([0-9a-f-]{36})$/i.exec(hash)?.[1] || "";

  useEffect(() => {
    const controller = new AbortController();
    setThread(null);
    setError("");
    scrolledTo.current = "";
    (async () => {
      try {
        const token = isSignedIn ? await getToken() : null;
        const data = await fetchThread(reviewId, { token, focus, signal: controller.signal });
        if (!controller.signal.aborted) setThread({ ...includeFocusedThread(data), loadedFocus: focus });
      } catch (loadError) {
        if (!controller.signal.aborted) setError(loadError.message);
      }
    })();
    return () => controller.abort();
  }, [getToken, isSignedIn, reviewId, focus]);

  // Notification and card links point at #comments or one #comment-<id>.
  useEffect(() => {
    if (!thread || thread.loadedFocus !== focus || !hash.startsWith("#comment") || scrolledTo.current === hash) return;
    scrolledTo.current = hash;
    const target = document.getElementById(hash.slice(1)) || document.getElementById("comments");
    target?.scrollIntoView({ block: "start" });
  }, [hash, thread, focus]);

  if (error) return <section className="review-comments" id="comments"><p className="review-comment-error" role="alert">{error}</p></section>;
  if (!thread) return <section className="review-comments" id="comments" aria-busy="true" />;
  if (!thread.commentsEnabled && !thread.comments.length) return null;

  const canInteract = Boolean(isSignedIn && thread.commentsEnabled);
  const privateNote = thread.viewer?.profileIsPrivate ? "Your profile is private, but comments show your name to everyone." : "";

  async function withToken(run) {
    return run(await getToken());
  }

  async function loadMore() {
    setIsLoadingMore(true);
    setPageError("");
    try {
      const page = await fetchThread(reviewId, { token: await getToken(), cursor: thread.nextCursor });
      setThread((current) => appendThreadPage(current, page));
    } catch (loadError) {
      setPageError(loadError.message);
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function loadReplies(comment) {
    setLoadingReplies(comment.commentId);
    setPageError("");
    try {
      const page = await fetchReplies(reviewId, comment.commentId, comment.repliesCursor);
      setThread((current) => appendReplies(current, comment.commentId, page));
    } catch (loadError) {
      setPageError(loadError.message);
    } finally {
      setLoadingReplies("");
    }
  }

  async function post(body, key, parentCommentId) {
    const created = await withToken((token) => postComment(token, reviewId, { body, parentCommentId }, key));
    setThread((current) => addComment(current, created));
    if (parentCommentId) setReplying(null);
  }

  const handlers = {
    viewerId: userId,
    canInteract,
    onReply: (comment) => setReplying({
      threadId: comment.parentCommentId || comment.commentId,
      parentCommentId: comment.commentId,
      name: comment.author?.username || "",
    }),
    onEdit: async (comment, body) => {
      const updated = await withToken((token) => editComment(token, comment.commentId, body));
      setThread((current) => updateComment(current, updated));
    },
    onDelete: async (comment) => {
      const { status } = await withToken((token) => deleteComment(token, comment.commentId));
      setThread((current) => removeComment(current, comment.commentId, status));
    },
    onReport: (comment, report) => withToken((token) => reportComment(token, comment.commentId, report)),
  };

  return (
    <section className="review-comments" id="comments" aria-labelledby="review-comments-title">
      <h2 id="review-comments-title">Comments <span>{thread.commentCount || 0}</span></h2>
      <ol className="review-comment-list">
        {thread.comments.map((comment) => {
          const hidden = (comment.replyCount || 0) - (comment.replies?.length || 0);
          return (
            <li key={comment.commentId}>
              <CommentItem comment={comment} {...handlers} />
              {hasReplyContent(comment, replying?.threadId) && (
                <ol className="review-comment-replies">
                  {comment.replies.map((reply) => <li key={reply.commentId}><CommentItem comment={reply} {...handlers} /></li>)}
                  {hidden > 0 && comment.repliesCursor && (
                    <li>
                      <button className="review-comment-link" type="button" disabled={loadingReplies === comment.commentId} onClick={() => loadReplies(comment)}>
                        Show {hidden} more {hidden === 1 ? "reply" : "replies"}
                      </button>
                    </li>
                  )}
                  {replying?.threadId === comment.commentId && (
                    <li>
                      <Composer
                        key={replying.parentCommentId}
                        draftKey={commentDraftKey(userId, reviewId, replying.threadId)}
                        placeholder={replying.name ? `Reply to ${replying.name}` : "Write a reply"}
                        submitLabel="Reply"
                        autoFocus
                        note={privateNote}
                        onCancel={() => setReplying(null)}
                        onSubmit={(body, key) => post(body, key, replying.parentCommentId)}
                      />
                    </li>
                  )}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
      {thread.nextCursor && (
        <button className="review-comment-more" type="button" onClick={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? "Loading..." : "Show more comments"}
        </button>
      )}
      {pageError && <p className="review-comment-error" role="alert">{pageError}</p>}
      {canInteract && (
        <Composer
          draftKey={commentDraftKey(userId, reviewId)}
          placeholder="Add a comment"
          submitLabel="Post"
          note={privateNote}
          onSubmit={(body, key) => post(body, key, null)}
        />
      )}
      {!isSignedIn && thread.commentsEnabled && (
        <SignInButton mode="modal">
          <button className="review-comment-submit" type="button">Sign in to comment</button>
        </SignInButton>
      )}
    </section>
  );
}

export default ReviewComments;
