import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import BaselineReviewPanel from "../Components/Community/BaselineReviewPanel.jsx";
import { API_BASE_URL } from "../config/api.js";
import { communityErrorFrom, requestCommunityJson } from "../features/community/community.js";

const BASE_PATH = "/moderation/album-baselines";
const QUEUE_VIEWS = {
  ready: {
    label: "Ready for review",
    status: "pending",
    readiness: "ready",
    emptyTitle: "No enriched tracklists are ready for review.",
    emptyDescription: "Apply a reviewed enrichment plan to place a prepared candidate here.",
  },
  unprepared: {
    label: "Needs discovery",
    status: "pending",
    readiness: "unprepared",
    emptyTitle: "No pending records or suggestions need discovery.",
    emptyDescription: "Pending catalog records and suggestions without an attached candidate will appear here.",
  },
  reviewed: {
    label: "Reviewed",
    status: "reviewed",
    emptyTitle: "No reviewed baselines in this view.",
    emptyDescription: "Confirmed tracklist baselines will appear here.",
  },
  stale: {
    label: "Stale",
    status: "stale",
    emptyTitle: "No stale baselines in this view.",
    emptyDescription: "Catalog records that changed after review will appear here.",
  },
  deferred: {
    label: "Deferred",
    status: "deferred",
    emptyTitle: "No deferred baselines in this view.",
    emptyDescription: "Baselines set aside for later review will appear here.",
  },
  revoked: {
    label: "Revoked",
    status: "revoked",
    emptyTitle: "No revoked baselines in this view.",
    emptyDescription: "Revoked baselines will appear here.",
  },
};

const QUEUE_VIEW_OPTIONS = Object.entries(QUEUE_VIEWS).map(([value, definition]) => ({ value, ...definition }));

function errorState(error, fallback) {
  return communityErrorFrom(error, fallback) || { message: fallback, code: "REQUEST_FAILED", status: 0 };
}

function isReadyForReview(item) {
  return item?.readyForReview === true && item?.status === "pending";
}

