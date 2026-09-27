import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useLocation } from "react-router-dom";
import { API_BASE_URL } from "../config/api.js";
import {
  formatLastfmDate,
  lastfmUrl,
  LASTFM_CONNECTION_PATH,
  requestLastfmJson,
} from "../features/lastfm/lastfm.js";

const EVENT_STATUSES = [
  { value: "", label: "All resolution states" },
  { value: "matched", label: "Matched" },
  { value: "unresolved", label: "Unresolved" },
  { value: "unavailable", label: "Unavailable" },
];

function apiOptions(token, options = {}) {
  return {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  };
}

function connectionLabel(connection) {
  if (!connection) return "Not connected";
  if (connection.state === "paused") return "Paused";
  if (connection.state === "disconnected") return "Disconnected";
  return "Syncing";
}

function resolutionLabel(event) {
  if (event?.resolution === "matched" && event?.baselineAvailable === false) {
    return "Mapped · baseline unavailable";
  }
  if (event?.resolution === "matched") return "Mapped";
  return event?.resolution || "Unavailable";
}

export default function LastfmConnectionPanel() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [eventStatus, setEventStatus] = useState("");
  const [eventCursor, setEventCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const callbackMessage = location.state?.lastfmMessage || "";
  const requestRef = useRef(0);

  const loadStatus = useCallback(async (signal) => {
    if (!isLoaded || !isSignedIn) {
      setLoading(false);
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError("");
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(LASTFM_CONNECTION_PATH),
        apiOptions(token, { signal }),
        "Could not load Last.fm connection status.",
      );
      if (!signal?.aborted && requestRef.current === requestId) setStatus(data);
    } catch (loadError) {
      if (!signal?.aborted && requestRef.current === requestId) setError(loadError.message);
    } finally {
      if (!signal?.aborted && requestRef.current === requestId) setLoading(false);
    }
  }, [getToken, isLoaded, isSignedIn]);

  useEffect(() => {
    const controller = new AbortController();
    loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  const loadEvents = useCallback(async ({ cursor = "", append = false } = {}) => {
    setEventsLoading(true);
    setError("");
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(`${LASTFM_CONNECTION_PATH}/events`, { status: eventStatus, cursor }),
        apiOptions(token),
        "Could not load listening matches.",
      );
      const incoming = Array.isArray(data?.items) ? data.items : [];
      setEvents((current) => append ? [...current, ...incoming] : incoming);
      setEventCursor(data?.nextCursor || "");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setEventsLoading(false);
    }
  }, [eventStatus, getToken]);

  useEffect(() => {
    if (status?.connection) loadEvents();
  }, [eventStatus, loadEvents, status?.connection]);

  async function startConnection() {
    setAction("start");
    setError("");
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(`${LASTFM_CONNECTION_PATH}/start`),
        apiOptions(token, { method: "POST" }),
        "Could not start Last.fm authorization.",
      );
      if (data?.authorizationUrl) window.location.assign(data.authorizationUrl);
      else throw new Error("The server did not return a Last.fm authorization URL.");
    } catch (startError) {
      setError(startError.message);
      setAction("");
    }
  }

  async function changeConnection(nextAction) {
    setAction(nextAction);
    setError("");
    try {
      const token = await getToken();
      const method = nextAction === "disconnect" ? "DELETE" : "POST";
      await requestLastfmJson(
        lastfmUrl(nextAction === "disconnect" ? LASTFM_CONNECTION_PATH : `${LASTFM_CONNECTION_PATH}/${nextAction}`),
        apiOptions(token, { method, ...(method === "POST" ? { body: JSON.stringify({}) } : {}) }),
        `Could not ${nextAction} Last.fm syncing.`,
      );
      await loadStatus();
      setEvents([]);
      setEventCursor("");
    } catch (changeError) {
      setError(changeError.message);
    } finally {
      setAction("");
    }
  }

  const enabled = status?.enabled !== false;
  const allowed = status?.pilotAllowed !== false;
  const connection = status?.connection;
  const canChange = Boolean(connection && connection.state !== "disconnected");
  const canConnect = enabled && allowed && (!connection || connection.state === "disconnected");
  const resumeDisabled = !enabled || !allowed;

  return (
    <section className="edit-profile-panel lastfm-panel" aria-labelledby="lastfm-heading">
      <div className="profile-section-header">
        <div>
          <p className="profile-kicker">Listening pilot</p>
          <h2 id="lastfm-heading">Last.fm sync</h2>
        </div>
        {connection ? <span className={`lastfm-state lastfm-state-${connection.state}`}>{connectionLabel(connection)}</span> : null}
      </div>

      <p className="edit-profile-current-value">
        Connect <a href="https://www.last.fm/" rel="noreferrer" target="_blank">Last.fm</a> to collect listening data from the time you connect onward and improve album-name matching.
        This pilot does not create diary entries. Rescened retains normalized listening evidence for up to 30 days and reads public recent tracks with your connection controls;
        revoking Last.fm authorization alone does not pause those reads.
      </p>

      {callbackMessage ? <p className="edit-profile-status" role="status">{callbackMessage}</p> : null}
      {loading ? <p className="edit-profile-current-value" role="status">Checking connection status…</p> : null}
      {!loading && !enabled ? <p className="edit-profile-current-value">Last.fm connections are currently unavailable for this environment.</p> : null}
      {!loading && enabled && !allowed ? <p className="edit-profile-current-value">This pilot is not enabled for your account yet.</p> : null}
      {error ? <p className="edit-profile-error" role="alert">{error}</p> : null}

      {canConnect ? (
        <button className="album-action-button" disabled={action === "start"} onClick={startConnection} type="button">
          {action === "start" ? "Opening Last.fm…" : connection?.state === "disconnected" ? "Reconnect Last.fm" : "Connect Last.fm"}
        </button>
      ) : null}

      {connection ? (
        <div className="lastfm-connection-summary">
          <div><span>Last.fm account</span><strong>{connection.username}</strong></div>
          <div><span>Last successful sync</span><strong>{formatLastfmDate(connection.lastSuccessfulSync, { time: true })}</strong></div>
          {connection.error ? <div><span>Sync status</span><strong className="lastfm-error-text">{connection.error.message || connection.error.code || "Needs attention"}</strong></div> : null}
          {connection.retentionGap ? <p className="edit-profile-error">Some listening data is older than the 30-day retention window and could not be recovered.</p> : null}
        </div>
      ) : null}

      {canChange ? (
        <div className="lastfm-action-row">
          {connection.state === "paused" ? (
            <button className="album-action-button" disabled={Boolean(action) || resumeDisabled} onClick={() => changeConnection("resume")} type="button">
              {action === "resume" ? "Resuming…" : "Resume sync"}
            </button>
          ) : (
            <button className="profile-secondary-button" disabled={Boolean(action)} onClick={() => changeConnection("pause")} type="button">
              {action === "pause" ? "Pausing…" : "Pause sync"}
            </button>
          )}
          <button className="profile-secondary-button lastfm-danger-button" disabled={Boolean(action)} onClick={() => changeConnection("disconnect")} type="button">
            {action === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : null}

      {connection && connection.state !== "disconnected" ? (
        <div className="lastfm-events">
          <div className="profile-section-header">
            <h3>Recent matches</h3>
            <select aria-label="Filter matching events" value={eventStatus} onChange={(event) => setEventStatus(event.target.value)}>
              {EVENT_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {eventsLoading && events.length === 0 ? <p className="edit-profile-current-value">Loading matches…</p> : null}
          {!eventsLoading && events.length === 0 ? <p className="edit-profile-current-value">No retained scrobbles match this filter yet.</p> : null}
          {events.length > 0 ? (
            <div className="lastfm-event-list">
              {events.map((event) => (
                <article className="lastfm-event" key={event.eventId}>
                  <div><strong>{event.track || "Unknown track"}</strong><span>{event.artist || "Unknown artist"} · {event.album || "Unknown album"}</span></div>
                  <div className="lastfm-event-meta"><span className={`lastfm-resolution lastfm-resolution-${event.resolution}`}>{resolutionLabel(event)}</span><time>{formatLastfmDate(event.playedAt, { time: true })}</time></div>
                </article>
              ))}
            </div>
          ) : null}
          {eventCursor ? <button className="profile-secondary-button" disabled={eventsLoading} onClick={() => loadEvents({ cursor: eventCursor, append: true })} type="button">{eventsLoading ? "Loading…" : "Load older matches"}</button> : null}
        </div>
      ) : null}
    </section>
  );
}
