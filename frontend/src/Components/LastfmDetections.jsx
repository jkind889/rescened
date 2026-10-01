import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link } from "react-router-dom";
import {
  formatLastfmDate,
  lastfmUrl,
  LASTFM_CONNECTION_PATH,
  requestLastfmJson,
} from "../features/lastfm/lastfm.js";

const COVERAGE_FILTERS = [
  { value: "", label: "All sessions" },
  { value: "qualified", label: "Would be logged" },
  { value: "below_threshold", label: "Not enough yet" },
];

const HOLD_MESSAGES = {
  evidence_expired: "The scrobbles behind this listen are past the 30-day retention window, so it can no longer be logged.",
  stale_mapping: "The album-name match behind this listen is no longer approved, so it is on hold.",
  stale_baseline: "This album's reviewed tracklist changed after the listen was detected, so it is on hold.",
  stale_rule: "The counting rules changed after this listen was detected. It keeps its original result and is on hold.",
  reconciliation_required: "Newer listening data conflicts with this result, so it is on hold for review.",
  sync_incomplete: "Some earlier listening data was outside the 30-day window, so this session may be incomplete.",
};

function apiOptions(token, options = {}) {
  return { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } };
}

function supportedTimeZones() {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

// Proposed dates are calendar dates already resolved in the saved zone.
function formatCalendarDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

const PUBLICATION_STATUS = {
  published: { label: "Logged to diary", tone: "matched" },
  needs_confirmation: { label: "Needs your confirmation", tone: "unresolved" },
  manual_duplicate: { label: "Possible duplicate", tone: "unresolved" },
  dismissed: { label: "Dismissed", tone: "unavailable" },
  suppressed: { label: "Previously removed", tone: "unavailable" },
};

const PUBLICATION_NOTES = {
  needs_confirmation: "This listen qualified more than 7 days ago, so it waits for you instead of being logged automatically.",
  manual_duplicate: "You already logged this album within a day of this date. Log it anyway only if this was a separate listen.",
  suppressed: "A diary entry for this listen was removed earlier, so it won't be logged again.",
};

function playStatus(play, holds) {
  if (PUBLICATION_STATUS[play.publication]) return PUBLICATION_STATUS[play.publication];
  if (play.coverage !== "qualified") return { label: "Not enough yet", tone: "unresolved" };
  if (holds.includes("evidence_expired")) return { label: "Expired", tone: "unavailable" };
  if (holds.length) return { label: "On hold", tone: "unavailable" };
  return { label: "Would be logged", tone: "matched" };
}

function TimeZoneSetting({ savedTimeZone, onSaved }) {
  const { getToken } = useAuth();
  const zones = useMemo(() => supportedTimeZones(), []);
  const [value, setValue] = useState(savedTimeZone || browserTimeZone());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(`${LASTFM_CONNECTION_PATH}/time-zone`),
        apiOptions(token, { method: "PUT", body: JSON.stringify({ timeZone: value }) }),
        "Could not save your time zone.",
      );
      setValue(data.timeZone);
      setMessage("Saved. It applies to sessions detected from now on.");
      onSaved(data.timeZone);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="lastfm-time-zone" onSubmit={save}>
      <label htmlFor="lastfm-time-zone">Date listens in this time zone</label>
      <div className="lastfm-action-row">
        {zones.length ? (
          <select id="lastfm-time-zone" value={value} onChange={(event) => setValue(event.target.value)}>
            {!zones.includes(value) && value ? <option value={value}>{value}</option> : null}
            {zones.map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}
          </select>
        ) : (
          <input id="lastfm-time-zone" value={value} onChange={(event) => setValue(event.target.value)} placeholder="America/New_York" />
        )}
        <button className="profile-secondary-button" disabled={saving || !value || value === savedTimeZone} type="submit">
          {saving ? "Saving…" : "Save time zone"}
        </button>
      </div>
      {!savedTimeZone ? <p className="edit-profile-current-value">Choose a time zone to see the date each detected listen would use.</p> : null}
      {message ? <p className="edit-profile-status" role="status">{message}</p> : null}
      {error ? <p className="edit-profile-error" role="alert">{error}</p> : null}
    </form>
  );
}

