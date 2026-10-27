import { API_BASE_URL } from "../../config/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { getApiErrorMessage } from "../../utils/apiErrors";
import "./rankings.css";
import Cover from "../../Components/Cover";

// A profile's track rankings, most recently changed first, each showing its top tracks.
export function ProfileRankings({ userId, isOwner = false }) {
  const { getToken, isSignedIn } = useAuth();
  const [rankings, setRankings] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const activeUserRef = useRef(userId);
  activeUserRef.current = userId;

  const fetchPage = useCallback(async (cursor, signal) => {
    const token = isSignedIn ? await getToken() : null;
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`${API_BASE_URL}/profile/${encodeURIComponent(userId)}/rankings${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
    });
    if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load rankings."));
    return response.json();
  }, [getToken, isSignedIn, userId]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadFirstPage() {
      setIsLoading(true);
      setError("");
      setRankings([]);
      setNextCursor(null);
      try {
        const data = await fetchPage(null, controller.signal);
        if (controller.signal.aborted) return;
        setRankings(Array.isArray(data.rankings) ? data.rankings : []);
        setNextCursor(data.nextCursor || null);
      } catch (loadError) {
        if (!controller.signal.aborted) setError(loadError.message || "Could not load rankings.");
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    if (userId) void loadFirstPage();
    return () => controller.abort();
  }, [fetchPage, userId]);

  async function loadMore() {
    if (!nextCursor || isLoadingMore) return;
    const requestedFor = userId;
    setIsLoadingMore(true);
    setError("");
    try {
      const data = await fetchPage(nextCursor);
      if (activeUserRef.current !== requestedFor) return;
      setRankings((current) => {
        const seen = new Set(current.map((entry) => entry.album.albumId));
        return [...current, ...(data.rankings || []).filter((entry) => !seen.has(entry.album.albumId))];
      });
      setNextCursor(data.nextCursor || null);
    } catch (loadError) {
      setError(loadError.message || "Could not load more rankings.");
    } finally {
      setIsLoadingMore(false);
    }
  }

  if (isLoading) return <p className="profile-rankings-status">Loading rankings…</p>;

  return (
    <section className="profile-rankings" aria-label="Track rankings">
      {error && <p className="profile-rankings-status" role="alert">{error}</p>}
      {!error && rankings.length === 0 && (
        <div className="profile-empty-state">
          <h3>No rankings yet</h3>
          <p>{isOwner ? "Open an album's Ranking tab to order its tracks." : "This listener hasn't ranked any albums yet."}</p>
        </div>
      )}
      <ul className="profile-rankings-list">
        {rankings.map((entry) => (
          <li key={entry.album.albumId}>
            <Link className="profile-rankings-album" to={`/album/${entry.album.albumId}`}>
              {entry.album.cover ? <Cover src={entry.album.cover} /> : <span className="profile-rankings-fallback">No cover</span>}
              <span>
                <strong>{entry.album.title || "Untitled album"}</strong>
                <em>{entry.album.artistDisplayName || "Artist unknown"}</em>
                <small>
                  Ranked {entry.rankedCount === entry.trackCount ? "all" : `${entry.rankedCount} of`} {entry.trackCount} tracks
                  {entry.updatedAt && <> · <time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time></>}
                </small>
              </span>
            </Link>
            <ol className="profile-rankings-tracks">
              {entry.topTracks.map((track) => (
                <li key={track.trackId}>
                  <span>{track.position}</span>
                  {track.title || "Untitled Track"}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
      {nextCursor && (
        <button className="profile-more-link" type="button" onClick={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? "Loading…" : "Load more rankings"}
        </button>
      )}
    </section>
  );
}

export default ProfileRankings;
