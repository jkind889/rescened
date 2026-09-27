import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useNavigate, useParams } from "react-router-dom";
import SubmissionDetails from "../Components/Community/SubmissionDetails.jsx";
import ModeratorDecision from "../Components/Community/ModeratorDecision.jsx";
import BaselineReviewPanel from "../Components/Community/BaselineReviewPanel.jsx";
import { API_BASE_URL } from "../config/api.js";
import {
  formatCommunityDate,
  formatCommunityStatus,
  requestCommunityJson,
} from "../features/community/community.js";
import useMediaQuery from "../features/community/useMediaQuery.js";

const MODERATION_PATH = "/moderation/album-suggestions";
const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "needs_changes", label: "Needs changes" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "duplicate", label: "Duplicate" },
  { value: "withdrawn", label: "Withdrawn" },
];
const ALL_STATUSES = STATUS_OPTIONS.map((option) => option.value);
const COMMAND_ENDPOINTS = {
  approve: "approve",
  request_changes: "request-changes",
  mark_duplicate: "mark-duplicate",
  reject: "reject",
};
const INITIAL_FILTERS = {
  statuses: ["pending"],
  submissionType: "",
  possibleDuplicate: "",
  submittedByUserId: "",
  limit: "20",
};
const EMPTY_COMMAND_STATE = {
  submissionId: "",
  pendingAction: "",
  error: null,
  success: null,
};

function normalizeCommunityError(error, fallback) {
  return {
    message: error?.message || fallback,
    code: error?.code || "",
    details: Array.isArray(error?.details) ? error.details : [],
    retryAfterSeconds: error?.retryAfterSeconds,
    status: error?.status,
  };
}

function mergeQueueSuggestions(currentSuggestions, incomingSuggestions) {
  const bySubmissionId = new Map(currentSuggestions.map((suggestion) => [suggestion.submissionId, suggestion]));
  incomingSuggestions.forEach((suggestion) => {
    bySubmissionId.set(suggestion.submissionId, suggestion);
  });
  return [...bySubmissionId.values()];
}

