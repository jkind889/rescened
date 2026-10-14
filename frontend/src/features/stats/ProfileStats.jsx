import { API_BASE_URL } from "../../config/api";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { getApiErrorMessage } from "../../utils/apiErrors";
import "./stats.css";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function monthLabel(month, short = false) {
  const [year, value] = month.split("-").map(Number);
  return new Date(year, value - 1, 1).toLocaleDateString(undefined, short ? { month: "narrow" } : { month: "long", year: "numeric" });
}

function dayLabel(day) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Horizontal bars for ranked lists; widths are relative to the largest value.
function BarList({ rows, label }) {
  const max = Math.max(...rows.map((row) => row.value), 0);
  return (
    <ol className="stats-bar-list" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key}>
          <span className="stats-bar-label">{row.label}</span>
          <span className="stats-bar-track" aria-hidden="true"><span style={{ width: max ? `${(row.value / max) * 100}%` : 0 }} /></span>
          <span className="stats-bar-value">{row.display ?? row.value}</span>
        </li>
      ))}
    </ol>
  );
}

// Listening, reviewing, and library stats for one profile. userId is the
// profile being viewed; isOwner switches to the signed-in /me endpoint.
export function ProfileStats({ userId, isOwner = false }) {
  const { getToken, isSignedIn } = useAuth();
  const [period, setPeriod] = useState("2y");
  const [includeAutomatic, setIncludeAutomatic] = useState(true);
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function fetchStats() {
      setIsLoading(true);
      setError("");
      try {
        const token = isSignedIn ? await getToken() : null;
        const base = isOwner ? `${API_BASE_URL}/profile/me/stats` : `${API_BASE_URL}/profile/${encodeURIComponent(userId)}/stats`;
        const query = new URLSearchParams({ period, ...(includeAutomatic ? {} : { automatic: "exclude" }) });
        const response = await fetch(`${base}?${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
        if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load stats."));
        const data = await response.json();
        if (!controller.signal.aborted) setStats(data);
      } catch (statsError) {
        if (!controller.signal.aborted) setError(statsError.message || "Could not load stats.");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    if (isOwner || userId) void fetchStats();
    return () => controller.abort();
  }, [getToken, includeAutomatic, isOwner, isSignedIn, period, userId]);

  const periods = stats?.availablePeriods || [{ value: "2y", label: "Last 2 years" }];
  const controls = (
    <div className="stats-controls">
      <select aria-label="Stats period" value={period} onChange={(event) => setPeriod(event.target.value)} disabled={isLoading}>
        {periods.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <label>
        <input type="checkbox" checked={includeAutomatic} onChange={(event) => setIncludeAutomatic(event.target.checked)} disabled={isLoading} />
        Include automatic listens
      </label>
    </div>
  );

  if (error) return <section className="profile-stats">{controls}<p className="stats-muted" role="alert">{error}</p></section>;
  if (!stats) return <section className="profile-stats">{controls}<p className="stats-muted">Loading stats…</p></section>;

  const { listening, topAlbums, topArtists, topGenres = [], eras, listeningTime, reviews, library } = stats;
  const hasListens = listening.totalListens > 0;
  const maxMonth = Math.max(...listening.perMonth.map((month) => month.count), 0);
  const maxRating = Math.max(...reviews.distribution.map((bucket) => bucket.count), 0);
  const versus = reviews.versusCommunity;

  return (
    <section className={isLoading ? "profile-stats profile-stats-loading" : "profile-stats"} aria-busy={isLoading}>
      {controls}

      {!hasListens && reviews.count === 0 ? (
        <div className="profile-empty-state">
          <h3>Nothing logged in this period</h3>
          <p>{isOwner ? "Log a listen or write a review and your stats will start filling in." : "This listener hasn't logged anything in this period."}</p>
        </div>
      ) : (
        <>
          <dl className="stats-headline">
            <div><dt>Listens</dt><dd>{listening.totalListens}</dd></div>
            <div><dt>Albums</dt><dd>{listening.distinctAlbums}</dd></div>
            <div><dt>Days listened</dt><dd>{listening.daysListened}</dd></div>
            <div><dt>Longest streak</dt><dd>{plural(listening.longestStreak.days, "day")}</dd></div>
            <div>
              <dt>Listening time</dt>
              <dd title={listeningTime.coveredListens < listeningTime.totalListens ? `Counts ${listeningTime.coveredListens} of ${listeningTime.totalListens} listens; the rest are albums without full track lengths.` : undefined}>
                ~{listeningTime.estimatedHours} hr
              </dd>
            </div>
            <div><dt>Reviews</dt><dd>{reviews.count}</dd></div>
          </dl>

          {hasListens && (
            <div className="stats-card stats-card-wide">
              <h3>Listens by month</h3>
              <div className="stats-months" role="list">
                {listening.perMonth.map((month) => (
                  <div key={month.month} className="stats-month" role="listitem" aria-label={`${monthLabel(month.month)}: ${plural(month.count, "listen")}`} title={`${monthLabel(month.month)}: ${plural(month.count, "listen")}`}>
                    <span className="stats-month-bar" style={{ height: maxMonth ? `${Math.max((month.count / maxMonth) * 100, month.count ? 4 : 0)}%` : 0 }} />
                    <span className="stats-month-label" aria-hidden="true">{monthLabel(month.month, true)}</span>
                  </div>
                ))}
              </div>
              <p className="stats-muted">
                {listening.busiestWeekday !== null && <>{WEEKDAYS[listening.busiestWeekday]}s are the busiest day. </>}
                {listening.longestStreak.days > 1 && <>Longest streak: {dayLabel(listening.longestStreak.start)} – {dayLabel(listening.longestStreak.end)}. </>}
                {stats.includesAutomatic && listening.automaticListens > 0 && <>{listening.automaticListens} of {listening.totalListens} listens were logged automatically.</>}
              </p>
            </div>
          )}

          {topAlbums.length > 0 && (
            <div className="stats-card">
              <h3>Top albums</h3>
              <ol className="stats-album-list">
                {topAlbums.map((entry, index) => (
                  <li key={entry.album.albumId}>
                    <span className="stats-rank">{index + 1}</span>
                    <Link to={`/album/${entry.album.albumId}`}>
                      {entry.album.cover ? <img src={entry.album.cover} alt="" loading="lazy" /> : <span className="stats-cover-fallback" />}
                      <span>
                        <strong>{entry.album.title || "Untitled album"}</strong>
                        <em>{entry.album.artistDisplayName || "Artist unknown"}</em>
                      </span>
                    </Link>
                    <span className="stats-count">{entry.listenCount}×</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {topArtists.length > 0 && (
            <div className="stats-card">
              <h3>Top artists</h3>
              <BarList label="Top artists by listens" rows={topArtists.map((artist) => ({ key: artist.name, label: artist.name, value: artist.listenCount }))} />
            </div>
          )}

          {topGenres.length > 0 && (
            <div className="stats-card">
              <h3>Top genres</h3>
              <BarList
                label="Top genres by listens"
                rows={topGenres.map((entry) => ({ key: entry.genre.genreId, label: <Link to={`/genre/${entry.genre.slug}`}>{entry.genre.name}</Link>, value: entry.listenCount }))}
              />
            </div>
          )}

          {eras.decades.length > 0 && (
            <div className="stats-card">
              <h3>Release decades</h3>
              <BarList label="Listens by release decade" rows={eras.decades.map((entry) => ({ key: entry.decade, label: `${entry.decade}s`, value: entry.listenCount }))} />
              {eras.releasedThatYearShare !== null && <p className="stats-muted">{eras.releasedThatYearShare}% of listens were to albums released in {stats.period.label}.</p>}
            </div>
          )}

          {reviews.count > 0 && (
            <div className="stats-card">
              <h3>Reviews</h3>
              <div className="stats-ratings" role="list" aria-label="Rating distribution">
                {reviews.distribution.map((bucket) => (
                  <div key={bucket.rating} className="stats-rating" role="listitem" aria-label={`${plural(bucket.count, "review")} rated ${bucket.rating}`}>
                    <span className="stats-rating-count">{bucket.count || ""}</span>
                    <span className="stats-rating-bar" style={{ height: maxRating ? `${(bucket.count / maxRating) * 100}%` : 0 }} />
                    <span className="stats-rating-label">{bucket.rating}</span>
                  </div>
                ))}
              </div>
              <ul className="stats-facts">
                <li>Average rating <strong>★ {reviews.averageRating}</strong></li>
                {reviews.reviewRate !== null && <li>Reviewed <strong>{reviews.reviewRate}%</strong> of albums listened to</li>}
                {versus.difference !== null && (
                  <li>
                    Rates{" "}
                    <strong>{versus.difference === 0 ? "right at" : `${Math.abs(versus.difference).toFixed(2)} ${versus.difference > 0 ? "above" : "below"}`}</strong>{" "}
                    the community average across {plural(versus.albumCount, "album")}
                  </li>
                )}
              </ul>
              {reviews.mostLiked && (
                <Link className="stats-most-liked" to={`/review/${reviews.mostLiked.reviewId}`}>
                  <small>Most liked review · {plural(reviews.mostLiked.likeCount, "like")}</small>
                  <strong>{reviews.mostLiked.album.title || "Untitled album"} · ★ {reviews.mostLiked.rating}</strong>
                  <span>{reviews.mostLiked.reviewText}</span>
                </Link>
              )}
            </div>
          )}
        </>
      )}

      <div className="stats-card stats-card-wide">
        <h3>Library now</h3>
        <ul className="stats-facts stats-facts-inline">
          <li><strong>{library.savedAlbums}</strong> saved albums</li>
          <li><strong>{library.unplayedSaved}</strong> saved but not yet played{isOwner && library.unplayedSaved > 0 && <> · <Link to="/boards">Pick one</Link></>}</li>
          <li><strong>{library.trackRankings}</strong> track rankings</li>
        </ul>
      </div>
    </section>
  );
}

export default ProfileStats;
