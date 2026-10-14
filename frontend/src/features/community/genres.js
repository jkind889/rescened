import { API_BASE_URL } from "../../config/api";
import { requestCommunityJson } from "./community.js";

export const MAX_ALBUM_GENRES = 5;
export const MAX_NEW_GENRES = 2;
export const MAX_GENRE_NOTE_LENGTH = 500;
export const GENRE_NAME_PATTERN = /^[\p{L}\p{M}\p{N} &'\-/+.]{2,40}$/u;

export function existingKey(genre) {
  return `id:${genre.genreId}`;
}

export function newKey(name) {
  return `new:${String(name || "").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function cleanGenreName(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function isValidGenreName(value) {
  return GENRE_NAME_PATTERN.test(cleanGenreName(value));
}

export function fetchTopLevelGenres(signal) {
  return requestCommunityJson(`${API_BASE_URL}/genres`, { signal }, "Could not load genres.")
    .then((data) => (Array.isArray(data?.results) ? data.results : []));
}

export function searchGenres(query, signal) {
  return requestCommunityJson(
    `${API_BASE_URL}/genres/search?q=${encodeURIComponent(query)}`,
    { signal },
    "Could not search genres.",
  ).then((data) => (Array.isArray(data?.results) ? data.results : []));
}

// Form state for a contributor's suggestion. `initialChanges` is a stored
// suggestion's genreChanges ({ add, remove, primary, note }) when revising.
export function initialGenreForm(currentGenres, initialChanges = null) {
  const onAlbum = new Set(currentGenres.map((genre) => genre.genreId));
  const additions = (initialChanges?.add || []).map((entry) => (entry.genre
    ? { key: existingKey(entry.genre), genre: entry.genre }
    : { key: newKey(entry.newGenre.name), newGenre: { name: entry.newGenre.name, parentGenreId: entry.newGenre.parent?.genreId || "" } }))
    .filter((entry) => !entry.genre || !onAlbum.has(entry.genre.genreId));
  const removed = (initialChanges?.remove || []).map((genre) => genre.genreId).filter((genreId) => onAlbum.has(genreId));
  let primaryKey = null;
  const primary = initialChanges?.primary;
  if (primary?.genre) primaryKey = existingKey(primary.genre);
  else if (Number.isInteger(primary?.addIndex)) {
    const entry = initialChanges.add[primary.addIndex];
    if (entry) primaryKey = entry.genre ? existingKey(entry.genre) : newKey(entry.newGenre.name);
  }
  return { additions, removed, primaryKey, note: initialChanges?.note || "" };
}

// The album's genres if this suggestion were approved as written, primary first.
export function previewGenreList(currentGenres, form) {
  const kept = currentGenres
    .filter((genre) => !form.removed.includes(genre.genreId))
    .map((genre) => ({ key: existingKey(genre), name: genre.name, isNew: false }));
  const added = form.additions.map((entry) => ({ key: entry.key, name: entry.genre ? entry.genre.name : entry.newGenre.name, isNew: !entry.genre }));
  const list = [...kept, ...added];
  const primaryIndex = form.primaryKey ? list.findIndex((item) => item.key === form.primaryKey) : -1;
  if (primaryIndex > 0) list.unshift(...list.splice(primaryIndex, 1));
  return list;
}

export function buildGenreSuggestionPayload(albumId, currentGenres, form) {
  const add = form.additions.map((entry) => (entry.genre
    ? { genreId: entry.genre.genreId }
    : { newGenre: { name: cleanGenreName(entry.newGenre.name), ...(entry.newGenre.parentGenreId ? { parentGenreId: entry.newGenre.parentGenreId } : {}) } }));
  const payload = { albumId, add, remove: [...form.removed] };
  const currentPrimaryKey = currentGenres[0] ? existingKey(currentGenres[0]) : null;
  if (form.primaryKey && form.primaryKey !== currentPrimaryKey) {
    const index = form.additions.findIndex((entry) => entry.key === form.primaryKey);
    if (index >= 0) add[index].primary = true;
    else payload.primaryGenreId = form.primaryKey.slice(3);
  }
  const note = form.note.trim();
  if (note) payload.note = note;
  return payload;
}

export function genreSuggestionHasChanges(payload) {
  return payload.add.length > 0 || payload.remove.length > 0 || Boolean(payload.primaryGenreId);
}

// Moderator decisions, one per proposed operation. A new name defaults to
// mapping onto a near-identical existing genre, otherwise to creating it.
export function initialGenreDecisions(changes, candidates = []) {
  return {
    add: (changes?.add || []).map((entry, index) => {
      if (entry.genre) return { decision: "apply" };
      const closest = (candidates[index] || []).find((candidate) => ["exact", "spelling"].includes(candidate.match));
      return {
        decision: "apply",
        action: closest ? "map" : "create",
        name: entry.newGenre.name,
        parentGenreId: entry.newGenre.parent?.genreId || "",
        mapGenre: closest || null,
        addAlias: Boolean(closest),
      };
    }),
    remove: (changes?.remove || []).map(() => ({ decision: "apply" })),
    primary: changes?.primary ? "apply" : null,
  };
}

export function buildGenreDecisionsBody(changes, decisions) {
  const body = {
    add: decisions.add.map((entry, index) => {
      if (entry.decision === "skip" || changes.add[index].genre) return { decision: entry.decision };
      const resolution = entry.action === "map"
        ? { action: "map", genreId: entry.mapGenre?.genreId, addAlias: entry.addAlias }
        : { action: "create", name: cleanGenreName(entry.name), parentGenreId: entry.parentGenreId || null };
      return { decision: "apply", resolution };
    }),
    remove: decisions.remove.map((entry) => ({ decision: entry.decision })),
  };
  if (decisions.primary) body.primary = decisions.primary;
  return body;
}

// The album's genres if the moderator approves with these decisions,
// applied to its current genres the way the server does it.
export function previewApproval(currentGenres, changes, decisions) {
  const removedIds = new Set((changes?.remove || [])
    .filter((genre, index) => decisions.remove[index]?.decision === "apply")
    .map((genre) => genre.genreId));
  const list = currentGenres
    .filter((genre) => !removedIds.has(genre.genreId))
    .map((genre) => ({ key: existingKey(genre), name: genre.name, change: "kept" }));
  const addedKeys = [];
  (changes?.add || []).forEach((entry, index) => {
    const choice = decisions.add[index];
    if (!choice || choice.decision !== "apply") {
      addedKeys.push(null);
      return;
    }
    let item;
    if (entry.genre) item = { key: existingKey(entry.genre), name: entry.genre.name, change: "added" };
    else if (choice.action === "map" && choice.mapGenre) item = { key: existingKey(choice.mapGenre), name: choice.mapGenre.name, change: "added" };
    else item = { key: newKey(choice.name), name: cleanGenreName(choice.name), change: "created" };
    addedKeys.push(item.key);
    if (!list.some((existing) => existing.key === item.key)) list.push(item);
  });
  if (changes?.primary && decisions.primary === "apply") {
    const key = changes.primary.genre ? existingKey(changes.primary.genre) : addedKeys[changes.primary.addIndex];
    const index = key ? list.findIndex((item) => item.key === key) : -1;
    if (index > 0) list.unshift(...list.splice(index, 1));
  }
  return list;
}

export function describeGenreApplication(application) {
  if (!application) return "";
  const parts = [];
  const applied = (application.add || []).filter((entry) => entry.decision === "applied").map((entry) => entry.genre?.name).filter(Boolean);
  const removed = (application.remove || []).filter((entry) => entry.decision === "applied").map((entry) => entry.genre?.name).filter(Boolean);
  if (applied.length) parts.push(`Added ${applied.join(", ")}`);
  if (removed.length) parts.push(`removed ${removed.join(", ")}`);
  if ((application.createdGenres || []).length) parts.push(`created ${application.createdGenres.map((genre) => genre.name).join(", ")}`);
  if (application.primary === "applied") parts.push("changed the primary genre");
  return parts.length ? `${parts.join("; ")}.` : "No change to the album's genres was needed.";
}

const GENRE_ERROR_MESSAGES = {
  GENRE_SUGGESTION_EXISTS: "You already have an open genre suggestion for this album. Withdraw it, or revise it once a moderator asks for changes.",
  GENRE_PROPOSAL_LIMIT: "You have too many proposed genre names waiting for review. Wait for some to be reviewed, or use existing genres.",
  GENRES_DISABLED: "Genre suggestions aren't available right now.",
};

// The server's message, with clearer wording for a few genre-specific codes.
export function communityGenreError(error) {
  if (!error) return null;
  const message = GENRE_ERROR_MESSAGES[error.code];
  return message ? { ...error, message } : error;
}
