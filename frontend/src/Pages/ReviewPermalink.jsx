import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import AsyncState from "../Components/Loading/AsyncState";
import PageMeta from "../Components/PageMeta";
import LikeButton from "../Components/LikeButton";
import ShareButton from "../Components/ShareButton";
import ReviewComments from "../features/comments/ReviewComments";
import EditedTag from "../features/reviews/EditedTag";
import ReviewEditForm from "../features/reviews/ReviewEditForm";
import { updateReview } from "../features/reviews/reviews";
import { getApiErrorMessage } from "../utils/apiErrors";
import { reviewPageMeta } from "../utils/pageMeta";

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// A shareable page for one review, reached from any review's Share button.
export function ReviewPermalink() {
  const { reviewId } = useParams();
  const { getToken, isLoaded, userId } = useAuth();
  // Navigation or a viewer change discards drafts and pending mutation state.
  // Responses belonging to the old page can only update its unmounted instance.
  return <ReviewPermalinkContent key={JSON.stringify([reviewId, userId])} reviewId={reviewId} getToken={getToken} isLoaded={isLoaded} userId={userId} />;
}

function ReviewPermalinkContent({ reviewId, getToken, isLoaded, userId }) {
  const [review, setReview] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [likeMessage, setLikeMessage] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [editMessage, setEditMessage] = useState("");

  useEffect(() => {
    // likedByViewer depends on the viewer, so wait for Clerk and fetch once.
    if (!isLoaded) return undefined;
    const controller = new AbortController();
    async function fetchReview() {
      setIsLoading(true);
      setError("");
      try {
        const token = userId ? await getToken() : null;
        const response = await fetch(`${API_BASE_URL}/reviews/review/${encodeURIComponent(reviewId)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load this review."));
        const data = await response.json();
        if (!controller.signal.aborted) setReview(data);
      } catch (reviewError) {
        if (!controller.signal.aborted) {
          setReview(null);
          setError(reviewError.message || "Could not load this review.");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    void fetchReview();
    return () => controller.abort();
  }, [getToken, isLoaded, reviewId, userId]);

  async function toggleLike() {
    if (!userId) {
      setLikeMessage("Sign in to like reviews.");
      return;
    }
    const previous = review;
    const liked = !review.likedByViewer;
    setLikeMessage("");
    setReview({ ...review, likedByViewer: liked, likeCount: Math.max(0, (Number(review.likeCount) || 0) + (liked ? 1 : -1)) });
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/likes/review/${review.reviewId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ liked }),
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not update that like."));
      const data = await response.json();
      setReview((current) => ({ ...current, likedByViewer: Boolean(data.likedByViewer), likeCount: Number(data.likeCount) || 0 }));
    } catch (likeError) {
      setReview(previous);
      setLikeMessage(likeError.message || "Could not update that like.");
    }
  }

  async function saveEdit(id, updates) {
    setEditMessage("");
    try {
      const updated = await updateReview(await getToken(), id, updates);
      setReview((current) => ({ ...current, ...updated }));
      setIsEditing(false);
    } catch (editError) {
      setEditMessage(editError.message || "Could not save your edit.");
    }
  }

  function cancelEdit() {
    setIsEditing(false);
    setEditMessage("");
  }

  if (isLoading || error || !review) {
    return (
      <section className="review-permalink-page">
        <AsyncState
          isLoading={isLoading}
          error={error}
          isEmpty={!isLoading && !error && !review}
          loadingVariant="detail"
          loadingMessage="Loading review"
          errorTitle="Review unavailable"
          emptyTitle="Review unavailable"
          emptyBody="This review could not be found."
        />
      </section>
    );
  }

  const album = review.album || {};
  const author = review.author || {};
  const isOwner = Boolean(userId) && review.userId === userId;

  return (
    <section className="review-permalink-page">
      <PageMeta {...reviewPageMeta(review)} />
      <article className="review-permalink">
        <Link className="review-permalink-cover" to={`/album/${album.albumId}`}>
          {album.cover ? <img src={album.cover} alt={`${album.title} cover`} /> : <span>No cover</span>}
        </Link>
        <div className="review-permalink-body">
          <p className="review-permalink-kicker">
            Review by{" "}
            {author.userId
              ? <Link to={`/profile/${encodeURIComponent(author.userId)}`}>{author.username || "rescened user"}</Link>
              : <span>{author.username || "deleted user"}</span>}
          </p>
          <h1><Link to={`/album/${album.albumId}`}>{album.title || "Untitled album"}</Link></h1>
          <p className="review-permalink-artist">
            {album.artistDisplayName || "Artist unknown"}{album.releaseYear ? ` · ${album.releaseYear}` : ""}
          </p>
          <p className="review-permalink-meta">
            <span aria-label={`${review.rating} out of 5`}>★ {review.rating}/5</span>
            <time dateTime={review.date}>{formatDate(review.date)}</time>
            <EditedTag editedAt={review.editedAt} />
          </p>
          {isEditing ? (
            <ReviewEditForm review={review} onCancelEdit={cancelEdit} onEditReview={saveEdit} editMessage={editMessage} />
          ) : (
            <>
              <p className="review-permalink-copy">{review.reviewText}</p>
              <div className="review-card-actions">
                <LikeButton liked={Boolean(review.likedByViewer)} count={review.likeCount} label="review" message={likeMessage} onToggle={toggleLike} />
                <ShareButton className="review-share-button" path={`/review/${review.reviewId}`} title={`${author.username ? `${author.username}’s review` : "A review"} of ${album.title || "an album"} on Rescened`} />
                <Link className="review-share-button" to={`/album/${album.albumId}/reviews`}>All reviews of this album</Link>
                {isOwner && <button className="review-edit-button" type="button" onClick={() => setIsEditing(true)}>Edit Review</button>}
              </div>
            </>
          )}
        </div>
      </article>
      <ReviewComments reviewId={review.reviewId} />
    </section>
  );
}

export default ReviewPermalink;
