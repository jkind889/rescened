import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { API_BASE_URL } from "../config/api";
import { communityErrorFrom, requestCommunityJson } from "../features/community/community";
import { artistSuggestionStatusLabel, proposalName } from "../features/artists/artistSuggestionPayload.js";
import ArtistSuggestionForm from "../Components/Community/ArtistSuggestionForm.jsx";
import ArtistSuggestionDetail from "../Components/Community/ArtistSuggestionDetail.jsx";

const BASE = `${API_BASE_URL}/artist-suggestions`;

// Contributor page for standalone artist suggestions: suggest an artist,
// list your suggestions, and open one to revise or withdraw it. Every
// command names the revision shown on the page.
export function ArtistSuggestions() {
  const { userId } = useAuth();
  return <ArtistSuggestionsPanel key={userId || "signed-out"} />;
}

function ArtistSuggestionsPanel() {
  const { getToken } = useAuth();
  const { submissionId } = useParams();
  const navigate = useNavigate();
  const [list, setList] = useState({ status: "loading", rows: [], error: null });
  const [detail, setDetail] = useState({ status: "idle", data: null, error: null });
  const [mutation, setMutation] = useState({ status: "idle", error: null });
  const [refresh, setRefresh] = useState(0);
  const requestKey = useRef(null);

  const request = useCallback(async (path, options = {}) => {
    const token = await getToken();
    return requestCommunityJson(`${BASE}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } }, "The artist suggestion request failed.");
  }, [getToken]);

  useEffect(() => {
    if (submissionId) return undefined;
    const controller = new AbortController();
    request("/mine", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setList({ status: "ready", rows: data.suggestions || [], error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setList({ status: "error", rows: [], error: communityErrorFrom(error) }); });
    return () => controller.abort();
  }, [request, submissionId, refresh]);

  useEffect(() => {
    if (!submissionId) return undefined;
    const controller = new AbortController();
    request(`/${encodeURIComponent(submissionId)}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setDetail({ status: "ready", data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setDetail({ status: "error", data: null, error: communityErrorFrom(error) }); });
    return () => controller.abort();
  }, [request, submissionId, refresh]);

  // A retry of the same suggestion reuses its request key; any change gets a new one.
  function withRequestKey(payload) {
    const fingerprint = JSON.stringify(payload);
    if (requestKey.current?.fingerprint !== fingerprint) requestKey.current = { fingerprint, key: globalThis.crypto.randomUUID() };
    return { ...payload, requestKey: requestKey.current.key };
  }

  async function mutate(work) {
    setMutation({ status: "loading", error: null });
    try {
      const data = await work();
      setMutation({ status: "idle", error: null });
      return data;
    } catch (error) {
      setMutation({ status: "error", error: communityErrorFrom(error) });
      if (error?.status === 409 && error?.code !== "ARTIST_ALREADY_EXISTS") setRefresh((value) => value + 1);
      return null;
    }
  }

  async function create(payload) {
    const data = await mutate(() => request("", { method: "POST", body: JSON.stringify(withRequestKey(payload)) }));
    if (data?.submissionId) navigate(`/artist-suggestions/${data.submissionId}`);
  }

  async function revise(payload) {
    const shown = detail.data;
    const data = await mutate(() => request(`/${encodeURIComponent(shown.submissionId)}/revise`, { method: "POST", body: JSON.stringify({ ...payload, expectedRevision: shown.currentRevision }) }));
    if (data) setDetail({ status: "ready", data, error: null });
  }

  async function withdraw() {
    const shown = detail.data;
    const data = await mutate(() => request(`/${encodeURIComponent(shown.submissionId)}/withdraw`, { method: "POST", body: JSON.stringify({ expectedRevision: shown.currentRevision }) }));
    if (data) setDetail({ status: "ready", data, error: null });
  }

  if (submissionId) {
    const shown = detail.data;
    return (
      <section className="community-page artist-suggestions-page">
        <p><Link to="/artist-suggestions">All artist suggestions</Link></p>
        {detail.status === "error" ? <p className="community-message community-message-error" role="alert">{detail.error?.message || "Could not load this artist suggestion."}</p> : null}
        {shown && shown.submissionId === submissionId ? (
          <>
            <ArtistSuggestionDetail
              suggestion={shown}
              actions={["pending", "needs_changes"].includes(shown.status) ? (
                <button className="community-text-button" type="button" onClick={withdraw} disabled={mutation.status === "loading"}>Withdraw</button>
              ) : null}
            />
            {mutation.error && shown.status !== "needs_changes" ? <p className="community-message community-message-error" role="alert">{mutation.error.message}</p> : null}
            {shown.status === "needs_changes" ? (
              <section className="community-panel">
                <h3>Revise this suggestion</h3>
                <ArtistSuggestionForm
                  key={`${shown.submissionId}-${shown.currentRevision}`}
                  getToken={getToken}
                  initialProposal={shown.proposal}
                  initialNote={shown.note}
                  onSubmit={revise}
                  isSubmitting={mutation.status === "loading"}
                  error={mutation.error}
                  submitLabel="Send revision"
                />
              </section>
            ) : null}
          </>
        ) : detail.status !== "error" ? <p className="community-message">Loading…</p> : null}
      </section>
    );
  }

  return (
    <section className="community-page artist-suggestions-page">
      <h1>Suggest an artist</h1>
      <p className="community-intro">Suggest an artist who is not on Rescened yet. A moderator reviews every suggestion.</p>
      <ArtistSuggestionForm getToken={getToken} onSubmit={create} isSubmitting={mutation.status === "loading"} error={mutation.error} />
      <h2>Your artist suggestions</h2>
      {list.status === "error" ? <p className="community-message community-message-error">{list.error?.message || "Could not load your artist suggestions."}</p> : null}
      {list.status === "ready" && !list.rows.length ? <p className="community-message">You have not suggested an artist yet.</p> : null}
      <ul className="artist-suggestion-list">
        {list.rows.map((row) => (
          <li key={row.submissionId}>
            <Link to={`/artist-suggestions/${row.submissionId}`}>{proposalName(row.proposal) || "Artist suggestion"}</Link>
            {" · "}{artistSuggestionStatusLabel(row.status)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default ArtistSuggestions;
