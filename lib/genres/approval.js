// Moderator approval of genre suggestions. The moderator decides each proposed
// operation; approval applies the accepted ones to the album's current genres
// in one transaction, together with any new vocabulary entries and the audit
// event. Operations apply to the current state rather than the contributor's
// baseline, so an approval never fails just because the album changed since
// the suggestion was made.

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const AlbumSubmission = require("../../models/AlbumSubmission");
const { Genre, GenreEvent } = require("../../models/Genre");
const { normalizeCatalogAlbum } = require("../../routes/utils/albumCatalog");
const { serializeSubmission } = require("../../routes/utils/submissions");
const {
  ApprovalUnavailableError,
  ModerationConflictError,
  ModerationValidationError,
  isTransactionUnavailable,
} = require("../../routes/utils/moderation");
const { MAX_ALBUM_GENRES, isGenreId, validateGenreName } = require("./vocabulary");
const { resolveAlbumGenres } = require("./read");
const { nameOwner, publicOwner } = require("./names");
const { genreProvenanceSet } = require("./provenance");

const DEFAULT_APPROVAL_REASON = "Genre suggestion approved.";
const ADD_DECISION_KEYS = new Set(["decision", "resolution"]);
const CREATE_KEYS = new Set(["action", "name", "parentGenreId"]);
const MAP_KEYS = new Set(["action", "genreId", "addAlias"]);

function fail(message) {
  throw new ModerationValidationError(message);
}

function conflict(message, code, details) {
  throw new ModerationConflictError(message, code, details);
}

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
}

function genreRef(genre) {
  return { genreId: genre.genreId, slug: genre.slug, name: genre.name };
}

function decision(value, path) {
  if (value !== "apply" && value !== "skip") fail(`${path} must be "apply" or "skip"`);
  return value;
}

