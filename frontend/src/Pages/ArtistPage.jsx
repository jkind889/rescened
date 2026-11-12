import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "../utils/apiErrors";
import Cover from "../Components/Cover";
import PageMeta from "../Components/PageMeta";
import { SITE_NAME } from "../utils/pageMeta";
import {
  biographyAdvertised,
  discographyAdvertised,
  otherCredits,
  releaseCountLabel,
  releaseCreditNote,
  releaseFilterFrom,
  releaseTypeLabel,
  visibleReleaseFilters,
} from "../features/artists/artists";
import ArtistDiscography from "../features/artists/ArtistDiscography";
import ArtistBiography from "../features/artists/ArtistBiography";
import ArtistBiographyModeration from "../features/artists/ArtistBiographyModeration";
import "../Components/Community/GenreSuggestion.css";
import "../features/artists/ArtistPage.css";

async function getJson(url, signal, fallback) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(await getApiErrorMessage(response, fallback));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function OtherCredits({ release, artistId }) {
  const others = otherCredits(release, artistId);
  if (!others.length) return null;
  return (
    <p className="artist-release-with">
      with{" "}
      {others.map((credit, index) => (
        <Fragment key={`${index}-${credit.name}`}>
          {index > 0 ? ", " : null}
          {credit.name}
        </Fragment>
      ))}
    </p>
  );
}

