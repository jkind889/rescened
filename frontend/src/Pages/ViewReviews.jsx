import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { useParams } from "react-router-dom";
import ReviewList from "../Components/ReviewList";
import { getApiErrorMessage } from "../utils/apiErrors";
import { REVIEW_SORTS, REVIEW_SORT_OPTIONS } from "../utils/reviewSorts";

function appendUniqueReviews(current, incoming) {
    const ids = new Set(current.map((review) => review.reviewId));
    return [...current, ...incoming.filter((review) => !ids.has(review.reviewId))];
}

export function ViewReviews() {
    const [reviews, setReviews] = useState([]);
    const [nextCursor, setNextCursor] = useState(null);
    const [error, setError] = useState("");
    const [likeMessage, setLikeMessage] = useState("");
    const [editMessage, setEditMessage] = useState("");
    const [editingReview, setEditingReview] = useState(null);
    const [reviewSort, setReviewSort] = useState("recent");
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [deletingReviewId, setDeletingReviewId] = useState("");
    const [deleteErrors, setDeleteErrors] = useState({});
    const { getToken, userId: viewerId } = useAuth();
    const { userId } = useParams();
    const isPublicReviewList = Boolean(userId);
    const canManageReviews = !isPublicReviewList;
    const encodedUserId = userId ? encodeURIComponent(userId) : "";
    const reviewEndpoint = isPublicReviewList
        ? `${API_BASE_URL}/reviews/review/user/${encodedUserId}`
        : `${API_BASE_URL}/reviews/review/user/`;

    useEffect(() => {
        const controller = new AbortController();
        async function fetchFirstPage() {
            setIsLoading(true);
            setError("");
            setReviews([]);
            setNextCursor(null);
            try {
                const token = viewerId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const response = await fetch(`${reviewEndpoint}?sort=${reviewSort}`, { headers, signal: controller.signal });
                if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load reviews right now."));
                const data = await response.json();
                if (!controller.signal.aborted) {
                    setReviews(Array.isArray(data.reviews) ? data.reviews : []);
                    setNextCursor(data.nextCursor || null);
                }
            } catch (reviewError) {
                if (!controller.signal.aborted) {
                    setError(reviewError.message || "Could not load reviews right now.");
                    setReviews([]);
                }
            } finally {
                if (!controller.signal.aborted) setIsLoading(false);
            }
        }
        void fetchFirstPage();
        return () => controller.abort();
    }, [getToken, reviewEndpoint, reviewSort, viewerId]);

    async function loadMore() {
        if (!nextCursor || isLoadingMore) return;
        setIsLoadingMore(true);
        setError("");
        try {
            const token = viewerId ? await getToken() : null;
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const response = await fetch(`${reviewEndpoint}?sort=${reviewSort}&cursor=${encodeURIComponent(nextCursor)}`, { headers });
            if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load more reviews."));
            const data = await response.json();
            setReviews((current) => appendUniqueReviews(current, Array.isArray(data.reviews) ? data.reviews : []));
            setNextCursor(data.nextCursor || null);
        } catch (reviewError) {
            setError(reviewError.message || "Could not load more reviews.");
        } finally {
            setIsLoadingMore(false);
        }
    }

    async function removeReview(reviewId) {
        if (deletingReviewId) return false;
        setDeletingReviewId(reviewId);
        setDeleteErrors((current) => ({ ...current, [reviewId]: "" }));
        try {
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/reviews/review/user/${reviewId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to delete review"));
            setReviews((current) => current.filter((review) => review.reviewId !== reviewId));
            return true;
        } catch (reviewError) {
            setDeleteErrors((current) => ({ ...current, [reviewId]: reviewError.message || "Could not delete that review." }));
            return false;
        } finally {
            setDeletingReviewId("");
        }
    }

    async function editReview(reviewId, updates) {
        setEditMessage("");
        try {
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/reviews/review/user/${reviewId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(updates) });
            if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to edit review"));
            const updatedReview = await res.json();
            setReviews((current) => current.map((review) => review.reviewId === reviewId ? updatedReview : review));
            setEditingReview(null);
            return true;
        } catch (reviewError) {
            setEditMessage(reviewError.message || "Could not edit that review.");
            return false;
        }
    }

    function updateReviewLikeState(reviewId, nextState) {
        setReviews((current) => current.map((review) => review.reviewId === reviewId ? { ...review, ...nextState } : review));
    }

    async function toggleReviewLike(review) {
        if (!viewerId) {
            setLikeMessage("Sign in to like reviews.");
            return;
        }
        const nextLiked = !review.likedByViewer;
        const previousLikeCount = Number(review.likeCount) || 0;
        updateReviewLikeState(review.reviewId, { likedByViewer: nextLiked, likeCount: Math.max(0, previousLikeCount + (nextLiked ? 1 : -1)) });
        setLikeMessage("");
        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/likes/review/${review.reviewId}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ liked: nextLiked }) });
            if (!response.ok) throw new Error(await getApiErrorMessage(response, "Failed to update review like"));
            const data = await response.json();
            updateReviewLikeState(review.reviewId, { likedByViewer: Boolean(data.likedByViewer), likeCount: Number(data.likeCount) || 0 });
        } catch (likeError) {
            updateReviewLikeState(review.reviewId, { likedByViewer: Boolean(review.likedByViewer), likeCount: previousLikeCount });
            setLikeMessage(likeError.message || "Could not update that like.");
        }
    }

    return (
        <main className="reviews-page">
            <section className="reviews-section">
                <div className="reviews-section-header">
                    <div><p className="reviews-kicker">Review shelf</p><h1>{REVIEW_SORTS[reviewSort].heading}</h1></div>
                    <div className="reviews-sort-control">
                        <label htmlFor="review-sort">Order</label>
                        <select id="review-sort" value={reviewSort} onChange={(event) => setReviewSort(event.target.value)} disabled={isLoading}>
                            {REVIEW_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                    </div>
                </div>
                {error && <p className="review-list-error" role="alert">{error}</p>}
                {isLoading ? <p className="review-list-empty">Loading reviews…</p> : (
                    <ReviewList listId={reviewSort} reviews={reviews} onRemoveReview={canManageReviews ? removeReview : undefined} onEditReview={canManageReviews ? editReview : undefined} editingReview={editingReview} onStartEdit={(reviewId, listId) => setEditingReview({ reviewId, listId })} onCancelEdit={() => { setEditingReview(null); setEditMessage(""); }} onToggleReviewLike={toggleReviewLike} likeMessage={likeMessage} editMessage={editMessage} deletingReviewId={deletingReviewId} deleteErrors={deleteErrors} />
                )}
                {nextCursor && <button className="album-more-link" type="button" onClick={loadMore} disabled={isLoadingMore}>{isLoadingMore ? "Loading…" : "Load more reviews"}</button>}
                {!isLoading && !nextCursor && reviews.length > 0 && <p className="review-list-empty">You’re all caught up.</p>}
            </section>
        </main>
    );
}

export default ViewReviews;
