import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { API_BASE_URL } from "../config/api";
import { communityErrorFrom, formatCommunityDate, requestCommunityJson } from "../features/community/community.js";
import { fetchTopLevelGenres } from "../features/community/genres.js";
import "../Components/Community/GenreSuggestion.css";

const BASE_PATH = "/moderation/genres";
const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "retired", label: "Retired" },
  { value: "all", label: "All" },
];
const EVENT_LABELS = {
  create: "Created",
  rename: "Renamed",
  alias_add: "Alias added",
  reparent: "Parent changed",
  retire: "Retired",
  restore: "Restored",
  merge: "Merged",
};

function describeEvent(event) {
  const before = event.before || {};
  const after = event.after || {};
  if (event.action === "rename") return `${before.name} → ${after.name}`;
  if (event.action === "alias_add") return (after.aliases || []).filter((alias) => !(before.aliases || []).includes(alias)).join(", ");
  if (event.action === "reparent") return `${before.parent?.name || "top-level"} → ${after.parent?.name || "top-level"}`;
  if (event.action === "merge") return `Into ${after.mergedInto?.name || "another genre"} (${after.albums ?? 0} albums)`;
  return "";
}

function ErrorMessage({ error }) {
  if (!error) return null;
  return (
    <div className="community-message community-message-error" role="alert">
      <strong>{error.message}</strong>
      {error.code ? <code>{error.code}</code> : null}
    </div>
  );
}

// One command form: a text input (or a parent select) plus an optional note.
function CommandForm({ label, action, genre, parents, busy, onRun, requireReason = false, field = null }) {
  const [value, setValue] = useState(field === "parent" ? genre.parent?.genreId || "" : "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  function submit(event) {
    event.preventDefault();
    if (field === "name" && !value.trim()) {
      setError("Enter a name.");
      return;
    }
    if (requireReason && !reason.trim()) {
      setError("Add a reason.");
      return;
    }
    setError("");
    const body = { expectedRevision: genre.revision, ...(reason.trim() ? { reason: reason.trim() } : {}) };
    if (field === "name") body.name = value.trim();
    if (field === "parent") body.parentGenreId = value || null;
    onRun(action, body);
  }

  return (
    <form className="genre-vocab-command" onSubmit={submit}>
      <h3>{label}</h3>
      {field === "name" ? (
        <input aria-label={label} disabled={busy} maxLength={40} onChange={(event) => setValue(event.target.value)} type="text" value={value} />
      ) : null}
      {field === "parent" ? (
        <select aria-label={label} disabled={busy} onChange={(event) => setValue(event.target.value)} value={value}>
          <option value="">None (top-level)</option>
          {parents.filter((parent) => parent.genreId !== genre.genreId).map((parent) => (
            <option key={parent.genreId} value={parent.genreId}>{parent.name}</option>
          ))}
        </select>
      ) : null}
      <input
        aria-label={`${label} reason`}
        disabled={busy}
        maxLength={1000}
        onChange={(event) => setReason(event.target.value)}
        placeholder={requireReason ? "Reason (required)" : "Reason (optional)"}
        type="text"
        value={reason}
      />
      {error ? <p className="community-message community-message-error" role="alert">{error}</p> : null}
      <button className="community-secondary-button" disabled={busy} type="submit">{label}</button>
    </form>
  );
}

