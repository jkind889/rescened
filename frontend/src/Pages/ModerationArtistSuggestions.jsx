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
  const [queueRefresh, setQueueRefresh] = useState(0);

  const request = useCallback(async (path, options = {}) => {
    const token = await getToken();
    return requestCommunityJson(`${BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } }, "The moderation request failed.");
  }, [getToken]);

  const refreshQueue = useCallback(() => setQueueRefresh((value) => value + 1), []);

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
      <SuggestionQueue key={`${status}:${queueRefresh}`} status={status} request={request} />
      {/* Keyed by route: every visit to a suggestion (including returning to
          one) is a new instance, so a decision sent from an earlier visit can
          never update, fail into, or leave pending a later one. */}
      {submissionId ? <SuggestionReview key={submissionId} submissionId={submissionId} request={request} onQueueChanged={refreshQueue} /> : null}
    </section>
  );
}

// A filter change or moderation refresh starts a new queue instance. Its
// aborted requests cannot append old pages or clear the new queue's state.
function SuggestionQueue({ status, request }) {
  const [queue, setQueue] = useState({ rows: [], nextCursor: null, loading: true, error: null });
  const controller = useRef(null);
  const pending = useRef(false);

  const load = useCallback(async (cursor = null) => {
    if (pending.current) return;
    pending.current = true;
    const current = new AbortController();
    controller.current = current;
    setQueue((value) => ({ ...value, loading: true, error: null }));
    try {
      const query = new URLSearchParams({ status });
      if (cursor) query.set("cursor", cursor);
      const data = await request(`?${query}`, { signal: current.signal });
      if (current.signal.aborted) return;
      setQueue((value) => {
        const rows = cursor ? [...value.rows] : [];
        const seen = new Set(rows.map((row) => row.submissionId));
        for (const row of data.suggestions || []) {
          if (!seen.has(row.submissionId)) {
            seen.add(row.submissionId);
            rows.push(row);
          }
        }
        return { rows, nextCursor: data.nextCursor || null, loading: false, error: null };
      });
    } catch (error) {
      if (!current.signal.aborted) setQueue((value) => ({ ...value, loading: false, error: communityErrorFrom(error) }));
    } finally {
      if (controller.current === current) pending.current = false;
    }
  }, [request, status]);

  useEffect(() => {
    load();
    return () => {
      controller.current?.abort();
      pending.current = false;
    };
  }, [load]);

  return (
    <>
      {queue.error ? <p className="community-message community-message-error" role="alert">{queue.error.message}</p> : null}
      {queue.loading ? <p role="status">Loading suggestions…</p> : null}
      {!queue.loading && !queue.error && !queue.rows.length ? <p className="community-message">No artist suggestions here.</p> : null}
      <ul className="artist-suggestion-list">
        {queue.rows.map((row) => (
          <li key={row.submissionId}>
            <Link to={`/moderation/artist-suggestions/${row.submissionId}`}>{proposalName(row.proposal) || "Artist suggestion"}</Link>
            {" · "}{row.proposal?.kind === "musicbrainz" ? "MusicBrainz" : "Community"}{" · revision "}{row.currentRevision}
          </li>
        ))}
      </ul>
      {queue.nextCursor || queue.error ? (
        <button type="button" className="community-button" disabled={queue.loading} onClick={() => load(queue.nextCursor)}>
          {queue.error ? "Retry loading suggestions" : "Load more"}
        </button>
      ) : null}
    </>
  );
}

function SuggestionReview({ submissionId, request, onQueueChanged }) {
  const [detail, setDetail] = useState({ data: null, error: null });
  const [command, setCommand] = useState({ pending: false, error: null });
  const [detailRefresh, setDetailRefresh] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request(`/${encodeURIComponent(submissionId)}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setDetail({ data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setDetail({ data: null, error: communityErrorFrom(error) }); });
    return () => controller.abort();
  }, [request, submissionId, detailRefresh]);

  async function decide(action, body) {
    setCommand({ pending: true, error: null });
    try {
      const data = await request(`/${encodeURIComponent(submissionId)}/${PATHS[action]}`, { method: "POST", body: JSON.stringify(body) });
      if (!alive.current) {
        // This visit is gone; only the shared queue may need reloading.
        onQueueChanged();
        return;
      }
      // The response is the new detail; only the queue needs reloading.
      setDetail({ data, error: null });
      setCommand({ pending: false, error: null });
      onQueueChanged();
    } catch (error) {
      if (!alive.current) return;
      setCommand({ pending: false, error: communityErrorFrom(error) });
      // A conflict means the shown revision is stale: reload both.
      if (error?.status === 409) {
        setDetailRefresh((value) => value + 1);
        onQueueChanged();
      }
    }
  }

  if (detail.error) return <p className="community-message community-message-error" role="alert">{detail.error.message}</p>;
  if (!detail.data) return null;
  return (
    <>
      <ArtistSuggestionDetail suggestion={detail.data.suggestion} showContributor />
      <ArtistSuggestionDecision
        key={`${detail.data.suggestion.submissionId}:${detail.data.suggestion.currentRevision}:${detail.data.suggestion.status}`}
        suggestion={detail.data.suggestion}
        context={detail.data.context}
        pending={command.pending}
        error={command.error}
        onCommand={decide}
      />
    </>
  );
}

export default ModerationArtistSuggestions;
