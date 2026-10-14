import { useEffect, useId, useState } from "react";
import {
  MAX_ALBUM_GENRES,
  MAX_GENRE_NOTE_LENGTH,
  MAX_NEW_GENRES,
  buildGenreSuggestionPayload,
  cleanGenreName,
  communityGenreError,
  existingKey,
  fetchTopLevelGenres,
  genreSuggestionHasChanges,
  initialGenreForm,
  isValidGenreName,
  newKey,
  previewGenreList,
  searchGenres,
} from "../../features/community/genres.js";
import "./GenreSuggestion.css";

const SEARCH_DELAY_MS = 250;

// Lets a contributor add, remove, and reorder an album's genres. Additions
// can be existing genres or up to two new names, which moderators review.
export function GenreSuggestionForm({
  album,
  currentGenres,
  initialChanges = null,
  onSubmit,
  isSubmitting = false,
  error = null,
  submitLabel = "Send for review",
  submittingLabel = "Sending…",
}) {
  const [form, setForm] = useState(() => initialGenreForm(currentGenres, initialChanges));
  const [query, setQuery] = useState("");
  // Results remember the query they answer, so a stale response never shows.
  const [search, setSearch] = useState({ query: "", results: [], status: "idle" });
  const [parents, setParents] = useState([]);
  const [clientError, setClientError] = useState("");
  const searchId = useId();
  const noteId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetchTopLevelGenres(controller.signal).then(setParents).catch(() => setParents([]));
    return () => controller.abort();
  }, []);

  const trimmedQuery = cleanGenreName(query);
  useEffect(() => {
    if (trimmedQuery.length < 2) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchGenres(trimmedQuery, controller.signal)
        .then((rows) => setSearch({ query: trimmedQuery, results: rows, status: "ready" }))
        .catch((searchError) => {
          if (searchError?.name !== "AbortError") setSearch({ query: trimmedQuery, results: [], status: "error" });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmedQuery]);
  const current = trimmedQuery.length >= 2 && search.query === trimmedQuery;
  const results = current ? search.results : [];
  const searchState = trimmedQuery.length < 2 ? "idle" : current ? search.status : "loading";

  const preview = previewGenreList(currentGenres, form);
  const usedKeys = new Set([
    ...currentGenres.filter((genre) => !form.removed.includes(genre.genreId)).map(existingKey),
    ...form.additions.map((entry) => entry.key),
  ]);
  const newCount = form.additions.filter((entry) => entry.newGenre).length;
  const atLimit = preview.length >= MAX_ALBUM_GENRES;
  const exactResult = results.some((genre) => newKey(genre.name) === newKey(trimmedQuery) || newKey(genre.matchedAlias || "") === newKey(trimmedQuery));
  const canProposeNew = searchState === "ready" && !exactResult && isValidGenreName(trimmedQuery)
    && newCount < MAX_NEW_GENRES && !atLimit && !usedKeys.has(newKey(trimmedQuery));
  const primaryKey = preview[0]?.key || null;

  function update(change) {
    setClientError("");
    setForm((current) => ({ ...current, ...change(current) }));
  }

  function toggleRemoval(genre) {
    update((current) => {
      const removing = !current.removed.includes(genre.genreId);
      return {
        removed: removing ? [...current.removed, genre.genreId] : current.removed.filter((genreId) => genreId !== genre.genreId),
        primaryKey: removing && current.primaryKey === existingKey(genre) ? null : current.primaryKey,
      };
    });
  }

  function addExisting(genre) {
    update((current) => ({ additions: [...current.additions, { key: existingKey(genre), genre: { genreId: genre.genreId, slug: genre.slug, name: genre.name } }] }));
    setQuery("");
  }

  function addNew() {
    const name = trimmedQuery;
    update((current) => ({ additions: [...current.additions, { key: newKey(name), newGenre: { name, parentGenreId: "" } }] }));
    setQuery("");
  }

  function removeAddition(key) {
    update((current) => ({
      additions: current.additions.filter((entry) => entry.key !== key),
      primaryKey: current.primaryKey === key ? null : current.primaryKey,
    }));
  }

  function setParent(key, parentGenreId) {
    update((current) => ({
      additions: current.additions.map((entry) => (entry.key === key ? { ...entry, newGenre: { ...entry.newGenre, parentGenreId } } : entry)),
    }));
  }

  function submit(event) {
    event.preventDefault();
    if (isSubmitting) return;
    const payload = buildGenreSuggestionPayload(album.albumId, currentGenres, form);
    if (!genreSuggestionHasChanges(payload)) {
      setClientError("Add, remove, or reorder at least one genre before sending.");
      return;
    }
    if (preview.length > MAX_ALBUM_GENRES) {
      setClientError(`An album can have at most ${MAX_ALBUM_GENRES} genres. Remove some first.`);
      return;
    }
    onSubmit(payload);
  }

  const shownError = communityGenreError(error);

  return (
    <form className="genre-form community-panel" onSubmit={submit} noValidate>
      <section className="genre-form-section" aria-labelledby={`${searchId}-current`}>
        <h2 className="genre-form-title" id={`${searchId}-current`}>Current genres</h2>
        {currentGenres.length ? (
          <ul className="genre-chip-list">
            {currentGenres.map((genre) => {
              const removed = form.removed.includes(genre.genreId);
              return (
                <li className={`genre-chip${removed ? " genre-chip-removed" : ""}`} key={genre.genreId}>
                  <span>{genre.name}</span>
                  <button className="genre-chip-button" disabled={isSubmitting} onClick={() => toggleRemoval(genre)} type="button">
                    {removed ? "Keep" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="genre-form-muted">This album has no genres yet.</p>}
      </section>

      <section className="genre-form-section">
        <label className="genre-form-title" htmlFor={searchId}>Add genres</label>
        <input
          autoComplete="off"
          className="genre-search-input"
          disabled={isSubmitting || atLimit}
          id={searchId}
          maxLength={40}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={atLimit ? `This album would have ${MAX_ALBUM_GENRES} genres` : "Search genres, e.g. jazz rap"}
          type="search"
          value={query}
        />
        {searchState === "error" ? <p className="genre-form-muted" role="alert">Genre search is unavailable right now.</p> : null}
        {results.length || canProposeNew ? (
          <ul className="genre-result-list">
            {results.map((genre) => {
              const used = usedKeys.has(existingKey(genre));
              return (
                <li className="genre-result" key={genre.genreId}>
                  <span>
                    {genre.name}
                    {genre.matchedAlias ? <small> also called {genre.matchedAlias}</small> : null}
                  </span>
                  <button className="community-text-button" disabled={used || atLimit || isSubmitting} onClick={() => addExisting(genre)} type="button">
                    {used ? "Added" : "Add"}
                  </button>
                </li>
              );
            })}
            {canProposeNew ? (
              <li className="genre-result genre-result-new">
                <span>Propose “{trimmedQuery}” as a new genre</span>
                <button className="community-text-button" disabled={isSubmitting} onClick={addNew} type="button">Propose</button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {searchState === "ready" && !results.length && !canProposeNew && trimmedQuery.length >= 2 ? (
          <p className="genre-form-muted">
            {newCount >= MAX_NEW_GENRES ? `You can propose at most ${MAX_NEW_GENRES} new genres per suggestion.` : "No matching genres."}
          </p>
        ) : null}
      </section>

      {form.additions.length ? (
        <section className="genre-form-section">
          <h2 className="genre-form-title">Your additions</h2>
          <ul className="genre-addition-list">
            {form.additions.map((entry) => (
              <li className="genre-addition" key={entry.key}>
                <div className="genre-addition-heading">
                  <strong>{entry.genre ? entry.genre.name : entry.newGenre.name}</strong>
                  {entry.newGenre ? <span className="genre-badge">New genre</span> : null}
                  <button className="community-text-button" disabled={isSubmitting} onClick={() => removeAddition(entry.key)} type="button">Remove</button>
                </div>
                {entry.newGenre ? (
                  <label className="genre-addition-parent">
                    Broader genre <span>optional</span>
                    <select disabled={isSubmitting} onChange={(event) => setParent(entry.key, event.target.value)} value={entry.newGenre.parentGenreId}>
                      <option value="">None (top-level)</option>
                      {parents.map((parent) => <option key={parent.genreId} value={parent.genreId}>{parent.name}</option>)}
                    </select>
                  </label>
                ) : null}
              </li>
            ))}
          </ul>
          {newCount ? <p className="genre-form-muted">A moderator reviews new genre names before anyone sees them.</p> : null}
        </section>
      ) : null}

      <section className="genre-form-section">
        <h2 className="genre-form-title">
          After approval <span className={`genre-count${preview.length > MAX_ALBUM_GENRES ? " genre-count-over" : ""}`}>{preview.length} of {MAX_ALBUM_GENRES}</span>
        </h2>
        {preview.length ? (
          <fieldset className="genre-primary-list">
            <legend>Primary genre</legend>
            {preview.map((item) => (
              <label className="genre-primary-option" key={item.key}>
                <input
                  checked={primaryKey === item.key}
                  disabled={isSubmitting}
                  name={`${searchId}-primary`}
                  onChange={() => update(() => ({ primaryKey: item.key }))}
                  type="radio"
                />
                <span>{item.name}{item.isNew ? <small> new</small> : null}</span>
              </label>
            ))}
          </fieldset>
        ) : <p className="genre-form-muted">The album would have no genres.</p>}
      </section>

      <div className="community-field">
        <label htmlFor={noteId}>Note for moderators <span>optional</span></label>
        <textarea
          disabled={isSubmitting}
          id={noteId}
          maxLength={MAX_GENRE_NOTE_LENGTH}
          onChange={(event) => update(() => ({ note: event.target.value }))}
          placeholder="Why these genres fit, if it isn't obvious."
          rows={3}
          value={form.note}
        />
        <small>{form.note.length}/{MAX_GENRE_NOTE_LENGTH}</small>
      </div>

      <div aria-live="polite">
        {clientError ? <p className="community-message community-message-error" role="alert">{clientError}</p> : null}
        {shownError ? (
          <div className="community-message community-message-error" role="alert">
            <strong>{shownError.message}</strong>
            {shownError.code ? <code>{shownError.code}</code> : null}
            {shownError.retryAfterSeconds ? <small>Try again in about {shownError.retryAfterSeconds} seconds.</small> : null}
          </div>
        ) : null}
      </div>

      <button className="community-primary-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? submittingLabel : submitLabel}
      </button>
    </form>
  );
}

export default GenreSuggestionForm;
