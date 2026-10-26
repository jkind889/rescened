import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../config/api.js";
import { communityErrorFrom, formatCommunityDate, requestCommunityJson } from "../features/community/community.js";
import "../features/comments/comments.css";

const BASE_PATH = "/moderation/comment-reports";
const REASON_LABELS = { spam: "Spam", harassment: "Harassment", off_topic: "Off topic", other: "Other" };

function reasonSummary(reasons) {
  return Object.entries(reasons || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${REASON_LABELS[reason] || reason} ${count}`)
    .join(" · ");
}

function Decision({ busy, onDecide }) {
  const [reason, setReason] = useState("");
  const ready = Boolean(reason.trim()) && !busy;
  return (
    <form className="comment-report-decision" onSubmit={(event) => event.preventDefault()}>
      <textarea
        aria-label="Reason for the decision"
        placeholder="Reason for the decision"
        rows={2}
        maxLength={1000}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="review-comment-composer-actions">
        <button className="community-secondary-button" type="button" disabled={!ready} onClick={() => onDecide("dismiss", reason.trim())}>Dismiss reports</button>
        <button className="community-primary-button" type="button" disabled={!ready} onClick={() => onDecide("remove", reason.trim())}>Remove comment</button>
      </div>
    </form>
  );
}

function ReportItem({ item, busy, error, onDecide }) {
  const { album, comment, review } = item;
  const link = review ? `/review/${review.reviewId}#comment-${comment.commentId}` : "";
  return (
    <article className="community-panel comment-report-item">
      <header className="comment-report-context">
        {album ? <Link to={link}>{album.title || "Untitled album"}</Link> : <span>Album unavailable</span>}
        {album?.artistDisplayName && <span>{album.artistDisplayName}</span>}
        {review && <span>Review by {review.author?.username} · {review.rating}/5</span>}
      </header>
      <div className="comment-report-comment">
        <p className="review-comment-meta">
          <Link to={`/profile/${encodeURIComponent(comment.author.userId)}`}>{comment.author.username}</Link>
          <time dateTime={comment.createdAt}>{formatCommunityDate(comment.createdAt)}</time>
          {comment.isReply && <span>reply</span>}
          {comment.editedAt && <span>edited</span>}
        </p>
        <p className="review-comment-body">{comment.body}</p>
      </div>
      <details className="comment-report-reports">
        <summary>{item.reportCount} {item.reportCount === 1 ? "report" : "reports"} · {reasonSummary(item.reasons)}</summary>
        <ul>
          {item.reports.map((report) => (
            <li key={report.reportId}>
              <strong>{REASON_LABELS[report.reason] || report.reason}</strong>
              <span>{report.reporter?.username} · {formatCommunityDate(report.createdAt)}</span>
              {report.note && <p>{report.note}</p>}
            </li>
          ))}
        </ul>
      </details>
      {error && <p className="community-message community-message-error" role="alert">{error}</p>}
      <Decision busy={busy} onDecide={(action, reason) => onDecide(item, action, reason)} />
    </article>
  );
}

export function CommentReports() {
  const { getToken } = useAuth();
  const [queue, setQueue] = useState({ items: [], total: 0, loading: true, error: "" });
  const [accessDenied, setAccessDenied] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState("");
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");

  const authorized = useCallback(async (url, options = {}, fallback = "Request failed") => {
    const token = await getToken();
    return requestCommunityJson(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } }, fallback);
  }, [getToken]);

  useEffect(() => {
    let ignore = false;
    setQueue((current) => ({ ...current, loading: true, error: "" }));
    authorized(`${API_BASE_URL}${BASE_PATH}`, {}, "Could not load comment reports.")
      .then((data) => { if (!ignore) setQueue({ items: data.items || [], total: data.total || 0, loading: false, error: "" }); })
      .catch((error) => {
        if (ignore) return;
        if (error?.status === 403) setAccessDenied(true);
        setQueue({ items: [], total: 0, loading: false, error: communityErrorFrom(error, "Could not load comment reports.")?.message || "" });
      });
    return () => { ignore = true; };
  }, [authorized, refresh]);

  async function decide(item, action, reason) {
    // Removal has no restore command yet, so it asks first.
    if (action === "remove" && !window.confirm("Remove this comment for everyone?")) return;
    const { commentId } = item.comment;
    setPending(commentId);
    setErrors((current) => ({ ...current, [commentId]: "" }));
    setMessage("");
    try {
      await authorized(`${API_BASE_URL}${BASE_PATH}/${encodeURIComponent(commentId)}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }, "Could not apply this decision.");
      setQueue((current) => ({ ...current, items: current.items.filter((entry) => entry.comment.commentId !== commentId), total: Math.max(0, current.total - 1) }));
      setMessage(action === "remove" ? "Comment removed." : "Reports dismissed.");
    } catch (error) {
      const parsed = communityErrorFrom(error, "Could not apply this decision.");
      // A conflict means someone already handled it; reload the queue.
      if (parsed?.status === 409 || parsed?.status === 404) {
        setMessage(parsed.message);
        setRefresh((value) => value + 1);
      } else {
        setErrors((current) => ({ ...current, [commentId]: parsed?.message || "Could not apply this decision." }));
      }
    } finally {
      setPending("");
    }
  }

  if (accessDenied) {
    return (
      <section className="community-page">
        <div className="community-empty-state" role="alert">
          <p className="community-eyebrow">Restricted desk · 403</p>
          <h1>Moderator access required.</h1>
        </div>
      </section>
    );
  }

  return (
    <section className="community-page comment-reports-page">
      <header className="community-page-header">
        <div>
          <p className="community-page-kicker">Moderator desk</p>
          <h1 className="community-page-title">Comment reports {queue.total > 0 && <span>{queue.total}</span>}</h1>
        </div>
        <div className="mapping-header-actions">
          <Link className="community-secondary-button" to="/moderation/album-suggestions">Suggestion queue</Link>
          <button className="community-secondary-button" type="button" disabled={queue.loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
        </div>
      </header>
      {message && <p className="community-message community-message-success" role="status">{message}</p>}
      {queue.error && <p className="community-message community-message-error" role="alert">{queue.error}</p>}
      {queue.loading && !queue.items.length && <p className="review-comment-note">Loading reports...</p>}
      {!queue.loading && !queue.error && !queue.items.length && <p className="review-comment-note">No open reports.</p>}
      <div className="comment-report-list">
        {queue.items.map((item) => (
          <ReportItem key={item.comment.commentId} item={item} busy={pending === item.comment.commentId} error={errors[item.comment.commentId]} onDecide={decide} />
        ))}
      </div>
    </section>
  );
}

export default CommentReports;
