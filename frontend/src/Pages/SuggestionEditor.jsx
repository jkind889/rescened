import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import SuggestionForm from "../Components/Community/SuggestionForm";
import CorrectionForm from "../Components/Community/CorrectionForm";
import GenreSuggestionForm from "../Components/Community/GenreSuggestionForm";
import { API_BASE_URL } from "../config/api";
import {
  communityErrorFrom,
  formatCommunityDate,
  requestCommunityJson,
} from "../features/community/community";
import { clearDraft, suggestionDraftKey } from "../features/community/drafts.js";

function EditorError({ error, onRetry = null }) {
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

export function SuggestionEditor({ mode = "create" }) {
  const { albumId, submissionId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { getToken, userId } = useAuth();
  const isRevision = mode === "revise";
  const isCorrection = mode === "correction";
  const isGenreCreate = mode === "genres";
  const externalMbid = isRevision || isGenreCreate ? "" : (searchParams.get("mbid") || "").trim();
  const [submission, setSubmission] = useState(null);
  const correctionFlow = isCorrection || (isRevision && submission?.submissionType === "catalog_correction");
  const genreFlow = isGenreCreate || (isRevision && submission?.submissionType === "genre_suggestion");
  // Genre forms work against the album's genres now; Array.isArray tells us
  // the server has genres enabled.
  const genreAlbum = isGenreCreate ? submission?.targetAlbum : submission?.currentAlbum;
  const genresUnavailable = genreFlow && submission && !Array.isArray(genreAlbum?.genres);
  const [loadStatus, setLoadStatus] = useState(isRevision || isCorrection || isGenreCreate || externalMbid ? "idle" : "ready");
  const [loadError, setLoadError] = useState(null);
  const [mutationStatus, setMutationStatus] = useState("idle");
  const [mutationError, setMutationError] = useState(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function loadEditorData() {
      if (!isRevision && !isCorrection && !isGenreCreate && !externalMbid) {
        setSubmission(null);
        setLoadError(null);
        setLoadStatus("ready");
        return;
      }

      if (isRevision && !submissionId) {
        setLoadError({
          message: "No suggestion ID was provided.",
          code: "MISSING_SUBMISSION_ID",
          details: [],
        });
        setLoadStatus("error");
        return;
      }

      if ((isCorrection || isGenreCreate) && !albumId) {
        setLoadError({
          message: "No catalog album ID was provided.",
          code: "MISSING_ALBUM_ID",
          details: [],
        });
        setLoadStatus("error");
        return;
      }

      setLoadStatus("loading");
      setLoadError(null);
      setSubmission(null);

      try {
        let data;
        if (isCorrection || isGenreCreate) {
          data = await requestCommunityJson(
            `${API_BASE_URL}/albums/album/${encodeURIComponent(albumId)}`,
            { signal: controller.signal },
            "Could not load this catalog album.",
          );
          data = { targetAlbum: data };
        } else if (isRevision) {
          const token = await getToken();
          if (controller.signal.aborted) return;
          data = await requestCommunityJson(
            `${API_BASE_URL}/suggestions/${encodeURIComponent(submissionId)}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: controller.signal,
            },
            "Could not load this suggestion for revision.",
          );
          if (data?.submissionType === "genre_suggestion" && data.targetAlbumId) {
            const currentAlbum = await requestCommunityJson(
              `${API_BASE_URL}/albums/album/${encodeURIComponent(data.targetAlbumId)}`,
              { signal: controller.signal },
              "Could not load this suggestion's album.",
            );
            data = { ...data, currentAlbum };
          }
        } else {
          data = await requestCommunityJson(
            `${API_BASE_URL}/search/musicbrainz/release-group/${encodeURIComponent(externalMbid)}`,
            { signal: controller.signal },
            "Could not load this MusicBrainz release group.",
          );

          if (!data?.proposedMetadata) {
            const alreadyInCatalogError = new Error("This album is already in the Rescened catalog.");
            alreadyInCatalogError.code = "ALBUM_ALREADY_IN_CATALOG";
            alreadyInCatalogError.details = data?.albumId ? ["Open the catalog album instead of submitting a duplicate suggestion."] : [];
            alreadyInCatalogError.albumId = data?.albumId || "";
            throw alreadyInCatalogError;
          }
        }

        if (controller.signal.aborted) return;
        setSubmission(data);
        setLoadStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(communityErrorFrom(
          error,
          isCorrection || isGenreCreate ? "Could not load this catalog album." : isRevision ? "Could not load this suggestion for revision." : "Could not load this MusicBrainz release group.",
        ));
        setLoadStatus("error");
      }
    }

    loadEditorData();
    return () => controller.abort();
  }, [albumId, externalMbid, getToken, isCorrection, isGenreCreate, isRevision, refreshIndex, submissionId]);

  // Drafts are per signed-in user and per thing being edited; a revision draft
  // never carries over to a later revision.
  const draftContext = isRevision
    ? submission?.submissionId && submission?.currentRevision ? `revise:${submission.submissionId}:${submission.currentRevision}` : ""
    : isCorrection ? `correction:${albumId}`
    : externalMbid ? `create:mbid:${externalMbid}` : "create";
  const draftKey = suggestionDraftKey(userId, draftContext);

  async function submitSuggestion(payload) {
    setMutationStatus("loading");
    setMutationError(null);

    try {
      const token = await getToken();
      const endpoint = isGenreCreate
        ? `${API_BASE_URL}/suggestions/genres`
        : isCorrection
        ? `${API_BASE_URL}/suggestions/corrections`
        : isRevision
        ? `${API_BASE_URL}/suggestions/${encodeURIComponent(submissionId)}/revise`
        : `${API_BASE_URL}/suggestions`;
      const data = await requestCommunityJson(
        endpoint,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        },
        isGenreCreate ? "Could not send this genre suggestion." : isCorrection ? "Could not submit this correction." : isRevision ? "Could not submit this revision." : "Could not create this suggestion.",
      );

      if (!genreFlow) clearDraft(draftKey);
      setMutationStatus("success");
      // Proposed names that already existed were stored as those genres.
      const reused = (data.resolvedNewGenres || []).map((match) => `“${match.name}” is the existing genre ${match.genre.name}`);
      navigate(`/suggestions/${data.submissionId}`, {
        replace: isRevision,
        state: {
          notice: isRevision
            ? "Revision submitted. The suggestion is back in the moderation queue."
            : genreFlow
              ? ["Genre suggestion sent for review.", reused.length ? `${reused.join("; ")}.` : ""].filter(Boolean).join(" ")
              : isCorrection ? "Correction submitted for community review." : "Suggestion submitted for community review.",
        },
      });
    } catch (error) {
      setMutationError(communityErrorFrom(
        error,
        isGenreCreate ? "Could not send this genre suggestion." : isCorrection ? "Could not submit this correction." : isRevision ? "Could not submit this revision." : "Could not create this suggestion.",
      ));
      setMutationStatus("error");
    }
  }

  const latestChangeRequest = isRevision
    ? [...(submission?.moderationHistory || [])]
      .reverse()
      .find((event) => ["request_changes", "requested_changes"].includes(event.action))
    : null;
  const revisionBlocked = isRevision && submission && submission.status !== "needs_changes";
  const externalPrefill = !isRevision && !isCorrection && !isGenreCreate && Boolean(externalMbid);

  return (
    <section className="community-page community-editor-page">
      <div className="community-page-frame community-editor-frame">
        <nav className="community-breadcrumb" aria-label="Suggestions breadcrumb">
          <Link
            className="community-back-link"
            to={submissionId ? `/suggestions/${submissionId}` : albumId ? `/album/${albumId}` : "/search"}
          >
            ← {submissionId ? "Suggestion detail" : "Your suggestions"}
          </Link>
        </nav>

        <header className="community-page-header community-editor-header">
          <div className="community-page-heading-copy">
            <p className="community-page-kicker">{genreFlow ? "Genre suggestion" : correctionFlow ? "Catalog correction" : isRevision ? "Contributor revision" : "New catalog proposal"}</p>
            <h1 className="community-page-title">
              {genreFlow
                ? `${isRevision ? "Revise genres for" : "Suggest genres for"} ${genreAlbum?.title || "this album"}`
                : correctionFlow ? "Suggest a catalog correction" : isRevision ? "Revise an album suggestion" : "Suggest an album"}
            </h1>
            <p className="community-page-description">
              {genreFlow
                ? "Add or remove genres and pick the primary one. A moderator reviews every change, including new genre names."
                : correctionFlow
                ? "Propose a precise, evidence-backed patch to one existing Rescened album."
                : isRevision
                ? "Update the complete record—not only the requested fields—then return it to the queue."
                : externalPrefill
                  ? "Review this MusicBrainz record, complete any missing evidence, and send it to the community queue."
                  : "Build a reviewable album record and back every proposal with reliable source evidence."}
            </p>
          </div>
        </header>

        {loadStatus === "loading" ? (
          <div className="community-loading" role="status" aria-live="polite">
            <span className="community-loading-index">Loading</span>
            <p className="community-loading-message">
              {isCorrection || isGenreCreate ? "Preparing the catalog album…" : externalPrefill ? "Preparing MusicBrainz release group…" : "Preparing the latest revision…"}
            </p>
          </div>
        ) : null}
        {loadStatus === "error" ? (
          <EditorError
            error={loadError}
            onRetry={() => setRefreshIndex((current) => current + 1)}
          />
        ) : null}

        {revisionBlocked ? (
          <section className="suggestion-editor-blocked">
            <p className="suggestion-editor-blocked-index">Revision unavailable</p>
            <h2 className="suggestion-editor-blocked-title">This suggestion is not awaiting changes.</h2>
            <p className="suggestion-editor-blocked-description">
              Only suggestions with a “Changes requested” status can be revised.
            </p>
            <Link className="community-primary-link" to={`/suggestions/${submission.submissionId}`}>Return to suggestion</Link>
          </section>
        ) : null}

        {latestChangeRequest?.reason && !revisionBlocked ? (
          <aside className="suggestion-editor-request" aria-labelledby="suggestion-editor-request-title">
            <div className="suggestion-editor-request-heading">
              <p className="suggestion-editor-request-kicker">Moderator request</p>
              <h2 className="suggestion-editor-request-title" id="suggestion-editor-request-title">What needs to change</h2>
              <time className="suggestion-editor-request-date" dateTime={latestChangeRequest.createdAt || undefined}>
                {formatCommunityDate(latestChangeRequest.createdAt)}
              </time>
            </div>
            <p className="suggestion-editor-request-reason">{latestChangeRequest.reason}</p>
          </aside>
        ) : null}

        {genresUnavailable ? (
          <section className="suggestion-editor-blocked">
            <p className="suggestion-editor-blocked-index">Genres unavailable</p>
            <h2 className="suggestion-editor-blocked-title">Genre suggestions aren't turned on.</h2>
          </section>
        ) : null}

        {loadStatus === "ready" && !revisionBlocked && genreFlow && !genresUnavailable ? (
          <GenreSuggestionForm
            key={`${submission?.submissionId || albumId}-${submission?.currentRevision || 0}`}
            album={genreAlbum}
            currentGenres={genreAlbum.genres}
            initialChanges={isRevision ? submission.genreChanges : null}
            onSubmit={submitSuggestion}
            submitLabel={isRevision ? "Submit revised genres" : "Send for review"}
            submittingLabel={isRevision ? "Submitting revision…" : "Sending suggestion…"}
            isSubmitting={mutationStatus === "loading"}
            error={mutationError}
          />
        ) : null}

        {loadStatus === "ready" && !revisionBlocked && !genreFlow ? (correctionFlow ? (
          <CorrectionForm
            key={`${submission?.submissionId || albumId || "correction"}-${submission?.currentRevision || 1}-${draftKey}`}
            initialValue={submission}
            draftKey={draftKey}
            onSubmit={submitSuggestion}
            submitLabel={isRevision ? "Submit corrected patch" : "Send correction for review"}
            submittingLabel={isRevision ? "Submitting correction…" : "Sending correction…"}
            isSubmitting={mutationStatus === "loading"}
            error={mutationError}
            formId={isRevision ? "community-correction-revision-form" : "community-correction-form"}
          />
        ) : (
          <SuggestionForm
            key={`${isRevision ? `${submission?.submissionId}-${submission?.currentRevision}` : externalMbid || "create"}-${draftKey}`}
            initialValue={submission}
            draftKey={draftKey}
            onSubmit={submitSuggestion}
            submitLabel={isRevision ? "Submit revised record" : "Send for review"}
            submittingLabel={isRevision ? "Submitting revision…" : "Sending suggestion…"}
            isSubmitting={mutationStatus === "loading"}
            error={mutationError}
            formId={isRevision ? "community-revision-form" : "community-create-form"}
          />
        )) : null}
      </div>
    </section>
  );
}

export default SuggestionEditor;