export function GenreVocabulary() {
  const { genreId } = useParams();
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const [status, setStatus] = useState("active");
  const [query, setQuery] = useState("");
  const [list, setList] = useState({ genres: [], loading: true, error: null });
  const [detail, setDetail] = useState({ data: null, loading: false, error: null });
  const [command, setCommand] = useState({ busy: false, error: null, message: "" });
  const [parents, setParents] = useState([]);
  const [refresh, setRefresh] = useState(0);
  const [accessDenied, setAccessDenied] = useState(false);

  const authorized = useCallback(async (url, options = {}, fallback = "Request failed") => {
    const token = await getToken();
    return requestCommunityJson(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } }, fallback);
  }, [getToken]);

  useEffect(() => {
    const controller = new AbortController();
    fetchTopLevelGenres(controller.signal).then(setParents).catch(() => setParents([]));
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    let ignore = false;
    const params = new URLSearchParams({ status });
    if (query.trim()) params.set("q", query.trim());
    const timer = setTimeout(() => {
      authorized(`${API_BASE_URL}${BASE_PATH}?${params}`, {}, "Could not load genres.")
        .then((data) => { if (!ignore) setList({ genres: data.genres || [], loading: false, error: null }); })
        .catch((error) => {
          if (ignore) return;
          if (error?.status === 403) setAccessDenied(true);
          setList({ genres: [], loading: false, error: communityErrorFrom(error, "Could not load genres.") });
        });
    }, 200);
    return () => { ignore = true; clearTimeout(timer); };
  }, [authorized, query, status, refresh]);

  useEffect(() => {
    if (!genreId) return undefined;
    let ignore = false;
    authorized(`${API_BASE_URL}${BASE_PATH}/${encodeURIComponent(genreId)}`, {}, "Could not load this genre.")
      .then((data) => { if (!ignore) setDetail({ data, loading: false, error: null }); })
      .catch((error) => { if (!ignore) setDetail({ data: null, loading: false, error: communityErrorFrom(error, "Could not load this genre.") }); });
    return () => { ignore = true; };
  }, [authorized, genreId, refresh]);

  async function run(path, body) {
    setCommand({ busy: true, error: null, message: "" });
    try {
      await authorized(`${API_BASE_URL}${BASE_PATH}/${encodeURIComponent(genreId)}/${path}`, { method: "POST", body: JSON.stringify(body) }, "Could not apply this change.");
      setCommand({ busy: false, error: null, message: "Saved." });
    } catch (error) {
      const parsed = communityErrorFrom(error, "Could not apply this change.");
      setCommand({
        busy: false,
        error: parsed?.code === "GENRE_REVISION_CONFLICT" ? { ...parsed, message: "Someone changed this genre meanwhile. It has been reloaded; try again." } : parsed,
        message: "",
      });
    }
    setRefresh((value) => value + 1);
  }

  if (accessDenied) {
    return (
      <section className="community-page">
        <div className="community-empty-state" role="alert">
          <p className="community-eyebrow">Restricted desk · 403</p>
          <h1>Moderator access required.</h1>
        </div>
      </section>
    );
  }

  const genre = genreId && detail.data?.genre?.genreId === genreId ? detail.data.genre : null;

  return (
    <section className="community-page genre-vocab-page">
      <header className="community-page-header">
        <div>
          <p className="community-page-kicker">Catalog vocabulary · moderator desk</p>
          <h1 className="community-page-title">Genres</h1>
          <p className="community-page-description">
            Rename genres, add alternative names, move them under a broader genre, or retire them. Every change is
            recorded. Merging two genres rewrites albums, so it uses the reviewed <code>genres:merge</code> command instead.
          </p>
        </div>
        <div className="mapping-header-actions">
          <Link className="community-secondary-button" to="/moderation/album-suggestions">Suggestion queue</Link>
        </div>
      </header>

      <div className="genre-vocab-workspace">
        <aside className="community-panel genre-vocab-list" aria-label="Genres">
          <div className="genre-vocab-filters">
            <input aria-label="Search genres" onChange={(event) => setQuery(event.target.value)} placeholder="Search names and aliases" type="search" value={query} />
            <select aria-label="Status" onChange={(event) => setStatus(event.target.value)} value={status}>
              {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <ErrorMessage error={list.error} />
          {list.loading ? <p className="genre-form-muted" role="status">Loading genres…</p> : null}
          <ul className="genre-vocab-rows">
            {list.genres.map((row) => (
              <li key={row.genreId}>
                <button
                  aria-current={row.genreId === genreId ? "true" : undefined}
                  className={`genre-vocab-row${row.genreId === genreId ? " genre-vocab-row-active" : ""}`}
                  onClick={() => { setCommand({ busy: false, error: null, message: "" }); navigate(`${BASE_PATH}/${row.genreId}`); }}
                  type="button"
                >
                  <strong>{row.name}</strong>
                  <span>{[row.parent?.name, `${row.albumCount} album${row.albumCount === 1 ? "" : "s"}`, row.status === "retired" ? "retired" : ""].filter(Boolean).join(" · ")}</span>
                </button>
              </li>
            ))}
          </ul>
          {!list.loading && !list.genres.length && !list.error ? <p className="genre-form-muted">No genres match.</p> : null}
        </aside>

        <div className="community-panel genre-vocab-detail">
          {!genreId ? <p className="genre-form-muted">Choose a genre to see its history and change it.</p> : null}
          <ErrorMessage error={detail.error} />
          {genre ? (
            <>
              <div className="genre-vocab-heading">
                <h2>{genre.name}</h2>
                <span className={`community-status community-status-${genre.status === "active" ? "approved" : "rejected"}`}>{genre.status}</span>
              </div>
              <dl className="genre-vocab-facts">
                <div><dt>Slug</dt><dd><code>{genre.slug}</code></dd></div>
                <div><dt>Broader genre</dt><dd>{genre.parent ? genre.parent.name : "None (top-level)"}</dd></div>
                <div><dt>Alternative names</dt><dd>{genre.aliases.length ? genre.aliases.join(", ") : "None"}</dd></div>
                <div><dt>Albums</dt><dd>{genre.albumCount}</dd></div>
                <div><dt>Sub-genres</dt><dd>{genre.childCount}</dd></div>
                <div><dt>Revision</dt><dd>{genre.revision}</dd></div>
              </dl>

              <div aria-live="polite">
                <ErrorMessage error={command.error} />
                {command.message ? <p className="community-message community-message-success" role="status">{command.message}</p> : null}
              </div>

              {genre.status === "active" ? (
                <div className="genre-vocab-commands" key={`${genre.genreId}:${genre.revision}`}>
                  <CommandForm action="rename" busy={command.busy} field="name" genre={genre} label="Rename" onRun={run} parents={parents} />
                  <CommandForm action="aliases" busy={command.busy} field="name" genre={genre} label="Add alternative name" onRun={run} parents={parents} />
                  <CommandForm action="parent" busy={command.busy} field="parent" genre={genre} label="Change broader genre" onRun={run} parents={parents} />
                  <CommandForm action="retire" busy={command.busy} genre={genre} label="Retire" onRun={run} parents={parents} requireReason />
                </div>
              ) : (
                <div className="genre-vocab-commands" key={`${genre.genreId}:${genre.revision}`}>
                  <CommandForm action="restore" busy={command.busy} genre={genre} label="Restore" onRun={run} parents={parents} />
                </div>
              )}

              <h3 className="genre-form-title">History</h3>
              <ol className="genre-vocab-events">
                {(detail.data.events || []).map((event, index) => (
                  <li key={`${event.createdAt}-${index}`}>
                    <strong>{EVENT_LABELS[event.action] || event.action}</strong>
                    {describeEvent(event) ? <span> {describeEvent(event)}</span> : null}
                    <small>{formatCommunityDate(event.createdAt)} · {event.actorUserId}{event.reason ? ` · ${event.reason}` : ""}</small>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export default GenreVocabulary;