// Checks the moderator's decisions against the stored suggestion: one
// decision per proposed operation, resolutions only for new genre names, and
// at least one accepted operation.
function normalizeGenreDecisions(input, changes) {
  const stored = plain(changes) || {};
  const additions = stored.additions || [];
  const removals = stored.removals || [];
  if (!isRecord(input)) fail("genreDecisions must be an object");
  assertKeys(input, new Set(["add", "remove", "primary"]), "genreDecisions");

  const addInput = input.add === undefined ? [] : input.add;
  if (!Array.isArray(addInput) || addInput.length !== additions.length) {
    fail(`genreDecisions.add must have one decision for each of the ${additions.length} proposed additions`);
  }
  const add = addInput.map((entry, index) => {
    const path = `genreDecisions.add[${index}]`;
    if (!isRecord(entry)) fail(`${path} must be an object`);
    assertKeys(entry, ADD_DECISION_KEYS, path);
    const value = decision(entry.decision, `${path}.decision`);
    const proposed = additions[index];
    if (proposed.genre || value === "skip") {
      if (entry.resolution !== undefined) fail(`${path}.resolution is only used to apply a new genre name`);
      return { decision: value, resolution: null };
    }
    const resolution = entry.resolution;
    if (!isRecord(resolution)) fail(`${path}.resolution is required to apply a new genre name`);
    if (resolution.action === "create") {
      assertKeys(resolution, CREATE_KEYS, `${path}.resolution`);
      let identity;
      try {
        identity = validateGenreName(resolution.name === undefined ? proposed.newGenre.name : resolution.name);
      } catch (error) {
        fail(`${path}.resolution.name: ${error.message}`);
      }
      let parentGenreId;
      if (resolution.parentGenreId === undefined) parentGenreId = proposed.newGenre.parent?.genreId || null;
      else if (resolution.parentGenreId === null) parentGenreId = null;
      else if (typeof resolution.parentGenreId === "string" && isGenreId(resolution.parentGenreId)) parentGenreId = resolution.parentGenreId.trim().toLowerCase();
      else fail(`${path}.resolution.parentGenreId must be a genre UUID or null`);
      return { decision: value, resolution: { action: "create", ...identity, parentGenreId } };
    }
    if (resolution.action === "map") {
      assertKeys(resolution, MAP_KEYS, `${path}.resolution`);
      if (typeof resolution.genreId !== "string" || !isGenreId(resolution.genreId)) fail(`${path}.resolution.genreId must be a genre UUID`);
      if (resolution.addAlias !== undefined && typeof resolution.addAlias !== "boolean") fail(`${path}.resolution.addAlias must be a boolean`);
      return { decision: value, resolution: { action: "map", genreId: resolution.genreId.trim().toLowerCase(), addAlias: resolution.addAlias === true } };
    }
    return fail(`${path}.resolution.action must be "create" or "map"`);
  });

  const removeInput = input.remove === undefined ? [] : input.remove;
  if (!Array.isArray(removeInput) || removeInput.length !== removals.length) {
    fail(`genreDecisions.remove must have one decision for each of the ${removals.length} proposed removals`);
  }
  const remove = removeInput.map((entry, index) => {
    const path = `genreDecisions.remove[${index}]`;
    if (!isRecord(entry)) fail(`${path} must be an object`);
    assertKeys(entry, new Set(["decision"]), path);
    return { decision: decision(entry.decision, `${path}.decision`) };
  });

  let primary = null;
  if (stored.primary) {
    primary = decision(input.primary, "genreDecisions.primary");
    if (primary === "apply" && Number.isInteger(stored.primary.addIndex) && add[stored.primary.addIndex]?.decision !== "apply") {
      fail("genreDecisions.primary can't be applied when its addition is skipped");
    }
  } else if (input.primary !== undefined) {
    fail("genreDecisions.primary is only used when the suggestion sets a primary genre");
  }

  if (![...add, ...remove].some((entry) => entry.decision === "apply") && primary !== "apply") {
    fail("Approve at least one operation, or reject or request changes instead");
  }
  return { add, remove, primary };
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

function nameConflict(name, owner) {
  conflict(`"${name}" is already used by the genre "${owner.name}"`, "GENRE_NAME_CONFLICT", [publicOwner(owner)]);
}

async function activeGenre(genreId, session, label) {
  const genre = await withSession(Genre.findOne({ genreId }), session).lean();
  if (!genre) conflict(`${label} no longer exists`, "GENRE_NOT_FOUND");
  if (genre.status !== "active") conflict(`${label} "${genre.name}" has been retired`, "GENRE_RETIRED");
  return genre;
}

async function createGenre({ resolution, submission, actorUserId, session, createdKeys }) {
  if (createdKeys.has(resolution.normalizedName)) {
    conflict(`"${resolution.name}" is created twice by this approval`, "GENRE_NAME_CONFLICT");
  }
  const owner = await nameOwner(resolution, { session });
  if (owner) nameConflict(resolution.name, owner);
  let parent = null;
  if (resolution.parentGenreId) {
    parent = await activeGenre(resolution.parentGenreId, session, "The parent genre");
    if (parent.parent) fail(`The parent genre "${parent.name}" is not top-level`);
  }
  const [genre] = await Genre.create([{
    genreId: crypto.randomUUID(),
    slug: resolution.slug,
    name: resolution.name,
    normalizedName: resolution.normalizedName,
    aliases: [],
    parent: parent?._id || null,
    status: "active",
    kind: "genre",
    origin: { source: "community", datasetId: null, submissionId: submission.submissionId },
  }], { session });
  await GenreEvent.create([{
    genre: genre._id,
    genreId: genre.genreId,
    action: "create",
    actorUserId,
    reason: `Created from genre suggestion ${submission.submissionId}`,
    after: { name: genre.name, slug: genre.slug, parent: parent ? genreRef(parent) : null },
    submissionId: submission.submissionId,
  }], { session });
  createdKeys.add(resolution.normalizedName);
  return plain(genre);
}

// Maps a proposed name onto an existing genre, optionally keeping the
// proposed spelling as an alias of it. Returns the genre and the alias added.
async function mapGenre({ resolution, proposed, submission, actorUserId, session }) {
  const genre = await activeGenre(resolution.genreId, session, "The mapped genre");
  if (!resolution.addAlias) return { genre, alias: null };
  const known = genre.normalizedName === proposed.normalizedName
    || (genre.aliases || []).some((alias) => alias.normalizedName === proposed.normalizedName);
  if (known) return { genre, alias: null };
  const owner = await nameOwner(proposed, { session, excludeId: genre._id });
  if (owner) nameConflict(proposed.name, owner);
  const alias = { name: proposed.name, normalizedName: proposed.normalizedName, slug: proposed.slug };
  const updated = await Genre.findOneAndUpdate(
    { _id: genre._id, status: "active", "aliases.normalizedName": { $ne: alias.normalizedName } },
    { $push: { aliases: alias }, $inc: { revision: 1 } },
    { returnDocument: "after", runValidators: true, session },
  ).lean();
  if (!updated) conflict(`The genre "${genre.name}" changed while it was being mapped`, "STATE_CONFLICT");
  await GenreEvent.create([{
    genre: genre._id,
    genreId: genre.genreId,
    action: "alias_add",
    actorUserId,
    reason: `Alias from genre suggestion ${submission.submissionId}`,
    before: { aliases: (genre.aliases || []).map((entry) => entry.name) },
    after: { aliases: updated.aliases.map((entry) => entry.name) },
    submissionId: submission.submissionId,
  }], { session });
  return { genre: updated, alias: alias.name };
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => String(id) === String(right[index]));
}

