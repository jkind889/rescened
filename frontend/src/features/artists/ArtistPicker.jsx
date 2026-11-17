import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { communityErrorFrom } from "../community/community";
import { createRequestGuard } from "./artists";
import {
  MAX_EVIDENCE_LINKS,
  candidateDetail,
  communitySelectionFrom,
  creditedDiffers,
  discoveryErrorMessage,
  fetchArtistDiscovery,
  localResultsFrom,
  normalizePickerQuery,
  pickerQueryProblem,
  pickerStatusMessage,
  providerCandidatesFrom,
  registeredNote,
  selectionFromCandidate,
  selectionFromLocal,
  selectionName,
  selectionSourceLabel,
} from "./pickerSelections.js";
import "./ArtistPicker.css";

const IDLE = { status: "idle", rows: [], error: null };

function enterPressed(event) {
  if (event.key !== "Enter" || event.nativeEvent?.isComposing) return false;
  event.preventDefault();
  return true;
}

// Links one credit to an artist by explicit choice: a Rescened artist, a
// MusicBrainz artist, or a new community artist with supporting links.
// Searching never selects anything, and the credit keeps its own wording.
//
// Lifecycle: the panel exists only while someone is signed in and is keyed by
// that user, so signing out unmounts it. Unmounting (row removal, form reset
// by changing the picker's key, navigation) aborts pending requests, and a
// per-source request guard drops any response that arrives after a newer
// search, an edit to the query, or unmount. Nothing retries by itself.
export function ArtistPicker(props) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn || !userId) {
    return <p className="artist-picker-note">Sign in to link this credit to an artist.</p>;
  }
  return <PickerPanel key={userId} {...props} />;
}

