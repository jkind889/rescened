import { API_BASE_URL } from "../config/api";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AsyncState from "../Components/Loading/AsyncState";
import ExternalAlbumCard from "../Components/ExternalAlbumCard";
import { getApiErrorMessage } from "../utils/apiErrors";
import Cover from "../Components/Cover";
import { artistMatchSummary } from "../features/artists/artists";
import ArtistCredits from "../features/artists/ArtistCredits";
import { CardLink, CardTitleLink } from "../Components/CardLink";
import "../features/artists/ArtistPage.css";

const EXTERNAL_SEARCH_LIMIT = 12;

export function SearchResults() {
  const [searchresults, setResults] = useState([]);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalError, setExternalError] = useState("");
  const [externalState, setExternalState] = useState("idle");
  const [catalogMatches, setCatalogMatches] = useState([]);
  const [externalCandidates, setExternalCandidates] = useState([]);
  const [externalRetry, setExternalRetry] = useState(0);
  // "Show more" for MusicBrainz results: a cursor from the API, bound to the
  // query. Paging is best effort: the API reuses its short-lived cached
  // provider page when it can and fetches afresh otherwise, so results are
  // de-duplicated here and a provider reorder can still skip one.
  const [externalMore, setExternalMore] = useState({ cursor: null, loading: false, error: "" });
  const externalMoreRequest = useRef(null);
  useEffect(() => () => {
    externalMoreRequest.current?.abort();
    externalMoreRequest.current = null;
  }, []);
  const [artistMatches, setArtistMatches] = useState({ key: "", results: [] });

  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const page = Math.max(Number.parseInt(searchParams.get("page") || "1", 10) || 1, 1);
  const viewParam = searchParams.get("view") || "grid";
  // Optional genre filter (a slug), set by a genre page's "Search this genre".
  const genre = searchParams.get("genre") || "";
  const [genreName, setGenreName] = useState("");
  const viewMode = viewParam === "list" ? "list" : "grid";

  // The catalog and external searches run concurrently. Retrying external
  // discovery refetches only the external results.
  useEffect(() => {
    let shouldIgnore = false;
    const controller = new AbortController();

    async function fetchResults() {
      if (!query) {
        setResults([]);
        setHasNextPage(false);
        setError("");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setResults([]);
      setHasNextPage(false);

      try {
        const response = await fetch(
          `${API_BASE_URL}/search/search?q=${encodeURIComponent(query)}&page=${page}${genre ? `&genre=${encodeURIComponent(genre)}` : ""}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error(await getApiErrorMessage(response, "Search request failed"));
        }

        const data = await response.json();
        if (shouldIgnore) return;

        const results = Array.isArray(data) ? data : data.results;
        const localResults = Array.isArray(results) ? results : [];
        setResults(localResults);
        setHasNextPage(Boolean(data?.hasNextPage));
        setGenreName(data?.genre?.name || "");
      } catch (searchError) {
        if (shouldIgnore || searchError.name === "AbortError") return;

        setResults([]);
        setHasNextPage(false);
        setError(searchError.message || "Unable to load search results.");
      } finally {
        if (!shouldIgnore) setLoading(false);
      }
    }

    fetchResults();

    return () => {
      shouldIgnore = true;
      controller.abort();
    };
  }, [query, page, genre]);

  useEffect(() => {
    let shouldIgnore = false;
    const controller = new AbortController();

    setExternalError("");
    setCatalogMatches([]);
    setExternalCandidates([]);
    externalMoreRequest.current?.abort();
    externalMoreRequest.current = null;
    setExternalMore({ cursor: null, loading: false, error: "" });

    // External candidates carry no genres, so a genre-filtered search skips them.
    if (!query || page !== 1 || genre) {
      setExternalLoading(false);
      setExternalState("idle");
      return undefined;
    }

    async function fetchExternalResults() {
      setExternalLoading(true);
      setExternalState("loading");

      try {
        const searchParams = new URLSearchParams({
          q: query,
          limit: String(EXTERNAL_SEARCH_LIMIT),
        });
        const response = await fetch(`${API_BASE_URL}/search/external?${searchParams.toString()}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await getApiErrorMessage(
            response,
            "External results are temporarily unavailable.",
          ));
        }

        const data = await response.json();
        if (shouldIgnore) return;

        setCatalogMatches(Array.isArray(data?.catalogMatches) ? data.catalogMatches : []);
        setExternalCandidates(Array.isArray(data?.candidates) ? data.candidates : []);
        setExternalMore({ cursor: data?.nextCursor || null, loading: false, error: "" });
        setExternalState("ready");
      } catch (searchError) {
        if (shouldIgnore || searchError.name === "AbortError") return;

        setExternalError(searchError.message || "External results are temporarily unavailable.");
        setExternalState("error");
      } finally {
        if (!shouldIgnore) setExternalLoading(false);
      }
    }

    fetchExternalResults();

    return () => {
      shouldIgnore = true;
      controller.abort();
    };
  }, [query, page, genre, externalRetry]);

  // Matching artist pages on page one. Optional: any failure, including
  // artist pages being disabled, just leaves the section out.
  useEffect(() => {
    const controller = new AbortController();
    if (!query || page !== 1 || genre) return undefined;
    const key = query;
    fetch(`${API_BASE_URL}/artists/search?${new URLSearchParams({ q: query, limit: "6" })}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { results: [] }))
      .then((data) => setArtistMatches({ key, results: Array.isArray(data?.results) ? data.results : [] }))
      .catch((fetchError) => {
        if (fetchError.name !== "AbortError") setArtistMatches({ key, results: [] });
      });
    return () => controller.abort();
  }, [query, page, genre]);

  async function loadMoreExternal() {
    if (!externalMore.cursor || externalMore.loading || externalMoreRequest.current) return;
    const controller = new AbortController();
    externalMoreRequest.current = controller;
    setExternalMore((current) => ({ ...current, loading: true, error: "" }));
    try {
      const params = new URLSearchParams({ q: query, limit: String(EXTERNAL_SEARCH_LIMIT), cursor: externalMore.cursor });
      const response = await fetch(`${API_BASE_URL}/search/external?${params.toString()}`, { signal: controller.signal });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "More external results are temporarily unavailable."));
      const data = await response.json();
      if (externalMoreRequest.current !== controller) return;
      // Provider pages can overlap; keep the first copy of each result.
      setExternalCandidates((current) => {
        const seen = new Set(current.map((item) => item.externalId));
        return [...current, ...(Array.isArray(data?.candidates) ? data.candidates : []).filter((item) => item?.externalId && !seen.has(item.externalId) && seen.add(item.externalId))];
      });
      setCatalogMatches((current) => {
        const seen = new Set(current.map((item) => item.albumId));
        return [...current, ...(Array.isArray(data?.catalogMatches) ? data.catalogMatches : []).filter((item) => item?.albumId && !seen.has(item.albumId) && seen.add(item.albumId))];
      });
      setExternalMore({ cursor: data?.nextCursor || null, loading: false, error: "" });
    } catch (moreError) {
      if (moreError.name === "AbortError" || externalMoreRequest.current !== controller) return;
      setExternalMore((current) => ({ ...current, loading: false, error: moreError.message }));
    } finally {
      if (externalMoreRequest.current === controller) externalMoreRequest.current = null;
    }
  }

  function updatePage(nextPage) {
    const nextParams = new URLSearchParams(searchParams);

    nextParams.set("page", String(nextPage));
    setSearchParams(nextParams);
  }

  function updateView(nextViewMode) {
    const nextParams = new URLSearchParams(searchParams);

    if (nextViewMode === "grid") {
      nextParams.delete("view");
    } else {
      nextParams.set("view", nextViewMode);
    }

    setSearchParams(nextParams);
  }

  function renderResults(results = searchresults) {
    return (
      <div className={viewMode === "list" ? "results-list" : "results-grid"}>
        {Array.isArray(results) && results.map((result) => (
          <CardLink className="result-card" key={result.albumId}>
            {result.cover ? (
              <Cover className="result-cover" src={result.cover} alt={`${result.title} cover`} size={viewMode === "list" ? 58 : undefined} />
            ) : (
              <span className="result-cover result-cover-fallback" aria-label="No cover available">No cover</span>
            )}
            <span className="result-copy">
              <h3><CardTitleLink to={`/album/${result.albumId}`}>{result.title}</CardTitleLink></h3>
              <p><ArtistCredits album={result} /></p>
            </span>
            <span className="result-year">{result.releaseYear || "Year unknown"}</span>
          </CardLink>
        ))}
      </div>
    );
  }

  const localAlbumIds = new Set(
    searchresults
      .map((result) => result?.albumId)
      .filter(Boolean),
  );
  const visibleCatalogMatches = [];
  const seenCatalogMatchIds = new Set();
  catalogMatches.forEach((match) => {
    const albumId = match?.albumId;
    if (albumId && (localAlbumIds.has(albumId) || seenCatalogMatchIds.has(albumId))) return;
    if (albumId) seenCatalogMatchIds.add(albumId);
    visibleCatalogMatches.push(match);
  });

  function renderExternalResults() {
    if (externalState === "loading") {
      return (
        <section className="external-search-message" role="status" aria-live="polite">
          <p className="external-search-message-kicker">External discovery</p>
          <h3>Searching MusicBrainz...</h3>
          <p>Looking for additional album matches.</p>
        </section>
      );
    }

    if (externalState === "error") {
      return (
        <section className="external-search-message" role="alert">
          <p className="external-search-message-kicker">External discovery unavailable</p>
          <h3>We couldn’t check MusicBrainz right now.</h3>
          <p>
            External results are temporarily unavailable.
            {externalError ? ` ${externalError}` : ""}
          </p>
          <button
            className="external-search-retry"
            type="button"
            onClick={() => setExternalRetry((current) => current + 1)}
          >
            Try external search again
          </button>
        </section>
      );
    }

    const hasAdditionalCatalogMatches = visibleCatalogMatches.length > 0;
    const hasCandidates = externalCandidates.length > 0;

    return (
      <div className="external-search-results">
        {searchresults.length === 0 ? (
          <section className="external-search-intro" aria-labelledby="external-search-heading">
            <p className="external-search-kicker">External discovery</p>
            <h3 id="external-search-heading">No albums in Rescened matched this search.</h3>
            <p>These MusicBrainz results are not in the catalog yet. You can suggest one for community review.</p>
          </section>
        ) : null}

        {hasAdditionalCatalogMatches ? (
          <section className="external-catalog-matches" aria-labelledby="catalog-matches-heading">
            <div className="external-section-heading">
              <p className="external-search-kicker">Known identities</p>
              <h3 id="catalog-matches-heading">Already in Rescened</h3>
            </div>
            {renderResults(visibleCatalogMatches)}
          </section>
        ) : null}

        {hasCandidates ? (
          <section className="external-candidates" aria-labelledby="external-candidates-heading">
            <div className="external-section-heading">
              <p className="external-search-kicker">MusicBrainz release groups</p>
              <h3 id="external-candidates-heading">Candidates to add</h3>
            </div>
            <div className="external-candidates-grid">
              {externalCandidates.map((candidate) => (
                <ExternalAlbumCard key={candidate.externalId} candidate={candidate} />
              ))}
            </div>
          </section>
        ) : null}

        {externalMore.error ? <p className="external-search-no-results" role="alert">{externalMore.error}</p> : null}
        {externalMore.cursor ? (
          <button className="external-search-retry" disabled={externalMore.loading} onClick={loadMoreExternal} type="button">
            {externalMore.loading ? "Loading…" : "Show more MusicBrainz results"}
          </button>
        ) : null}

        {!hasAdditionalCatalogMatches && !hasCandidates ? (
          <p className="external-search-no-results">
            {catalogMatches.length > 0
              ? "MusicBrainz did not find any additional albums beyond the Rescened results above."
              : "MusicBrainz did not return any usable release groups for this query."}
          </p>
        ) : null}
      </div>
    );
  }

  const isExternalMiss = Boolean(
    query && page === 1 && !loading && !error && searchresults.length === 0,
  );
  const isExternalPage = Boolean(
    query && page === 1 && !loading && !error && externalState !== "idle",
  );
  const hasExternalResults = visibleCatalogMatches.length > 0 || externalCandidates.length > 0;
  const hasVisibleResults = searchresults.length > 0 || hasExternalResults;

  return (
    <section className="search-results-page">
        <div className="search-results-header">
          <p className="search-results-kicker">Search results</p>
          <h2>{query || "Search"}</h2>
          {genre ? (
            <p className="search-genre-filter">
              In <Link to={`/genre/${encodeURIComponent(genre)}`}>{genreName || genre}</Link> and its sub-genres ·{" "}
              <button
                className="community-text-button"
                onClick={() => {
                  const nextParams = new URLSearchParams(searchParams);
                  nextParams.delete("genre");
                  nextParams.delete("page");
                  setSearchParams(nextParams);
                }}
                type="button"
              >
                Search all genres
              </button>
            </p>
          ) : null}
          <div className="search-results-toolbar">
            <p className="search-results-summary">
              {loading
                ? "Loading albums..."
                : externalLoading && searchresults.length === 0
                  ? "Searching MusicBrainz..."
                : isExternalMiss && hasExternalResults
                  ? `${visibleCatalogMatches.length + externalCandidates.length} discovery result${visibleCatalogMatches.length + externalCandidates.length === 1 ? "" : "s"}`
                  : `${searchresults.length} album${searchresults.length === 1 ? "" : "s"} on page ${page}`}
            </p>
            <div className="profile-view-toggle search-view-toggle" aria-label="Search results view">
              <button
                className={viewMode === "grid" ? "profile-view-toggle-active" : ""}
                type="button"
                onClick={() => updateView("grid")}
              >
                Grid
              </button>
              <button
                className={viewMode === "list" ? "profile-view-toggle-active" : ""}
                type="button"
                onClick={() => updateView("list")}
              >
                List
              </button>
            </div>
          </div>
        </div>

        {query && page === 1 && !genre && artistMatches.key === query && artistMatches.results.length > 0 ? (
          <section className="search-artist-matches" aria-labelledby="search-artists-heading">
            <h3 id="search-artists-heading">Artists</h3>
            <ul className="search-artist-list">
              {artistMatches.results.map((artist) => (
                <li key={artist.artistId}>
                  <Link to={`/artist/${artist.artistId}`}>
                    <strong>{artist.name}</strong>
                    <small>{artistMatchSummary(artist)}</small>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <AsyncState
          isLoading={loading && Boolean(query)}
          error={error}
          isEmpty={!loading && !error && Boolean(query) && !hasVisibleResults && !isExternalMiss}
          loadingVariant="grid"
          loadingMessage="Loading search results"
          errorTitle="Search unavailable"
          emptyTitle="No albums matched that search."
        >
          {searchresults.length > 0 ? renderResults() : null}
          {isExternalPage ? renderExternalResults() : null}
        </AsyncState>

        {query && (page > 1 || hasNextPage) && (
          <div className="search-pagination" aria-label="Search pagination">
            <button
              type="button"
              disabled={loading || page <= 1}
              onClick={() => updatePage(page - 1)}
            >
              Previous
            </button>
            <span>Page {page}</span>
            <button
              type="button"
              disabled={loading || !hasNextPage}
              onClick={() => updatePage(page + 1)}
            >
              Next
            </button>
          </div>
        )}

    </section>
  )


}

export default SearchResults;