export default function AlbumBaselines() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { albumId = "" } = useParams();
  const navigate = useNavigate();
  const [queueView, setQueueView] = useState("ready");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const queueSequence = useRef(0);
  const queueDefinition = QUEUE_VIEWS[queueView] || QUEUE_VIEWS.ready;

  const loadQueue = useCallback(async ({ cursor = "", append = false, signal } = {}) => {
    const sequence = queueSequence.current + 1;
    queueSequence.current = sequence;
    if (!append) {
      setItems([]);
      setNextCursor("");
      setLoadingMore(false);
    }
    if (!isLoaded || !isSignedIn) {
      setLoading(false);
      return;
    }
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const params = new URLSearchParams({ status: queueDefinition.status, limit: "20" });
      if (queueDefinition.readiness) params.set("readiness", queueDefinition.readiness);
      if (appliedQuery.trim()) params.set("q", appliedQuery.trim());
      if (cursor) params.set("cursor", cursor);
      const data = await requestCommunityJson(`${API_BASE_URL}${BASE_PATH}?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` }, signal }, "The baseline queue could not be loaded.");
      if (signal?.aborted || sequence !== queueSequence.current) return;
      setItems((current) => append ? [...current, ...(Array.isArray(data?.items) ? data.items : [])] : (Array.isArray(data?.items) ? data.items : []));
      setNextCursor(typeof data?.nextCursor === "string" ? data.nextCursor : "");
    } catch (requestError) {
      if (!signal?.aborted && sequence === queueSequence.current) setError(errorState(requestError, "The baseline queue could not be loaded."));
    } finally {
      if (!signal?.aborted && sequence === queueSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [appliedQuery, getToken, isLoaded, isSignedIn, queueDefinition]);

  useEffect(() => {
    const controller = new AbortController();
    loadQueue({ signal: controller.signal });
    return () => {
      controller.abort();
      queueSequence.current += 1;
    };
  }, [loadQueue, refresh]);

  if (!isLoaded) return <section className="community-page"><div className="community-loading" role="status">Opening baseline review…</div></section>;
  if (!isSignedIn) return <section className="community-page"><div className="community-empty-state"><h1>Sign in to open baseline review.</h1><p>Reviewed tracklists are restricted to moderators.</p></div></section>;

  const selectedItem = items.find((item) => item.id === albumId && item.kind === "albums") || null;

  return (
    <section className="community-page baseline-queue-page">
      <header className="community-page-header">
        <div>
          <p className="community-eyebrow">Catalog enrichment · moderator desk</p>
          <h1>Reviewed tracklist baselines</h1>
          <p>Confirm a MusicBrainz release as the standard tracklist for an existing album. This prepares mapping and listening evidence without creating diary entries.</p>
        </div>
        <div className="mapping-header-actions">
          <Link className="community-secondary-button" to="/moderation/album-suggestions">Album submissions</Link>
          <Link className="community-secondary-button" to="/moderation/album-mappings">Album mappings</Link>
          <button className="community-secondary-button" disabled={loading} onClick={() => setRefresh((value) => value + 1)} type="button">Refresh queue</button>
        </div>
      </header>
      <div className="mapping-workspace">
        <aside className="mapping-queue-panel community-panel" aria-label="Baseline queue">
          <form className="mapping-filter-row" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); setRefresh((value) => value + 1); }}>
            <label htmlFor="baseline-queue-view">Queue view<select id="baseline-queue-view" value={queueView} onChange={(event) => setQueueView(event.target.value)}>{QUEUE_VIEW_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Search<input onChange={(event) => setQuery(event.target.value)} placeholder="Album or artist" value={query} /></label>
            <button className="community-secondary-button" type="submit">Apply</button>
          </form>
          {error ? <div className="community-message community-message-error" role="alert"><strong>{error.message}</strong>{error.code ? <code>{error.code}</code> : null}<button className="community-text-button" onClick={() => setRefresh((value) => value + 1)} type="button">Try again</button></div> : null}
          {loading && items.length === 0 ? <div className="community-loading" role="status">Loading baseline queue…</div> : null}
          {!loading && !error && items.length === 0 ? <div className="community-empty-state"><h2>{queueDefinition.emptyTitle}</h2><p>{queueDefinition.emptyDescription}</p></div> : null}
          {items.length ? <ol className="mapping-queue-list">{items.map((item) => { const ready = isReadyForReview(item); return <li key={`${item.kind || "albums"}:${item.id}`}><button className={`mapping-queue-card${item.id === albumId && item.kind === "albums" ? " mapping-queue-card-selected" : ""}`} onClick={() => navigate(item.kind === "submissions" ? `/moderation/album-suggestions/${encodeURIComponent(item.id)}` : `${BASE_PATH}/${encodeURIComponent(item.id)}`)} type="button"><span className="mapping-queue-topline"><span className={`community-status${ready ? " community-status-pending" : ""}`}>{ready ? "Ready for review" : item.status || "pending"}</span><span>{item.kind === "submissions" ? "Suggestion" : "Album"} · Rev. {item.revision || 0}</span></span><strong>{item.title || "Untitled album"}</strong><span>{item.artistDisplayName || "Unknown artist"}</span><small>{ready ? "Enriched candidate attached · " : ""}{item.releaseGroupMbid || "Release group not selected"}</small></button></li>; })}</ol> : null}
          {nextCursor ? <button className="community-secondary-button mapping-load-more" disabled={loading || loadingMore} onClick={() => loadQueue({ cursor: nextCursor, append: true })} type="button">{loadingMore ? "Loading…" : "Load more"}</button> : null}
        </aside>
        <section className="mapping-detail-panel" aria-label="Selected baseline">
          {!albumId ? <div className="community-empty-state"><p className="community-eyebrow">No selection</p><h2>Choose an album to review.</h2><p>The recommended MusicBrainz edition and complete ordered tracklist will appear here.</p></div> : null}
          {albumId ? <BaselineReviewPanel compact id={albumId} kind="albums" onStateChange={() => setRefresh((value) => value + 1)} target={selectedItem} /> : null}
        </section>
      </div>
    </section>
  );
}
