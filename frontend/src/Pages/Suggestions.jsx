import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useLocation, useParams } from "react-router-dom";
import SubmissionDetails from "../Components/Community/SubmissionDetails";
import { API_BASE_URL } from "../config/api";
import {
  communityErrorFrom,
  formatCommunityDate,
  formatCommunityStatus,
  formatCommunityValue,
  requestCommunityJson,
  WITHDRAWABLE_SUGGESTION_STATUSES,
} from "../features/community/community";
import useMediaQuery from "../features/community/useMediaQuery";

const PAGE_LIMIT = 20;

function ErrorNotice({ error, onRetry = null }) {
  if (!error) {
    return null;
  }

  return (
    <div className="community-error" role="alert">
      <p className="community-error-message">{error.message || "Something went wrong."}</p>
      {error.code ? <p className="community-error-code">Code: {error.code}</p> : null}
      {error.details?.length ? (
        <ul className="community-error-details">
          {error.details.map((detail, index) => <li key={`${detail}-${index}`}>{detail}</li>)}
        </ul>
      ) : null}
      {error.retryAfterSeconds ? (
        <p className="community-error-retry-after">Try again in about {error.retryAfterSeconds} seconds.</p>
      ) : null}
      {onRetry ? (
        <button className="community-error-retry" type="button" onClick={onRetry}>Try again</button>
      ) : null}
    </div>
  );
}

function SuggestionCard({ suggestion, selected = false, compact = false }) {
  const metadata = suggestion.proposedMetadata || {};
  const TitleTag = compact ? "p" : "h2";

  return (
    <li className={selected ? "suggestion-list-item suggestion-list-item-active" : "suggestion-list-item"}>
      <Link
        className="suggestion-list-link"
        to={`/suggestions/${suggestion.submissionId}`}
        aria-current={selected ? "page" : undefined}
      >
        <div className="suggestion-list-index">
          <span className={`suggestion-status suggestion-status-${suggestion.status || "unknown"}`}>
            {formatCommunityStatus(suggestion.status)}
          </span>
          <span className="suggestion-list-revision">R{suggestion.currentRevision || 1}</span>
        </div>
        <div className="suggestion-list-copy">
          <TitleTag className="suggestion-list-title">{metadata.title || "Untitled suggestion"}</TitleTag>
          <p className="suggestion-list-artist">{metadata.artistDisplayName || "Artist not supplied"}</p>
          <p className="suggestion-list-meta">
            {[formatCommunityValue(metadata.releaseType), metadata.releaseDate || metadata.releaseYear].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="suggestion-list-aside">
          {suggestion.hasPossibleDuplicate ? (
            <span className="suggestion-list-duplicate">Duplicate signal</span>
          ) : null}
          <time className="suggestion-list-date" dateTime={suggestion.updatedAt || undefined}>
            {formatCommunityDate(suggestion.updatedAt || suggestion.createdAt)}
          </time>
          <span className="suggestion-list-open">Open →</span>
        </div>
      </Link>
    </li>
  );
}

function SuggestionIndex({
  suggestions,
  selectedId = "",
  listStatus,
  listError,
  loadMoreStatus,
  loadMoreError,
  nextCursor,
  onLoadMore,
  onRetry,
  compact = false,
}) {
  return (
    <section className={compact ? "suggestion-index suggestion-index-compact" : "suggestion-index"} aria-labelledby={compact ? "suggestion-index-heading" : "suggestion-list-heading"}>
      <div className="suggestion-list-heading-row">
        <div className="suggestion-index-heading-copy">
          <p className="suggestion-list-kicker">Contributor records</p>
          {compact ? (
            <p className="suggestion-list-heading" id="suggestion-index-heading">Your suggestions</p>
          ) : (
            <h2 className="suggestion-list-heading" id="suggestion-list-heading">Submission history</h2>
          )}
        </div>
        {compact ? (
          <Link className="suggestion-index-new" to="/suggestions/new" aria-label="Create a new album suggestion">+</Link>
        ) : (
          <span className="suggestion-list-count">{suggestions.length} loaded</span>
        )}
      </div>

      {listStatus === "loading" ? (
        <div className="community-loading community-loading-compact" role="status" aria-live="polite">
          <span className="community-loading-index">Loading</span>
          <p className="community-loading-message">Retrieving submission history…</p>
        </div>
      ) : null}
      {listStatus === "error" ? <ErrorNotice error={listError} onRetry={onRetry} /> : null}
      {listStatus === "ready" && suggestions.length === 0 ? (
        <div className="suggestion-index-empty">
          <p className="suggestion-index-empty-title">No suggestions yet.</p>
          <Link className="suggestion-index-empty-link" to="/suggestions/new">Suggest an album</Link>
        </div>
      ) : null}

      {suggestions.length ? (
        <ol className="suggestion-list">
          {suggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.submissionId}
              compact={compact}
              suggestion={suggestion}
              selected={suggestion.submissionId === selectedId}
            />
          ))}
        </ol>
      ) : null}
      <ErrorNotice error={loadMoreError} />
      {suggestions.length && nextCursor ? (
        <button
          className="community-load-more"
          type="button"
          disabled={loadMoreStatus === "loading"}
          onClick={onLoadMore}
        >
          {loadMoreStatus === "loading" ? "Loading more…" : "Load more suggestions"}
        </button>
      ) : null}
      {suggestions.length && !nextCursor ? <p className="community-list-end">End of submission history.</p> : null}
    </section>
  );
}