function PickerPanel({ creditName = "", value = null, onChange, disabled = false, label = "Artist" }) {
  const { getToken } = useAuth();
  const id = useId();
  const [query, setQuery] = useState(null); // null follows the credit name until edited
  const [searchedQuery, setSearchedQuery] = useState("");
  const [queryProblem, setQueryProblem] = useState("");
  const [local, setLocal] = useState(IDLE);
  const [provider, setProvider] = useState(IDLE);
  const [mode, setMode] = useState("search");
  const [draft, setDraft] = useState({ canonicalName: "", evidence: [""] });
  const [draftProblems, setDraftProblems] = useState({});
  const guards = useRef({ local: createRequestGuard(), musicbrainz: createRequestGuard() });
  const controllers = useRef({ local: null, musicbrainz: null });
  const searchInput = useRef(null);
  const summaryButton = useRef(null);
  const communityName = useRef(null);
  const pendingFocus = useRef("");

  const effectiveQuery = query === null ? creditName : query;

  const cancel = useCallback((source) => {
    guards.current[source].invalidate();
    controllers.current[source]?.abort();
    controllers.current[source] = null;
  }, []);

  useEffect(() => () => {
    cancel("local");
    cancel("musicbrainz");
  }, [cancel]);

  useEffect(() => {
    const target = { summary: summaryButton, search: searchInput, community: communityName }[pendingFocus.current];
    pendingFocus.current = "";
    target?.current?.focus();
  });

  const run = useCallback((source, searchText) => {
    cancel(source);
    const controller = new AbortController();
    controllers.current[source] = controller;
    const token = guards.current[source].begin();
    const setState = source === "local" ? setLocal : setProvider;
    setState({ status: "loading", rows: [], error: null });
    fetchArtistDiscovery(source, searchText, { getToken, signal: controller.signal })
      .then((data) => {
        if (!guards.current[source].isCurrent(token)) return;
        const rows = source === "local" ? localResultsFrom(data) : providerCandidatesFrom(data);
        setState({ status: "ready", rows, error: null });
      })
      .catch((error) => {
        if (!guards.current[source].isCurrent(token)) return;
        const parsed = communityErrorFrom(error, "Search failed");
        if (!parsed) return;
        setState({ status: "error", rows: [], error: parsed });
      })
      .finally(() => {
        if (controllers.current[source] === controller) controllers.current[source] = null;
      });
  }, [cancel, getToken]);

  // The picker sits inside other forms (an album suggestion), so it uses no
  // <form> of its own: Enter in its fields is handled here and never submits
  // the surrounding form.

  function search() {
    const problem = pickerQueryProblem(effectiveQuery);
    setQueryProblem(problem);
    if (problem) return;
    const text = normalizePickerQuery(effectiveQuery);
    setSearchedQuery(text);
    run("local", text);
    run("musicbrainz", text);
  }

  // Typing a new query makes any pending results obsolete.
  function editQuery(text) {
    setQuery(text);
    setQueryProblem("");
    if (local.status === "loading") { cancel("local"); setLocal(IDLE); }
    if (provider.status === "loading") { cancel("musicbrainz"); setProvider(IDLE); }
  }

  function choose(selection) {
    cancel("local");
    cancel("musicbrainz");
    setLocal((current) => (current.status === "loading" ? IDLE : current));
    setProvider((current) => (current.status === "loading" ? IDLE : current));
    pendingFocus.current = "summary";
    onChange?.(selection);
  }

  function removeLink() {
    pendingFocus.current = "search";
    onChange?.(null);
  }

  function openCommunity() {
    setDraft((current) => ({ ...current, canonicalName: current.canonicalName || normalizePickerQuery(effectiveQuery) }));
    setDraftProblems({});
    pendingFocus.current = "community";
    setMode("community");
  }

  function closeCommunity() {
    pendingFocus.current = "search";
    setMode("search");
  }

  function submitCommunity() {
    const result = communitySelectionFrom(draft);
    if (result.problems) {
      setDraftProblems(result.problems);
      return;
    }
    setDraftProblems({});
    setMode("search");
    choose(result.selection);
  }

  if (value) {
    const name = selectionName(value);
    return (
      <div className="artist-picker artist-picker-selected" role="group" aria-label={`${label} link`}>
        <p className="artist-picker-selection">
          <span className="artist-picker-selection-name">{name}</span>
          <span className={`artist-picker-badge artist-picker-badge-${value.kind}`}>{selectionSourceLabel(value)}</span>
        </p>
        {value.kind === "musicbrainz" && (value.disambiguation || value.type) ? (
          <p className="artist-picker-detail">{candidateDetail(value)}</p>
        ) : null}
        {creditedDiffers(creditName, value) ? (
          <p className="artist-picker-detail">The credit keeps its wording, &ldquo;{creditName}&rdquo;.</p>
        ) : null}
        <button ref={summaryButton} type="button" className="artist-picker-button" onClick={removeLink} disabled={disabled}>
          Remove link to {name}
        </button>
      </div>
    );
  }

  if (mode === "community") {
    const evidenceProblems = draftProblems.evidence || [];
    return (
      <div className="artist-picker artist-picker-community" role="group" aria-label={`Propose a new artist for ${label}`}>
        <p className="artist-picker-note">
          Propose an artist that is not on Rescened or MusicBrainz. A moderator reviews the name and your links; they stay private.
        </p>
        <label className="artist-picker-field" htmlFor={`${id}-community-name`}>
          <span>Artist name on Rescened</span>
          <input
            ref={communityName}
            id={`${id}-community-name`}
            value={draft.canonicalName}
            maxLength={200}
            aria-invalid={draftProblems.canonicalName ? "true" : undefined}
            aria-describedby={draftProblems.canonicalName ? `${id}-community-name-problem` : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, canonicalName: event.target.value }))}
            onKeyDown={(event) => { if (enterPressed(event)) submitCommunity(); }}
            disabled={disabled}
          />
        </label>
        {draftProblems.canonicalName ? <p className="artist-picker-problem" id={`${id}-community-name-problem`}>{draftProblems.canonicalName}</p> : null}
        <fieldset className="artist-picker-evidence">
          <legend>Links that show this artist exists</legend>
          {draft.evidence.map((link, index) => (
            <div key={index} className="artist-picker-evidence-row">
              <label className="artist-picker-field" htmlFor={`${id}-evidence-${index}`}>
                <span>{`Supporting link ${index + 1}`}</span>
                <input
                  id={`${id}-evidence-${index}`}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={link}
                  aria-invalid={evidenceProblems[index] ? "true" : undefined}
                  aria-describedby={evidenceProblems[index] ? `${id}-evidence-${index}-problem` : undefined}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    evidence: current.evidence.map((entry, entryIndex) => (entryIndex === index ? event.target.value : entry)),
                  }))}
                  onKeyDown={(event) => { if (enterPressed(event)) submitCommunity(); }}
                  disabled={disabled}
                />
              </label>
              {evidenceProblems[index] ? <p className="artist-picker-problem" id={`${id}-evidence-${index}-problem`}>{evidenceProblems[index]}</p> : null}
            </div>
          ))}
          {draft.evidence.length < MAX_EVIDENCE_LINKS ? (
            <button type="button" className="artist-picker-link-button" onClick={() => setDraft((current) => ({ ...current, evidence: [...current.evidence, ""] }))} disabled={disabled}>
              Add another link
            </button>
          ) : null}
        </fieldset>
        {draftProblems.form ? <p className="artist-picker-problem">{draftProblems.form}</p> : null}
        <div className="artist-picker-actions">
          <button type="button" className="artist-picker-button artist-picker-button-primary" onClick={submitCommunity} disabled={disabled}>Use this new artist</button>
          <button type="button" className="artist-picker-button" onClick={closeCommunity} disabled={disabled}>Back to search</button>
        </div>
      </div>
    );
  }

  const searched = Boolean(searchedQuery) && (local.status !== "idle" || provider.status !== "idle");
  return (
    <div className="artist-picker" role="group" aria-label={`${label} link`}>
      <div className="artist-picker-search" role="search" aria-label={`Find an artist for ${label}`}>
        <label className="artist-picker-field" htmlFor={`${id}-query`}>
          <span>Find the artist</span>
          <input
            ref={searchInput}
            id={`${id}-query`}
            type="search"
            value={effectiveQuery}
            maxLength={200}
            onChange={(event) => editQuery(event.target.value)}
            onKeyDown={(event) => { if (enterPressed(event)) search(); }}
            aria-invalid={queryProblem ? "true" : undefined}
            aria-describedby={queryProblem ? `${id}-query-problem` : undefined}
            disabled={disabled}
          />
        </label>
        <button type="button" className="artist-picker-button artist-picker-button-primary" onClick={search} disabled={disabled}>Search artists</button>
      </div>
      {queryProblem ? <p className="artist-picker-problem" id={`${id}-query-problem`}>{queryProblem}</p> : null}
      <p className="artist-picker-status" role="status" aria-live="polite">
        {pickerStatusMessage({ searchedQuery, local, provider })}
      </p>

      {searched || local.status !== "idle" ? (
        <section className="artist-picker-section" aria-labelledby={`${id}-local-heading`}>
          <h4 id={`${id}-local-heading`} className="artist-picker-heading">On Rescened</h4>
          {local.status === "loading" ? <p className="artist-picker-note">Searching Rescened…</p> : null}
          {local.status === "error" ? <p className="artist-picker-problem">{discoveryErrorMessage(local.error, "local")}</p> : null}
          {local.status === "ready" && !local.rows.length ? <p className="artist-picker-note">No Rescened artists match.</p> : null}
          {local.rows.length ? (
            <ul className="artist-picker-results" aria-label="Rescened artists">
              {local.rows.map((row) => (
                <li key={row.artistId} className="artist-picker-result">
                  <div className="artist-picker-result-copy">
                    <span className="artist-picker-result-name">{row.name}</span>
                    <span className="artist-picker-detail" id={`${id}-local-${row.artistId}`}>
                      {row.releaseCount ? `${row.releaseCount} release${row.releaseCount === 1 ? "" : "s"}` : "No releases yet"}
                      {row.knownFor.length ? ` · ${row.knownFor.join(", ")}` : ""}
                      {row.match && row.match.kind !== "name" ? ` · also credited as ${row.match.name}` : ""}
                    </span>
                  </div>
                  <button type="button" className="artist-picker-button" aria-describedby={`${id}-local-${row.artistId}`} onClick={() => choose(selectionFromLocal(row))} disabled={disabled}>
                    Choose {row.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {searched || provider.status !== "idle" ? (
        <section className="artist-picker-section artist-picker-section-external" aria-labelledby={`${id}-provider-heading`}>
          <h4 id={`${id}-provider-heading`} className="artist-picker-heading">From MusicBrainz</h4>
          {provider.status === "loading" ? <p className="artist-picker-note">Asking MusicBrainz…</p> : null}
          {provider.status === "error" ? (
            <div className="artist-picker-error-row">
              <p className="artist-picker-problem">{discoveryErrorMessage(provider.error, "musicbrainz")}</p>
              <button type="button" className="artist-picker-link-button" onClick={() => run("musicbrainz", searchedQuery)} disabled={disabled}>
                Try MusicBrainz again
              </button>
            </div>
          ) : null}
          {provider.status === "ready" && !provider.rows.length ? <p className="artist-picker-note">No MusicBrainz artists match.</p> : null}
          {provider.rows.length ? (
            <ul className="artist-picker-results" aria-label="MusicBrainz artists">
              {provider.rows.map((row) => (
                <li key={row.artistMbid} className="artist-picker-result artist-picker-result-external">
                  <div className="artist-picker-result-copy">
                    <span className="artist-picker-result-name">{row.name}</span>
                    <span className="artist-picker-detail" id={`${id}-mb-${row.artistMbid}`}>
                      {candidateDetail(row) || "No description on MusicBrainz"}
                      {row.registeredArtistId ? ` · ${registeredNote(row)}` : ""}
                    </span>
                    <a className="artist-picker-source" href={row.sourceUrl} target="_blank" rel="noopener noreferrer">
                      View {row.name} on MusicBrainz
                    </a>
                  </div>
                  <button type="button" className="artist-picker-button" aria-describedby={`${id}-mb-${row.artistMbid}`} onClick={() => choose(selectionFromCandidate(row))} disabled={disabled}>
                    Choose {row.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <div className="artist-picker-fallback">
        <button type="button" className="artist-picker-link-button" onClick={openCommunity} disabled={disabled}>
          Not listed? Propose a new artist
        </button>
      </div>
    </div>
  );
}

export default ArtistPicker;
