import { Link } from "react-router-dom";
import LikeButton from "./LikeButton";

const DEFAULT_USERNAME = "rescened user";

function formatReviewDate(date) {
    if (!date) {
        return "Date unavailable";
    }

    const parsedDate = new Date(date);
    return Number.isNaN(parsedDate.getTime())
        ? "Date unavailable"
        : parsedDate.toLocaleDateString();
}

function getReviewUsername(review) {
    return review.author?.username || DEFAULT_USERNAME;
}

function getAvatarInitial(username) {
    const trimmedUsername = username.trim();
    return trimmedUsername ? trimmedUsername[0].toUpperCase() : "A";
}

function AlbumReviewCard({
    review,
    currentUserId,
    onRemoveReview,
    onToggleReviewLike,
    likeMessage,
    deletingReviewId,
    deleteError,
}) {
    const username = getReviewUsername(review);
    const imageUrl = review.author?.imageUrl;
    const canDelete = currentUserId && review.userId === currentUserId;
    const profileState = {
        profileUser: {
            username,
            imageUrl,
        },
    };

    return (
        <article className="album-review-card">
            <div className="album-review-avatar" aria-hidden="true">
                {imageUrl ? (
                    <img src={imageUrl} alt="" />
                ) : (
                    <span>{getAvatarInitial(username)}</span>
                )}
            </div>

            <div className="album-review-content">
                <div className="album-review-meta">
                    <p>
                        Review by{" "}
                        {review.userId ? (
                            <Link
                                className="album-review-author-link"
                                to={`/profile/${review.userId}`}
                                state={profileState}
                            >
                                {username}
                            </Link>
                        ) : (
                            <span className="album-review-author-link">{username}</span>
                        )}
                    </p>
                    <span>{review.rating}/5</span>
                    <span>{formatReviewDate(review.date)}</span>
                </div>

                <p className="album-review-copy">{review.reviewText}</p>

                <div className="review-card-actions">
                    <LikeButton
                        liked={Boolean(review.likedByViewer)}
                        count={review.likeCount}
                        label="review"
                        message={likeMessage}
                        onToggle={() => onToggleReviewLike?.(review)}
                    />
                </div>

                {canDelete && (
                    <button
                        className="review-delete-button album-review-delete"
                        type="button"
                        onClick={() => onRemoveReview(review.reviewId)}
                        disabled={deletingReviewId === review.reviewId}
                    >
                        {deletingReviewId === review.reviewId ? "Deleting..." : "Delete Review"}
                    </button>
                )}
                {deleteError && <p className="review-edit-error" role="alert">{deleteError}</p>}
            </div>
        </article>
    );
}

export function AlbumReviewFeed({
    reviews,
    currentUserId,
    onRemoveReview,
    onToggleReviewLike,
    likeMessage,
    deletingReviewId,
    deleteErrors = {},
})
{
    if (reviews.length === 0) {
        return (
            <div className="review-list-empty">
                <p>No reviews yet.</p>
            </div>
        );
    }

    return (
        <div className="album-review-feed">
            {reviews.map((review) => (
                <AlbumReviewCard
                    key={review.reviewId}
                    review={review}
                    currentUserId={currentUserId}
                    onRemoveReview={onRemoveReview}
                    onToggleReviewLike={onToggleReviewLike}
                    likeMessage={likeMessage}
                    deletingReviewId={deletingReviewId}
                    deleteError={deleteErrors[review.reviewId]}
                />
            ))}
        </div>
    );
}

export default AlbumReviewFeed;
