// Contributor genre suggestions: validate a request against the vocabulary
// and the album's current genres, and build the stored, server-owned value.
// Moderator approval (applying the operations) is a separate step.

const crypto = require("node:crypto");
const { Genre } = require("../../models/Genre");
const AlbumSubmission = require("../../models/AlbumSubmission");
const { SubmissionValidationError } = require("../../routes/utils/submissions");
const { MAX_ALBUM_GENRES, isGenreId, validateGenreName } = require("./vocabulary");

const BODY_KEYS = new Set(["albumId", "add", "remove", "primaryGenreId", "note"]);
const ADD_KEYS = new Set(["genreId", "newGenre", "primary"]);
const NEW_GENRE_KEYS = new Set(["name", "parentGenreId"]);
const MAX_NEW_GENRES = 2;
const MAX_OPEN_NEW_GENRES = 10;
const MAX_NOTE_LENGTH = 500;
const OPEN_STATUSES = ["pending", "needs_changes"];

function fail(message, code) {
  const error = new SubmissionValidationError(message);
  if (code) error.code = code;
  throw error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
}

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function genreRef(genre) {
  return { genreId: genre.genreId, slug: genre.slug, name: genre.name };
}

function requireGenreId(value, path) {
  if (typeof value !== "string" || !isGenreId(value)) fail(`${path} must be a genre UUID`);
  return value.trim().toLowerCase();
}

function openGenreSuggestionKey(userId, album) {
  return `${userId}:${String(plain(album)._id)}`;
}

// Parses the request shape only. Nothing here reads the database.
function parseRequest(body) {
  if (!isRecord(body)) fail("request body must be an object");
  assertKeys(body, BODY_KEYS, "request body");

  const add = body.add === undefined ? [] : body.add;
  if (!Array.isArray(add) || add.length > MAX_ALBUM_GENRES) fail(`add must be an array of at most ${MAX_ALBUM_GENRES} entries`);
  const additions = add.map((entry, index) => {
    const path = `add[${index}]`;
    if (!isRecord(entry)) fail(`${path} must be an object`);
    assertKeys(entry, ADD_KEYS, path);
    if ((entry.genreId === undefined) === (entry.newGenre === undefined)) fail(`${path} needs exactly one of genreId or newGenre`);
    if (entry.primary !== undefined && typeof entry.primary !== "boolean") fail(`${path}.primary must be a boolean`);
    const primary = entry.primary === true;
    if (entry.genreId !== undefined) return { path, genreId: requireGenreId(entry.genreId, `${path}.genreId`), primary };
    if (!isRecord(entry.newGenre)) fail(`${path}.newGenre must be an object`);
    assertKeys(entry.newGenre, NEW_GENRE_KEYS, `${path}.newGenre`);
    if (typeof entry.newGenre.name !== "string") fail(`${path}.newGenre.name must be a string`);
    let identity;
    try {
      identity = validateGenreName(entry.newGenre.name);
    } catch (error) {
      fail(`${path}.newGenre.name: ${error.message}`);
    }
    const parentGenreId = entry.newGenre.parentGenreId === undefined || entry.newGenre.parentGenreId === null
      ? null
      : requireGenreId(entry.newGenre.parentGenreId, `${path}.newGenre.parentGenreId`);
    return { path, newGenre: { ...identity, parentGenreId }, primary };
  });

  const remove = body.remove === undefined ? [] : body.remove;
  if (!Array.isArray(remove) || remove.length > MAX_ALBUM_GENRES) fail(`remove must be an array of at most ${MAX_ALBUM_GENRES} genre IDs`);
  const removals = remove.map((value, index) => requireGenreId(value, `remove[${index}]`));
  if (new Set(removals).size !== removals.length) fail("remove lists a genre more than once");

  const primaryGenreId = body.primaryGenreId === undefined || body.primaryGenreId === null
    ? null
    : requireGenreId(body.primaryGenreId, "primaryGenreId");
  if (primaryGenreId && additions.some((entry) => entry.primary)) fail("Use primaryGenreId or add[].primary, not both");
  if (additions.filter((entry) => entry.primary).length > 1) fail("Only one addition can be primary");

  if (body.note !== undefined && typeof body.note !== "string") fail("note must be a string");
  const note = String(body.note || "").normalize("NFC").trim();
  if (note.length > MAX_NOTE_LENGTH) fail(`note must be ${MAX_NOTE_LENGTH} characters or fewer`);

  return { albumId: body.albumId, additions, removals, primaryGenreId, note };
}