export function Suggestions() {
  const { submissionId } = useParams();
  const location = useLocation();
  const { getToken } = useAuth();
  const [suggestions, setSuggestions] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [listStatus, setListStatus] = useState("idle");
  const [listError, setListError] = useState(null);
  const [loadMoreStatus, setLoadMoreStatus] = useState("idle");
  const [loadMoreError, setLoadMoreError] = useState(null);
  const [submission, setSubmission] = useState(null);
  const [detailStatus, setDetailStatus] = useState("idle");
  const [detailError, setDetailError] = useState(null);
  const [withdrawIntent, setWithdrawIntent] = useState(false);
  const [withdrawStatus, setWithdrawStatus] = useState("idle");
  const [withdrawError, setWithdrawError] = useState(null);
  const [withdrawNotice, setWithdrawNotice] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const withdrawTriggerRef = useRef(null);
  const withdrawDialogRef = useRef(null);
  const withdrawCancelRef = useRef(null);
  const withdrawNoticeRef = useRef(null);
  const isNarrowWorkspace = useMediaQuery("(max-width: 900px)");

  useEffect(() => {
    if (!withdrawIntent) return undefined;

    const previousFocus = document.activeElement;
    const animationFrame = window.requestAnimationFrame(() => {
      (withdrawCancelRef.current || withdrawDialogRef.current)?.focus();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [withdrawIntent]);

  useEffect(() => {
    if (withdrawIntent && withdrawStatus === "loading") withdrawDialogRef.current?.focus();
  }, [withdrawIntent, withdrawStatus]);

  useEffect(() => {
    if (withdrawNotice) withdrawNoticeRef.current?.focus();
  }, [withdrawNotice]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSuggestions() {
      setListStatus("loading");
      setListError(null);
      setLoadMoreError(null);

      try {
        const token = await getToken();
        if (controller.signal.aborted) return;
        const data = await requestCommunityJson(
          `${API_BASE_URL}/suggestions/mine?limit=${PAGE_LIMIT}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
          "Could not load your suggestions.",
        );

        if (controller.signal.aborted) return;
        setSuggestions(Array.isArray(data?.suggestions) ? data.suggestions : []);
        setNextCursor(data?.nextCursor || null);
        setListStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setSuggestions([]);
        setNextCursor(null);
        setListError(communityErrorFrom(error, "Could not load your suggestions."));
        setListStatus("error");
      }
    }

    loadSuggestions();
    return () => controller.abort();
  }, [getToken, refreshIndex]);

  useEffect(() => {
    if (!submissionId) {
      return undefined;
    }

    const controller = new AbortController();

    async function loadSuggestion() {
      setDetailStatus("loading");
      setDetailError(null);
      setSubmission(null);
      setWithdrawIntent(false);
      setWithdrawError(null);
      setWithdrawNotice("");

      try {
        const token = await getToken();
        if (controller.signal.aborted) return;
        const data = await requestCommunityJson(
          `${API_BASE_URL}/suggestions/${encodeURIComponent(submissionId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
          "Could not load this suggestion.",
        );

        if (controller.signal.aborted) return;
        setSubmission(data);
        setDetailStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setDetailError(communityErrorFrom(error, "Could not load this suggestion."));
        setDetailStatus("error");
      }
    }

    loadSuggestion();
    return () => controller.abort();
  }, [getToken, refreshIndex, submissionId]);

  async function loadMore() {
    if (!nextCursor || loadMoreStatus === "loading") {
      return;
    }

    setLoadMoreStatus("loading");
    setLoadMoreError(null);

    try {
      const token = await getToken();
      const data = await requestCommunityJson(
        `${API_BASE_URL}/suggestions/mine?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(nextCursor)}`,
        { headers: { Authorization: `Bearer ${token}` } },
        "Could not load more suggestions.",
      );
      const page = Array.isArray(data?.suggestions) ? data.suggestions : [];
      setSuggestions((current) => {
        const known = new Set(current.map((item) => item.submissionId));
        return [...current, ...page.filter((item) => !known.has(item.submissionId))];
      });
      setNextCursor(data?.nextCursor || null);
      setLoadMoreStatus("idle");
    } catch (error) {
      setLoadMoreError(communityErrorFrom(error, "Could not load more suggestions."));
      setLoadMoreStatus("error");
    }
  }

  async function withdrawSuggestion() {
    if (!submission || withdrawStatus === "loading") {
      return;
    }

    setWithdrawStatus("loading");
    setWithdrawError(null);
    setWithdrawNotice("");

    try {
      const token = await getToken();
      const data = await requestCommunityJson(
        `${API_BASE_URL}/suggestions/${encodeURIComponent(submission.submissionId)}/withdraw`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
        "Could not withdraw this suggestion.",
      );
      setSubmission(data);
      setSuggestions((current) => current.map((suggestion) => (
        suggestion.submissionId === data.submissionId ? { ...suggestion, ...data } : suggestion
      )));
      setWithdrawIntent(false);
      setWithdrawStatus("success");
      setWithdrawNotice("Suggestion withdrawn. Its history is still available here.");
    } catch (error) {
      setWithdrawStatus("error");
      setWithdrawError(communityErrorFrom(error, "Could not withdraw this suggestion."));
    }
  }

  function retryCurrentView() {
    setRefreshIndex((current) => current + 1);
  }

  function handleWithdrawDialogKeyDown(event) {
    if (event.key === "Escape" && withdrawStatus !== "loading") {
      event.preventDefault();
      setWithdrawIntent(false);
      setWithdrawError(null);
      return;
    }

    if (event.key !== "Tab") return;
    const focusable = [...(withdrawDialogRef.current?.querySelectorAll("button:not(:disabled)") || [])];
    if (!focusable.length) {
      event.preventDefault();
      withdrawDialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (submissionId) {
    // Genre suggestions get their own editor with the genre picker; until
    // then they can be withdrawn but not revised from this page.
    const canRevise = submission?.status === "needs_changes" && submission?.submissionType !== "genre_suggestion";
    const canWithdraw = WITHDRAWABLE_SUGGESTION_STATUSES.includes(submission?.status);
    const actions = submission ? (
      <>
        {canRevise ? (
          <Link className="suggestion-action suggestion-action-primary" to={`/suggestions/${submission.submissionId}/revise`}>
            Revise suggestion
          </Link>
        ) : null}
        {canWithdraw ? (
          <button
            className="suggestion-action suggestion-action-danger"
            type="button"
            ref={withdrawTriggerRef}
            disabled={withdrawStatus === "loading"}
            onClick={() => {
              setWithdrawIntent(true);
              setWithdrawError(null);
            }}
          >
            Withdraw
          </button>
        ) : null}
      </>
    ) : null;
    const indexPane = (
      <aside className="community-index-pane" key="suggestion-index">
        <SuggestionIndex
          suggestions={suggestions}
          selectedId={submissionId}
          listStatus={listStatus}
          listError={listError}
          loadMoreStatus={loadMoreStatus}
          loadMoreError={loadMoreError}
          nextCursor={nextCursor}
          onLoadMore={loadMore}
          onRetry={retryCurrentView}
          compact
        />
      </aside>
    );
    const detailPane = (
      <div className="community-detail-pane" key="suggestion-detail">
        {detailStatus === "loading" ? (
          <div className="community-loading" role="status" aria-live="polite">
            <span className="community-loading-index">Loading</span>
            <p className="community-loading-message">Retrieving suggestion record…</p>
          </div>
        ) : null}
        {detailStatus === "error" ? <ErrorNotice error={detailError} onRetry={retryCurrentView} /> : null}

        {withdrawIntent && canWithdraw ? (
          <div
            aria-busy={withdrawStatus === "loading"}
            aria-labelledby="suggestion-withdraw-title"
            aria-modal="true"
            className="suggestion-withdraw-confirmation"
            onKeyDown={handleWithdrawDialogKeyDown}
            ref={withdrawDialogRef}
            role="alertdialog"
            tabIndex={-1}
          >
            <div className="suggestion-withdraw-copy">
              <h2 className="suggestion-withdraw-title" id="suggestion-withdraw-title">Withdraw this suggestion?</h2>
              <p className="suggestion-withdraw-description">
                It will leave the moderation queue and cannot be revised afterward. The audit record will remain.
              </p>
            </div>
            <div className="suggestion-withdraw-actions">
              <button
                className="suggestion-action suggestion-action-secondary"
                type="button"
                ref={withdrawCancelRef}
                disabled={withdrawStatus === "loading"}
                onClick={() => {
                  setWithdrawIntent(false);
                  setWithdrawError(null);
                }}
              >
                Keep suggestion
              </button>
              <button
                className="suggestion-action suggestion-action-danger"
                type="button"
                disabled={withdrawStatus === "loading"}
                onClick={withdrawSuggestion}
              >
                {withdrawStatus === "loading" ? "Withdrawing…" : "Confirm withdrawal"}
              </button>
            </div>
            <ErrorNotice error={withdrawError} />
          </div>
        ) : null}

        {submission ? <SubmissionDetails submission={submission} actions={actions} headingLevel={1} /> : null}
      </div>
    );

    return (
      <section className="community-page community-detail-page">
        <div className="community-page-frame">
          <nav className="community-breadcrumb" aria-label="Suggestions breadcrumb">
            <Link className="community-back-link" to="/suggestions">← Your suggestions</Link>
          </nav>

          {location.state?.notice ? (
            <p className="community-success" role="status">{location.state.notice}</p>
          ) : null}
          {withdrawNotice ? (
            <p className="community-success" ref={withdrawNoticeRef} role="status" tabIndex={-1}>{withdrawNotice}</p>
          ) : null}

          <div className="community-split-layout">
            {isNarrowWorkspace ? <>{detailPane}{indexPane}</> : <>{indexPane}{detailPane}</>}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="community-page community-list-page">
      <div className="community-page-frame">
        <header className="community-page-header">
          <div className="community-page-heading-copy">
            <p className="community-page-kicker">Community catalog desk</p>
            <h1 className="community-page-title">Your album suggestions</h1>
            <p className="community-page-description">
              Submit missing releases, track moderator feedback, and keep a complete revision record.
            </p>
          </div>
          <Link className="community-primary-link" to="/suggestions/new">+ Suggest an album</Link>
        </header>

        {listStatus === "ready" && suggestions.length === 0 ? (
          <section className="community-empty">
            <p className="community-empty-index">00 records</p>
            <h2 className="community-empty-title">Your suggestion desk is clear.</h2>
            <p className="community-empty-description">Found an album the catalog is missing? Send the evidence to the review queue.</p>
            <Link className="community-primary-link" to="/suggestions/new">Suggest the first album</Link>
          </section>
        ) : null}

        {listStatus !== "ready" || suggestions.length ? (
          <SuggestionIndex
            suggestions={suggestions}
            listStatus={listStatus}
            listError={listError}
            loadMoreStatus={loadMoreStatus}
            loadMoreError={loadMoreError}
            nextCursor={nextCursor}
            onLoadMore={loadMore}
            onRetry={retryCurrentView}
          />
        ) : null}
      </div>
    </section>
  );
}

export default Suggestions;