async function applyDecisions({ submission, album, decisions, actorUserId, session }) {
  const changes = submission.genreChanges;
  const genresRevision = Number.isInteger(album.genresRevision) ? album.genresRevision : 0;
  let ids = (album.genres || []).map(String);
  const application = {
    targetAlbumId: album.albumId,
    add: [],
    removals: [],
    primary: null,
    createdGenres: [],
    aliasesAdded: [],
    retiredRemoved: [],
    resultGenres: [],
    baseGenresRevision: genresRevision,
    resultGenresRevision: genresRevision,
  };

  // Removals first, so a suggestion that swaps genres fits under the cap.
  changes.removals.forEach((genre, index) => {
    if (decisions.remove[index].decision === "skip") {
      application.removals.push({ decision: "skipped", genre });
      return;
    }
    application.removals.push({ decision: "noop", genre });
  });
  const removalIds = await withSession(Genre.find({ genreId: { $in: changes.removals.map((genre) => genre.genreId) } }), session).lean();
  const removalIdByGenreId = new Map(removalIds.map((genre) => [genre.genreId, String(genre._id)]));
  application.removals.forEach((entry) => {
    if (entry.decision !== "noop") return;
    const id = removalIdByGenreId.get(entry.genre.genreId);
    if (id && ids.includes(id)) {
      ids = ids.filter((value) => value !== id);
      entry.decision = "applied";
    }
  });

  const createdKeys = new Set();
  const addedGenreIds = [];
  for (const [index, proposed] of changes.additions.entries()) {
    const choice = decisions.add[index];
    if (choice.decision === "skip") {
      application.add.push({ decision: "skipped", genre: proposed.genre || null, resolution: null });
      addedGenreIds.push(null);
      continue;
    }
    let genre;
    let resolution = "existing";
    if (proposed.genre) {
      genre = await activeGenre(proposed.genre.genreId, session, "The genre");
    } else if (choice.resolution.action === "create") {
      genre = await createGenre({ resolution: choice.resolution, submission, actorUserId, session, createdKeys });
      application.createdGenres.push(genreRef(genre));
      resolution = "created";
    } else {
      const mapped = await mapGenre({ resolution: choice.resolution, proposed: proposed.newGenre, submission, actorUserId, session });
      genre = mapped.genre;
      if (mapped.alias) application.aliasesAdded.push({ genre: genreRef(genre), alias: mapped.alias });
      resolution = "mapped";
    }
    const id = String(genre._id);
    const present = ids.includes(id);
    if (!present) ids.push(id);
    application.add.push({ decision: present ? "noop" : "applied", genre: genreRef(genre), resolution });
    addedGenreIds.push(id);
  }

  // Retired genres stay on the album until a merge remaps them, but albums
  // don't show them, so the cap and the primary consider active genres only.
  const statusRows = ids.length
    ? await withSession(Genre.find({ _id: { $in: ids } }).select("genreId slug name status"), session).lean()
    : [];
  const activeIds = new Set(statusRows.filter((genre) => genre.status === "active").map((genre) => String(genre._id)));

  if (changes.primary) {
    if (decisions.primary === "skip") {
      application.primary = "skipped";
    } else {
      let id = null;
      if (changes.primary.genre) {
        const genre = await withSession(Genre.findOne({ genreId: changes.primary.genre.genreId }), session).lean();
        if (genre && genre.status !== "active") conflict(`The primary genre "${genre.name}" has been retired`, "GENRE_RETIRED");
        id = genre ? String(genre._id) : null;
      } else {
        id = addedGenreIds[changes.primary.addIndex];
      }
      if (id && ids.includes(id) && ids.find((value) => activeIds.has(value)) !== id) {
        ids = [id, ...ids.filter((value) => value !== id)];
        application.primary = "applied";
      } else {
        application.primary = "noop";
      }
    }
  }

  const activeCount = ids.filter((id) => activeIds.has(id)).length;
  if (activeCount > MAX_ALBUM_GENRES) {
    conflict(`Approving these operations would give the album ${activeCount} genres; the limit is ${MAX_ALBUM_GENRES}. Skip some additions.`, "GENRE_LIMIT_EXCEEDED");
  }
  // The stored list holds at most MAX_ALBUM_GENRES entries in all, so retired
  // genres that no longer fit beside the active ones are dropped, last first.
  const rowById = new Map(statusRows.map((genre) => [String(genre._id), genre]));
  while (ids.length > MAX_ALBUM_GENRES) {
    const index = ids.findLastIndex((id) => !activeIds.has(id));
    const [dropped] = ids.splice(index, 1);
    if (rowById.has(dropped)) application.retiredRemoved.push(genreRef(rowById.get(dropped)));
  }

  let updatedAlbum = album;
  if (!sameIds(ids, (album.genres || []).map(String))) {
    const approvedAt = new Date();
    const provenance = {
      source: "community",
      submissionId: submission.submissionId,
      revision: submission.currentRevision,
      approvedByUserId: actorUserId,
      approvedAt,
    };
    updatedAlbum = await AlbumCatalog.findOneAndUpdate(
      { _id: album._id, albumId: album.albumId, genresRevision: genresRevision === 0 ? { $in: [null, 0] } : genresRevision },
      {
        $set: {
          genres: ids.map((id) => new mongoose.Types.ObjectId(id)),
          genresRevision: genresRevision + 1,
          ...genreProvenanceSet(album, provenance),
        },
      },
      { returnDocument: "after", runValidators: true, session },
    ).lean();
    if (!updatedAlbum) conflict("The album's genres changed while the suggestion was being approved", "GENRES_CHANGED");
    application.resultGenresRevision = genresRevision + 1;
  }
  const resultRows = ids.length ? await withSession(Genre.find({ _id: { $in: ids } }), session).lean() : [];
  const byId = new Map(resultRows.map((genre) => [String(genre._id), genre]));
  application.resultGenres = ids.map((id) => byId.get(id)).filter(Boolean).map(genreRef);
  return { application, album: updatedAlbum };
}

