import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE_URL } from "../../config/api";
import { getApiErrorMessage } from "../../utils/apiErrors";
import ExternalAlbumCard from "../../Components/ExternalAlbumCard";
import { DISCOGRAPHY_FILTERS, discographyHidden, discographySummary, mergeDiscographyRows, releaseTypeLabel } from "./artists";

async function getDiscography(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    let code = "";
    try { code = (await response.clone().json())?.code || ""; } catch { code = ""; }
    const error = new Error(await getApiErrorMessage(response, "MusicBrainz discography is unavailable."));
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return response.json();
}

function CatalogRow({ release }) {
  return (
    <article className="external-album-card artist-discography-catalog">
      {release.cover ? (
        <img className="external-album-cover" src={release.cover} alt={`${release.title} cover`} loading="lazy" decoding="async" />
      ) : (
        <div className="external-album-cover external-album-cover-fallback" aria-label="No cover available">No cover</div>
      )}
      <div className="external-album-copy">
        <div className="external-album-label-row">
          <span className="external-album-label">On Rescened</span>
          <span className="external-album-type">{releaseTypeLabel(release.releaseType)}</span>
        </div>
        <h4 className="external-album-title">{release.title}</h4>
        <p className="external-album-artist">{release.artistDisplayName}</p>
        <p className="external-album-year">{release.releaseYear || "Year unknown"}</p>
        <div className="external-album-actions">
          <Link className="external-album-source" to={`/album/${release.albumId}`}>Open album</Link>
        </div>
      </div>
    </article>
  );
}

