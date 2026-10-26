import { Link } from "react-router-dom";
import "./comments.css";

// Sits next to the like button on review cards and opens the review's thread.
export function CommentCountLink({ reviewId, count }) {
  if (!reviewId) return null;
  const total = Number(count) || 0;
  return (
    <Link className="review-comment-count-link" to={`/review/${reviewId}#comments`} aria-label={`${total} ${total === 1 ? "comment" : "comments"}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2" /></svg>
      <strong>{total}</strong>
    </Link>
  );
}

export default CommentCountLink;
