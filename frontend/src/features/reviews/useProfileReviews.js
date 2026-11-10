import { useEffect, useMemo, useState } from "react";
import { getApiErrorMessage } from "../../utils/apiErrors";
import { appendReviewPage, createReviewRequestGate, normalizeReviewSearch, reviewPageUrl } from "./profileReviewSearch";

export default function useProfileReviews({ endpoint, viewerId, getToken, isSignedIn, enabled, sort, query }) {
  const search = normalizeReviewSearch(query);
  const key = JSON.stringify([endpoint, viewerId, isSignedIn, sort, search]);
  const gate = useMemo(() => createReviewRequestGate(), []);
  const [page, setPage] = useState({ key: "", reviews: [], cursor: null, loading: false, error: "" });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const ticket = gate.begin();
    setPage({ key, reviews: [], cursor: null, loading: true, error: "" });
    const timer = setTimeout(async () => {
      try {
        const token = isSignedIn ? await getToken() : null;
        if (!gate.isCurrent(ticket)) return;
        const response = await fetch(reviewPageUrl(endpoint, { sort, search }), {
          headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ticket.signal,
        });
        if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load reviews."));
        const data = await response.json();
        if (gate.isCurrent(ticket)) setPage({ key, reviews: Array.isArray(data.reviews) ? data.reviews : [], cursor: data.nextCursor || null, loading: false, error: "" });
      } catch (error) {
        if (gate.isCurrent(ticket)) setPage({ key, reviews: [], cursor: null, loading: false, error: error.message || "Could not load reviews." });
      }
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); gate.cancel(); };
  }, [enabled, endpoint, gate, getToken, isSignedIn, key, revision, search, sort]);

  async function loadMore() {
    if (!enabled || page.key !== key || page.loading || !page.cursor) return;
    const ticket = gate.begin();
    setPage((current) => ({ ...current, loading: true, error: "" }));
    try {
      const token = isSignedIn ? await getToken() : null;
      if (!gate.isCurrent(ticket)) return;
      const response = await fetch(reviewPageUrl(endpoint, { sort, search, cursor: page.cursor }), {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ticket.signal,
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load more reviews."));
      const data = await response.json();
      if (gate.isCurrent(ticket)) setPage((current) => ({
        ...current, reviews: appendReviewPage(current.reviews, Array.isArray(data.reviews) ? data.reviews : []),
        cursor: data.nextCursor || null, loading: false, error: "",
      }));
    } catch (error) {
      if (gate.isCurrent(ticket)) setPage((current) => ({ ...current, loading: false, error: error.message || "Could not load more reviews." }));
    }
  }

  return {
    reviews: page.key === key ? page.reviews : [],
    nextCursor: page.key === key ? page.cursor : null,
    isLoading: enabled && (page.key !== key || page.loading),
    error: page.key === key ? page.error : "",
    loadMore,
    retry: () => setRevision((value) => value + 1),
    setReviews: (update) => setPage((current) => ({ ...current, reviews: typeof update === "function" ? update(current.reviews) : update })),
  };
}
