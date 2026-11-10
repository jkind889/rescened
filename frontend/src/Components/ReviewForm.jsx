import { useEffect, useId, useRef, useState } from "react";
import { MAX_REVIEW_LENGTH, readReviewDraft, reviewDraftKey, reviewValidationMessage, saveReviewDraft, settleReviewDraft } from "../features/reviews/reviewDrafts";
import "../features/reviews/ReviewComposer.css";

function draftStorage() {
    try { return window.sessionStorage; } catch { return null; }
}

export function ReviewForm({ album, userId, isOpen, focusRequest, onAddReview, onSubmitted, onClose }) {
    const key = reviewDraftKey(userId, album.albumId);
    const [draft, setDraft] = useState(() => readReviewDraft(draftStorage(), key, album.albumId));
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [isDraftSaved, setIsDraftSaved] = useState(false);
    const submittingRef = useRef(false);
    const mountedRef = useRef(false);
    const activeRequestRef = useRef(null);
    const sectionRef = useRef(null);
    const ratingRef = useRef(null);
    const formId = useId();
    const { rating, reviewText, request } = draft;
    const isLocked = isSubmitting || Boolean(request);
    const numericRating = Number(rating);
    const hasValidRating = numericRating >= 1 && numericRating <= 5 && Number.isInteger(numericRating * 2);

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        sectionRef.current?.scrollIntoView({ block: "start" });
        // On a restored uncertain request the input is locked; focus the form.
        (ratingRef.current?.disabled ? sectionRef.current : ratingRef.current)?.focus({ preventScroll: true });
    }, [isOpen, focusRequest]);

    function updateDraft(next) {
        setDraft(next);
        setIsDraftSaved(saveReviewDraft(draftStorage(), key, next));
    }

    function settleDraft(next, requestKey) {
        setIsDraftSaved(settleReviewDraft(draftStorage(), key, requestKey, next));
        setDraft(next);
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (submittingRef.current) return;
        const validationMessage = reviewValidationMessage(draft);
        if (validationMessage) {
            setSubmitError(validationMessage);
            return;
        }
        const nextRequest = request || {
            key: crypto.randomUUID(),
            body: { albumId: album.albumId, rating: numericRating, reviewText: reviewText.trim() },
        };
        submittingRef.current = true;
        activeRequestRef.current = nextRequest.key;
        setIsSubmitting(true);
        setSubmitError("");
        updateDraft({ ...draft, request: nextRequest });
        try {
            const wasAdded = await onAddReview(nextRequest.body, nextRequest.key);
            if (!mountedRef.current || activeRequestRef.current !== nextRequest.key) return;
            if (wasAdded === false) {
                if (!request) settleDraft({ ...draft, request: null }, nextRequest.key);
                setSubmitError("Sign in to post your review. Your draft has been kept.");
                return;
            }
            settleDraft({ rating: "", reviewText: "", request: null }, nextRequest.key);
            onSubmitted?.();
        } catch (error) {
            if (!mountedRef.current || activeRequestRef.current !== nextRequest.key) return;
            // A rejected request can be edited. An uncertain result stays locked
            // and keeps its payload/key across closing, navigation and refresh.
            if (!request && error?.status >= 400 && error.status < 500 && error.status !== 408) {
                settleDraft({ ...draft, request: null }, nextRequest.key);
            }
            setSubmitError(error?.message || "Could not submit your review. Try again.");
        } finally {
            if (mountedRef.current && activeRequestRef.current === nextRequest.key) {
                submittingRef.current = false;
                activeRequestRef.current = null;
                setIsSubmitting(false);
            }
        }
    }

    return (
        <section className="album-review-composer" id="album-review-composer" hidden={!isOpen} ref={sectionRef} tabIndex={-1} aria-labelledby={`${formId}-title`}>
            <div className="album-section-heading">
                <h2 id={`${formId}-title`}>Write a review</h2>
                <span className="review-composer-draft-label">{request ? "Submission unconfirmed" : "Draft · Not posted"}</span>
            </div>
            <form className="review-edit-form review-composer-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
                <label className="review-edit-field review-composer-rating">
                    <span id={`${formId}-rating-label`}>Rating</span>
                    <input ref={ratingRef} type="number" min="1" max="5" step="0.5" required value={rating}
                        onChange={(event) => updateDraft({ ...draft, rating: event.target.value })}
                        placeholder="1–5" disabled={isLocked} aria-labelledby={`${formId}-rating-label`} aria-describedby={`${formId}-rating-hint`} />
                    <small id={`${formId}-rating-hint`}>1–5, including half stars</small>
                </label>
                <label className="review-edit-field">
                    <span id={`${formId}-text-label`}>Review</span>
                    <textarea value={reviewText} onChange={(event) => updateDraft({ ...draft, reviewText: event.target.value })}
                        placeholder={`What did you think of ${album.title}?`} rows="4" maxLength={MAX_REVIEW_LENGTH} required
                        disabled={isLocked} aria-labelledby={`${formId}-text-label`} aria-describedby={`${formId}-count`} />
                    <small className="review-composer-count" id={`${formId}-count`}>{reviewText.length} / {MAX_REVIEW_LENGTH}</small>
                </label>
                <div className="review-composer-preview" aria-label="Review preview">
                    <p className="review-composer-preview-label">Preview</p>
                    <article className="album-review-card">
                        <div className="album-review-avatar" aria-hidden="true"><span>Y</span></div>
                        <div className="album-review-content">
                            <div className="album-review-meta">
                                <p>Review by <strong>you</strong></p>
                                <span>{hasValidRating ? `${numericRating}/5` : "No rating yet"}</span>
                                <span>{request ? "Pending" : "Draft"}</span>
                            </div>
                            <p className={`album-review-copy${reviewText.trim() ? "" : " review-composer-placeholder"}`}>
                                {reviewText.trim() || "Your review will appear here as you write."}
                            </p>
                        </div>
                    </article>
                </div>
                {submitError && <p className="review-edit-error" role="alert">{submitError}</p>}
                {request && !isSubmitting && <p className="review-composer-note" role="status">Submission has not been confirmed. Retry checks the same review without creating a duplicate.</p>}
                <div className="review-card-actions review-composer-actions">
                    <button className="review-submit-button review-edit-save-button" type="submit" disabled={isSubmitting}>
                        {isSubmitting ? "Posting…" : request ? "Retry submission" : "Post review"}
                    </button>
                    <button className="review-delete-button review-edit-cancel-button" type="button" onClick={onClose} disabled={isSubmitting}>Close</button>
                </div>
                <p className="review-composer-note">{request ? "Keep this draft and retry to confirm whether it posted." : isDraftSaved ? "Draft kept in this tab. Nothing is posted until you choose Post review." : "Nothing is posted until you choose Post review. Closing keeps your draft on this page."}</p>
            </form>
        </section>
    );
}

export default ReviewForm;
