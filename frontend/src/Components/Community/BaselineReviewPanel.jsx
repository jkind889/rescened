import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../../config/api.js";
import { communityErrorFrom, requestCommunityJson } from "../../features/community/community.js";
import "./BaselineReviewPanel.css";

const BASE_PATH = "/moderation/album-baselines";
function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure request identifiers are unavailable.");
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((value, index) => `${[4, 6, 8, 10].includes(index) ? "-" : ""}${value.toString(16).padStart(2, "0")}`).join("");
}

function displayError(error, fallback) {
  return communityErrorFrom(error, fallback) || { message: fallback, code: "REQUEST_FAILED", status: 0 };
}

function candidateLabel(item) {
  return `${item?.title || "Untitled release"} — ${item?.artistDisplayName || "Unknown artist"}`;
}

function durationLabel(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 1) return "—";
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function flagLabel(flag) {
  return flag ? "Enabled" : "Disabled";
}

function rationaleText(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" || typeof item === "number").join(" ");
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

// Snapshots are bound to the target revision they were previewed against, so a stale review
// cannot reuse its previous selection; the moderator must fetch a fresh candidate.
function reusableCandidate(data) {
  if (data?.status === "stale") return null;
  return data?.selection || data?.activeBaseline?.candidate || null;
}

function CandidateTracks({ candidate }) {
  if (!Array.isArray(candidate?.tracks) || candidate.tracks.length === 0) {
    return <p className="baseline-muted">No complete tracklist is available for this release.</p>;
  }
  return (
    <div className="baseline-track-table-wrap">
      <table className="baseline-track-table">
        <thead><tr><th scope="col">Disc</th><th scope="col">No.</th><th scope="col">Track</th><th scope="col">Artist</th><th scope="col">Time</th></tr></thead>
        <tbody>
          {candidate.tracks.map((track) => (
            <tr key={`${track.discNumber}-${track.trackNumber}-${track.releaseTrackMbid}`}>
              <td>{track.discNumber}</td>
              <td>{track.trackNumber}</td>
              <td>{track.title}</td>
              <td>{track.artistDisplayName || "—"}</td>
              <td>{durationLabel(track.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateSummary({ candidate, rationale, incomplete, ambiguous }) {
  if (!candidate) return null;
  const explanation = rationaleText(rationale);
  return (
    <section className="baseline-candidate-preview" aria-labelledby="baseline-candidate-heading">
      <div className="baseline-section-heading">
        <div>
          <p className="community-eyebrow">Release candidate</p>
          <h3 id="baseline-candidate-heading">{candidateLabel(candidate)}</h3>
        </div>
        <span className="baseline-candidate-count">{candidate.tracks?.length || 0} tracks</span>
      </div>
      <div className="baseline-candidate-facts">
        <span>{candidate.date || "Date unavailable"}</span>
        <span>{candidate.country || "Country unavailable"}</span>
        <span>{candidate.formats?.join(", ") || "Format unavailable"}</span>
        {candidate.status ? <span>{candidate.status}</span> : null}
      </div>
      {candidate.disambiguation ? <p className="baseline-muted">Edition note: {candidate.disambiguation}</p> : null}
      {incomplete ? <p className="baseline-warning">The release browse was incomplete. Review the alternatives before confirming.</p> : null}
      {ambiguous ? <p className="baseline-warning">Several releases are equally suitable. Confirm this edition only after checking its date and edition details.</p> : null}
      {explanation ? <p className="baseline-rationale">{explanation}</p> : null}
      <CandidateTracks candidate={candidate} />
      <a className="baseline-source-link" href={candidate.sourceUrl} rel="noreferrer" target="_blank">Open MusicBrainz release ↗</a>
    </section>
  );
}

// onStateChange fires only after recorded decisions. Provider lookups change no review state, and
// parents that refresh on it may remount this panel and discard the unsaved recommendation.
export default function BaselineReviewPanel({ kind, id, target = null, compact = false, onStateChange, onBusyChange }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState(null);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [groupQuery, setGroupQuery] = useState("");
  const [groupResults, setGroupResults] = useState([]);
  const [groupLoading, setGroupLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(target?.releaseGroupMbid || "");
  const [releaseInput, setReleaseInput] = useState("");
  const [reason, setReason] = useState("");
  const [command, setCommand] = useState({ pending: false, error: null, success: "" });
  const [candidateOffset, setCandidateOffset] = useState("");
  const requestSequence = useRef(0);
  const providerController = useRef(null);

  const targetKey = `${kind}:${id || ""}`;
  useEffect(() => {
    onBusyChange?.(candidateLoading || command.pending);
  }, [candidateLoading, command.pending, onBusyChange]);
  const runRequest = useCallback(async (url, options, fallback) => {
    const token = await getToken();
    if (!token) throw Object.assign(new Error("Your session could not be verified."), { status: 401, code: "UNAUTHORIZED" });
    return requestCommunityJson(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options?.headers || {}) },
    }, fallback);
  }, [getToken]);

  const loadDetail = useCallback(async (signal) => {
    if (!id || !isLoaded || !isSignedIn) return;
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const data = await runRequest(`${API_BASE_URL}${BASE_PATH}/${kind}/${encodeURIComponent(id)}`, { signal }, "This baseline review could not be loaded.");
      if (signal.aborted || sequence !== requestSequence.current) return;
      setDetail(data);
      setSelectedGroup(data?.target?.releaseGroupMbid || target?.releaseGroupMbid || "");
      setSelectedCandidate(reusableCandidate(data));
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") return;
      setDetailError(displayError(error, "This baseline review could not be loaded."));
    } finally {
      if (!signal.aborted && sequence === requestSequence.current) setDetailLoading(false);
    }
  }, [id, isLoaded, isSignedIn, kind, runRequest, target?.releaseGroupMbid]);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setRecommendation(null);
    setCandidateError(null);
    setCandidateOffset("");
    loadDetail(controller.signal);
    return () => {
      controller.abort();
      providerController.current?.abort();
    };
  }, [loadDetail, targetKey]);

  const flags = detail?.flags || {};
  const hasBaseline = Boolean(detail?.activeBaseline);
  // Only a currently reviewed head accepts replace; queued, stale, deferred, and revoked reviews use confirm.
  const isReviewed = detail?.status === "reviewed";
  const canRevoke = Boolean(isReviewed || hasBaseline || detail?.status === "stale");
  const knownGroup = detail?.target?.releaseGroupMbid || target?.releaseGroupMbid || "";
  const canDiscover = flags.discovery !== false;
  const canModerate = flags.moderation !== false;
  const candidates = useMemo(() => Array.isArray(recommendation?.items) ? recommendation.items : [], [recommendation]);

  async function searchGroups(event) {
    event?.preventDefault();
    if (groupQuery.trim().length < 2) return;
    setGroupLoading(true);
    setCandidateError(null);
    providerController.current?.abort();
    const controller = new AbortController();
    providerController.current = controller;
    try {
      const data = await runRequest(`${API_BASE_URL}${BASE_PATH}/groups?q=${encodeURIComponent(groupQuery.trim())}`, { signal: controller.signal }, "MusicBrainz release-group search failed.");
      if (controller.signal.aborted) return;
      setGroupResults(Array.isArray(data?.items) ? data.items : []);
    } catch (error) {
      if (!controller.signal.aborted) setCandidateError(displayError(error, "MusicBrainz release-group search failed."));
    } finally {
      if (providerController.current === controller) providerController.current = null;
      if (!controller.signal.aborted) setGroupLoading(false);
    }
  }

  async function loadCandidates(offset = 0, group = selectedGroup) {
    if (!group || !canDiscover) return;
    setCandidateLoading(true);
    setCandidateError(null);
    providerController.current?.abort();
    const controller = new AbortController();
    providerController.current = controller;
    try {
      const data = await runRequest(`${API_BASE_URL}${BASE_PATH}/${kind}/${encodeURIComponent(id)}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseGroupMbid: group, ...(offset ? { offset } : {}) }),
        signal: controller.signal,
      }, "MusicBrainz release recommendations are unavailable.");
      if (controller.signal.aborted) return;
      setRecommendation((current) => offset ? { ...data, items: [...(current?.items || []), ...(data?.items || [])] } : data);
      if (data?.candidate) setSelectedCandidate(data.candidate);
      setCandidateOffset(data?.nextOffset ?? "");
    } catch (error) {
      if (!controller.signal.aborted) setCandidateError(displayError(error, "MusicBrainz release recommendations are unavailable."));
    } finally {
      if (providerController.current === controller) providerController.current = null;
      if (!controller.signal.aborted) setCandidateLoading(false);
    }
  }

  async function previewRelease(event, valueOverride = "") {
    event.preventDefault();
    const input = valueOverride || releaseInput;
    if (!input.trim() || !selectedGroup) return;
    setCandidateLoading(true);
    setCandidateError(null);
    providerController.current?.abort();
    const controller = new AbortController();
    providerController.current = controller;
    try {
      const data = await runRequest(`${API_BASE_URL}${BASE_PATH}/${kind}/${encodeURIComponent(id)}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseMbid: input.trim(), releaseGroupMbid: selectedGroup }),
        signal: controller.signal,
      }, "The selected MusicBrainz release could not be previewed.");
      if (controller.signal.aborted) return;
      setSelectedCandidate(data?.candidate || null);
      setRecommendation((current) => ({ ...(current || {}), candidate: data?.candidate || null }));
    } catch (error) {
      if (!controller.signal.aborted) setCandidateError(displayError(error, "The selected MusicBrainz release could not be previewed."));
    } finally {
      if (providerController.current === controller) providerController.current = null;
      if (!controller.signal.aborted) setCandidateLoading(false);
    }
  }

  async function applyAction(action) {
    if (!canModerate || command.pending) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setCommand({ pending: false, error: { message: "Add a reason before recording this baseline decision.", code: "REASON_REQUIRED" }, success: "" });
      return;
    }
    if (["confirm", "replace"].includes(action) && !selectedCandidate) {
      setCommand({ pending: false, error: { message: "Select and preview a complete MusicBrainz release first.", code: "CANDIDATE_REQUIRED" }, success: "" });
      return;
    }
    setCommand({ pending: true, error: null, success: "" });
    try {
      const body = {
        expectedRevision: detail?.revision,
        expectedTargetRevision: detail?.targetRevision ?? detail?.target?.catalogRevision ?? detail?.target?.submissionRevision,
        reason: trimmedReason,
        requestId: requestId(),
      };
      if (["confirm", "replace"].includes(action)) {
        body.candidateHash = selectedCandidate.tracklistHash;
        body.releaseMbid = selectedCandidate.releaseMbid;
        body.releaseGroupMbid = selectedCandidate.releaseGroupMbid;
      }
      const data = await runRequest(`${API_BASE_URL}${BASE_PATH}/${kind}/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, "The baseline decision could not be recorded.");
      setDetail(data);
      setSelectedCandidate(data?.status === "stale" ? null : reusableCandidate(data) || selectedCandidate);
      setCommand({ pending: false, error: null, success: `Baseline ${action} recorded.` });
      setReason("");
      onStateChange?.(data);
    } catch (error) {
      const parsed = displayError(error, "The baseline decision could not be recorded.");
      setCommand({ pending: false, error: parsed, success: "" });
      if (parsed.status === 409) {
        const controller = new AbortController();
        loadDetail(controller.signal);
      }
    }
  }

  if (!id) return null;
  if (!isLoaded || detailLoading) return <section className={`baseline-review-panel community-panel${compact ? " baseline-review-panel-compact" : ""}`}><div className="community-loading" role="status">Loading baseline review…</div></section>;
  if (!isSignedIn) return <section className="baseline-review-panel community-panel"><p className="baseline-muted">Sign in to review a MusicBrainz baseline.</p></section>;
  if (detailError) return <section className="baseline-review-panel community-panel" role="alert"><div className="community-message community-message-error"><strong>{detailError.message}</strong>{detailError.code ? <code>{detailError.code}</code> : null}<button className="community-text-button" onClick={() => loadDetail(new AbortController().signal)} type="button">Try again</button></div></section>;

  return (
    <section className={`baseline-review-panel community-panel${compact ? " baseline-review-panel-compact" : ""}`} aria-labelledby="baseline-review-title">
      <div className="baseline-panel-heading">
        <div>
          <p className="community-eyebrow">MusicBrainz baseline</p>
          <h2 id="baseline-review-title">{detail?.target?.title || target?.title || "Tracklist review"}</h2>
          <p>{detail?.target?.artistDisplayName || target?.artistDisplayName || "Choose a reviewed standard release."}</p>
        </div>
        <span className={`community-status community-status-${detail?.status || "pending"}`}>{detail?.status || "pending"}</span>
      </div>
      <div className="baseline-flag-row"><span>Discovery: {flagLabel(canDiscover)}</span><span>Moderation: {flagLabel(canModerate)}</span>{detail?.revision ? <span>Review revision {detail.revision}</span> : null}</div>
      {detail?.status === "stale" ? <p className="baseline-warning">The catalog record changed after this review. Suggest or preview a release again before confirming.</p> : null}
      {detail?.activeBaseline ? <p className="baseline-success">Active baseline v{detail.activeBaseline.version || "?"} · reviewed {detail.activeBaseline.reviewedAt ? new Date(detail.activeBaseline.reviewedAt).toLocaleDateString() : "date unavailable"}.</p> : null}

      {!selectedGroup ? (
        <section className="baseline-group-picker"><h3>Choose a MusicBrainz release group</h3><p className="baseline-muted">This record has no trusted release-group identity. Search by title and artist, then select the exact group before browsing releases.</p><form onSubmit={searchGroups}><div className="baseline-inline-form"><input aria-label="MusicBrainz release-group search" onChange={(event) => setGroupQuery(event.target.value)} placeholder="Album title and artist" value={groupQuery} /><button className="community-secondary-button" disabled={groupLoading || !canDiscover} type="submit">{groupLoading ? "Searching…" : "Search MusicBrainz"}</button></div></form>{groupResults.length ? <div className="baseline-group-results">{groupResults.map((item) => <button className="baseline-choice" key={item.releaseGroupMbid} onClick={() => { setSelectedGroup(item.releaseGroupMbid); setGroupResults([]); }} type="button"><strong>{candidateLabel(item)}</strong><small>{item.releaseGroupMbid} · {item.date || "Date unavailable"}</small></button>)}</div> : null}</section>
      ) : (
        <div className="baseline-group-selected"><span>Release group</span><code>{selectedGroup}</code><button className="community-text-button" disabled={Boolean(knownGroup)} onClick={() => { setSelectedGroup(""); setSelectedCandidate(null); setRecommendation(null); }} title={knownGroup ? "The release group is bound to this catalog identity." : "Choose another release group"} type="button">Change</button></div>
      )}

      {selectedGroup && canDiscover ? <section className="baseline-discovery"><div className="baseline-section-heading"><div><h3>Recommended standard release</h3><p className="baseline-muted">The recommendation uses official status, exact title, edition markers, date, and MBID. Track count never decides identity.</p></div><button className="community-secondary-button" disabled={candidateLoading} onClick={() => loadCandidates(0)} type="button">{candidateLoading ? "Loading…" : "Suggest a release"}</button></div>{candidateError ? <div className="community-message community-message-error" role="alert"><strong>{candidateError.message}</strong>{candidateError.code ? <code>{candidateError.code}</code> : null}</div> : null}<CandidateSummary ambiguous={recommendation?.ambiguous} candidate={selectedCandidate} incomplete={recommendation?.incomplete} rationale={recommendation?.rationale} />{candidates.length ? <div className="baseline-alternative-list"><h4>Alternative releases</h4>{candidates.map((item) => <button className={`baseline-choice${selectedCandidate?.releaseMbid === item.releaseMbid ? " baseline-choice-selected" : ""}`} key={item.releaseMbid} onClick={() => { setReleaseInput(item.releaseMbid); previewRelease({ preventDefault() {} }, item.releaseMbid); }} type="button"><strong>{candidateLabel(item)}</strong><small>{item.date || "Date unavailable"} · {item.status || "Status unavailable"}{item.disambiguation ? ` · ${item.disambiguation}` : ""}</small></button>)}{candidateOffset ? <button className="community-secondary-button" disabled={candidateLoading} onClick={() => loadCandidates(Number(candidateOffset))} type="button">Load more releases</button> : null}</div> : null}<form className="baseline-direct-preview" onSubmit={previewRelease}><label htmlFor="baseline-release-input">Preview an alternative release ID or MusicBrainz URL</label><div className="baseline-inline-form"><input id="baseline-release-input" onChange={(event) => setReleaseInput(event.target.value)} placeholder="Release UUID or https://musicbrainz.org/release/…" value={releaseInput} /><button className="community-secondary-button" disabled={candidateLoading || !releaseInput.trim()} type="submit">{candidateLoading ? "Loading…" : "Preview alternative"}</button></div></form></section> : null}
      {candidateError && (!selectedGroup || !canDiscover) ? <div className="community-message community-message-error" role="alert"><strong>{candidateError.message}</strong>{candidateError.code ? <code>{candidateError.code}</code> : null}</div> : null}
      {!canDiscover ? <p className="baseline-muted">MusicBrainz discovery is disabled. Existing catalog or submission moderation remains available.</p> : null}

      <section className="baseline-decision"><h3>Record baseline decision</h3><p className="baseline-muted">A reviewed baseline enables later listening comparison. It does not create diary entries. Catalog track correction remains a separate workflow.</p><label htmlFor="baseline-decision-reason">Reason<textarea id="baseline-decision-reason" maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="Explain why this release is the standard baseline." required rows="3" value={reason} /></label>{command.error ? <div className="community-message community-message-error" role="alert"><strong>{command.error.message}</strong>{command.error.code ? <code>{command.error.code}</code> : null}</div> : null}{command.success ? <div className="community-message community-message-success" role="status">{command.success}</div> : null}<div className="baseline-actions"><button className="community-primary-button" disabled={!canModerate || command.pending || candidateLoading || !selectedCandidate} onClick={() => applyAction(isReviewed ? "replace" : "confirm")} type="button">{command.pending ? "Saving…" : isReviewed ? "Replace baseline" : "Confirm baseline"}</button><button className="community-secondary-button" disabled={!canModerate || command.pending || candidateLoading} onClick={() => applyAction("defer")} type="button">Defer</button>{canRevoke ? <button className="community-text-button" disabled={!canModerate || command.pending || candidateLoading} onClick={() => applyAction("revoke")} type="button">Revoke baseline</button> : null}</div></section>
    </section>
  );
}
