export const MAX_REVIEW_LENGTH = 300;

export function reviewDraftKey(userId, albumId) {
  return userId && albumId ? `rescened:review-draft:${userId}:${albumId}` : "";
}

export function reviewValidationMessage({ rating, reviewText }) {
  const value = Number(rating);
  if (!Number.isFinite(value) || value < 1 || value > 5 || !Number.isInteger(value * 2)) {
    return "Choose a whole or half rating from 1 to 5.";
  }
  if (!reviewText.trim()) return "Write a review before posting.";
  if (reviewText.length > MAX_REVIEW_LENGTH) return "Reviews must be 300 characters or fewer.";
  return "";
}

export function readReviewDraft(storage, key, albumId) {
  const empty = { rating: "", reviewText: "", request: null };
  try {
    if (!key) return empty;
    const saved = JSON.parse(storage.getItem(key));
    if (!saved || typeof saved.rating !== "string" || typeof saved.reviewText !== "string") return empty;
    const draft = { rating: saved.rating, reviewText: saved.reviewText.slice(0, MAX_REVIEW_LENGTH), request: null };
    const request = saved.request;
    if (request && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.key)
      && request.body?.albumId === albumId && typeof request.body.reviewText === "string"
      && !reviewValidationMessage(request.body)) {
      // An uncertain submission is retried with exactly its original payload.
      return { rating: String(request.body.rating), reviewText: request.body.reviewText, request };
    }
    return draft;
  } catch {
    return empty;
  }
}

export function saveReviewDraft(storage, key, draft) {
  try {
    if (!key) return false;
    if (!draft.rating && !draft.reviewText && !draft.request) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    // Restricted storage must not prevent writing or submitting a review.
    return false;
  }
}

// A response belongs only to the request that is still stored. A composer
// mounted later may already have confirmed it and started a different draft.
export function settleReviewDraft(storage, key, requestKey, draft) {
  try {
    if (!key || JSON.parse(storage.getItem(key))?.request?.key !== requestKey) return false;
    return saveReviewDraft(storage, key, draft);
  } catch {
    return false;
  }
}
