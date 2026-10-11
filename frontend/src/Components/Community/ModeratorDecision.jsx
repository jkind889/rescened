import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { formatCommunityStatus } from "../../features/community/community.js";

const ACTIONS = [
  {
    id: "approve",
    label: "Approve",
    description: "Publish this proposal as a new album or link it to an existing catalog album.",
  },
  {
    id: "request_changes",
    label: "Request changes",
    description: "Return the proposal to its contributor with a concrete revision note.",
  },
  {
    id: "mark_duplicate",
    label: "Mark duplicate",
    description: "Close it against another approved community suggestion.",
  },
  {
    id: "reject",
    label: "Reject",
    description: "Close the proposal when it cannot be accepted or revised.",
  },
];

const EMPTY_REASONS = {
  approve: "",
  request_changes: "",
  mark_duplicate: "",
  reject: "",
};

const CORRECTION_FIELD_ORDER = [
  "title",
  "artists",
  "releaseType",
  "releaseDate",
  "label",
  "cover",
  "tracks",
  "externalReferences",
];

const CORRECTION_FIELD_LABELS = {
  title: "Title",
  artists: "Artists and credits",
  releaseType: "Release type",
  releaseDate: "Release date",
  label: "Label",
  cover: "Cover URL",
  tracks: "Tracklist",
  externalReferences: "External references",
};

function correctionFieldsFor(submission) {
  return CORRECTION_FIELD_ORDER.filter((field) => (
    submission?.proposedChanges && Object.prototype.hasOwnProperty.call(submission.proposedChanges, field)
  ));
}

function errorDetailText(detail) {
  if (typeof detail === "string") {
    return detail;
  }

  if (detail && typeof detail === "object") {
    return detail.message || detail.albumId || detail.submissionId || "Additional server detail";
  }

  return String(detail || "Additional server detail");
}

function candidateAlbumLabel(candidate) {
  const title = candidate.title || "Untitled album";
  const artist = candidate.artistDisplayName || "Unknown artist";
  return `${title} — ${artist}`;
}

function candidateSubmissionLabel(candidate) {
  const metadata = candidate.proposedMetadata || {};
  const title = metadata.title || "Untitled proposal";
  const artist = metadata.artistDisplayName || "Unknown artist";
  return `${title} — ${artist}`;
}

function retryAfterLabel(seconds) {
  const value = Math.ceil(Number(seconds));
  if (!Number.isFinite(value) || value <= 0) return "";
  return `Try again in ${value} second${value === 1 ? "" : "s"}.`;
}