function AutoDiarySetting({ autoDiary, savedTimeZone, onChanged }) {
  const { getToken } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const enabled = Boolean(autoDiary?.enabled);

  async function toggle() {
    setSaving(true);
    setError("");
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(`${LASTFM_CONNECTION_PATH}/auto-diary`),
        apiOptions(token, { method: "PUT", body: JSON.stringify({ enabled: !enabled }) }),
        "Could not change automatic logging.",
      );
      onChanged(data.autoDiary);
    } catch (toggleError) {
      setError(toggleError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="lastfm-auto-diary">
      <div>
        <strong>{enabled ? "Automatic logging is on" : "Automatic logging is off"}</strong>
        <span>
          {enabled
            ? `Listens that qualify after ${formatLastfmDate(autoDiary.enabledAt)} are added to your diary, labeled as automatically logged. You can change their date or delete them.`
            : "Turn this on to add qualifying listens to your diary. Listens detected before you turn it on are not imported."}
        </span>
      </div>
      <button className="profile-secondary-button" disabled={saving || (!enabled && !savedTimeZone)} onClick={toggle} type="button">
        {saving ? "Saving…" : enabled ? "Turn off" : "Turn on"}
      </button>
      {!enabled && !savedTimeZone ? <p className="edit-profile-current-value">Save a time zone first so listens get the right date.</p> : null}
      {error ? <p className="edit-profile-error" role="alert">{error}</p> : null}
    </div>
  );
}

