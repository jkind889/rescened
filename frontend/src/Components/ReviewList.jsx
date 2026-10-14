import { useState } from "react";
import LikeButton from "./LikeButton";
import ShareButton from "./ShareButton";

function ReviewEditForm({
    review,
    onCancelEdit,
    onEditReview,
    editMessage,
}) {
    const [editText, setEditText] = useState(review.reviewText || "");
    const [editRating, setEditRating] = useState(String(review.rating || ""));
    const [isSaving, setIsSaving] = useState(false);
    const [localError, setLocalError] = useState("");

    async function handleEditSubmit(event) {
        event.preventDefault();

        const trimmedText = editText.trim();
        const numericRating = Number(editRating);

        if (!trimmedText) {
            setLocalError("Review text is required.");
            return;
        }

        if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
            setLocalError("Rating must be between 1 and 5.");
            return;
        }

        setIsSaving(true);
        setLocalError("");

        const wasSaved = await onEditReview?.(review.reviewId, {
            reviewText: trimmedText,
            rating: numericRating,
        });

        setIsSaving(false);

        if (wasSaved === false) {
            return;
        }
    }

    return (
        <form className="review-edit-form" onSubmit={handleEditSubmit}>
            <label className="review-edit-field">
                <span>Rating</span>
                <input
                    type="number"
                    min="1"
                    max="5"
                    step="0.5"
                    required
                    value={editRating}
                    onChange={(event) => setEditRating(event.target.value)}
                />
            </label>
            <label className="review-edit-field">
                <span>Review</span>
                <textarea
                    rows="4"
                    maxLength="300"
                    required
                    value={editText}
                    onChange={(event) => setEditText(event.target.value)}
                />
            </label>
            {(localError || editMessage) && (
                <p className="review-edit-error">{localError || editMessage}</p>
            )}
            <div className="review-card-actions">
                <button className="review-submit-button review-edit-save-button" type="submit" disabled={isSaving}>
                    {isSaving ? "Saving..." : "Save"}
                </button>
                <button className="review-delete-button review-edit-cancel-button" type="button" onClick={onCancelEdit} disabled={isSaving}>
                    Cancel
                </button>
            </div>
        </form>
    );
}

function ReviewListCard({
    review,
    listId,
    isEditing,
    canEditReviews,
    canRemoveReviews,
    onStartEdit,
    onCancelEdit,
    onEditReview,
    onRemoveReview,
    onToggleReviewLike,
    likeMessage,
    editMessage,
    deletingReviewId,
    deleteError,
    formatReviewDate,
    formatRatingStars,
}) {
    return (
        <article className="review-card" key={review.reviewId}>
            <div className="review-card-poster">
                {review.cover && (
                    <img className="review-card-image" src={review.cover} alt={`${review.title} cover`} />
                )}
                {!review.cover && (
                    <div className="review-card-image-fallback">No cover</div>
                )}
            </div>
            <div className="review-card-content">
                <div className="review-card-title-row">
                    <h2>{review.title || "Untitled album"}</h2>
                    {review.year && <span>{review.year}</span>}
                </div>
                <div className="review-card-meta">
                    <span className="review-card-rating" aria-label={`${review.rating} out of 5`}>
                        {formatRatingStars(review.rating)}
                    </span>
                    <span>Reviewed {formatReviewDate(review.date)}</span>
                </div>
                {isEditing ? (
                    <ReviewEditForm
                        key={review.reviewId}
                        review={review}
                        onCancelEdit={onCancelEdit}
                        onEditReview={onEditReview}
                        editMessage={editMessage}
                    />
                ) : (
                    <>
                        <p className="review-card-copy">{review.reviewText}</p>
                        <div className="review-card-actions">
                            <LikeButton
                                liked={Boolean(review.likedByViewer)}
                                count={review.likeCount}
                                label="review"
                                message={likeMessage}
                                onToggle={() => onToggleReviewLike?.(review)}
                            />
                            {review.reviewId && <ShareButton className="review-share-button" path={`/review/${review.reviewId}`} title={`Review of ${review.title || "an album"} on Rescened`} />}
                            {canEditReviews && (
                                <button className="review-edit-button" type="button" onClick={() => onStartEdit?.(review.reviewId, listId)}>
                                    Edit Review
                                </button>
                            )}
                            {canRemoveReviews && (
                                <button className="review-delete-button" type="button" disabled={deletingReviewId === review.reviewId} onClick={() => onRemoveReview(review.reviewId)}>
                                    {deletingReviewId === review.reviewId ? "Deleting..." : "Delete Review"}
                                </button>
                            )}
                        </div>
                        {deleteError && <p className="review-edit-error" role="alert">{deleteError}</p>}
                    </>
                )}
            </div>
        </article>
    );
}

export function ReviewList({
    listId,
    reviews,
    onRemoveReview,
    onEditReview,
    editingReview,
    onStartEdit,
    onCancelEdit,
    onToggleReviewLike,
    likeMessage,
    editMessage,
    deletingReviewId,
    deleteErrors = {},
})
{
    const canRemoveReviews = typeof onRemoveReview === "function";
    const canEditReviews = typeof onEditReview === "function";
    const formatReviewDate = (date) => {
        if (!date) {
            return "Date unavailable";
        }

        const parsedDate = new Date(date);
        return Number.isNaN(parsedDate.getTime())
            ? "Date unavailable"
            : parsedDate.toLocaleDateString();
    };

    const formatRatingStars = (rating) => {
        const numericRating = Number(rating) || 0;
        const fullStars = Math.floor(numericRating);
        const hasHalfStar = numericRating % 1 >= 0.5;

        return `${"★".repeat(fullStars)}${hasHalfStar ? "½" : ""}`;
    };

    if (reviews.length === 0) {
        return (
            <div className="review-list-empty">
                <p>No reviews yet.</p>
            </div>
        );
    }


    return (
        <div className="review-list">
            {reviews.map((review) => (
                <ReviewListCard
                    key={review.reviewId}
                    review={review}
                    listId={listId}
                    isEditing={editingReview?.reviewId === review.reviewId && editingReview?.listId === listId}
                    canEditReviews={canEditReviews}
                    canRemoveReviews={canRemoveReviews}
                    onStartEdit={onStartEdit}
                    onCancelEdit={onCancelEdit}
                    onEditReview={onEditReview}
                    onRemoveReview={onRemoveReview}
                    onToggleReviewLike={onToggleReviewLike}
                    likeMessage={likeMessage}
                    editMessage={editMessage}
                    deletingReviewId={deletingReviewId}
                    deleteError={deleteErrors[review.reviewId]}
                    formatReviewDate={formatReviewDate}
                    formatRatingStars={formatRatingStars}
                />
            ))}
        </div>

    );
}

export default ReviewList
