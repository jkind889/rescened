import { API_BASE_URL } from "../../config/api";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { getApiErrorMessage } from "../../utils/apiErrors";
import "./diary.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_COVERS_PER_DAY = 3;

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(key, delta) {
  const [year, month] = key.split("-").map(Number);
  return monthKey(new Date(year, month - 1 + delta, 1));
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// "Monday, October 5" in the viewer's locale. Noon avoids DST edge cases.
function dayLabel(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

// Calendar cells for one month, Monday first, padded with nulls before day 1.
function monthCells(key) {
  const [year, month] = key.split("-").map(Number);
  const leading = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const dayCount = new Date(year, month, 0).getDate();
  return [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => `${key}-${String(index + 1).padStart(2, "0")}`),
  ];
}

// A month grid of listening-diary entries. userId selects a public profile's
// diary; without it the signed-in viewer's own diary is shown.
export function DiaryCalendar({ userId = "" }) {
  const { getToken, isSignedIn } = useAuth();
  const today = monthKey(new Date());
  const [month, setMonth] = useState(today);
  const [calendar, setCalendar] = useState({ days: [], total: 0, limit: 0, truncated: false });
  const [selectedDate, setSelectedDate] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function fetchMonth() {
      setIsLoading(true);
      setError("");
      setSelectedDate("");
      try {
        const token = isSignedIn ? await getToken() : null;
        const base = userId
          ? `${API_BASE_URL}/profile/${encodeURIComponent(userId)}/diary/calendar`
          : `${API_BASE_URL}/diary/calendar`;
        const response = await fetch(`${base}?month=${month}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load this month."));
        const data = await response.json();
        if (!controller.signal.aborted) {
          setCalendar({ days: Array.isArray(data.days) ? data.days : [], total: Number(data.total) || 0, limit: Number(data.limit) || 0, truncated: Boolean(data.truncated) });
        }
      } catch (monthError) {
        if (!controller.signal.aborted) {
          setCalendar({ days: [], total: 0, limit: 0, truncated: false });
          setError(monthError.message || "Could not load this month.");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    void fetchMonth();
    return () => controller.abort();
  }, [getToken, isSignedIn, month, userId]);

  const listensByDate = useMemo(() => new Map(calendar.days.map((day) => [day.date, day.listens])), [calendar.days]);
  const cells = useMemo(() => monthCells(month), [month]);
  const activeDays = calendar.days.length;
  const selectedListens = selectedDate ? listensByDate.get(selectedDate) || [] : [];

  return (
    <section className="diary-calendar" aria-label="Listening diary calendar">
      <header className="diary-calendar-header">
        <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">←</button>
        <div>
          <h2>{monthLabel(month)}</h2>
          <p>
            {isLoading ? "Loading…" : `${calendar.total} listen${calendar.total === 1 ? "" : "s"} across ${activeDays} day${activeDays === 1 ? "" : "s"}`}
          </p>
        </div>
        <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= today} aria-label="Next month">→</button>
      </header>
      {error && <p className="diary-calendar-error" role="alert">{error}</p>}
      {calendar.truncated && <p className="diary-calendar-note">Showing the first {calendar.limit || calendar.total} listens this month.</p>}
      <div className="diary-calendar-grid" aria-busy={isLoading}>
        {/* Day buttons carry their full date in aria-label, so the weekday row is visual only. */}
        {WEEKDAYS.map((day) => <span className="diary-calendar-weekday" key={day} aria-hidden="true">{day}</span>)}
        {cells.map((date, index) => {
          if (!date) return <span className="diary-calendar-blank" key={`blank-${index}`} aria-hidden="true" />;
          const listens = listensByDate.get(date) || [];
          const dayNumber = Number(date.slice(-2));
          const label = `${dayLabel(date)}: ${listens.length} listen${listens.length === 1 ? "" : "s"}`;
          return (
            <button
              className={[
                "diary-calendar-day",
                listens.length ? "diary-calendar-day-active" : "",
                selectedDate === date ? "diary-calendar-day-selected" : "",
              ].join(" ").trim()}
              key={date}
              type="button"
              aria-label={label}
              aria-pressed={selectedDate === date}
              disabled={!listens.length}
              onClick={() => setSelectedDate(selectedDate === date ? "" : date)}
            >
              <span className="diary-calendar-date">{dayNumber}</span>
              {listens.length > 0 && (
                <span className="diary-calendar-covers" aria-hidden="true">
                  {listens.slice(0, MAX_COVERS_PER_DAY).map((listen) => (
                    listen.album.cover
                      ? <img key={listen.listenId} src={listen.album.cover} alt="" loading="lazy" />
                      : <span key={listen.listenId} className="diary-calendar-cover-fallback" />
                  ))}
                  {listens.length > MAX_COVERS_PER_DAY && <em>+{listens.length - MAX_COVERS_PER_DAY}</em>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {selectedDate && (
        <div className="diary-calendar-day-list">
          <h3>{dayLabel(selectedDate)}</h3>
          <ul>
            {selectedListens.map((listen) => (
              <li key={listen.listenId}>
                <Link to={`/album/${listen.album.albumId}`}>
                  {listen.album.cover ? <img src={listen.album.cover} alt="" /> : <span className="diary-calendar-cover-fallback" />}
                  <span>
                    <strong>{listen.album.title || "Untitled album"}</strong>
                    <em>{listen.album.artistDisplayName || "Artist unknown"}{listen.source === "automatic" ? " · Automatic" : ""}</em>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default DiaryCalendar;
