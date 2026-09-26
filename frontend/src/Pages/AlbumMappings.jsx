import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ALBUM_MAPPING_PATH,
  formatLastfmDate,
  formatMappingStatus,
  lastfmUrl,
  requestLastfmJson,
} from "../features/lastfm/lastfm.js";
import { communityErrorFrom } from "../features/community/community.js";

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "no_catalog_match", label: "No catalog match" },
];

const ACTIONS = [
  { value: "approve", label: "Approve mapping" },
  { value: "reject", label: "Reject case" },
  { value: "no-catalog-match", label: "No catalog match" },
  { value: "refresh", label: "Request refreshed evidence" },
  { value: "revoke", label: "Revoke mapping" },
];

function errorState(error, fallback) {
  return communityErrorFrom(error, fallback) || { message: fallback, code: "REQUEST_FAILED", status: 0 };
}

function candidateLabel(candidate) {
  return `${candidate?.title || "Untitled album"} — ${candidate?.artistDisplayName || "Unknown artist"}`;
}

function evidenceTypeLabel(item) {
  return item?.type || item?.source || item?.provider || "Provider evidence";
}

function candidateEvidenceSummary(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "Evidence";
    const facts = [evidenceTypeLabel(item)];
    if (Number.isFinite(Number(item.sharedTrackCount))) facts.push(`${item.sharedTrackCount} shared`);
    if (Number.isFinite(Number(item.missingTrackCount))) facts.push(`${item.missingTrackCount} missing`);
    return facts.join(" · ");
  });
}

function Evidence({ evidence }) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return <p className="mapping-muted">No provider evidence is available yet.</p>;
  }

  return (
    <div className="mapping-evidence-list">
      {evidence.map((item, index) => (
        <article className="mapping-evidence" key={`${item.source || "source"}-${item.retrievedAt || index}`}>
          <div className="mapping-evidence-heading">
            <strong>{evidenceTypeLabel(item)}</strong>
            {item.retrievedAt ? <time>{formatLastfmDate(item.retrievedAt)}</time> : null}
          </div>
          {item.sourceLink || item.url ? <a href={item.sourceLink || item.url} rel="noreferrer" target="_blank">Open source</a> : null}
          <div className="mapping-evidence-facts">
            {item.provider ? <span>Provider: {item.provider}</span> : null}
            {Number.isFinite(Number(item.sharedTrackCount)) ? <span>{item.sharedTrackCount} shared tracks</span> : null}
            {Number.isFinite(Number(item.missingTrackCount)) ? <span>{item.missingTrackCount} missing tracks</span> : null}
            {Number.isFinite(Number(item.providerTrackCount)) ? <span>{item.providerTrackCount} provider tracks</span> : null}
            {Number.isFinite(Number(item.catalogTrackCount)) ? <span>{item.catalogTrackCount} catalog tracks</span> : null}
            {Array.isArray(item.extraTracks) && item.extraTracks.length > 0 ? <span>{item.extraTracks.length} extra tracks</span> : null}
            {item.countDifference !== undefined ? <span>Count difference: {item.countDifference}</span> : null}
            {item.duplicateTitleAmbiguity ? <span>Duplicate-title ambiguity</span> : null}
            {Array.isArray(item.duplicateTitles) && item.duplicateTitles.length > 0 ? <span>Duplicate titles: {item.duplicateTitles.join(", ")}</span> : null}
            {Array.isArray(item.identifierConflicts) && item.identifierConflicts.length > 0 ? <span>Identifier conflicts: {item.identifierConflicts.join("; ")}</span> : null}
          </div>
          {Array.isArray(item.sharedTracks) && item.sharedTracks.length > 0 ? <p>Shared: {item.sharedTracks.slice(0, 8).join(", ")}</p> : null}
          {Array.isArray(item.missingTracks) && item.missingTracks.length > 0 ? <p>Missing: {item.missingTracks.slice(0, 8).join(", ")}</p> : null}
          {Array.isArray(item.extraTracks) && item.extraTracks.length > 0 ? <p>Extra: {item.extraTracks.slice(0, 8).join(", ")}</p> : null}
        </article>
      ))}
    </div>
  );
}

