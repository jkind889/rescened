import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE_URL } from "../config/api";
import {
  communityErrorFrom,
  formatCommunityDate,
  formatCommunityValue,
  requestCommunityJson,
} from "../features/community/community";
import Cover from "../Components/Cover";

const PAGE_LIMIT = 20;
const SEARCH_DELAY_MS = 300;
const MAX_SEARCH_LENGTH = 100;

function approvedUrl(query, cursor = "") {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  return `${API_BASE_URL}/suggestions/approved?${params.toString()}`;
}

function FeedError({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="community-error" role="alert">
      <p className="community-error-message">{error.message || "The community feed could not be loaded."}</p>
      {error.code ? <p className="community-error-code">Code: {error.code}</p> : null}
      <button className="community-error-retry" onClick={onRetry} type="button">Try again</button>
    </div>
  );
}

function ApprovedCard({ item }) {
  const album = item.album || {};
  return (
    <article className="approved-feed-card">
      <Link className="approved-feed-cover" to={`/album/${album.albumId}`}>
        {album.cover ? <Cover alt={`${album.title || "Album"} cover`} src={album.cover} /> : <span>No cover</span>}
      </Link>
      <div className="approved-feed-copy">
        <p className="community-eyebrow">{formatCommunityValue(item.publicationType)}</p>
        <h2><Link to={`/album/${album.albumId}`}>{album.title || "Untitled album"}</Link></h2>
        <p className="approved-feed-artist">{album.artistDisplayName || "Unknown artist"}</p>
        <p className="approved-feed-meta">
          {[album.releaseDate || album.releaseYear, formatCommunityValue(album.releaseType)].filter(Boolean).join(" · ")}
        </p>
        <time dateTime={item.approvedAt}>{formatCommunityDate(item.approvedAt)}</time>
      </div>
    </article>
  );
}

export function ApprovedSuggestions() {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState("");
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const activeQueryRef = useRef("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    activeQueryRef.current = query;
    const controller = new AbortController();
    async function load() {
      setStatus("loading");
      setError(null);
      try {
        const data = await requestCommunityJson(
          approvedUrl(query),
          { signal: controller.signal },
          "The approved community feed could not be loaded.",
        );
        if (controller.signal.aborted) return;
        setItems(Array.isArray(data?.suggestions) ? data.suggestions : []);
        setNextCursor(data?.nextCursor || "");
        setStatus("ready");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setItems([]);
        setNextCursor("");
        setError(communityErrorFrom(loadError, "The approved community feed could not be loaded."));
        setStatus("error");
      }
    }
    load();
    return () => controller.abort();
  }, [query, refreshIndex]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const requestedQuery = query;
    setLoadingMore(true);
    setError(null);
    try {
      const data = await requestCommunityJson(
        approvedUrl(requestedQuery, nextCursor),
        {},
        "More approved suggestions could not be loaded.",
      );
      // A page for an earlier search must not join the current results.
      if (activeQueryRef.current !== requestedQuery) return;
      const incoming = Array.isArray(data?.suggestions) ? data.suggestions : [];
      setItems((current) => {
        const known = new Set(current.map((item) => item.submissionId));
        return [...current, ...incoming.filter((item) => !known.has(item.submissionId))];
      });
      setNextCursor(data?.nextCursor || "");
    } catch (loadError) {
      setError(communityErrorFrom(loadError, "More approved suggestions could not be loaded."));
    } finally {
      setLoadingMore(false);
    }
  }

  function retryFeed() {
    setRefreshIndex((current) => current + 1);
  }

  return (
    <section className="community-page approved-feed-page">
      <div className="community-page-frame">
        <header className="community-page-header">
          <div>
            <p className="community-eyebrow">Community catalog</p>
            <h1>Recently approved</h1>
            <p>New community records, explicit catalog links, and field corrections—shown as a chronological approval history.</p>
          </div>
          <Link className="community-secondary-button" to="/search">Browse catalog</Link>
        </header>
        <form className="community-field approved-feed-search" role="search" onSubmit={(event) => { event.preventDefault(); setQuery(searchInput.trim()); }}>
          <label htmlFor="approved-feed-search">Search approvals</label>
          <input
            id="approved-feed-search"
            maxLength={MAX_SEARCH_LENGTH}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Album title or artist"
            type="search"
            value={searchInput}
          />
        </form>
        {status === "loading" ? <div className="community-loading" role="status">Reading approved submissions…</div> : null}
        {status === "error" ? <FeedError error={error} onRetry={retryFeed} /> : null}
        {status === "ready" && !items.length ? (query
          ? <div className="community-empty-state"><h2>No matching approvals.</h2><p>No approved suggestion has an album title or artist matching “{query}”.</p></div>
          : <div className="community-empty-state"><h2>No approvals yet.</h2><p>The next approved community record will appear here.</p></div>) : null}
        {items.length ? <div className="approved-feed-list">{items.map((item) => <ApprovedCard item={item} key={item.submissionId} />)}</div> : null}
        {error && status === "ready" ? <FeedError error={error} onRetry={loadMore} /> : null}
        {nextCursor ? <button className="community-load-more" disabled={loadingMore} onClick={loadMore} type="button">{loadingMore ? "Loading more…" : "Load more approvals"}</button> : null}
        {status === "ready" && items.length && !nextCursor ? <p className="community-list-end">{query ? "End of matching approvals." : "End of approval history."}</p> : null}
      </div>
    </section>
  );
}

export default ApprovedSuggestions;