async function approvalResult({ submission, album, idempotent }) {
  return {
    suggestion: serializeSubmission(submission, { detail: true, moderator: true }),
    album: { ...normalizeCatalogAlbum(album), genres: await resolveAlbumGenres(album) },
    albumUrl: `/album/${plain(album).albumId}`,
    idempotent,
  };
}

async function approveGenreSuggestion({ preliminary, submissionId, actorUserId, genreDecisions, reason }) {
  if (preliminary.status === "approved") {
    const album = await AlbumCatalog.findById(preliminary.approvedAlbumCatalogId).lean();
    if (!album) conflict("Approved suggestion has no usable catalog album", "APPROVAL_INCONSISTENT");
    return approvalResult({ submission: { ...preliminary, approvedAlbumCatalogId: album, targetAlbumCatalogId: album }, album, idempotent: true });
  }
  if (preliminary.status !== "pending") conflict("Only pending suggestions can be approved", "INVALID_SUBMISSION_STATE");
  if (genreDecisions === undefined) fail("genreDecisions is required to approve a genre suggestion");
  // Validate before opening a transaction so a malformed body costs nothing.
  normalizeGenreDecisions(genreDecisions, preliminary.genreChanges);

  let session;
  let result = null;
  try {
    session = await mongoose.startSession();
    if (typeof session.withTransaction !== "function") throw new ApprovalUnavailableError();
    // withTransaction retries transient conflicts (such as a concurrent
    // approval on the same album) by re-running this callback against the
    // newly committed state, which the operation lists are designed for.
    await session.withTransaction(async () => {
      result = null;
      const current = await withSession(AlbumSubmission.findOne({ submissionId }), session).lean();
      if (!current) conflict("Suggestion not found", "SUGGESTION_NOT_FOUND");
      if (current.status === "approved") {
        const album = await withSession(AlbumCatalog.findById(current.approvedAlbumCatalogId), session).lean();
        if (!album) conflict("Approved suggestion has no usable catalog album", "APPROVAL_INCONSISTENT");
        result = { submission: { ...current, approvedAlbumCatalogId: album, targetAlbumCatalogId: album }, album, idempotent: true };
        return;
      }
      if (current.status !== "pending") conflict("Only pending suggestions can be approved", "INVALID_SUBMISSION_STATE");
      if (current.currentRevision !== preliminary.currentRevision) {
        conflict("The suggestion was revised while it was being approved", "STATE_CONFLICT");
      }
      const album = await withSession(AlbumCatalog.findById(current.targetAlbumCatalogId), session).lean();
      if (!album) conflict("The suggestion's album is missing", "CATALOG_TARGET_MISSING");

      const decisions = normalizeGenreDecisions(genreDecisions, current.genreChanges);
      const applied = await applyDecisions({ submission: current, album, decisions, actorUserId, session });
      const approvedAt = new Date();
      const updated = await AlbumSubmission.findOneAndUpdate(
        { _id: current._id, submissionId, status: "pending", currentRevision: current.currentRevision },
        {
          $set: {
            status: "approved",
            approvedAlbumCatalogId: album._id,
            duplicateOfSubmissionId: null,
            approvedAt,
            approvalPublicationType: "genres_updated",
          },
          $unset: { openGenreSuggestionKey: "" },
          $push: {
            moderationHistory: {
              actorUserId,
              action: "approved",
              reason: reason || DEFAULT_APPROVAL_REASON,
              createdAt: approvedAt,
              genreApplication: applied.application,
            },
          },
        },
        { returnDocument: "after", runValidators: true, session },
      ).lean();
      if (!updated) conflict("Suggestion changed while it was being approved", "STATE_CONFLICT");
      result = {
        submission: { ...updated, approvedAlbumCatalogId: applied.album, targetAlbumCatalogId: applied.album },
        album: applied.album,
        idempotent: false,
      };
    });
    if (!result) conflict("Approval did not produce a result", "APPROVAL_CONFLICT");
    return approvalResult(result);
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    if (isTransactionUnavailable(error)) throw new ApprovalUnavailableError();
    if (error?.code === 11000) conflict("A new genre's name or slug is already taken", "GENRE_NAME_CONFLICT");
    throw error;
  } finally {
    if (session) await session.endSession();
  }
}

module.exports = {
  DEFAULT_APPROVAL_REASON,
  approveGenreSuggestion,
  normalizeGenreDecisions,
};