// Builds the stored genre suggestion for `album`. Throws
// SubmissionValidationError (400) for anything the contributor must fix.
async function normalizeGenreSuggestion(body, album, { GenreModel = Genre } = {}) {
  const request = parseRequest(body);
  const target = plain(album);
  if (typeof request.albumId !== "string" || request.albumId.trim().toLowerCase() !== target.albumId) {
    fail("albumId does not match the target catalog album");
  }

  const currentIds = (target.genres || []).map(String);
  const newKeys = request.additions.filter((entry) => entry.newGenre).map((entry) => entry.newGenre.normalizedName);
  const referencedIds = [
    ...request.additions.filter((entry) => entry.genreId).map((entry) => entry.genreId),
    ...request.additions.filter((entry) => entry.newGenre?.parentGenreId).map((entry) => entry.newGenre.parentGenreId),
    ...request.removals,
    ...(request.primaryGenreId ? [request.primaryGenreId] : []),
  ];
  const [current, referenced, matches] = await Promise.all([
    currentIds.length ? GenreModel.find({ _id: { $in: currentIds } }).lean() : [],
    referencedIds.length ? GenreModel.find({ genreId: { $in: [...new Set(referencedIds)] } }).lean() : [],
    newKeys.length ? GenreModel.find({ $or: [{ normalizedName: { $in: newKeys } }, { "aliases.normalizedName": { $in: newKeys } }] }).lean() : [],
  ]);
  const currentById = new Map(current.map((genre) => [String(genre._id), genre]));
  // The album's genres in stored order; a reference to a deleted genre is skipped.
  const currentGenres = currentIds.map((id) => currentById.get(id)).filter(Boolean);
  const onAlbum = new Set(currentGenres.map((genre) => genre.genreId));
  const byGenreId = new Map([...referenced, ...currentGenres].map((genre) => [genre.genreId, genre]));

  const activeGenre = (genreId, path) => {
    const genre = byGenreId.get(genreId);
    if (!genre) fail(`${path} does not match a genre`);
    if (genre.status !== "active") fail(`${path} names the retired genre "${genre.name}"`, "GENRE_RETIRED");
    return genre;
  };

  // A proposed name that already exists becomes a reference to that genre.
  const resolvedNewGenres = [];
  const additions = request.additions.map((entry) => {
    if (entry.genreId) return { genre: activeGenre(entry.genreId, `${entry.path}.genreId`), primary: entry.primary };
    const { newGenre } = entry;
    const existing = matches.find((genre) => genre.normalizedName === newGenre.normalizedName)
      || matches.find((genre) => (genre.aliases || []).some((alias) => alias.normalizedName === newGenre.normalizedName));
    if (existing) {
      if (existing.status !== "active") fail(`${entry.path}.newGenre.name matches the retired genre "${existing.name}"`, "GENRE_RETIRED");
      resolvedNewGenres.push({ name: newGenre.name, matchedBy: existing.normalizedName === newGenre.normalizedName ? "name" : "alias", genre: genreRef(existing) });
      return { genre: existing, primary: entry.primary };
    }
    let parent = null;
    if (newGenre.parentGenreId) {
      parent = activeGenre(newGenre.parentGenreId, `${entry.path}.newGenre.parentGenreId`);
      if (parent.parent) fail(`${entry.path}.newGenre.parentGenreId must be a top-level genre`);
    }
    return { newGenre: { name: newGenre.name, normalizedName: newGenre.normalizedName, slug: newGenre.slug, parent }, primary: entry.primary };
  });

  if (additions.filter((entry) => entry.newGenre).length > MAX_NEW_GENRES) {
    fail(`A suggestion can propose at most ${MAX_NEW_GENRES} new genres`);
  }
  const addedKeys = new Set();
  additions.forEach((entry, index) => {
    const key = entry.genre ? `id:${entry.genre.genreId}` : `new:${entry.newGenre.normalizedName}`;
    if (addedKeys.has(key)) fail(`add[${index}] repeats another addition`);
    addedKeys.add(key);
    if (entry.genre && onAlbum.has(entry.genre.genreId)) fail(`add[${index}]: "${entry.genre.name}" is already on this album`);
    if (entry.genre && request.removals.includes(entry.genre.genreId)) fail(`add[${index}]: "${entry.genre.name}" is also in remove`);
  });

  // Removals may name a retired genre, so contributors can clean one off.
  const removals = request.removals.map((genreId, index) => {
    if (!onAlbum.has(genreId)) fail(`remove[${index}] is not one of this album's genres`);
    return byGenreId.get(genreId);
  });

  const resultCount = currentGenres.length - removals.length + additions.length;
  if (resultCount > MAX_ALBUM_GENRES) {
    // A state conflict (409), as at approval: the album already has genres.
    const error = new Error(`An album can have at most ${MAX_ALBUM_GENRES} genres; this would leave ${resultCount}`);
    error.status = 409;
    error.code = "GENRE_LIMIT_EXCEEDED";
    throw error;
  }

  let primary = null;
  const primaryAddIndex = additions.findIndex((entry) => entry.primary);
  if (primaryAddIndex !== -1) {
    primary = { genre: null, addIndex: primaryAddIndex };
  } else if (request.primaryGenreId) {
    const addIndex = additions.findIndex((entry) => entry.genre?.genreId === request.primaryGenreId);
    if (addIndex !== -1) {
      primary = { genre: null, addIndex };
    } else {
      const genre = activeGenre(request.primaryGenreId, "primaryGenreId");
      if (!onAlbum.has(genre.genreId) || request.removals.includes(genre.genreId)) {
        fail("primaryGenreId must be a genre the album keeps or gains");
      }
      // Promoting the genre that is already primary changes nothing.
      if (currentGenres[0]?.genreId !== genre.genreId) primary = { genre: genreRef(genre), addIndex: null };
    }
  }

  if (!additions.length && !removals.length && !primary) fail("The suggestion does not change this album's genres");

  const genreChanges = {
    additions: additions.map((entry) => (entry.genre
      ? { genre: genreRef(entry.genre), newGenre: null }
      : { genre: null, newGenre: { ...entry.newGenre, parent: entry.newGenre.parent ? genreRef(entry.newGenre.parent) : null } })),
    removals: removals.map(genreRef),
    primary,
    note: request.note,
  };
  const genreBaseline = {
    genres: currentGenres.map(genreRef),
    genresRevision: Number.isInteger(target.genresRevision) ? target.genresRevision : 0,
  };
  return {
    albumId: target.albumId,
    targetAlbumCatalogId: target._id,
    genreBaseline,
    genreChanges,
    resolvedNewGenres,
    normalizedFingerprint: crypto.createHash("sha256").update(JSON.stringify({
      type: "genre_suggestion",
      albumId: target.albumId,
      baseline: genreBaseline,
      additions: genreChanges.additions,
      removals: genreChanges.removals,
      primary,
    })).digest("hex"),
  };
}

