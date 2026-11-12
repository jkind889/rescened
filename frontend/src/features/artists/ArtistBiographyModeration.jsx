import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../../config/api";
import { requestCommunityJson } from "../community/community";
import { biographyStateLabel, correctionDraftFor, createRequestGuard } from "./artists";
import { BiographyAttribution } from "./ArtistBiography";

// Moderator review of one artist's cached biography. Showing it is a
// display hint only; the API enforces moderator access and revisions.
//
// The panel exists only for a signed-in user and is keyed by that user, so
// signing out unmounts it and switching user remounts it with empty state.
// Unmounting aborts pending loads and commands, and a request guard drops
// any result that arrives after that, so a late response can never store a
// record or show "Saved" for someone who left.
export function ArtistBiographyModeration(props) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded || !isSignedIn || !userId) return null;
  return <ModerationPanel key={userId} {...props} />;
}

function ModerationPanel({ artistId, onChanged }) {
  const { getToken } = useAuth();
  const [moderator, setModerator] = useState(false);
  const [detail, setDetail] = useState({ record: null, missing: false, error: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const guard = useRef(createRequestGuard());
  const controllers = useRef(new Set());
  const unmounted = useRef(false);
  const base = `${API_BASE_URL}/moderation/artist-biographies/${encodeURIComponent(artistId)}`;

  // One place to start a request: a fresh abort controller tracked for
  // unmount, and a guard token that later results must still match.
  const startRequest = useCallback(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return { controller, token: guard.current.begin(), done: () => controllers.current.delete(controller) };
  }, []);

  useEffect(() => {
    const active = controllers.current;
    const requestGuard = guard.current;
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      requestGuard.invalidate();
      for (const controller of active) controller.abort();
      active.clear();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const token = await getToken();
        const response = await fetch(`${API_BASE_URL}/moderation/album-suggestions/access`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const data = response.ok ? await response.json() : {};
        if (!controller.signal.aborted) setModerator(data.moderator === true);
      } catch (error) {
        if (error.name !== "AbortError") setModerator(false);
      }
    })();
    return () => controller.abort();
  }, [getToken]);

  const load = useCallback(async () => {
    const request = startRequest();
    try {
      const token = await getToken();
      const data = await requestCommunityJson(base, { headers: { Authorization: `Bearer ${token}` }, signal: request.controller.signal }, "Could not load the biography record.");
      if (!guard.current.isCurrent(request.token)) return;
      setDetail({ record: data.biography, missing: false, error: "" });
      setText(correctionDraftFor(data.biography));
    } catch (error) {
      if (error.name === "AbortError" || !guard.current.isCurrent(request.token)) return;
      if (error.code === "BIOGRAPHY_NOT_FOUND") setDetail({ record: null, missing: true, error: "" });
      else if (error.code === "ARTIST_BIOGRAPHIES_DISABLED" || error.status === 403 || error.status === 404) setDetail({ record: null, missing: false, error: "" });
      else setDetail({ record: null, missing: false, error: error.message });
    } finally {
      request.done();
    }
  }, [base, getToken, startRequest]);

  useEffect(() => {
    if (moderator) load();
  }, [moderator, load]);

  async function run(path, body = {}) {
    const record = detail.record;
    if (!record || busy) return;
    const request = startRequest();
    setBusy(true);
    setMessage("");
    try {
      const token = await getToken();
      const data = await requestCommunityJson(`${base}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ expectedRevision: record.revision, ...body }),
        signal: request.controller.signal,
      }, "The command failed.");
      if (!guard.current.isCurrent(request.token)) return;
      setDetail({ record: data.biography, missing: false, error: "" });
      setText(correctionDraftFor(data.biography));
      setReason("");
      setMessage("Saved.");
      onChanged?.();
    } catch (error) {
      if (error.name === "AbortError" || !guard.current.isCurrent(request.token)) return;
      setMessage(error.code === "BIOGRAPHY_REVISION_CONFLICT" ? "The record changed. It has been reloaded; review it and try again." : error.message);
      if (error.code === "BIOGRAPHY_REVISION_CONFLICT") load();
    } finally {
      request.done();
      // A conflict reload starts a newer request, so busy is cleared for any
      // command that ends while the panel is mounted, not only the latest.
      if (!unmounted.current) setBusy(false);
    }
  }

  if (!moderator) return null;
  const record = detail.record;
  const needsReason = !reason.trim();

  return (
    <details className="artist-biography-moderation">
      <summary>Biography moderation</summary>
      {detail.error ? <p className="community-message community-message-error" role="alert">{detail.error}</p> : null}
      {detail.missing ? <p className="genre-form-muted">No biography record yet. Records are created by the operator command after a reviewed plan.</p> : null}
      {record ? (
        <div className="artist-biography-moderation-body">
          <dl className="artist-biography-facts">
            <div><dt>State</dt><dd>{biographyStateLabel(record.identity?.state)}{record.identity?.reasons?.length ? ` (${record.identity.reasons.join(", ")})` : ""}</dd></div>
            <div><dt>Shown</dt><dd>{record.display ? "Yes" : "No"}{record.moderation?.suppressed ? ` · suppressed: ${record.moderation.suppressedReason}` : ""}{record.moderation?.verdict ? ` · ${record.moderation.verdict.replace("_", " ")}` : ""}</dd></div>
            {record.identity?.qid ? <div><dt>Wikidata</dt><dd><a href={`https://www.wikidata.org/wiki/${record.identity.qid}`} rel="noopener noreferrer" target="_blank">{record.identity.qid}</a></dd></div> : null}
            {record.fetch?.lastErrorCode ? <div><dt>Last error</dt><dd>{record.fetch.lastErrorCode} ({record.fetch.consecutiveFailures} in a row)</dd></div> : null}
          </dl>
          {record.accepted ? (
            <div className="artist-biography-candidate">
              <p className="genre-form-muted">Published excerpt:</p>
              <blockquote lang="en">{record.accepted.text}</blockquote>
              <BiographyAttribution article={record.accepted.article} license={record.accepted.license} shortened={record.accepted.shortened} edited={false} />
            </div>
          ) : null}
          {record.candidate ? (
            <div className="artist-biography-candidate">
              <p className="genre-form-muted">Candidate waiting for review:</p>
              <blockquote lang="en">{record.candidate.text}</blockquote>
              <BiographyAttribution article={record.candidate.article} license={record.candidate.license} shortened={record.candidate.shortened} edited={false} />
            </div>
          ) : null}
          <label className="artist-biography-field">
            Reason (for suppress or reject)
            <input maxLength={500} onChange={(event) => setReason(event.target.value)} type="text" value={reason} />
          </label>
          <div className="artist-biography-actions">
            {record.identity?.state === "needs_review" && record.candidate ? <button className="community-secondary-button" disabled={busy} onClick={() => run("confirm-match")} type="button">Confirm candidate</button> : null}
            {record.moderation?.suppressed
              ? <button className="community-secondary-button" disabled={busy} onClick={() => run("unsuppress")} type="button">Unsuppress</button>
              : <button className="community-secondary-button" disabled={busy || needsReason} onClick={() => run("suppress", { reason })} type="button">Suppress</button>}
            {record.moderation?.verdict
              ? <button className="community-secondary-button" disabled={busy} onClick={() => run("clear-verdict")} type="button">Clear verdict</button>
              : <button className="community-secondary-button" disabled={busy || needsReason || !record.identity?.qid} onClick={() => run("reject-match", { reason })} type="button">Reject match</button>}
          </div>
          {record.identity?.state === "verified" && record.accepted ? (
            <div className="artist-biography-correction">
              <label className="artist-biography-field">
                Corrected text (20–250 characters, plain text; shown as edited)
                <textarea maxLength={600} onChange={(event) => setText(event.target.value)} rows={4} value={text} />
              </label>
              <div className="artist-biography-actions">
                <button className="community-secondary-button" disabled={busy} onClick={() => run("correct-text", { text })} type="button">Save correction</button>
                {record.manual ? <button className="community-secondary-button" disabled={busy} onClick={() => run("clear-correction")} type="button">Clear correction</button> : null}
              </div>
            </div>
          ) : null}
          {message ? <p className="genre-form-muted" role="status">{message}</p> : null}
          {record.history?.length ? (
            <ol className="artist-biography-history">
              {record.history.slice(-5).reverse().map((event, index) => (
                <li key={`${event.at}-${index}`}>{new Date(event.at).toLocaleString()} · {event.actorType === "moderator" ? "Moderator" : "System"} · {event.action}</li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

export default ArtistBiographyModeration;
