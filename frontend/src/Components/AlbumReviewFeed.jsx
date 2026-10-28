import { useState } from "react";
import { Link } from "react-router-dom";
import LikeButton from "./LikeButton";
import ShareButton from "./ShareButton";
import CommentCountLink from "../features/comments/CommentCountLink";
import EditedTag from "../features/reviews/EditedTag";
import ReviewEditForm from "../features/reviews/ReviewEditForm";

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
    onEditReview,
    onToggleReviewLike,
    likeMessage,
    deletingReviewId,
    deleteError,
}) {
    const [isEditing, setIsEditing] = useState(false);
    const [editMessage, setEditMessage] = useState("");
    const username = getReviewUsername(review);
    const imageUrl = review.author?.imageUrl;
    const canDelete = currentUserId && review.userId === currentUserId;
    const canEdit = canDelete && typeof onEditReview === "function";

    async function saveEdit(reviewId, updates) {
        setEditMessage("");
        try {
            await onEditReview(reviewId, updates);
            setIsEditing(false);
        } catch (error) {
            setEditMessage(error.message || "Could not save your edit.");
        }
    }

    function cancelEdit() {
        setIsEditing(false);
        setEditMessage("");
    }
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
                    <img src={imageUrl} alt="" loading="lazy" decoding="async" />
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
                    <EditedTag editedAt={review.editedAt} />
                </div>

                {isEditing ? (
                    <ReviewEditForm review={review} onCancelEdit={cancelEdit} onEditReview={saveEdit} editMessage={editMessage} />
                ) : (
                    <>
                        <p className="album-review-copy">{review.reviewText}</p>

                        <div className="review-card-actions">
                            <LikeButton
                                liked={Boolean(review.likedByViewer)}
                                count={review.likeCount}
                                label="review"
                                message={likeMessage}
                                onToggle={() => onToggleReviewLike?.(review)}
                            />
                            <CommentCountLink reviewId={review.reviewId} count={review.commentCount} />
                            {review.reviewId && <ShareButton className="review-share-button" path={`/review/${review.reviewId}`} title={`${username}'s review on Rescened`} />}
                        </div>

                        {canDelete && (
                            <div className="review-card-actions album-review-owner-actions">
                                {canEdit && (
                                    <button className="review-edit-button" type="button" onClick={() => setIsEditing(true)}>
                                        Edit Review
                                    </button>
                                )}
                                <button
                                    className="review-delete-button"
                                    type="button"
                                    onClick={() => onRemoveReview(review.reviewId)}
                                    disabled={deletingReviewId === review.reviewId}
                                >
                                    {deletingReviewId === review.reviewId ? "Deleting..." : "Delete Review"}
                                </button>
                            </div>
                        )}
                        {deleteError && <p className="review-edit-error" role="alert">{deleteError}</p>}
                    </>
                )}
            </div>
        </article>
    );
}

export function AlbumReviewFeed({
    reviews,
    currentUserId,
    onRemoveReview,
    onEditReview,
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
                    onEditReview={onEditReview}
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
