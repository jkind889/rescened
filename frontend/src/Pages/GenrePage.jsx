import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "../utils/apiErrors";
import "../Components/Community/GenreSuggestion.css";
import Cover from "../Components/Cover";

const SORTS = [
  { value: "rating", label: "Highest rated" },
  { value: "recent", label: "Recently reviewed" },
];

async function getJson(url, signal, fallback) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(await getApiErrorMessage(response, fallback));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// A genre's albums, best-rated or most recently reviewed first, with links to
// its broader genre and sub-genres and a search limited to the genre.
export function GenrePage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = searchParams.get("sort") === "recent" ? "recent" : "rating";
  const includeChildren = searchParams.get("includeChildren") !== "false";
  const [detail, setDetail] = useState({ data: null, error: "", status: 0 });
  const [albums, setAlbums] = useState({ key: "", rows: [], nextCursor: null, loading: true, error: "" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const listKey = `${slug}|${sort}|${includeChildren}`;

  useEffect(() => {
    const controller = new AbortController();
    getJson(`${API_BASE_URL}/genres/${encodeURIComponent(slug)}`, controller.signal, "Could not load this genre.")
      .then((data) => {
        // An old or alternative slug redirects to the genre's current one.
        if (!data.canonical) navigate(`/genre/${data.genre.slug}${window.location.search}`, { replace: true });
        else setDetail({ data, error: "", status: 0 });
      })
      .catch((error) => {
        if (error.name !== "AbortError") setDetail({ data: null, error: error.message, status: error.status || 0 });
      });
    return () => controller.abort();
  }, [slug, navigate]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ sort, includeChildren: String(includeChildren) });
    getJson(`${API_BASE_URL}/genres/${encodeURIComponent(slug)}/albums?${params}`, controller.signal, "Could not load albums.")
      .then((data) => setAlbums({ key: listKey, rows: data.albums || [], nextCursor: data.nextCursor, loading: false, error: "" }))
      .catch((error) => {
        if (error.name !== "AbortError") setAlbums({ key: listKey, rows: [], nextCursor: null, loading: false, error: error.message });
      });
    return () => controller.abort();
  }, [slug, sort, includeChildren, listKey]);

  async function loadMore() {
    if (!albums.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ sort, includeChildren: String(includeChildren), cursor: albums.nextCursor });
      const data = await getJson(`${API_BASE_URL}/genres/${encodeURIComponent(slug)}/albums?${params}`, undefined, "Could not load more albums.");
      setAlbums((current) => ({ ...current, rows: [...current.rows, ...(data.albums || [])], nextCursor: data.nextCursor }));
    } catch (error) {
      setAlbums((current) => ({ ...current, error: error.message }));
    } finally {
      setLoadingMore(false);
    }
  }

  function setParam(key, value, fallback) {
    const next = new URLSearchParams(searchParams);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }

  function submitSearch(event) {
    event.preventDefault();
    const text = query.trim();
    if (text) navigate(`/search?q=${encodeURIComponent(text)}&genre=${encodeURIComponent(detail.data?.genre.slug || slug)}`);
  }

  if (detail.error) {
    return (
      <section className="community-page">
        <div className="community-empty-state" role="alert">
          <p className="community-eyebrow">{detail.status === 404 ? "Genre not found" : "Genre unavailable"}</p>
          <h1>{detail.status === 404 ? "There's no genre at this address." : detail.error}</h1>
          <Link className="community-primary-link" to="/search">Search the catalog</Link>
        </div>
      </section>
    );
  }

  const data = detail.data;
  const showRows = albums.key === listKey;

  return (
    <section className="community-page genre-page">
      <header className="community-page-header genre-page-header">
        <p className="community-page-kicker">Genre</p>
        <h1 className="community-page-title">{data?.genre.name || "Loading…"}</h1>
        {data ? (
          <>
            {data.aliases.length ? <p className="community-page-description">Also called {data.aliases.join(", ")}</p> : null}
            <div className="genre-page-related">
              {data.parent ? <>Part of <Link to={`/genre/${data.parent.slug}`}>{data.parent.name}</Link></> : null}
              {data.children.length ? (
                <>
                  <span>Sub-genres</span>
                  {data.children.map((child) => <Link key={child.genreId} to={`/genre/${child.slug}`}>{child.name}</Link>)}
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </header>

      <div className="genre-page-controls">
        <div className="genre-page-sort" role="group" aria-label="Sort albums">
          {SORTS.map((option) => (
            <button
              aria-pressed={sort === option.value}
              className="community-secondary-button"
              key={option.value}
              onClick={() => setParam("sort", option.value, "rating")}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        {data?.children.length ? (
          <label className="genre-primary-option">
            <input checked={includeChildren} onChange={(event) => setParam("includeChildren", String(event.target.checked), "true")} type="checkbox" />
            Include sub-genres
          </label>
        ) : null}
        <form className="genre-page-search" onSubmit={submitSearch} role="search">
          <input aria-label={`Search ${data?.genre.name || "this genre"}`} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${data?.genre.name || "this genre"}`} type="search" value={query} />
          <button className="community-secondary-button" type="submit">Search</button>
        </form>
      </div>

      {sort === "rating" ? <p className="genre-form-muted">Albums with at least 3 reviews come first, by community average.</p> : null}
      {albums.error ? <p className="community-message community-message-error" role="alert">{albums.error}</p> : null}
      {!showRows || albums.loading ? <p className="genre-form-muted" role="status">Loading albums…</p> : null}
      {showRows && !albums.loading && !albums.rows.length && !albums.error ? <p className="genre-form-muted">No albums have this genre yet.</p> : null}

      {showRows ? (
        <div className="results-grid">
          {albums.rows.map((album) => (
            <Link className="result-card" key={album.albumId} to={`/album/${album.albumId}`}>
              {album.cover ? (
                <Cover className="result-cover" src={album.cover} alt={`${album.title} cover`} />
              ) : (
                <span className="result-cover result-cover-fallback" aria-label="No cover available">No cover</span>
              )}
              <span className="result-copy">
                <h3>{album.title}</h3>
                <p>{album.artistDisplayName}</p>
              </span>
              <span className="result-year">
                {album.releaseYear || "Year unknown"}
                {album.reviewCount ? <span className="genre-page-rating"> · ★ {album.averageRating} ({album.reviewCount})</span> : null}
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      {showRows && albums.nextCursor ? (
        <button className="community-secondary-button genre-page-more" disabled={loadingMore} onClick={loadMore} type="button">
          {loadingMore ? "Loading…" : "Show more albums"}
        </button>
      ) : null}
    </section>
  );
}

export default GenrePage;