// A local artist page: the registry heading and the artist's releases in the
// Rescened catalog, which never depend on a provider. When the API advertises
// it, a separately loaded MusicBrainz section (ArtistDiscography) follows; its
// failures stay inside that section.
export function ArtistPage() {
  const { artistId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const type = releaseFilterFrom(searchParams.get("type"));
  const [detail, setDetail] = useState({ key: "", data: null, error: "", status: 0 });
  const [releases, setReleases] = useState({ key: "", rows: [], nextCursor: null, loading: true, error: "" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  // Bumped after a moderator command so the About section reloads.
  const [biographyVersion, setBiographyVersion] = useState(0);
  const moreRequest = useRef(null);
  useEffect(() => () => {
    moreRequest.current?.abort();
    moreRequest.current = null;
  }, []);
  const listKey = `${artistId}|${type}`;
  const artistUrl = `${API_BASE_URL}/artists/${encodeURIComponent(artistId)}`;

  useEffect(() => {
    const controller = new AbortController();
    getJson(artistUrl, controller.signal, "Could not load this artist.")
      .then((data) => setDetail({ key: artistId, data, error: "", status: 0 }))
      .catch((error) => {
        if (error.name !== "AbortError") setDetail({ key: artistId, data: null, error: error.message, status: error.status || 0 });
      });
    return () => controller.abort();
  }, [artistId, artistUrl]);

  useEffect(() => {
    const controller = new AbortController();
    // A new artist or filter starts a new list; drop any pending "show more".
    moreRequest.current?.abort();
    moreRequest.current = null;
    setLoadingMore(false);
    setMoreError("");
    getJson(`${artistUrl}/releases?${new URLSearchParams({ type })}`, controller.signal, "Could not load releases.")
      .then((data) => setReleases({ key: listKey, rows: data.releases || [], nextCursor: data.nextCursor, loading: false, error: "" }))
      .catch((error) => {
        if (error.name !== "AbortError") setReleases({ key: listKey, rows: [], nextCursor: null, loading: false, error: error.message });
      });
    return () => controller.abort();
  }, [artistUrl, type, listKey]);

  async function loadMore() {
    if (!releases.nextCursor || loadingMore) return;
    const requestedKey = listKey;
    const controller = new AbortController();
    moreRequest.current = controller;
    setLoadingMore(true);
    setMoreError("");
    try {
      const params = new URLSearchParams({ type, cursor: releases.nextCursor });
      const data = await getJson(`${artistUrl}/releases?${params}`, controller.signal, "Could not load more releases.");
      setReleases((current) => (current.key === requestedKey
        ? { ...current, rows: [...current.rows, ...(data.releases || [])], nextCursor: data.nextCursor }
        : current));
    } catch (error) {
      if (error.name !== "AbortError" && moreRequest.current === controller) setMoreError(error.message);
    } finally {
      if (moreRequest.current === controller) {
        moreRequest.current = null;
        setLoadingMore(false);
      }
    }
  }

  function selectType(value) {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("type");
    else next.set("type", value);
    setSearchParams(next, { replace: true });
  }

  const currentDetail = detail.key === artistId ? detail : { data: null, error: "", status: 0 };
  if (currentDetail.error) {
    const missing = currentDetail.status === 404 || currentDetail.status === 400;
    return (
      <section className="community-page">
        <div className="community-empty-state" role="alert">
          <p className="community-eyebrow">{missing ? "Artist not found" : "Artist unavailable"}</p>
          <h1>{missing ? "There's no artist at this address." : currentDetail.error}</h1>
          <Link className="community-primary-link" to="/search">Search the catalog</Link>
        </div>
      </section>
    );
  }

  const data = currentDetail.data;
  const artist = data?.artist;
  const counts = data?.releaseCounts;
  const showRows = releases.key === listKey;
  const filters = counts ? visibleReleaseFilters(counts, type) : [];

  return (
    <section className="community-page artist-page">
      {artist ? (
        <PageMeta
          title={`${artist.name} · ${SITE_NAME}`}
          description={`${artist.name}: ${releaseCountLabel(counts?.all)}. Browse their releases in the ${SITE_NAME} catalog.`}
        />
      ) : null}
      <header className="community-page-header artist-page-header">
        <p className="community-page-kicker">Artist</p>
        <h1 className="community-page-title">{artist?.name || "Loading…"}</h1>
        {artist?.aliases?.length ? (
          <p className="community-page-description artist-page-names">
            Also known as{" "}
            {artist.aliases.map((alias, index) => (
              <Fragment key={alias.name}>
                {index > 0 ? ", " : null}
                <span lang={alias.locale || undefined}>{alias.name}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
        {artist?.creditedAs?.length ? (
          <p className="artist-page-names artist-page-credited">
            Credited as {artist.creditedAs.join(", ")}
          </p>
        ) : null}
        {artist ? (
          <p className="artist-page-meta">
            <span>{releaseCountLabel(counts?.all)}</span>
            {artist.musicBrainzUrl ? (
              <a href={artist.musicBrainzUrl} rel="noopener noreferrer" target="_blank">MusicBrainz</a>
            ) : null}
          </p>
        ) : null}
      </header>

      {artist && biographyAdvertised(data) ? (
        <>
          <ArtistBiography key={`${artist.artistId}-${biographyVersion}`} artistId={artist.artistId} />
          <ArtistBiographyModeration key={artist.artistId} artistId={artist.artistId} onChanged={() => setBiographyVersion((value) => value + 1)} />
        </>
      ) : null}

      <section className="artist-releases" aria-labelledby="artist-releases-heading">
        <div className="artist-releases-heading">
          <h2 id="artist-releases-heading">On Rescened</h2>
          <p className="genre-form-muted">
            Releases in the Rescened catalog credited to this artist, including collaborations. This is not a complete discography.
          </p>
        </div>

        {filters.length > 1 ? (
          <div className="genre-page-sort artist-release-filters" role="group" aria-label="Filter releases by type">
            {filters.map((filter) => (
              <button
                aria-pressed={type === filter.value}
                className="community-secondary-button"
                key={filter.value}
                onClick={() => selectType(filter.value)}
                type="button"
              >
                {filter.label} <span className="artist-release-filter-count">{counts?.[filter.value] ?? 0}</span>
              </button>
            ))}
          </div>
        ) : null}

        {showRows && releases.error ? <p className="community-message community-message-error" role="alert">{releases.error}</p> : null}
        {!showRows || releases.loading ? <p className="genre-form-muted" role="status">Loading releases…</p> : null}
        {showRows && !releases.loading && !releases.rows.length && !releases.error ? (
          <p className="genre-form-muted">
            {type === "all" ? "No releases in the Rescened catalog are linked to this artist yet." : "No releases of this type are linked to this artist yet."}
          </p>
        ) : null}

        {showRows && releases.rows.length ? (
          <div className="results-grid">
            {releases.rows.map((release) => {
              const note = releaseCreditNote(release);
              return (
                <Link className="result-card artist-release-card" key={release.albumId} to={`/album/${release.albumId}`}>
                  {release.cover ? (
                    <Cover className="result-cover" src={release.cover} alt={`${release.title} cover`} />
                  ) : (
                    <span className="result-cover result-cover-fallback" aria-label="No cover available">No cover</span>
                  )}
                  <span className="result-copy">
                    <h3>{release.title}</h3>
                    <OtherCredits release={release} artistId={artist?.artistId || artistId.toLowerCase()} />
                  </span>
                  <span className="result-year">
                    {release.releaseYear || "Year unknown"} · {releaseTypeLabel(release.releaseType)}
                    {note ? <span className="artist-release-note"> · {note}</span> : null}
                  </span>
                </Link>
              );
            })}
          </div>
        ) : null}

        {moreError ? <p className="community-message community-message-error" role="alert">{moreError}</p> : null}
        {showRows && releases.nextCursor ? (
          <button className="community-secondary-button genre-page-more" disabled={loadingMore} onClick={loadMore} type="button">
            {loadingMore ? "Loading…" : "Show more releases"}
          </button>
        ) : null}
      </section>

      {artist && discographyAdvertised(data) ? <ArtistDiscography key={artist.artistId} artistId={artist.artistId} /> : null}
    </section>
  );
}

export default ArtistPage;