function DetectionCard({ detection, onResolve, resolving }) {
  const held = detection.holds.length > 0;
  const { album, countable } = detection;
  return (
    <article className="lastfm-detection">
      <div className="lastfm-detection-heading">
        <div>
          {album.title ? <Link to={`/album/${album.albumId}`}><strong>{album.title}</strong></Link> : <strong>Album unavailable</strong>}
          <span>{album.artistDisplayName}</span>
        </div>
        {detection.lifecycle === "open" ? <span className="lastfm-resolution lastfm-resolution-unresolved">Still listening</span> : null}
      </div>
      <ul className="lastfm-play-list">
        {detection.plays.map((play) => {
          const status = playStatus(play, detection.holds);
          return (
            <li key={play.playId}>
              <div>
                <strong>{detection.plays.length > 1 ? `Play ${play.ordinal} · ` : ""}{play.distinct} / {countable.countable} standard tracks</strong>
                <span>Needs {play.required} to count</span>
              </div>
              <div className="lastfm-event-meta">
                <span className={`lastfm-resolution lastfm-resolution-${status.tone}`}>{status.label}</span>
                {play.coverage === "qualified" ? (
                  <span>{play.proposedDate ? `Dated ${formatCalendarDate(play.proposedDate)}` : "Save a time zone to see its date"}</span>
                ) : null}
                {PUBLICATION_NOTES[play.publication] ? <span className="lastfm-play-note">{PUBLICATION_NOTES[play.publication]}</span> : null}
                {["needs_confirmation", "manual_duplicate"].includes(play.publication) && !held ? (
                  <span className="lastfm-action-row">
                    <button className="profile-secondary-button" disabled={Boolean(resolving)} onClick={() => onResolve(detection, play, "confirm")} type="button">
                      {resolving === `${play.playId}:confirm` ? "Logging…" : play.publication === "manual_duplicate" ? "Log anyway" : "Log to diary"}
                    </button>
                    <button className="profile-secondary-button" disabled={Boolean(resolving)} onClick={() => onResolve(detection, play, "dismiss")} type="button">
                      {resolving === `${play.playId}:dismiss` ? "Dismissing…" : "Dismiss"}
                    </button>
                  </span>
                ) : null}
                {held && play.evidenceExpiresAt && !detection.holds.includes("evidence_expired") ? (
                  <span>Evidence expires {formatLastfmDate(play.evidenceExpiresAt)}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {countable.excluded > 0 ? (
        <p className="lastfm-detection-note">
          {countable.excluded} of {countable.total} tracks are not counted, such as very short interludes or tracks that cannot be told apart.
        </p>
      ) : null}
      {detection.holds.map((hold) => (
        <p className="lastfm-detection-note lastfm-detection-hold" key={hold}>{HOLD_MESSAGES[hold] || "This listen is on hold."}</p>
      ))}
    </article>
  );
}

export default function LastfmDetections({ savedTimeZone, onTimeZoneSaved, autoDiaryAllowed, autoDiary, onAutoDiaryChanged }) {
  const { getToken } = useAuth();
  const [items, setItems] = useState([]);
  const [resolving, setResolving] = useState("");
  const [notice, setNotice] = useState("");
  const [cursor, setCursor] = useState("");
  const [coverage, setCoverage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async ({ next = "", append = false } = {}) => {
    setLoading(true);
    setError("");
    try {
      const token = await getToken();
      const data = await requestLastfmJson(
        lastfmUrl(`${LASTFM_CONNECTION_PATH}/detections`, { coverage, cursor: next }),
        apiOptions(token),
        "Could not load detected listens.",
      );
      const incoming = Array.isArray(data?.items) ? data.items : [];
      setItems((current) => (append ? [...current, ...incoming] : incoming));
      setCursor(data?.nextCursor || "");
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [coverage, getToken]);

  useEffect(() => { load(); }, [load, savedTimeZone]);

  async function resolve(detection, play, action) {
    setResolving(`${play.playId}:${action}`);
    setError("");
    setNotice("");
    try {
      const token = await getToken();
      await requestLastfmJson(
        lastfmUrl(`${LASTFM_CONNECTION_PATH}/detections/${detection.sessionId}/plays/${play.playId}/${action}`),
        apiOptions(token, { method: "POST", body: JSON.stringify({}) }),
        action === "confirm" ? "Could not log this listen." : "Could not dismiss this listen.",
      );
      setNotice(action === "confirm" ? `Logged ${detection.album.title || "this album"} to your diary.` : "Dismissed. It won't be suggested again.");
      await load();
    } catch (resolveError) {
      setError(resolveError.message);
    } finally {
      setResolving("");
    }
  }

  return (
    <div className="lastfm-events lastfm-detections">
      <div className="profile-section-header">
        <h3>Detected album listens</h3>
        <select aria-label="Filter detected listens" value={coverage} onChange={(event) => setCoverage(event.target.value)}>
          {COVERAGE_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <p className="edit-profile-current-value">
        A listen counts once you play at least 80% of an album's standard tracks.
        {autoDiary?.enabled ? " Qualifying listens are added to your diary automatically." : " Nothing is added to your diary unless you turn on automatic logging."}
      </p>
      <TimeZoneSetting savedTimeZone={savedTimeZone} onSaved={onTimeZoneSaved} />
      {autoDiaryAllowed ? <AutoDiarySetting autoDiary={autoDiary} savedTimeZone={savedTimeZone} onChanged={onAutoDiaryChanged} /> : null}
      {notice ? <p className="edit-profile-status" role="status">{notice}</p> : null}
      {error ? <p className="edit-profile-error" role="alert">{error}</p> : null}
      {loading && items.length === 0 ? <p className="edit-profile-current-value">Loading detected listens…</p> : null}
      {!loading && !error && items.length === 0 ? <p className="edit-profile-current-value">No album sessions detected yet.</p> : null}
      {items.length > 0 ? <div className="lastfm-event-list">{items.map((item) => <DetectionCard detection={item} key={item.sessionId} onResolve={resolve} resolving={resolving} />)}</div> : null}
      {cursor ? (
        <button className="profile-secondary-button" disabled={loading} onClick={() => load({ next: cursor, append: true })} type="button">
          {loading ? "Loading…" : "Load older sessions"}
        </button>
      ) : null}
    </div>
  );
}