export default function AlbumMappings() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { caseId = "" } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("pending");
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState("");
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueLoadingMore, setQueueLoadingMore] = useState(false);
  const [queueError, setQueueError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [action, setAction] = useState("approve");
  const [reason, setReason] = useState("");
  const [selectedAlbumId, setSelectedAlbumId] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [command, setCommand] = useState({ pending: false, error: null, success: "" });
  const [accessDenied, setAccessDenied] = useState(false);

  const loadQueue = useCallback(async ({ cursor = "", append = false } = {}) => {
    if (!isLoaded || !isSignedIn) {
      setQueueLoading(false);
      return;
    }
    if (append) setQueueLoadingMore(true); else setQueueLoading(true);
    setQueueError(null);
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(ALBUM_MAPPING_PATH, { status, cursor, priority: priorityOnly ? "high" : "" }),
        { headers: { Authorization: `Bearer ${token}` } },
        "The album mapping queue could not be loaded.",
      );
      const incoming = Array.isArray(data?.items) ? data.items : [];
      setItems((current) => append ? [...current, ...incoming] : incoming);
      setNextCursor(data?.nextCursor || "");
    } catch (error) {
      const parsed = errorState(error, "The album mapping queue could not be loaded.");
      setQueueError(parsed);
      if (parsed.status === 403 || parsed.code === "MODERATOR_REQUIRED") setAccessDenied(true);
    } finally {
      setQueueLoading(false);
      setQueueLoadingMore(false);
    }
  }, [getToken, isLoaded, isSignedIn, priorityOnly, status]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!caseId || !isLoaded || !isSignedIn) return undefined;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    async function loadDetail() {
      try {
        const token = await getToken();
        const data = await requestLastfmJson(
          lastfmUrl(`${ALBUM_MAPPING_PATH}/${encodeURIComponent(caseId)}`),
          { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
          "This album mapping case could not be loaded.",
        );
        if (!controller.signal.aborted) {
          setDetail(data);
          setSelectedAlbumId(data?.mapping?.albumId || "");
          setCommand({ pending: false, error: null, success: "" });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const parsed = errorState(error, "This album mapping case could not be loaded.");
          setDetailError(parsed);
          if (parsed.status === 403 || parsed.code === "MODERATOR_REQUIRED") setAccessDenied(true);
        }
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }
    loadDetail();
    return () => controller.abort();
  }, [caseId, getToken, isLoaded, isSignedIn]);

  const selectedCase = detail?.case || null;
  const candidates = useMemo(() => Array.isArray(selectedCase?.candidates) ? selectedCase.candidates : [], [selectedCase]);

  async function searchCatalog(event) {
    event?.preventDefault();
    if (catalogQuery.trim().length < 2) {
      setCatalogResults([]);
      return;
    }
    setCatalogLoading(true);
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(`${ALBUM_MAPPING_PATH}/catalog-search`, { q: catalogQuery.trim() }),
        { headers: { Authorization: `Bearer ${token}` } },
        "Catalog search failed.",
      );
      setCatalogResults(Array.isArray(data?.items) ? data.items : []);
    } catch (error) {
      setCommand((current) => ({ ...current, error: errorState(error, "Catalog search failed.") }));
    } finally {
      setCatalogLoading(false);
    }
  }

  async function applyAction(event) {
    event.preventDefault();
    if (!selectedCase || command.pending) return;
    if (!reason.trim()) {
      setCommand((current) => ({ ...current, error: { message: "A decision reason is required.", code: "REASON_REQUIRED" } }));
      return;
    }
    if (action === "approve" && !selectedAlbumId) {
      setCommand((current) => ({ ...current, error: { message: "Select an existing catalog album before approving.", code: "ALBUM_REQUIRED" } }));
      return;
    }
    setCommand({ pending: true, error: null, success: "" });
    try {
      const token = await getToken();
      await requestLastfmJson(
        lastfmUrl(`${ALBUM_MAPPING_PATH}/${encodeURIComponent(selectedCase.caseId || caseId)}/${action}`),
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: selectedCase.revision, reason: reason.trim(), ...(action === "approve" ? { albumId: selectedAlbumId } : {}) }),
        },
        "The mapping decision could not be applied.",
      );
      setCommand({ pending: false, error: null, success: `${ACTIONS.find((item) => item.value === action)?.label || "Decision"} recorded.` });
      setReason("");
      await loadQueue();
      if (action !== "revoke") navigate(`${ALBUM_MAPPING_PATH}/${encodeURIComponent(caseId)}`, { replace: true });
      else setDetail(null);
    } catch (error) {
      const parsed = errorState(error, "The mapping decision could not be applied.");
      setCommand({ pending: false, error: parsed, success: "" });
      if (parsed.status === 409) {
        setDetailError({ message: "This case changed while you were reviewing it. Reload the case before trying again.", code: parsed.code });
      }
    }
  }

  if (!isLoaded) return <section className="community-page mapping-page"><div className="community-loading" role="status">Opening album mapping review…</div></section>;
  if (!isSignedIn) return <section className="community-page mapping-page"><div className="community-empty-state"><h1>Sign in to open mapping review.</h1><p>Album-name evidence is restricted to moderators.</p></div></section>;
  if (accessDenied) return <section className="community-page mapping-page"><div className="community-empty-state" role="alert"><p className="community-eyebrow">Restricted desk · 403</p><h1>Moderator access required.</h1><p>This queue is separate from album submissions and is only available to the existing moderator allowlist.</p></div></section>;

  return (
    <section className="community-page mapping-page">
      <header className="community-page-header mapping-page-header">
        <div>
          <p className="community-page-kicker">Catalog identity · moderator desk</p>
          <h1 className="community-page-title">Album name mappings</h1>
          <p className="community-page-description">Review Last.fm names against existing Rescened albums. Approval establishes identity only; it does not certify a standard tracklist or create diary entries.</p>
        </div>
        <div className="mapping-header-actions">
          <Link className="community-secondary-button" to="/moderation/album-suggestions">Album submissions</Link>
          <Link className="community-secondary-button" to="/suggestions/new">Submit a missing catalog album</Link>
          <button className="community-secondary-button" disabled={queueLoading} onClick={() => loadQueue()} type="button">Refresh queue</button>
        </div>
      </header>

      <div className="mapping-workspace">
        <aside className="mapping-queue-panel community-panel" aria-label="Album mapping queue">
          <div className="mapping-filter-row">
            <label>Review status<select value={status} onChange={(event) => setStatus(event.target.value)}>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="mapping-checkbox"><input checked={priorityOnly} onChange={(event) => setPriorityOnly(event.target.checked)} type="checkbox" /> High encounter priority</label>
          </div>
          {queueError ? <div className="community-message community-message-error" role="alert"><strong>{queueError.message}</strong>{queueError.code ? <code>{queueError.code}</code> : null}</div> : null}
          {queueLoading && items.length === 0 ? <div className="community-loading" role="status">Loading mapping cases…</div> : null}
          {!queueLoading && !queueError && items.length === 0 ? <div className="community-empty-state"><h2>No cases in this view.</h2><p>Unknown names appear here after the supervised worker gathers provider evidence.</p></div> : null}
          {items.length > 0 ? <ol className="mapping-queue-list">{items.map((item) => <li key={item.caseId}><button className={`mapping-queue-card${item.caseId === caseId ? " mapping-queue-card-selected" : ""}`} onClick={() => navigate(`${ALBUM_MAPPING_PATH}/${encodeURIComponent(item.caseId)}`)} type="button"><span className="mapping-queue-topline"><span className="community-status">{formatMappingStatus(item.status)}</span><span>{item.encounterCount || 0} encounters</span></span><strong>{item.album || "Unknown album"}</strong><span>{item.artist || "Unknown artist"}</span><small>Priority {item.priority ?? item.encounterCount ?? 0} · Rev. {item.revision || 1}</small></button></li>)}</ol> : null}
          {nextCursor ? <button className="community-secondary-button mapping-load-more" disabled={queueLoadingMore} onClick={() => loadQueue({ cursor: nextCursor, append: true })} type="button">{queueLoadingMore ? "Loading…" : "Load more"}</button> : null}
        </aside>

        <section className="mapping-detail-panel community-panel" aria-label="Selected album mapping">
          {!caseId ? <div className="community-empty-state"><p className="community-eyebrow">No selection</p><h2>Choose a mapping case to inspect.</h2><p>Provider evidence and catalog candidates will appear here without exposing listener identities or exact listening times.</p></div> : null}
          {caseId && detailLoading ? <div className="community-loading" role="status">Loading mapping evidence…</div> : null}
          {caseId && detailError ? <div className="community-message community-message-error" role="alert"><strong>{detailError.message}</strong>{detailError.code ? <code>{detailError.code}</code> : null}<button className="community-text-button" onClick={() => navigate(`${ALBUM_MAPPING_PATH}/${encodeURIComponent(caseId)}`)} type="button">Try again</button></div> : null}
          {selectedCase && !detailLoading ? (
            <div className="mapping-detail-content">
              <div className="mapping-detail-toolbar"><div><p className="community-eyebrow">Mapping case</p><code>{selectedCase.caseId}</code></div><button className="community-text-button" onClick={() => navigate(ALBUM_MAPPING_PATH)} type="button">Close</button></div>
              <div className="mapping-detail-heading"><div><h2>{selectedCase.album}</h2><p>{selectedCase.artist}</p></div><span className="community-status">{formatMappingStatus(selectedCase.status)}</span></div>
              <div className="mapping-fact-grid"><div><span>Encounters</span><strong>{selectedCase.encounterCount || 0}</strong></div><div><span>Revision</span><strong>{selectedCase.revision || 1}</strong></div><div><span>Normalization</span><strong>v{selectedCase.normalizationVersion || 1}</strong></div></div>
              <section className="mapping-detail-section"><h3>Candidate albums</h3><p className="mapping-muted">Choose an existing public catalog album. Candidate overlap is evidence for review, never automatic approval.</p>{candidates.length === 0 ? <p className="mapping-muted">No local catalog candidates were found.</p> : <div className="mapping-candidate-list">{candidates.map((candidate) => <label className={`mapping-candidate${selectedAlbumId === candidate.albumId ? " mapping-candidate-selected" : ""}`} key={candidate.albumId}><input checked={selectedAlbumId === candidate.albumId} name="mapping-candidate" onChange={() => setSelectedAlbumId(candidate.albumId)} type="radio" /><span><strong>{candidateLabel(candidate)}</strong><small>{candidate.albumId} · catalog rev. {candidate.catalogRevision || "?"}</small>{candidateEvidenceSummary(candidate.evidence).map((summary, index) => <small key={`${candidate.albumId}-${summary}-${index}`}>{summary}</small>)}</span></label>)}</div>}</section>
              <section className="mapping-detail-section"><h3>Search existing catalog</h3><form className="mapping-catalog-search" onSubmit={searchCatalog}><input aria-label="Search existing catalog" onChange={(event) => setCatalogQuery(event.target.value)} placeholder="Album or artist" value={catalogQuery} /><button className="community-secondary-button" disabled={catalogLoading} type="submit">{catalogLoading ? "Searching…" : "Search"}</button></form>{catalogResults.length > 0 ? <div className="mapping-candidate-list">{catalogResults.map((candidate) => <button className="mapping-catalog-result" key={candidate.albumId} onClick={() => setSelectedAlbumId(candidate.albumId)} type="button"><strong>{candidateLabel(candidate)}</strong><small>{candidate.albumId} · catalog rev. {candidate.catalogRevision || "?"}</small></button>)}</div> : null}</section>
              <section className="mapping-detail-section"><h3>Provider evidence</h3><Evidence evidence={selectedCase.evidence} /></section>
              {detail?.mapping ? <section className="mapping-detail-section"><h3>Current mapping</h3><p>{candidateLabel(detail.mapping)} · {formatMappingStatus(detail.mapping.status)}</p><p className="mapping-muted">Reviewed catalog revision {detail.mapping.catalogRevision || "unknown"}. Baseline tracklist availability is reviewed separately.</p></section> : null}
              <form className="mapping-decision-form" onSubmit={applyAction}><label>Decision<select value={action} onChange={(event) => setAction(event.target.value)}>{ACTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>Decision reason<textarea maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="Explain the evidence and decision." required rows="4" value={reason} /></label>{command.error ? <p className="community-message community-message-error" role="alert">{command.error.message}{command.error.code ? <code>{command.error.code}</code> : null}</p> : null}{command.success ? <p className="community-message community-message-success" role="status">{command.success}</p> : null}<button className="community-primary-button" disabled={command.pending} type="submit">{command.pending ? "Saving decision…" : "Save decision"}</button></form>
              {Array.isArray(detail?.history) && detail.history.length > 0 ? <section className="mapping-detail-section"><h3>Decision history</h3><div className="mapping-history">{detail.history.map((entry, index) => <article key={`${entry.revision || index}-${entry.action || "event"}`}><strong>{formatMappingStatus(entry.action)}</strong><span>{entry.reason || "No reason supplied"}</span><time>{formatLastfmDate(entry.createdAt || entry.at)}</time></article>)}</div></section> : null}
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}