function buildQueueSearchParams(filters, cursor = "") {
  const params = new URLSearchParams();
  params.set("status", filters.statuses.join(","));
  params.set("limit", filters.limit);
  if (filters.possibleDuplicate) {
    params.set("hasPossibleDuplicate", filters.possibleDuplicate);
  }
  if (filters.submissionType) {
    params.set("submissionType", filters.submissionType);
  }
  if (filters.submittedByUserId) {
    params.set("submittedByUserId", filters.submittedByUserId);
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  return params;
}

function queueTitle(suggestion) {
  return suggestion.proposedMetadata?.title || suggestion.targetAlbum?.title || "Untitled proposal";
}

function queueArtist(suggestion) {
  return suggestion.proposedMetadata?.artistDisplayName || suggestion.targetAlbum?.artistDisplayName || "Unknown artist";
}

function commandSuccess(action, response) {
  if (action === "approve") {
    return {
      message: response.idempotent
        ? "This suggestion was already approved; its published album is unchanged."
        : "Suggestion approved and published to the catalog.",
      albumUrl: response.albumUrl || "",
    };
  }
  if (action === "request_changes") {
    return { message: "Change request recorded and returned to the contributor." };
  }
  if (action === "mark_duplicate") {
    return { message: "Suggestion closed as a duplicate." };
  }
  return { message: "Suggestion rejected and the reason was added to its history." };
}

function sourceTypeLabel(value) {
  return String(value || "source").replaceAll("_", " ");
}

function retryAfterLabel(seconds) {
  const value = Math.ceil(Number(seconds));
  if (!Number.isFinite(value) || value <= 0) return "";
  return `Try again in ${value} second${value === 1 ? "" : "s"}.`;
}

export function ModerationSuggestions() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { submissionId = "" } = useParams();
  const navigate = useNavigate();
  const [filterDraft, setFilterDraft] = useState(() => ({ ...INITIAL_FILTERS }));
  const [appliedFilters, setAppliedFilters] = useState(() => ({ ...INITIAL_FILTERS }));
  const [filterError, setFilterError] = useState("");
  const [queueSuggestions, setQueueSuggestions] = useState([]);
  const [nextCursor, setNextCursor] = useState("");
  const [isQueueLoading, setIsQueueLoading] = useState(true);
  const [isQueueLoadingMore, setIsQueueLoadingMore] = useState(false);
  const [queueError, setQueueError] = useState(null);
  const [queueRefreshIndex, setQueueRefreshIndex] = useState(0);
  const [detailRefreshIndex, setDetailRefreshIndex] = useState(0);
  const [detailState, setDetailState] = useState({
    submissionId: "",
    data: null,
    isLoading: false,
    error: null,
  });
  const [commandState, setCommandState] = useState(EMPTY_COMMAND_STATE);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const queueRequestIdRef = useRef(0);
  const isNarrowWorkspace = useMediaQuery("(max-width: 900px)");
  const isMobileDecisionLayout = useMediaQuery("(max-width: 640px)");

  const fetchQueuePage = useCallback(async ({ cursor = "", append = false, signal } = {}) => {
    const requestId = queueRequestIdRef.current + 1;
    queueRequestIdRef.current = requestId;

    if (!isLoaded || !isSignedIn) {
      setIsQueueLoading(false);
      return;
    }

    if (append) {
      setIsQueueLoadingMore(true);
    } else {
      setIsQueueLoading(true);
    }
    setQueueError(null);

    try {
      const token = await getToken();
      if (!token) {
        throw Object.assign(new Error("Your session could not be verified."), { status: 401, code: "UNAUTHORIZED" });
      }
      const searchParams = buildQueueSearchParams(appliedFilters, cursor);
      const data = await requestCommunityJson(
        `${API_BASE_URL}${MODERATION_PATH}?${searchParams.toString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        },
        "The moderation queue could not be loaded.",
      );

      if (signal?.aborted || requestId !== queueRequestIdRef.current) return;
      const incomingSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      setQueueSuggestions((currentSuggestions) => (
        append ? mergeQueueSuggestions(currentSuggestions, incomingSuggestions) : incomingSuggestions
      ));
      setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : "");
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError" || requestId !== queueRequestIdRef.current) return;
      const normalizedError = normalizeCommunityError(error, "The moderation queue could not be loaded.");
      if (normalizedError.status === 403 || normalizedError.code === "MODERATOR_REQUIRED") {
        setAccessDenied(true);
      } else {
        setQueueError(normalizedError);
      }
    } finally {
      if (!signal?.aborted && requestId === queueRequestIdRef.current) {
        setIsQueueLoading(false);
        setIsQueueLoadingMore(false);
      }
    }
  }, [appliedFilters, getToken, isLoaded, isSignedIn]);

  useEffect(() => {
    const controller = new AbortController();
    fetchQueuePage({ signal: controller.signal });
    return () => controller.abort();
  }, [fetchQueuePage, queueRefreshIndex]);

  useEffect(() => {
    if (!submissionId || !isLoaded || !isSignedIn) {
      return undefined;
    }

    const controller = new AbortController();
    let isCurrent = true;

    async function fetchDetail() {
      setDetailState({ submissionId, data: null, isLoading: true, error: null });
      try {
        const token = await getToken();
        if (!token) {
          throw Object.assign(new Error("Your session could not be verified."), { status: 401, code: "UNAUTHORIZED" });
        }
        const data = await requestCommunityJson(
          `${API_BASE_URL}${MODERATION_PATH}/${encodeURIComponent(submissionId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
          "This moderation record could not be loaded.",
        );
        if (isCurrent) {
          setDetailState({ submissionId, data, isLoading: false, error: null });
        }
      } catch (error) {
        if (!isCurrent || controller.signal.aborted || error?.name === "AbortError") return;
        const normalizedError = normalizeCommunityError(error, "This moderation record could not be loaded.");
        if (normalizedError.status === 403 || normalizedError.code === "MODERATOR_REQUIRED") {
          setAccessDenied(true);
        } else {
          setDetailState({ submissionId, data: null, isLoading: false, error: normalizedError });
        }
      }
    }

    fetchDetail();
    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [detailRefreshIndex, getToken, isLoaded, isSignedIn, submissionId]);

  const activeDetailState = detailState.submissionId === submissionId
    ? detailState
    : { submissionId, data: null, isLoading: Boolean(submissionId), error: null };
  const selectedSuggestion = activeDetailState.data?.suggestion || null;
  const selectedDuplicateCandidates = activeDetailState.data?.duplicateCandidates || {};
  const activeCommandState = commandState.submissionId === submissionId
    ? commandState
    : EMPTY_COMMAND_STATE;

  function toggleStatus(status) {
    setFilterDraft((currentFilters) => {
      const isSelected = currentFilters.statuses.includes(status);
      return {
        ...currentFilters,
        statuses: isSelected
          ? currentFilters.statuses.filter((currentStatus) => currentStatus !== status)
          : [...currentFilters.statuses, status],
      };
    });
    setFilterError("");
  }

  function chooseStatusPreset(statuses) {
    setFilterDraft((currentFilters) => ({ ...currentFilters, statuses: [...statuses] }));
    setFilterError("");
  }

  function applyFilters(event) {
    event.preventDefault();
    if (filterDraft.statuses.length === 0) {
      setFilterError("Select at least one queue status.");
      return;
    }

    setFilterError("");
    setAppliedFilters({
      statuses: [...filterDraft.statuses],
      submissionType: filterDraft.submissionType,
      possibleDuplicate: filterDraft.possibleDuplicate,
      submittedByUserId: filterDraft.submittedByUserId.trim(),
      limit: filterDraft.limit,
    });
    setQueueRefreshIndex((currentIndex) => currentIndex + 1);
  }

  function clearFilters() {
    const clearedFilters = { ...INITIAL_FILTERS, statuses: ["pending"] };
    setFilterDraft(clearedFilters);
    setAppliedFilters(clearedFilters);
    setFilterError("");
    setQueueRefreshIndex((currentIndex) => currentIndex + 1);
  }

  async function applyCommand(action, body) {
    const endpoint = COMMAND_ENDPOINTS[action];
    const targetSubmissionId = submissionId;
    if (!endpoint || !targetSubmissionId || activeCommandState.pendingAction) return;
    if (baselineBusy) {
      setCommandState({
        submissionId: targetSubmissionId,
        pendingAction: "",
        error: { message: "Wait for the MusicBrainz release preview to finish before approving this suggestion.", code: "BASELINE_REVIEW_IN_PROGRESS" },
        success: null,
      });
      return;
    }

    setCommandState({
      submissionId: targetSubmissionId,
      pendingAction: action,
      error: null,
      success: null,
    });

    try {
      const token = await getToken();
      if (!token) {
        throw Object.assign(new Error("Your session could not be verified."), { status: 401, code: "UNAUTHORIZED" });
      }
      const data = await requestCommunityJson(
        `${API_BASE_URL}${MODERATION_PATH}/${encodeURIComponent(targetSubmissionId)}/${endpoint}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        "The moderation decision could not be applied.",
      );

      const updatedSuggestion = data.suggestion;
      if (updatedSuggestion) {
        setQueueSuggestions((currentSuggestions) => currentSuggestions.map((suggestion) => (
          suggestion.submissionId === updatedSuggestion.submissionId
            ? { ...suggestion, ...updatedSuggestion }
            : suggestion
        )));
        setDetailState((currentDetail) => {
          if (currentDetail.submissionId !== targetSubmissionId) return currentDetail;
          return {
            submissionId: targetSubmissionId,
            isLoading: false,
            error: null,
            data: {
              suggestion: updatedSuggestion,
              duplicateCandidates: data.duplicateCandidates || currentDetail.data?.duplicateCandidates || {},
            },
          };
        });
      }
      setCommandState({
        submissionId: targetSubmissionId,
        pendingAction: "",
        error: null,
        success: commandSuccess(action, data),
      });
      setQueueRefreshIndex((currentIndex) => currentIndex + 1);
    } catch (error) {
      const normalizedError = normalizeCommunityError(error, "The moderation decision could not be applied.");
      if (normalizedError.status === 403 || normalizedError.code === "MODERATOR_REQUIRED") {
        setAccessDenied(true);
        return;
      }
      setCommandState({
        submissionId: targetSubmissionId,
        pendingAction: "",
        error: normalizedError,
        success: null,
      });
      if (
        normalizedError.status === 409
        && normalizedError.code !== "EXACT_CATALOG_MATCH"
        && normalizedError.code !== "POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED"
      ) {
        setDetailRefreshIndex((currentIndex) => currentIndex + 1);
        setQueueRefreshIndex((currentIndex) => currentIndex + 1);
      }
    }
  }

  function clearCommandFeedback() {
    setCommandState((currentState) => (
      currentState.submissionId === submissionId
        ? { ...currentState, error: null, success: null }
        : currentState
    ));
  }

  function renderDetailPanel() {
    let detailChildren = null;

    if (submissionId && selectedSuggestion && !activeDetailState.isLoading) {
      const toolbar = (
        <div className="moderation-detail-toolbar" key="moderation-toolbar">
          <div>
            <p className="community-eyebrow">Selected record</p>
            <code>{submissionId}</code>
          </div>
          <button className="community-text-button" onClick={() => navigate(MODERATION_PATH)} type="button">
            Close
          </button>
        </div>
      );
      const submissionDetail = (
        <SubmissionDetails
          duplicateCandidates={selectedDuplicateCandidates}
          headingLevel={2}
          key="moderation-submission-detail"
          showContributor
          submission={selectedSuggestion}
        />
      );
      const baselineReview = selectedSuggestion.submissionType === "new_album" ? (
        <BaselineReviewPanel
          compact
          id={selectedSuggestion.submissionId}
          kind="submissions"
          key="moderation-baseline-review"
          onBusyChange={setBaselineBusy}
          onStateChange={() => setDetailRefreshIndex((currentIndex) => currentIndex + 1)}
          target={{
            artistDisplayName: queueArtist(selectedSuggestion),
            releaseGroupMbid: selectedSuggestion.proposedMetadata?.externalReferences?.find((reference) => reference.provider === "musicbrainz" && reference.entityType === "release-group")?.externalId || "",
            title: queueTitle(selectedSuggestion),
          }}
        />
      ) : null;
      const decision = (
        <ModeratorDecision
          duplicateCandidates={selectedDuplicateCandidates}
          error={activeCommandState.error}
          key={`${selectedSuggestion.submissionId}:${selectedSuggestion.currentRevision}`}
          onClearFeedback={clearCommandFeedback}
          onCommand={applyCommand}
          pendingAction={activeCommandState.pendingAction}
          submission={selectedSuggestion}
          success={activeCommandState.success}
        />
      );
      detailChildren = isMobileDecisionLayout
        ? [toolbar, baselineReview, decision, submissionDetail]
        : [toolbar, submissionDetail, baselineReview, decision];
    }

    return (
      <section className="moderation-detail-panel" aria-label="Selected suggestion" key="moderation-detail">
        {!submissionId ? (
          <div className="community-empty-state moderation-detail-empty">
            <p className="community-eyebrow">No selection</p>
            <h2>Choose a queue record to inspect.</h2>
            <p>The full proposal, tracks, evidence, revisions, audit history, and duplicate candidates appear here.</p>
          </div>
        ) : null}

        {submissionId && activeDetailState.isLoading ? (
          <div className="community-loading moderation-detail-loading" role="status">
            <span className="community-loading-mark" aria-hidden="true">D</span>
            <p>Loading proposal history…</p>
          </div>
        ) : null}

        {submissionId && activeDetailState.error ? (
          <div className="community-empty-state moderation-detail-error" role="alert">
            <p className="community-eyebrow">Detail unavailable</p>
            <h2>{activeDetailState.error.message}</h2>
            {activeDetailState.error.code ? <code>{activeDetailState.error.code}</code> : null}
            <div className="moderation-detail-error-actions">
              <button className="community-primary-button" onClick={() => setDetailRefreshIndex((currentIndex) => currentIndex + 1)} type="button">
                Try again
              </button>
              <button className="community-secondary-button" onClick={() => navigate(MODERATION_PATH)} type="button">
                Close record
              </button>
            </div>
          </div>
        ) : null}

        {detailChildren ? <div className="moderation-detail-content">{detailChildren}</div> : null}
      </section>
    );
  }

  if (!isLoaded) {
    return (
      <section className="community-page moderation-page">
        <div className="community-loading" role="status">
          <span className="community-loading-mark" aria-hidden="true">M</span>
          <p>Opening the moderator desk…</p>
        </div>
      </section>
    );
  }

  if (!isSignedIn) {
    return (
      <section className="community-page moderation-page">
        <section className="community-empty-state moderation-access-state">
          <p className="community-eyebrow">Authentication required</p>
          <h1>Sign in to open moderation.</h1>
          <p>Community proposals and their evidence are private workflow records.</p>
        </section>
      </section>
    );
  }

  if (accessDenied) {
    return (
      <section className="community-page moderation-page">
        <section className="community-empty-state moderation-access-state" role="alert">
          <p className="community-eyebrow">Restricted desk · 403</p>
          <h1>This account does not have moderator access.</h1>
          <p>
            You are signed in, but the server has not allowlisted this account for the private review queue. That
            boundary keeps contributor identities, supporting evidence, and unresolved catalog work out of public view.
          </p>
          <p>If you should have access, ask a project administrator to verify the moderator allowlist for your user ID.</p>
          <button className="community-primary-button" onClick={() => navigate("/suggestions")} type="button">
            Return to my suggestions
          </button>
        </section>
      </section>
    );
  }

  return (
    <section className="community-page moderation-page">
      <header className="community-page-header moderation-page-header">
        <div>
          <p className="community-eyebrow">Community catalog · moderator desk</p>
          <h1>Suggestion queue</h1>
          <p>Review provenance, compare duplicate candidates, and leave a durable decision trail.</p>
        </div>
        <div className="moderation-page-actions">
          <button className="community-secondary-button" onClick={() => navigate("/moderation/album-mappings")} type="button">
            Album name mappings
          </button>
          <button className="community-secondary-button" onClick={() => navigate("/moderation/album-baselines")} type="button">
            Tracklist baselines
          </button>
          <button className="community-secondary-button" onClick={() => navigate("/suggestions")} type="button">
            My suggestions
          </button>
          <button
            className="community-secondary-button"
            disabled={isQueueLoading || isQueueLoadingMore}
            onClick={() => setQueueRefreshIndex((currentIndex) => currentIndex + 1)}
            type="button"
          >
            Refresh queue
          </button>
        </div>
      </header>

      <div className="moderation-workspace">
        {isNarrowWorkspace && submissionId ? renderDetailPanel() : null}
        <aside className="moderation-queue-panel community-panel" aria-label="Moderation queue">
          <form className="moderation-filters" onSubmit={applyFilters}>
            <div className="moderation-filter-heading">
              <div>
                <p className="community-eyebrow">Queue controls</p>
                <h2>Filter records</h2>
              </div>
              <button className="community-text-button" onClick={clearFilters} type="button">Reset</button>
            </div>

            <fieldset className="moderation-status-filter">
              <legend>Status</legend>
              <div className="moderation-filter-presets">
                <button onClick={() => chooseStatusPreset(["pending"])} type="button">Pending only</button>
                <button onClick={() => chooseStatusPreset(ALL_STATUSES)} type="button">All states</button>
              </div>
              <div className="moderation-status-options">
                {STATUS_OPTIONS.map((option) => (
                  <label key={option.value}>
                    <input
                      checked={filterDraft.statuses.includes(option.value)}
                      onChange={() => toggleStatus(option.value)}
                      type="checkbox"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="community-field moderation-filter-field">
              <label htmlFor="moderation-submission-type-filter">Submission type</label>
              <select
                id="moderation-submission-type-filter"
                onChange={(event) => setFilterDraft((currentFilters) => ({
                  ...currentFilters,
                  submissionType: event.target.value,
                }))}
                value={filterDraft.submissionType}
              >
                <option value="">All submission types</option>
                <option value="new_album">New albums</option>
                <option value="catalog_correction">Catalog corrections</option>
              </select>
            </div>

            <div className="community-field moderation-filter-field">
              <label htmlFor="moderation-duplicate-filter">Possible duplicate</label>
              <select
                id="moderation-duplicate-filter"
                onChange={(event) => setFilterDraft((currentFilters) => ({
                  ...currentFilters,
                  possibleDuplicate: event.target.value,
                }))}
                value={filterDraft.possibleDuplicate}
              >
                <option value="">All proposals</option>
                <option value="true">Possible duplicate</option>
                <option value="false">No duplicate signal</option>
              </select>
            </div>

            <div className="community-field moderation-filter-field">
              <label htmlFor="moderation-submitter-filter">Submitter user ID</label>
              <input
                autoComplete="off"
                id="moderation-submitter-filter"
                maxLength={128}
                onChange={(event) => setFilterDraft((currentFilters) => ({
                  ...currentFilters,
                  submittedByUserId: event.target.value,
                }))}
                placeholder="Exact Clerk user ID"
                type="text"
                value={filterDraft.submittedByUserId}
              />
            </div>

            <div className="community-field moderation-filter-field">
              <label htmlFor="moderation-page-size">Page size</label>
              <select
                id="moderation-page-size"
                onChange={(event) => setFilterDraft((currentFilters) => ({
                  ...currentFilters,
                  limit: event.target.value,
                }))}
                value={filterDraft.limit}
              >
                <option value="10">10 records</option>
                <option value="20">20 records</option>
                <option value="50">50 records</option>
              </select>
            </div>

            {filterError ? <p className="community-message community-message-error" role="alert">{filterError}</p> : null}
            <button className="community-primary-button moderation-apply-filters" disabled={isQueueLoading} type="submit">
              Apply filters
            </button>
          </form>

          <div className="moderation-queue-heading">
            <h2>Oldest activity first</h2>
            <span>{queueSuggestions.length} loaded</span>
          </div>

          <div className="moderation-queue" aria-busy={isQueueLoading || isQueueLoadingMore}>
            {isQueueLoading && queueSuggestions.length === 0 ? (
              <div className="community-loading moderation-queue-loading" role="status">
                <span className="community-loading-mark" aria-hidden="true">Q</span>
                <p>Loading private queue…</p>
              </div>
            ) : null}

            {queueError ? (
              <div className="community-message community-message-error" role="alert">
                <strong>{queueError.message}</strong>
                {queueError.code ? <code>{queueError.code}</code> : null}
                {retryAfterLabel(queueError.retryAfterSeconds) ? <small>{retryAfterLabel(queueError.retryAfterSeconds)}</small> : null}
                <button className="community-text-button" onClick={() => setQueueRefreshIndex((currentIndex) => currentIndex + 1)} type="button">
                  Try again
                </button>
              </div>
            ) : null}

            {!isQueueLoading && !queueError && queueSuggestions.length === 0 ? (
              <div className="community-empty-state moderation-queue-empty">
                <h3>No records match these filters.</h3>
                <p>Try another status set, remove the submitter filter, or include possible duplicates.</p>
              </div>
            ) : null}

            {queueSuggestions.length > 0 ? (
              <ol className="moderation-queue-list">
                {queueSuggestions.map((suggestion) => (
                  <li key={suggestion.submissionId}>
                    <button
                      aria-current={submissionId === suggestion.submissionId ? "true" : undefined}
                      className={`moderation-queue-card${submissionId === suggestion.submissionId ? " moderation-queue-card-selected" : ""}`}
                      onClick={() => navigate(`${MODERATION_PATH}/${suggestion.submissionId}`)}
                      type="button"
                    >
                      <span className="moderation-queue-card-topline">
                        <span className={`community-status community-status-${suggestion.status}`}>
                          {formatCommunityStatus(suggestion.status)}
                        </span>
                        <time dateTime={suggestion.updatedAt}>{formatCommunityDate(suggestion.updatedAt)}</time>
                      </span>
                      <strong>{queueTitle(suggestion)}</strong>
                      <span>{queueArtist(suggestion)}</span>
                      <span className="moderation-queue-card-meta">
                        <span>Rev. {suggestion.currentRevision || 1}</span>
                        <span>{suggestion.sourceCount || 0} evidence source{suggestion.sourceCount === 1 ? "" : "s"}</span>
                      </span>
                      {Array.isArray(suggestion.sourceTypes) && suggestion.sourceTypes.length > 0 ? (
                        <span className="moderation-source-types">
                          {suggestion.sourceTypes.map((sourceType) => (
                            <span key={sourceType}>{sourceTypeLabel(sourceType)}</span>
                          ))}
                        </span>
                      ) : null}
                      {suggestion.hasPossibleDuplicate ? (
                        <span className="moderation-duplicate-flag">Possible duplicate</span>
                      ) : null}
                      <code>{suggestion.submittedByUserId}</code>
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}

            {nextCursor ? (
              <button
                className="community-secondary-button moderation-load-more"
                disabled={isQueueLoading || isQueueLoadingMore}
                onClick={() => fetchQueuePage({ cursor: nextCursor, append: true })}
                type="button"
              >
                {isQueueLoadingMore ? "Loading next page…" : "Load more"}
              </button>
            ) : null}
          </div>
        </aside>
        {isNarrowWorkspace && submissionId ? null : renderDetailPanel()}
      </div>
    </section>
  );
}

export default ModerationSuggestions;
