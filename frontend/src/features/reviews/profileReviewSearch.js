export const MAX_REVIEW_SEARCH_LENGTH = 200;

export function normalizeReviewSearch(value) {
  // Preserve Unicode literally: lowercasing can expand characters such as İ.
  // The database regex supplies case-insensitive matching without rewriting text.
  return value.trim().replace(/\s+/gu, " ");
}

export function reviewPageUrl(endpoint, { sort, search, cursor }) {
  const params = new URLSearchParams({ sort });
  if (search) params.set("q", normalizeReviewSearch(search));
  if (cursor) params.set("cursor", cursor);
  return `${endpoint}?${params}`;
}

// A superseded page may finish even after abort (e.g. token lookup or JSON
// parsing). The ticket guards every state update as well as cancelling fetch.
export function createReviewRequestGate() {
  let current = null;
  return {
    begin() {
      current?.abort();
      current = new AbortController();
      return current;
    },
    isCurrent(ticket) { return current === ticket && !ticket.signal.aborted; },
    cancel() { current?.abort(); current = null; },
  };
}

export function appendReviewPage(current, incoming) {
  const ids = new Set(current.map((review) => review.reviewId));
  return [...current, ...incoming.filter((review) => !ids.has(review.reviewId))];
}
