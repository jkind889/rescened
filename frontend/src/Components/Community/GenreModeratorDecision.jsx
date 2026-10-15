import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { formatCommunityStatus } from "../../features/community/community.js";
import {
  MAX_ALBUM_GENRES,
  buildGenreDecisionsBody,
  cleanGenreName,
  fetchTopLevelGenres,
  initialGenreDecisions,
  isValidGenreName,
  previewApproval,
  searchGenres,
} from "../../features/community/genres.js";
import "./GenreSuggestion.css";

const ACTIONS = [
  { id: "approve", label: "Approve", description: "Apply the operations you accept to the album's current genres." },
  { id: "request_changes", label: "Request changes", description: "Return the suggestion to its contributor with a note." },
  { id: "reject", label: "Reject", description: "Close the suggestion when it can't be accepted or revised." },
];

const MATCH_LABELS = { exact: "same name", spelling: "close spelling", contains: "overlapping name", word: "shared word" };

// Finds another existing genre to map a proposed name onto.
function MapSearch({ disabled, onChoose }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState({ query: "", results: [] });
  const trimmed = cleanGenreName(query);

  useEffect(() => {
    if (trimmed.length < 2) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchGenres(trimmed, controller.signal).then((rows) => setSearch({ query: trimmed, results: rows })).catch(() => {});
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmed]);
  const results = trimmed.length >= 2 && search.query === trimmed ? search.results : [];

  return (
    <div className="genre-map-search">
      <input
        aria-label="Search for a genre to map onto"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search another genre"
        type="search"
        value={query}
      />
      {results.length ? (
        <ul className="genre-result-list">
          {results.map((genre) => (
            <li className="genre-result" key={genre.genreId}>
              <span>{genre.name}</span>
              <button className="community-text-button" disabled={disabled} onClick={() => { onChoose(genre); setQuery(""); }} type="button">Use</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function retryAfterLabel(seconds) {
  const value = Math.ceil(Number(seconds));
  return Number.isFinite(value) && value > 0 ? `Try again in ${value} second${value === 1 ? "" : "s"}.` : "";
}

function errorDetailText(detail) {
  if (typeof detail === "string") return detail;
  if (detail?.name) return `Conflicts with “${detail.name}”`;
  return "Additional server detail";
}

export function GenreModeratorDecision({
  submission,
  genreReview = null,
  pendingAction = "",
  error = null,
  success = null,
  onCommand,
  onClearFeedback,
}) {
  const changes = submission?.genreChanges || { add: [], remove: [], primary: null, note: "" };
  const currentGenres = genreReview?.currentGenres || submission?.baseGenres || [];
  const [action, setAction] = useState("approve");
  const [reasons, setReasons] = useState({ approve: "", request_changes: "", reject: "" });
  const [decisions, setDecisions] = useState(() => initialGenreDecisions(changes, genreReview?.newGenreCandidates));
  const [parents, setParents] = useState([]);
  const [clientError, setClientError] = useState("");
  const reasonId = useId();
  const groupId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetchTopLevelGenres(controller.signal).then(setParents).catch(() => setParents([]));
    return () => controller.abort();
  }, []);

  const preview = previewApproval(currentGenres, changes, decisions);
  const isSubmitting = Boolean(pendingAction);
  const canModerate = submission?.status === "pending";
  const reason = reasons[action];
  const requiresReason = action !== "approve";
  const selected = ACTIONS.find((option) => option.id === action) || ACTIONS[0];

  function clearFeedback() {
    setClientError("");
    if (typeof onClearFeedback === "function") onClearFeedback();
  }

  function updateAdd(index, change) {
    clearFeedback();
    setDecisions((current) => ({ ...current, add: current.add.map((entry, position) => (position === index ? { ...entry, ...change } : entry)) }));
  }

  function updateRemove(index, decision) {
    clearFeedback();
    setDecisions((current) => ({ ...current, remove: current.remove.map((entry, position) => (position === index ? { decision } : entry)) }));
  }

  function submitDecision(event) {
    event.preventDefault();
    clearFeedback();
    if (!canModerate || isSubmitting || typeof onCommand !== "function") return;
    const trimmedReason = reason.trim();
    if (requiresReason && !trimmedReason) {
      setClientError("Add a note before applying this decision.");
      return;
    }
    if (action !== "approve") {
      onCommand(action, { reason: trimmedReason });
      return;
    }
    const accepted = [...decisions.add, ...decisions.remove].some((entry) => entry.decision === "apply") || decisions.primary === "apply";
    if (!accepted) {
      setClientError("Accept at least one operation, or reject or request changes instead.");
      return;
    }
    const unresolved = decisions.add.findIndex((entry, index) => !changes.add[index].genre && entry.decision === "apply"
      && (entry.action === "map" ? !entry.mapGenre : !isValidGenreName(entry.name)));
    if (unresolved !== -1) {
      setClientError(`Choose a genre to map “${changes.add[unresolved].newGenre.name}” onto, or give it a valid name.`);
      return;
    }
    const primaryIndex = changes.primary?.addIndex;
    if (decisions.primary === "apply" && Number.isInteger(primaryIndex) && decisions.add[primaryIndex]?.decision !== "apply") {
      setClientError("The primary genre's addition is skipped. Skip the primary change too, or apply the addition.");
      return;
    }
    onCommand("approve", {
      genreDecisions: buildGenreDecisionsBody(changes, decisions),
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    });
  }

  const primaryName = changes.primary?.genre
    ? changes.primary.genre.name
    : Number.isInteger(changes.primary?.addIndex)
      ? (changes.add[changes.primary.addIndex]?.genre?.name || changes.add[changes.primary.addIndex]?.newGenre?.name)
      : "";

  return (
    <section className="moderation-decision community-panel" aria-labelledby="genre-decision-title">
      <div className="moderation-decision-heading">
        <div>
          <p className="community-eyebrow">Moderator command</p>
          <h2 id="genre-decision-title">Review genre suggestion</h2>
        </div>
        <span className={`community-status community-status-${submission?.status || "unknown"}`}>
          {formatCommunityStatus(submission?.status)}
        </span>
      </div>

      {canModerate ? (
        <form className="moderation-decision-form" onSubmit={submitDecision} noValidate>
          <div className="moderation-decision-actions" aria-label="Decision type">
            {ACTIONS.map((option) => (
              <button
                aria-pressed={action === option.id}
                className={`moderation-decision-action${action === option.id ? " moderation-decision-action-active" : ""}`}
                disabled={isSubmitting}
                key={option.id}
                onClick={() => { setAction(option.id); clearFeedback(); }}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="moderation-decision-description">{selected.description}</p>

          {action === "approve" ? (
            <div className="genre-decision-body">
              {genreReview?.stale ? (
                <p className="genre-stale-note" role="note">
                  The album's genres changed after this suggestion was made. Decisions apply to its genres now;
                  anything already done is recorded as “no change”.
                </p>
              ) : null}

              {changes.add.length ? (
                <fieldset className="genre-decision-group">
                  <legend>Additions</legend>
                  {changes.add.map((entry, index) => {
                    const choice = decisions.add[index];
                    if (entry.genre) {
                      return (
                        <label className="genre-decision-row" key={`add-${entry.genre.genreId}`}>
                          <input checked={choice.decision === "apply"} disabled={isSubmitting} onChange={(event) => updateAdd(index, { decision: event.target.checked ? "apply" : "skip" })} type="checkbox" />
                          <span>Add <strong>{entry.genre.name}</strong></span>
                        </label>
                      );
                    }
                    const mode = choice.decision === "skip" ? "skip" : choice.action;
                    const candidates = genreReview?.newGenreCandidates?.[index] || [];
                    const name = `${groupId}-new-${index}`;
                    return (
                      <div className="genre-decision-new" key={`new-${entry.newGenre.slug}`}>
                        <p>
                          New genre <strong>“{entry.newGenre.name}”</strong>
                          {entry.newGenre.parent ? <> under {entry.newGenre.parent.name}</> : null}
                        </p>
                        <div className="genre-decision-modes" role="radiogroup" aria-label={`How to handle “${entry.newGenre.name}”`}>
                          {[["create", "Create it"], ["map", "Use an existing genre"], ["skip", "Skip"]].map(([value, label]) => (
                            <label key={value}>
                              <input
                                checked={mode === value}
                                disabled={isSubmitting}
                                name={name}
                                onChange={() => updateAdd(index, value === "skip" ? { decision: "skip" } : { decision: "apply", action: value })}
                                type="radio"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                        {mode === "create" ? (
                          <div className="genre-decision-create">
                            <label>
                              Name
                              <input disabled={isSubmitting} maxLength={40} onChange={(event) => updateAdd(index, { name: event.target.value })} type="text" value={choice.name} />
                            </label>
                            <label>
                              Broader genre
                              <select disabled={isSubmitting} onChange={(event) => updateAdd(index, { parentGenreId: event.target.value })} value={choice.parentGenreId}>
                                <option value="">None (top-level)</option>
                                {parents.map((parent) => <option key={parent.genreId} value={parent.genreId}>{parent.name}</option>)}
                              </select>
                            </label>
                          </div>
                        ) : null}
                        {mode === "map" ? (
                          <div className="genre-decision-map">
                            {candidates.length ? (
                              <ul className="genre-candidate-list">
                                {candidates.map((candidate) => (
                                  <li key={candidate.genreId}>
                                    <label>
                                      <input
                                        checked={choice.mapGenre?.genreId === candidate.genreId}
                                        disabled={isSubmitting}
                                        name={`${name}-map`}
                                        onChange={() => updateAdd(index, { mapGenre: candidate })}
                                        type="radio"
                                      />
                                      {candidate.name} <small>{MATCH_LABELS[candidate.match] || candidate.match}</small>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            ) : <p className="genre-form-muted">No similar genres found.</p>}
                            {choice.mapGenre && !candidates.some((candidate) => candidate.genreId === choice.mapGenre.genreId) ? (
                              <p>Mapping onto <strong>{choice.mapGenre.name}</strong></p>
                            ) : null}
                            <MapSearch disabled={isSubmitting} onChoose={(genre) => updateAdd(index, { mapGenre: genre })} />
                            <label className="genre-decision-row">
                              <input checked={choice.addAlias} disabled={isSubmitting} onChange={(event) => updateAdd(index, { addAlias: event.target.checked })} type="checkbox" />
                              <span>Keep “{entry.newGenre.name}” as an alternative name</span>
                            </label>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </fieldset>
              ) : null}

              {changes.remove.length ? (
                <fieldset className="genre-decision-group">
                  <legend>Removals</legend>
                  {changes.remove.map((genre, index) => (
                    <label className="genre-decision-row" key={`remove-${genre.genreId}`}>
                      <input checked={decisions.remove[index].decision === "apply"} disabled={isSubmitting} onChange={(event) => updateRemove(index, event.target.checked ? "apply" : "skip")} type="checkbox" />
                      <span>Remove <strong>{genre.name}</strong></span>
                    </label>
                  ))}
                </fieldset>
              ) : null}

              {changes.primary ? (
                <label className="genre-decision-row">
                  <input
                    checked={decisions.primary === "apply"}
                    disabled={isSubmitting}
                    onChange={(event) => { clearFeedback(); setDecisions((current) => ({ ...current, primary: event.target.checked ? "apply" : "skip" })); }}
                    type="checkbox"
                  />
                  <span>Make <strong>{primaryName}</strong> the primary genre</span>
                </label>
              ) : null}

              <div className="genre-decision-preview">
                <p className="community-eyebrow">
                  After approval <span className={`genre-count${preview.length > MAX_ALBUM_GENRES ? " genre-count-over" : ""}`}>{preview.length} of {MAX_ALBUM_GENRES}</span>
                </p>
                {preview.length ? (
                  <ol className="genre-chip-list">
                    {preview.map((item, index) => (
                      <li className={`genre-chip genre-chip-${item.change}${index === 0 ? " genre-chip-primary" : ""}`} key={item.key}>
                        {item.name}
                        {item.change === "created" ? <small> new</small> : null}
                      </li>
                    ))}
                  </ol>
                ) : <p className="genre-form-muted">The album would have no genres.</p>}
              </div>
            </div>
          ) : null}

          <div className="community-field moderation-reason-field">
            <label htmlFor={reasonId}>
              Moderator note {requiresReason ? <span>required</span> : <span>optional</span>}
            </label>
            <textarea
              disabled={isSubmitting}
              id={reasonId}
              maxLength={1000}
              onChange={(event) => { setReasons((current) => ({ ...current, [action]: event.target.value })); setClientError(""); }}
              placeholder={action === "request_changes" ? "Describe what should change." : "Record the rationale for the audit trail."}
              rows={4}
              value={reason}
            />
            <small>{reason.length}/1,000</small>
          </div>

          <div className="moderation-command-feedback" aria-live="polite">
            {clientError ? <p className="community-message community-message-error" role="alert">{clientError}</p> : null}
            {error ? (
              <div className="community-message community-message-error" role="alert">
                <strong>{error.message || "The decision could not be applied."}</strong>
                {error.code ? <code>{error.code}</code> : null}
                {retryAfterLabel(error.retryAfterSeconds) ? <small>{retryAfterLabel(error.retryAfterSeconds)}</small> : null}
                {Array.isArray(error.details) && error.details.length ? (
                  <ul>{error.details.map((detail, index) => <li key={index}>{errorDetailText(detail)}</li>)}</ul>
                ) : null}
              </div>
            ) : null}
            {success ? (
              <div className="community-message community-message-success" role="status">
                <strong>{success.message}</strong>
                {success.albumUrl ? <Link to={success.albumUrl}>Open album</Link> : null}
              </div>
            ) : null}
          </div>

          <button className="community-primary-button moderation-submit-decision" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Applying decision…" : action === "approve" ? "Approve genres" : action === "request_changes" ? "Send change request" : "Reject suggestion"}
          </button>
        </form>
      ) : (
        <div className="moderation-decision-closed">
          <h3>This suggestion is no longer pending.</h3>
          <p>Its current state is {formatCommunityStatus(submission?.status)}.</p>
          {success ? (
            <div className="community-message community-message-success" role="status">
              <strong>{success.message}</strong>
              {success.albumUrl ? <Link to={success.albumUrl}>Open album</Link> : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default GenreModeratorDecision;
