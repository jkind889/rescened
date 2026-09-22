import { useState } from "react";

export function ReviewForm({album, onAddReview, onSubmitted})
{
    const [reviewText, setReviewText] = useState("");
    const [rating, setRating] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [idempotencyKey, setIdempotencyKey] = useState("");


    const handleSubmit = async (e) => {
        e.preventDefault();

        const numericRating = Number(rating);

        if (!numericRating || !reviewText.trim()) {
            return;
        }

        const newReview = {
            albumId: album.albumId,
            rating: numericRating,
            reviewText: reviewText.trim(),
        };
        const requestKey = idempotencyKey || crypto.randomUUID();

        setIsSubmitting(true);
        setSubmitError("");
        setIdempotencyKey(requestKey);

        try {
            const wasAdded = await onAddReview(newReview, requestKey);
            if (wasAdded === false) {
                return;
            }
            setReviewText("");
            setRating("");
            setIdempotencyKey("");
            onSubmitted?.();
        } catch (error) {
            setSubmitError(error?.message || "Could not submit your review. Try again.");
        } finally {
            setIsSubmitting(false);
        }

    };

    return (
        <form className="review-form-card" onSubmit={handleSubmit}>
            <div className="review-form-header">
                <div>
                    <p className="review-form-kicker">Your review</p>
                    <h2>Review {album.title}</h2>
                </div>
            </div>

            <label className="review-form-field">
                <span>Rating</span>
                <input
                    type="number"
                    min="1"
                    max="5"
                    step="0.5"
                    required
                    value={rating}
                    onChange={(e) => setRating(e.target.value)}
                    placeholder="1-5"
                    disabled={isSubmitting}
                />
            </label>

            <label className="review-form-field">
                <span>Review</span>
                <textarea
                    value={reviewText}
                    onChange={(e) => setReviewText(e.target.value)}
                    placeholder="Write your review here..."
                    rows="5"
                    maxLength="300"
                    required
                    disabled={isSubmitting}
                />
            </label>

            {submitError && <p className="review-action-message" role="alert">{submitError}</p>}
            <button className="review-submit-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Submitting..." : "Submit Review"}
            </button>
        </form>
    );
}

export default ReviewForm;
