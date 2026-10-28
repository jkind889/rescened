import { useState } from "react";
import { MAX_REVIEW_LENGTH } from "./reviews";

export default function ReviewEditForm({ review, onCancelEdit, onEditReview, editMessage }) {
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

        if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5 || !Number.isInteger(numericRating * 2)) {
            setLocalError("Rating must be a whole or half number between 1 and 5.");
            return;
        }

        setIsSaving(true);
        setLocalError("");
        await onEditReview?.(review.reviewId, { reviewText: trimmedText, rating: numericRating });
        setIsSaving(false);
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
                    maxLength={MAX_REVIEW_LENGTH}
                    required
                    value={editText}
                    onChange={(event) => setEditText(event.target.value)}
                />
            </label>
            {(localError || editMessage) && (
                <p className="review-edit-error" role="alert">{localError || editMessage}</p>
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
