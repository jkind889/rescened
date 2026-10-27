import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../config/api";
import ProfileReviewCard from "../Components/ProfileReviewCard";
import { getApiErrorMessage } from "../utils/apiErrors";

const POPULAR_REVIEW_LIMIT = 12;

export function ReviewDispatches() {
  const { getToken, isLoaded, userId: viewerId } = useAuth();
  const [reviews, setReviews] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [likeMessage, setLikeMessage] = useState("");

  useEffect(() => {
    // Like state depends on the viewer, so wait for Clerk and fetch once.
    if (!isLoaded) return undefined;
    let isCurrent = true;

    async function fetchPopularReviews() {
      try {
        setStatus("loading");
        setError("");

        const token = viewerId ? await getToken() : null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const response = await fetch(
          `${API_BASE_URL}/reviews/popular-reviews?limit=${POPULAR_REVIEW_LIMIT}`,
          { headers },
        );

        if (!response.ok) {
          throw new Error(await getApiErrorMessage(response, "Could not load review dispatches."));
        }

        const data = await response.json();

        if (!isCurrent) {
          return;
        }

        setReviews(Array.isArray(data) ? data : []);
        setStatus("ready");
      } catch (loadError) {
        if (!isCurrent) {
          return;
        }

        if (loadError.name !== "AbortError") {
          setReviews([]);
          setError(
            loadError.name === "TypeError"
              ? "Could not load review dispatches right now."
              : loadError.message || "Could not load review dispatches.",
          );
          setStatus("error");
        }
      }
    }

    fetchPopularReviews();

    return () => {
      isCurrent = false;
    };
  }, [getToken, isLoaded, viewerId]);

  function updateReviewLikeState(reviewId, nextState) {
    setReviews((currentReviews) => currentReviews.map((review) => (
      review.reviewId === reviewId ? { ...review, ...nextState } : review
    )));
  }

  async function toggleReviewLike(review) {
    if (!viewerId) {
      setLikeMessage("Sign in to like reviews.");
      return;
    }

    const reviewId = review.reviewId;
    const nextLiked = !review.likedByViewer;
    const previousLikeCount = Number(review.likeCount) || 0;

    setLikeMessage("");
    updateReviewLikeState(reviewId, {
      likedByViewer: nextLiked,
      likeCount: Math.max(0, previousLikeCount + (nextLiked ? 1 : -1)),
    });

    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/likes/review/${reviewId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ liked: nextLiked }),
      });

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, "Failed to update review like"));
      }

      const data = await response.json();
      updateReviewLikeState(reviewId, {
        likedByViewer: Boolean(data.likedByViewer),
        likeCount: Number(data.likeCount) || 0,
      });
    } catch (likeError) {
      console.error(likeError);
      updateReviewLikeState(reviewId, {
        likedByViewer: Boolean(review.likedByViewer),
        likeCount: previousLikeCount,
      });
      setLikeMessage(likeError.message || "Could not update that like.");
    }
  }

  return (
    <section className="reviews-page review-dispatches-page">
      <section className="reviews-section">
        <div className="reviews-section-header">
          <div>
            <p className="reviews-kicker">Review dispatches</p>
            <h1>Most Liked</h1>
          </div>
          {status === "ready" && (
            <span className="review-dispatches-count">
              {reviews.length} dispatches
            </span>
          )}
        </div>

        {error && <p className="review-list-error">{error}</p>}
        {status === "loading" && <p className="review-dispatches-message">Gathering the most liked reviews…</p>}
        {status === "ready" && reviews.length === 0 && (
          <p className="review-dispatches-message">No popular reviews yet.</p>
        )}
        {reviews.length > 0 && (
          <div className="profile-review-list">
            {reviews.map((review) => (
              <ProfileReviewCard
                key={review.reviewId}
                review={review}
                likeMessage={likeMessage}
                onToggleLike={toggleReviewLike}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

export default ReviewDispatches;
