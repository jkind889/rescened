import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const DEFAULT_USERNAME = "rescened user";

function formatReviewDate(date) {
    if (!date) {
        return "Date unavailable";
    }

    const parsedDate = new Date(date);
    return Number.isNaN(parsedDate.getTime()) ? "Date unavailable" : parsedDate.toLocaleDateString();
}

function formatRatingStars(rating) {
    const numericRating = Number(rating) || 0;
    return "★".repeat(Math.floor(numericRating));
}

export function PopularReviews({ limit = 4 }) {
    const [reviews, setReviews] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function fetchPopularReviews() {
            setIsLoading(true);

            try {
                const params = new URLSearchParams({ limit: String(limit) });
                const res = await fetch(`${API_BASE_URL}/reviews/popular-reviews?${params.toString()}`);

                if (!res.ok) {
                    setReviews([]);
                    return;
                }

                const data = await res.json();

                if (isMounted) {
                    setReviews(Array.isArray(data) ? data : []);
                }
            } catch (error) {
                console.error("Failed to fetch popular reviews", error);

                if (isMounted) {
                    setReviews([]);
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        fetchPopularReviews();

        return () => {
            isMounted = false;
        };
    }, [limit]);

    if (isLoading) {
        return <p className="front-empty-state">Loading popular reviews...</p>;
    }

    if (!reviews.length) {
        return <p className="front-empty-state">No popular reviews yet.</p>;
    }

    return (
        <div className="front-review-list">
            {reviews.map((review) => {
                const username = review.author?.username || DEFAULT_USERNAME;

                return (
                    <article className="front-review-card" key={review.reviewId}>
                        <Link className="front-review-cover-link" to={`/album/${review.albumId}`}>
                            {review.album?.cover ? (
                                <img src={review.album.cover} alt={`${review.album.title} cover`} />
                            ) : (
                                <span className="front-album-cover-fallback">No cover</span>
                            )}
                        </Link>
                        <div>
                            <div className="front-review-meta">
                                {review.userId ? <Link to={`/profile/${review.userId}`}>{username}</Link> : <span>{username}</span>}
                                <span>{formatRatingStars(review.rating)}</span>
                                <span>{formatReviewDate(review.date)}</span>
                            </div>
                            <h4>
                                <Link to={`/album/${review.albumId}`}>{review.album?.title || "Untitled album"}</Link>
                            </h4>
                            {review.reviewText && <p>{review.reviewText}</p>}
                        </div>
                    </article>
                );
            })}
        </div>
    );
}

export default PopularReviews;
