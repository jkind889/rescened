import { useCallback, useEffect, useId, useRef, useState } from "react";
import { API_BASE_URL } from "../../config/api.js";
import { communityErrorFrom, requestCommunityJson } from "../../features/community/community.js";
import "./ContributorEditionPicker.css";

const BASE = `${API_BASE_URL}/suggestions/editions`;

function editionLabel(edition) {
  return [edition.title, edition.date, edition.country, edition.formats?.join(", "), edition.disambiguation].filter(Boolean).join(" · ");
}

export default function ContributorEditionPicker({ getToken, knownGroup = "", selection = null, onSelect, onClear, disabled = false, onBusyChange }) {
  const id = useId();
  const [enabled, setEnabled] = useState(false);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState(null);
  const [chosenGroup, setChosenGroup] = useState("");
  const [browse, setBrowse] = useState(null);
  const [releaseInput, setReleaseInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const operation = useRef(null);
  const group = knownGroup || chosenGroup;
  const currentGroup = useRef(group);
  currentGroup.current = group;

  const request = useCallback(async (path, options = {}) => {
    if (typeof getToken !== "function") throw new Error("Sign in to choose an edition.");
    const token = await getToken();
    if (!token) throw new Error("Your session could not be verified.");
    return requestCommunityJson(`${BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } }, "Edition lookup failed.");
  }, [getToken]);

  useEffect(() => {
    const controller = new AbortController();
    request("/capabilities", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) setEnabled(value.enabled === true);
    }).catch(() => { /* Manual metadata submission remains available. */ });
    return () => { controller.abort(); operation.current?.abort(); };
  }, [request]);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  async function perform(work, apply) {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await work(controller.signal);
      if (!controller.signal.aborted && operation.current === controller) apply(result);
    } catch (failure) {
      if (!controller.signal.aborted && operation.current === controller) setError(communityErrorFrom(failure, "Edition lookup failed."));
    } finally {
      if (operation.current === controller) { operation.current = null; setBusy(false); }
    }
  }

  function searchGroups() {
    const q = query.trim();
    if (q.length < 2) return;
    perform((signal) => request(`/groups?q=${encodeURIComponent(q)}`, { signal }), (value) => setGroups(value.items || []));
  }

  function loadEditions(offset = 0, selectedGroup = group) {
    if (!selectedGroup) return;
    setChosenGroup(selectedGroup);
    currentGroup.current = selectedGroup;
    perform((signal) => request("/candidates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ releaseGroupMbid: selectedGroup, offset }), signal }), (value) => {
      if (currentGroup.current !== selectedGroup) return;
      setBrowse({ ...value, group: selectedGroup });
    });
  }

  function preview(releaseMbid) {
    if (!group || !releaseMbid.trim()) return;
    const selectedGroup = group;
    perform((signal) => request("/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ releaseGroupMbid: selectedGroup, releaseMbid: releaseMbid.trim() }), signal }), (value) => {
      if (currentGroup.current === selectedGroup) onSelect(value);
    });
  }

  if (!enabled && !selection) return null;
  const currentBrowse = browse?.group === group ? browse : null;
  const items = currentBrowse?.items || [];
  const hasMoreEditions = currentBrowse?.nextOffset !== undefined && currentBrowse?.nextOffset !== null;
  return (
    <div className="contributor-editions" aria-busy={busy}>
      {selection ? (
        <div className="contributor-editions-selection">
          <h3>Proposed edition</h3>
          <p>{editionLabel(selection.candidate)}</p>
          <a href={selection.candidate.sourceUrl} target="_blank" rel="noreferrer">MusicBrainz edition</a>
          <button className="suggestion-form-remove" type="button" disabled={disabled || busy} onClick={onClear}>Remove edition proposal</button>
        </div>
      ) : null}
      {enabled ? (
        <div className="contributor-editions-discovery">
          {!knownGroup ? (
            <div className="contributor-editions-controls">
              <label className="suggestion-form-field" htmlFor={`${id}-query`}><span>Find a release group</span><input className="suggestion-form-input" id={`${id}-query`} value={query} maxLength={200} disabled={disabled || busy} onChange={(event) => setQuery(event.target.value)} /></label>
              <button className="suggestion-form-add" type="button" disabled={disabled || busy || query.trim().length < 2} onClick={searchGroups}>Search groups</button>
              {groups?.length ? <ul className="contributor-editions-list">{groups.map((item) => <li key={item.releaseGroupMbid || item.mbid}><button className="suggestion-form-add" type="button" disabled={disabled || busy} onClick={() => loadEditions(0, item.releaseGroupMbid || item.mbid)}>{item.title} · {item.artistDisplayName}</button></li>)}</ul> : groups && !busy ? <p role="status">No release groups found.</p> : null}
            </div>
          ) : null}
          {group ? <button className="suggestion-form-add" type="button" disabled={disabled || busy} onClick={() => loadEditions()}>Find editions</button> : null}
          {currentBrowse?.invalid ? <p role="status">Some edition records were unavailable.</p> : currentBrowse?.incomplete && !hasMoreEditions ? <p role="status">Edition discovery is incomplete.</p> : null}
          {currentBrowse ? <ul className="contributor-editions-list">{items.map((edition) => <li key={edition.releaseMbid}><button className="suggestion-form-add" type="button" disabled={disabled || busy} onClick={() => preview(edition.releaseMbid)}>{editionLabel(edition)}{Number.isInteger(edition.trackCount) ? ` · ${edition.trackCount} tracks` : ""}</button></li>)}</ul> : null}
          {currentBrowse && !items.length && !busy ? <p role="status">No editions found on this page.</p> : null}
          {hasMoreEditions ? <button className="suggestion-form-add" type="button" disabled={disabled || busy} onClick={() => loadEditions(currentBrowse.nextOffset)}>More editions</button> : null}
          {group ? <div className="contributor-editions-controls"><label className="suggestion-form-field" htmlFor={`${id}-release`}><span>MusicBrainz release URL or ID</span><input className="suggestion-form-input" id={`${id}-release`} value={releaseInput} maxLength={2048} disabled={disabled || busy} onChange={(event) => setReleaseInput(event.target.value)} /></label><button className="suggestion-form-add" type="button" disabled={disabled || busy || !releaseInput.trim()} onClick={() => preview(releaseInput)}>Preview edition</button></div> : null}
        </div>
      ) : null}
      {busy ? <p role="status">Loading editions…</p> : null}
      {error ? <div role="alert"><p>{error.message}</p>{error.retryAfterSeconds ? <p>Try again in {error.retryAfterSeconds} seconds.</p> : null}</div> : null}
    </div>
  );
}