// The artist's MusicBrainz release groups, loaded on their own after the
// local page. Failures stay inside this section; nothing retries by itself.
export function ArtistDiscography({ artistId }) {
  const [filter, setFilter] = useState("album");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ key: "", rows: [], providerCount: null, nextCursor: null, pages: 0, lastAdded: 0, filteredOut: 0, source: null, suggestionsAvailable: false, truncated: false, loading: true, error: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const moreRequest = useRef(null);
  const key = `${artistId}|${filter}|${attempt}`;
  const baseUrl = `${API_BASE_URL}/artists/${encodeURIComponent(artistId)}/discography`;

  // Leaving the page cancels any pending "load more" request.
  useEffect(() => () => {
    moreRequest.current?.abort();
    moreRequest.current = null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    moreRequest.current?.abort();
    moreRequest.current = null;
    setLoadingMore(false);
    setMoreError("");
    getDiscography(`${baseUrl}?${new URLSearchParams({ type: filter })}`, controller.signal)
      .then((data) => setState({
        key, rows: mergeDiscographyRows([], data.releases).rows, providerCount: data.providerCount, nextCursor: data.nextCursor,
        pages: 1, lastAdded: (data.releases || []).length, filteredOut: data.filteredOut || 0, source: data.source,
        suggestionsAvailable: data.suggestionsAvailable === true, truncated: Boolean(data.truncatedAtOffsetCap), loading: false, error: null,
      }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ key, rows: [], providerCount: null, nextCursor: null, pages: 0, lastAdded: 0, filteredOut: 0, source: null, suggestionsAvailable: false, truncated: false, loading: false, error });
      });
    return () => controller.abort();
  }, [baseUrl, filter, key]);

  async function loadMore() {
    if (!state.nextCursor || loadingMore || moreRequest.current) return;
    const requestedKey = key;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    setMoreError("");
    try {
      const data = await getDiscography(`${baseUrl}?${new URLSearchParams({ type: filter, cursor: state.nextCursor })}`, controller.signal);
      setState((current) => {
        if (current.key !== requestedKey) return current;
        const merged = mergeDiscographyRows(current.rows, data.releases);
        return { ...current, rows: merged.rows, lastAdded: merged.added, nextCursor: data.nextCursor, pages: current.pages + 1,
          filteredOut: current.filteredOut + (data.filteredOut || 0), truncated: Boolean(data.truncatedAtOffsetCap) };
      });
    } catch (error) {
      if (error.name !== "AbortError" && moreRequest.current === controller) setMoreError(error.message);
    } finally {
      if (moreRequest.current === controller) {
        moreRequest.current = null;
        setLoadingMore(false);
      }
    }
  }

  const current = state.key === key ? state : { ...state, loading: true, error: null, rows: [] };
  // Discography off or not served by this API: leave the page without it.
  if (discographyHidden(current.error)) return null;

  return (
    <section className="artist-releases artist-discography" aria-labelledby="artist-discography-heading">
      <div className="artist-releases-heading">
        <h2 id="artist-discography-heading">On MusicBrainz</h2>
        <p className="genre-form-muted">
          Release groups MusicBrainz credits to this artist, including collaborations, from its default website view. That view leaves out groups whose releases are all promotional, bootleg, or pseudo-releases, but it is not limited to official releases. Ones already in the catalog link to their Rescened album; the rest are not in Rescened.
        </p>
      </div>

      <div className="genre-page-sort artist-release-filters" role="group" aria-label="Filter MusicBrainz release groups">
        {DISCOGRAPHY_FILTERS.map((option) => (
          <button aria-pressed={filter === option.value} className="community-secondary-button" key={option.value} onClick={() => setFilter(option.value)} type="button">
            {option.label}
          </button>
        ))}
      </div>
      {["album", "ep", "single"].includes(filter) ? (
        <p className="genre-form-muted artist-discography-note">
          MusicBrainz {filter === "ep" ? "EP" : filter} release groups with no secondary type such as live, compilation, or remix. This is not a guarantee of official studio releases.
        </p>
      ) : null}

      {current.loading ? <p className="genre-form-muted" role="status">Loading MusicBrainz discography…</p> : null}
      {current.error ? (
        <div className="community-message community-message-error" role="alert">
          <p>{current.error.code === "ARTIST_DISCOGRAPHY_NOT_AVAILABLE" ? "This artist has no MusicBrainz identity, so there is no discography to show." : current.error.message}</p>
          {current.error.code !== "ARTIST_DISCOGRAPHY_NOT_AVAILABLE" ? (
            <button className="community-secondary-button" onClick={() => setAttempt((value) => value + 1)} type="button">Try again</button>
          ) : null}
        </div>
      ) : null}

      {!current.loading && !current.error ? (
        <>
          <p className="genre-form-muted artist-discography-summary" role="status">
            {discographySummary({ filter, providerCount: current.providerCount, shown: current.rows.length, pagesLoaded: current.pages, hasMore: Boolean(current.nextCursor) })}
            {current.filteredOut ? ` ${current.filteredOut} other returned row${current.filteredOut === 1 ? " is" : "s are"} hidden because ${current.filteredOut === 1 ? "it doesn't" : "they don't"} match this filter or could not be verified for this artist.` : ""}
          </p>
          {!current.rows.length && !current.nextCursor ? (
            <p className="genre-form-muted">
              {current.filteredOut
                ? "None of the release groups MusicBrainz returned could be verified for this artist and filter."
                : `MusicBrainz has no ${DISCOGRAPHY_FILTERS.find((item) => item.value === filter).noun} for this artist in its default view.`}
            </p>
          ) : null}
          {!current.rows.length && current.nextCursor ? (
            <p className="genre-form-muted">No verified matching release groups in this batch yet. MusicBrainz has more to check.</p>
          ) : null}
          {current.rows.length ? (
            <div className="external-candidates-grid">
              {current.rows.map((release) => (release.kind === "catalog"
                ? <CatalogRow key={release.externalId} release={release} />
                : <ExternalAlbumCard key={release.externalId} candidate={release} showSuggest={current.suggestionsAvailable} />))}
            </div>
          ) : null}
          {current.pages > 1 && current.lastAdded === 0 && current.nextCursor ? (
            <p className="genre-form-muted">The last batch had no new verified matching release groups. MusicBrainz has more to check.</p>
          ) : null}
          {current.truncated ? <p className="genre-form-muted">Browsing stops here; MusicBrainz lists more than Rescened pages through.</p> : null}
          {moreError ? <p className="community-message community-message-error" role="alert">{moreError}</p> : null}
          {current.nextCursor ? (
            <button className="community-secondary-button genre-page-more" disabled={loadingMore} onClick={loadMore} type="button">
              {loadingMore ? "Loading…" : "Load more from MusicBrainz"}
            </button>
          ) : null}
          {current.source?.artistUrl ? (
            <p className="artist-discography-source">
              Data from <a href={current.source.artistUrl} rel="noopener noreferrer" target="_blank">MusicBrainz</a> (CC0). Cover images are linked from the Cover Art Archive.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default ArtistDiscography;