export function ModeratorDecision({
  submission,
  duplicateCandidates = {},
  pendingAction = "",
  error = null,
  success = null,
  onCommand,
  onClearFeedback,
}) {
  const [action, setAction] = useState("approve");
  const [reasons, setReasons] = useState(() => ({ ...EMPTY_REASONS }));
  const [albumId, setAlbumId] = useState("");
  const [duplicateOfSubmissionId, setDuplicateOfSubmissionId] = useState("");
  const [confirmPossibleDuplicate, setConfirmPossibleDuplicate] = useState(false);
  const [applyFields, setApplyFields] = useState(() => correctionFieldsFor(submission));
  const [clientError, setClientError] = useState("");
  const reasonId = useId();
  const albumIdInputId = useId();
  const duplicateInputId = useId();
  const confirmationId = useId();

  const catalogCandidates = Array.isArray(duplicateCandidates.catalogAlbums)
    ? duplicateCandidates.catalogAlbums
    : [];
  const submissionCandidates = Array.isArray(duplicateCandidates.submissions)
    ? duplicateCandidates.submissions
    : [];
  const eligibleDuplicateCandidates = submissionCandidates.filter((candidate) => (
    candidate.status === "approved"
  ));
  const serverCandidateAlbumIds = [
    "EXACT_CATALOG_MATCH",
    "POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED",
  ].includes(error?.code)
    ? [...new Set((error.details || [])
      .map((detail) => (typeof detail === "string" ? detail : detail?.albumId))
      .filter(Boolean))]
    : [];
  const catalogCandidatesById = new Map(catalogCandidates.map((candidate) => [candidate.albumId, candidate]));
  serverCandidateAlbumIds.forEach((candidateId) => {
    if (!catalogCandidatesById.has(candidateId)) {
      catalogCandidatesById.set(candidateId, { albumId: candidateId });
    }
  });
  const displayedCatalogCandidates = [...catalogCandidatesById.values()];

  const isSubmitting = Boolean(pendingAction);
  const canModerate = submission?.status === "pending";
  const selectedAction = ACTIONS.find((option) => option.id === action) || ACTIONS[0];
  const reason = reasons[action];
  const requiresReason = !["approve", "mark_duplicate"].includes(action);
  const isExactMatchError = error?.code === "EXACT_CATALOG_MATCH";
  const needsDuplicateConfirmation = error?.code === "POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED";
  const isCorrection = submission?.submissionType === "catalog_correction";
  const correctionFields = correctionFieldsFor(submission);
  const correctionDiffByField = new Map(
    (Array.isArray(submission?.correctionDiff) ? submission.correctionDiff : [])
      .map((item) => [item.field, item]),
  );

  function clearFeedback() {
    setClientError("");
    if (typeof onClearFeedback === "function") {
      onClearFeedback();
    }
  }

  function chooseAction(nextAction) {
    setAction(nextAction);
    clearFeedback();
  }

  function updateReason(value) {
    setReasons((currentReasons) => ({ ...currentReasons, [action]: value }));
    if (clientError) {
      setClientError("");
    }
  }

  function submitDecision(event) {
    event.preventDefault();
    clearFeedback();

    if (!canModerate || isSubmitting || typeof onCommand !== "function") {
      return;
    }

    const trimmedReason = reason.trim();
    if (requiresReason && !trimmedReason) {
      setClientError("Add a reason before applying this decision.");
      return;
    }

    if (action === "mark_duplicate" && !duplicateOfSubmissionId.trim()) {
      setClientError("Choose the approved suggestion this proposal duplicates.");
      return;
    }

    if (action === "approve") {
      if (isCorrection) {
        if (!applyFields.length) {
          setClientError("Select at least one proposed field before approving the correction.");
          return;
        }
        onCommand("approve", {
          applyFields,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        });
        return;
      }

      const body = {};
      const selectedAlbumId = albumId.trim();

      if (selectedAlbumId) {
        body.albumId = selectedAlbumId;
      } else if (confirmPossibleDuplicate) {
        body.confirmPossibleDuplicate = true;
      }
      if (trimmedReason) {
        body.reason = trimmedReason;
      }

      onCommand("approve", body);
      return;
    }

    if (action === "mark_duplicate") {
      onCommand("mark_duplicate", {
        duplicateOfSubmissionId: duplicateOfSubmissionId.trim(),
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      });
      return;
    }

    onCommand(action, { reason: trimmedReason });
  }

  function submitLabel() {
    if (pendingAction) {
      const pendingOption = ACTIONS.find((option) => option.id === pendingAction);
      return pendingOption ? `${pendingOption.label} in progress…` : "Applying decision…";
    }
    if (action === "approve") return "Approve & publish";
    if (action === "request_changes") return "Send change request";
    if (action === "mark_duplicate") return "Mark as duplicate";
    return "Reject proposal";
  }

  return (
    <section className="moderation-decision community-panel" aria-labelledby="moderation-decision-title">
      <div className="moderation-decision-heading">
        <div>
          <p className="community-eyebrow">Moderator command</p>
          <h2 id="moderation-decision-title">Record a decision</h2>
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
                onClick={() => chooseAction(option.id)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>

          <p className="moderation-decision-description">{selectedAction.description}</p>

          {action === "approve" ? (
            <div className="moderation-approval-fields">
              {isCorrection ? (
                <fieldset className="moderation-correction-fields">
                  <legend>Fields to apply</legend>
                  <p className="moderation-decision-note">
                    Review the baseline, current catalog value, and proposal above. Only selected groups will be
                    changed; a stale catalog revision will be rejected by the server.
                  </p>
                  {correctionFields.map((field) => (
                    <label className="moderation-correction-field" key={field}>
                      <input
                        checked={applyFields.includes(field)}
                        disabled={isSubmitting}
                        onChange={(event) => {
                          setApplyFields((currentFields) => (
                            event.target.checked
                              ? [...currentFields, field]
                              : currentFields.filter((currentField) => currentField !== field)
                          ));
                          clearFeedback();
                        }}
                        type="checkbox"
                      />
                      <span>
                        <strong>{CORRECTION_FIELD_LABELS[field] || field}</strong>
                        <small>{correctionDiffByField.get(field)?.stale ? "Catalog changed since submission" : "Baseline matches current catalog"}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}

              {!isCorrection && isExactMatchError ? (
                <div className="moderation-resolution moderation-resolution-required" role="alert">
                  <p className="community-eyebrow">Exact catalog match</p>
                  <h3>Choose the existing album before approving.</h3>
                  <p>
                    The server found a matching catalog identity. Confirmation alone cannot create a second album;
                    select the correct catalog record below and submit approval again.
                  </p>
                </div>
              ) : null}

              {!isCorrection && needsDuplicateConfirmation ? (
                <div className="moderation-resolution moderation-resolution-warning" role="alert">
                  <p className="community-eyebrow">Duplicate check required</p>
                  <h3>Review the candidates, then confirm a new record is intentional.</h3>
                  <p>
                    The matches are advisory, but the server will not create a new catalog album until you explicitly
                    acknowledge them.
                  </p>
                </div>
              ) : null}

              {!isCorrection && displayedCatalogCandidates.length > 0 ? (
                <fieldset className="moderation-candidate-choices">
                  <legend>Catalog candidates</legend>
                  {displayedCatalogCandidates.map((candidate) => (
                    <div className="moderation-candidate-choice" key={candidate.albumId}>
                      <label>
                        <input
                          checked={albumId === candidate.albumId}
                          disabled={isSubmitting}
                          name="approval-album"
                          onChange={() => {
                            setAlbumId(candidate.albumId);
                            setConfirmPossibleDuplicate(false);
                            clearFeedback();
                          }}
                          type="radio"
                          value={candidate.albumId}
                        />
                        <span>
                          <strong>{candidateAlbumLabel(candidate)}</strong>
                          {candidate.releaseDate ? <small>{candidate.releaseDate}</small> : null}
                          {Array.isArray(candidate.matchTypes) && candidate.matchTypes.length > 0 ? (
                            <small>Matched by {candidate.matchTypes.join(", ")}</small>
                          ) : null}
                          <code>{candidate.albumId}</code>
                        </span>
                      </label>
                      <Link to={`/album/${candidate.albumId}`}>Inspect album</Link>
                    </div>
                  ))}
                </fieldset>
              ) : null}

              {!isCorrection ? <div className="community-field">
                <label htmlFor={albumIdInputId}>Existing catalog album ID <span>optional</span></label>
                <input
                  autoComplete="off"
                  disabled={isSubmitting}
                  id={albumIdInputId}
                  onChange={(event) => {
                    setAlbumId(event.target.value);
                    if (event.target.value) setConfirmPossibleDuplicate(false);
                    clearFeedback();
                  }}
                  placeholder="Album UUID, or leave blank to create a new record"
                  type="text"
                  value={albumId}
                />
                <small>Use this for an existing catalog match. It links without overwriting that album.</small>
              </div> : null}

              {!isCorrection ? <label className={`moderation-confirmation${needsDuplicateConfirmation ? " moderation-confirmation-required" : ""}`} htmlFor={confirmationId}>
                <input
                  checked={confirmPossibleDuplicate}
                  disabled={isSubmitting || Boolean(albumId.trim())}
                  id={confirmationId}
                  onChange={(event) => {
                    setConfirmPossibleDuplicate(event.target.checked);
                    clearFeedback();
                  }}
                  type="checkbox"
                />
                <span>
                  I reviewed the duplicate candidates and intend to create a new catalog album.
                  <small>This acknowledgement is sent only when no existing album ID is selected.</small>
                </span>
              </label> : null}
            </div>
          ) : null}

          {action === "mark_duplicate" ? (
            <div className="moderation-duplicate-fields">
              {eligibleDuplicateCandidates.length > 0 ? (
                <fieldset className="moderation-candidate-choices">
                  <legend>Approved suggestion candidates</legend>
                  {eligibleDuplicateCandidates.map((candidate) => (
                    <label className="moderation-candidate-choice" key={candidate.submissionId}>
                      <input
                        checked={duplicateOfSubmissionId === candidate.submissionId}
                        disabled={isSubmitting}
                        name="duplicate-suggestion"
                        onChange={() => {
                          setDuplicateOfSubmissionId(candidate.submissionId);
                          clearFeedback();
                        }}
                        type="radio"
                        value={candidate.submissionId}
                      />
                      <span>
                        <strong>{candidateSubmissionLabel(candidate)}</strong>
                        <small>{formatCommunityStatus(candidate.status)}</small>
                        <code>{candidate.submissionId}</code>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : (
                <p className="moderation-decision-note">
                  No approved suggestion appears in the detected candidates. You can enter another approved suggestion
                  ID below; catalog-only matches should be resolved through approval instead.
                </p>
              )}

              <div className="community-field">
                <label htmlFor={duplicateInputId}>Approved suggestion ID</label>
                <input
                  autoComplete="off"
                  disabled={isSubmitting}
                  id={duplicateInputId}
                  onChange={(event) => {
                    setDuplicateOfSubmissionId(event.target.value);
                    clearFeedback();
                  }}
                  placeholder="Suggestion UUID"
                  required
                  type="text"
                  value={duplicateOfSubmissionId}
                />
                <small>The target must be another approved community suggestion with a published album.</small>
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
              onChange={(event) => updateReason(event.target.value)}
              placeholder={action === "request_changes" ? "Describe what should be corrected and what evidence would resolve it." : "Record the rationale for the audit trail."}
              required={requiresReason}
              rows={5}
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
                {!isExactMatchError && Array.isArray(error.details) && error.details.length > 0 ? (
                  <ul>
                    {error.details.map((detail, index) => (
                      <li key={`${errorDetailText(detail)}-${index}`}>{errorDetailText(detail)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {success ? (
              <div className="community-message community-message-success" role="status">
                <strong>{success.message}</strong>
                {success.albumUrl ? <Link to={success.albumUrl}>Open published album</Link> : null}
              </div>
            ) : null}
            {isSubmitting ? <p className="community-message community-message-pending" role="status">Writing an immutable moderation event…</p> : null}
          </div>

          <button className="community-primary-button moderation-submit-decision" disabled={isSubmitting} type="submit">
            {submitLabel()}
          </button>
        </form>
      ) : (
        <div className="moderation-decision-closed">
          <h3>This proposal is no longer pending.</h3>
          <p>
            Its current state is {formatCommunityStatus(submission?.status)}. The record below remains available for
            audit, but the server accepts moderation commands only while a suggestion is pending.
          </p>
          {success ? (
            <div className="community-message community-message-success" role="status">
              <strong>{success.message}</strong>
              {success.albumUrl ? <Link to={success.albumUrl}>Open published album</Link> : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default ModeratorDecision;