function newGenreCount(changes) {
  return (plain(changes)?.additions || []).filter((entry) => entry.newGenre).length;
}

// New genre names a user has waiting across open suggestions, optionally
// leaving out the suggestion being revised.
async function openNewGenreCount(userId, { excludeSubmissionId = null } = {}) {
  const query = { submittedByUserId: userId, submissionType: "genre_suggestion", status: { $in: OPEN_STATUSES } };
  if (excludeSubmissionId) query._id = { $ne: excludeSubmissionId };
  const rows = await AlbumSubmission.find(query).select("genreChanges").lean();
  return rows.reduce((total, row) => total + newGenreCount(row.genreChanges), 0);
}

async function assertNewGenreAllowance(userId, payload, options) {
  const proposed = newGenreCount(payload.genreChanges);
  if (!proposed) return;
  const open = await openNewGenreCount(userId, options);
  if (open + proposed > MAX_OPEN_NEW_GENRES) {
    const error = new Error(`You can have at most ${MAX_OPEN_NEW_GENRES} proposed genre names waiting for review; ${open} are open`);
    error.status = 409;
    error.code = "GENRE_PROPOSAL_LIMIT";
    throw error;
  }
}

function genreSuggestionFields(payload, revision, status) {
  return {
    submissionType: "genre_suggestion",
    targetAlbumCatalogId: payload.targetAlbumCatalogId,
    genreBaseline: payload.genreBaseline,
    genreChanges: payload.genreChanges,
    supportingSources: [],
    externalReferences: [],
    normalizedFingerprint: payload.normalizedFingerprint,
    candidateAlbumCatalogId: null,
    candidateSubmissionIds: [],
    duplicateSignals: [],
    currentRevision: revision,
    status,
  };
}

function genreSuggestionSnapshot(payload, submittedAt, revision) {
  return {
    revision,
    submittedAt,
    submissionType: "genre_suggestion",
    supportingSources: [],
    externalReferences: [],
    normalizedFingerprint: payload.normalizedFingerprint,
    candidateAlbumCatalogId: null,
    candidateSubmissionIds: [],
    duplicateSignals: [],
    targetAlbumCatalogId: payload.targetAlbumCatalogId,
    genreBaseline: payload.genreBaseline,
    genreChanges: payload.genreChanges,
  };
}

module.exports = {
  MAX_NEW_GENRES,
  MAX_NOTE_LENGTH,
  MAX_OPEN_NEW_GENRES,
  OPEN_STATUSES,
  assertNewGenreAllowance,
  genreSuggestionFields,
  genreSuggestionSnapshot,
  normalizeGenreSuggestion,
  openGenreSuggestionKey,
  parseRequest,
};
