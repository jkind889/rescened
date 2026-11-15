import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useParams } from "react-router-dom";
import { API_BASE_URL } from "../config/api";
import { communityErrorFrom, requestCommunityJson } from "../features/community/community";
import { artistSuggestionStatusLabel, proposalName } from "../features/artists/artistSuggestionPayload.js";
import ArtistSuggestionDetail from "../Components/Community/ArtistSuggestionDetail.jsx";
import ArtistSuggestionDecision from "../Components/Community/ArtistSuggestionDecision.jsx";

const BASE = `${API_BASE_URL}/moderation/artist-suggestions`;
const PATHS = { approve: "approve", request_changes: "request-changes", reject: "reject", mark_duplicate: "mark-duplicate" };

// Moderator queue and review for standalone artist suggestions. The API
// enforces moderator access; this page only renders what it returns.
export function ModerationArtistSuggestions() {
  const { userId } = useAuth();
  return <ModerationPanel key={userId || "signed-out"} />;
}

function ModerationPanel() {
  const { getToken } = useAuth();
  const { submissionId } = useParams();
  const [status, setStatus] = useState("pending");
  const [queue, setQueue] = useState({ state: "loading", rows: [], error: null });
  const [detail, setDetail] = useState({ submissionId: "", data: null, error: null });
  // Command state belongs to the suggestion it was sent for; a result that
  // arrives after the moderator opened another suggestion is dropped.
  const [command, setCommand] = useState({ submissionId: "", pending: false, error: null });
  const activeSubmission = useRef(submissionId);
  useEffect(() => {
    activeSubmission.current = submissionId;
  }, [submissionId]);
  const [queueRefresh, setQueueRefresh] = useState(0);
  const [detailRefresh, setDetailRefresh] = useState(0);

  const request = useCallback(async (path, options = {}) => {
    const token = await getToken();
    return requestCommunityJson(`${BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } }, "The moderation request failed.");
  }, [getToken]);

  useEffect(() => {
    const controller = new AbortController();
    request(`?status=${encodeURIComponent(status)}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setQueue({ state: "ready", rows: data.suggestions || [], error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setQueue({ state: "error", rows: [], error: communityErrorFrom(error) }); });
    return () => controller.abort();
  }, [request, status, queueRefresh]);

  useEffect(() => {
    if (!submissionId) return undefined;
    const controller = new AbortController();
    request(`/${encodeURIComponent(submissionId)}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setDetail({ submissionId, data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setDetail({ submissionId, data: null, error: communityErrorFrom(error) }); });
    return () => controller.abort();
  }, [request, submissionId, detailRefresh]);

  // A command finished after the moderator moved on: clear its pending
  // state (the suggestion reloads when reopened) and show nothing.
  function settleElsewhere(target) {
    setCommand((current) => (current.submissionId === target ? { submissionId: target, pending: false, error: null } : current));
    setQueueRefresh((value) => value + 1);
  }

  async function decide(action, body) {
    const target = detail.data?.suggestion?.submissionId;
    if (!target) return;
    setCommand({ submissionId: target, pending: true, error: null });
    try {
      const data = await request(`/${encodeURIComponent(target)}/${PATHS[action]}`, { method: "POST", body: JSON.stringify(body) });
      if (activeSubmission.current !== target) {
        settleElsewhere(target);
        return;
      }
      setDetail((current) => (current.submissionId === target ? { submissionId: target, data, error: null } : current));
      setCommand({ submissionId: target, pending: false, error: null });
      // The response is the new detail; only the queue needs reloading.
      setQueueRefresh((value) => value + 1);
    } catch (error) {
      if (activeSubmission.current !== target) {
        settleElsewhere(target);
        return;
      }
      setCommand({ submissionId: target, pending: false, error: communityErrorFrom(error) });
      // A conflict means the shown revision is stale: reload both.
      if (error?.status === 409) {
        setQueueRefresh((value) => value + 1);
        setDetailRefresh((value) => value + 1);
      }
    }
  }

  const shown = detail.submissionId === submissionId ? detail.data : null;
  const shownCommand = command.submissionId === submissionId ? command : { pending: false, error: null };
  return (
    <section className="community-page moderation-artist-suggestions">
      <h1>Artist suggestions</h1>
      <label className="community-field">
        <span>Status</span>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {["pending", "needs_changes", "approved", "rejected", "duplicate", "withdrawn"].map((value) => (
            <option key={value} value={value}>{artistSuggestionStatusLabel(value)}</option>
          ))}
        </select>
      </label>
      {queue.state === "error" ? <p className="community-message community-message-error" role="alert">{queue.error?.message}</p> : null}
      {queue.state === "ready" && !queue.rows.length ? <p className="community-message">No artist suggestions here.</p> : null}
      <ul className="artist-suggestion-list">
        {queue.rows.map((row) => (
          <li key={row.submissionId}>
            <Link to={`/moderation/artist-suggestions/${row.submissionId}`}>{proposalName(row.proposal) || "Artist suggestion"}</Link>
            {" · "}{row.proposal?.kind === "musicbrainz" ? "MusicBrainz" : "Community"}{" · revision "}{row.currentRevision}
          </li>
        ))}
      </ul>
      {submissionId && detail.error && detail.submissionId === submissionId ? <p className="community-message community-message-error" role="alert">{detail.error.message}</p> : null}
      {shown ? (
        <>
          <ArtistSuggestionDetail suggestion={shown.suggestion} showContributor />
          <ArtistSuggestionDecision
            key={`${shown.suggestion.submissionId}:${shown.suggestion.currentRevision}:${shown.suggestion.status}`}
            suggestion={shown.suggestion}
            context={shown.context}
            pending={shownCommand.pending}
            error={shownCommand.error}
            onCommand={decide}
          />
        </>
      ) : null}
    </section>
  );
}

export default ModerationArtistSuggestions;
