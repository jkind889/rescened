import { API_BASE_URL } from "../../config/api";
import { getApiErrorMessage } from "../../utils/apiErrors";

export const MAX_REVIEW_LENGTH = 300;

export async function updateReview(token, reviewId, { rating, reviewText }) {
  const response = await fetch(`${API_BASE_URL}/reviews/review/user/${encodeURIComponent(reviewId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rating, reviewText }),
  });
  if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not save your edit."));
  return response.json();
}

// Swap an edited review into a list, keeping any fields the list adds itself.
export function replaceReview(reviews, updated) {
  return reviews.map((review) => (review.reviewId === updated.reviewId ? { ...review, ...updated } : review));
}
