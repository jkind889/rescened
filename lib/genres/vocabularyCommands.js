// Moderator vocabulary commands: rename, add an alias, change the parent,
// retire, and restore. Each command checks the genre's revision, writes the
// genre, and appends one GenreEvent in a single transaction. None of them
// rewrites albums; merging one genre into another is the operator CLI's job.

const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { Genre, GenreEvent } = require("../../models/Genre");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");
const { genreMatchKey, isGenreId, validateGenreName } = require("./vocabulary");
const { nameOwner, publicOwner } = require("./names");

const ACTIONS = ["rename", "alias_add", "reparent", "retire", "restore"];
const DEFAULT_REASONS = {
  rename: "Genre renamed by a moderator.",
  alias_add: "Alias added by a moderator.",
  reparent: "Parent genre changed by a moderator.",
  restore: "Genre restored by a moderator.",
};
const MAX_REASON_LENGTH = 1000;
const MAX_LIST_QUERY_LENGTH = 40;
const EVENT_LIMIT = 50;

function commandError(message, status, code, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

const invalid = (message) => { throw commandError(message, 400, "INVALID_GENRE_COMMAND"); };
const conflict = (message, code, details) => { throw commandError(message, 409, code, details); };

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function genreRef(genre) {
  return genre ? { genreId: genre.genreId, slug: genre.slug, name: genre.name } : null;
}

function revisionOf(genre) {
  return Number.isInteger(genre.revision) ? genre.revision : 0;
}

function parseName(value, path) {
  if (typeof value !== "string") invalid(`${path} must be a string`);
  try {
    return validateGenreName(value);
  } catch (error) {
    return invalid(`${path}: ${error.message}`);
  }
}

// Validates a command body. Every command needs the genre's current
// `expectedRevision`; retiring also needs a reason.
function normalizeVocabularyCommand(action, body) {
  if (!ACTIONS.includes(action)) invalid("Unknown genre command");
  if (!isRecord(body)) invalid("request body must be an object");
  const allowed = new Set(["expectedRevision", "reason", ...({ rename: ["name"], alias_add: ["name"], reparent: ["parentGenreId"] }[action] || [])]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid(`request body.${key} is not allowed`);
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) invalid("expectedRevision must be a non-negative integer");
  if (body.reason !== undefined && typeof body.reason !== "string") invalid("reason must be a string");
  const reason = String(body.reason || "").trim();
  if (reason.length > MAX_REASON_LENGTH) invalid(`reason must be ${MAX_REASON_LENGTH} characters or fewer`);
  if (action === "retire" && !reason) invalid("reason is required to retire a genre");
  const command = { action, expectedRevision: body.expectedRevision, reason: reason || DEFAULT_REASONS[action] };
  if (action === "rename" || action === "alias_add") command.identity = parseName(body.name, "name");
  if (action === "reparent") {
    if (!Object.prototype.hasOwnProperty.call(body, "parentGenreId")) invalid("parentGenreId is required (null for top-level)");
    if (body.parentGenreId === null) command.parentGenreId = null;
    else if (typeof body.parentGenreId === "string" && isGenreId(body.parentGenreId)) command.parentGenreId = body.parentGenreId.trim().toLowerCase();
    else invalid("parentGenreId must be a genre UUID or null");
  }
  return command;
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

async function assertFreeName(identity, genre, session) {
  const owner = await nameOwner(identity, { session, excludeId: genre._id });
  if (owner) conflict(`"${identity.name}" is already used by the genre "${owner.name}"`, "GENRE_NAME_CONFLICT", [publicOwner(owner)]);
}

async function hasActiveChildren(genre, session) {
  return Boolean(await withSession(Genre.exists({ parent: genre._id, status: "active" }), session));
}

// Returns { set, before, after } for the command against the current genre.
async function planCommand(command, genre, session) {
  const active = genre.status === "active";
  if (command.action === "restore") {
    if (active) conflict(`"${genre.name}" is not retired`, "INVALID_GENRE_STATE");
    // A merge copies the source's names onto the target as aliases, so a
    // merged genre's names belong to the target now and it can't come back.
    for (const identity of [genre, ...(genre.aliases || [])]) {
      await assertFreeName(identity, genre, session);
    }
    // Restore re-checks what retire and reparent enforce: an active genre's
    // parent is active and top-level.
    if (genre.parent) {
      const parent = await withSession(Genre.findById(genre.parent), session).lean();
      if (!parent || parent.status !== "active") {
        conflict(`The parent genre${parent ? ` "${parent.name}"` : ""} is retired; restore it first`, "GENRE_RETIRED", parent ? [genreRef(parent)] : undefined);
      }
      if (parent.parent) conflict(`"${parent.name}" isn't top-level anymore; genres nest one level deep`, "GENRE_NOT_TOP_LEVEL");
    }
    return { set: { status: "active" }, before: { status: "retired" }, after: { status: "active" } };
  }
  if (!active) conflict(`"${genre.name}" is retired; restore it first`, "GENRE_RETIRED");

  if (command.action === "rename") {
    const { identity } = command;
    if (identity.name === genre.name) invalid("The new name is the same as the current name");
    await assertFreeName(identity, genre, session);
    // A spelling that was an alias becomes the name; the old name becomes an
    // alias (keeping its slug for redirects) unless only its case changed.
    const aliases = (genre.aliases || []).filter((alias) => alias.normalizedName !== identity.normalizedName);
    if (identity.normalizedName !== genre.normalizedName || identity.slug !== genre.slug) {
      aliases.push({ name: genre.name, normalizedName: genre.normalizedName, slug: genre.slug });
    }
    return {
      set: { name: identity.name, normalizedName: identity.normalizedName, slug: identity.slug, aliases },
      before: { name: genre.name, slug: genre.slug },
      after: { name: identity.name, slug: identity.slug },
    };
  }

  if (command.action === "alias_add") {
    const { identity } = command;
    const own = [genre.normalizedName, ...(genre.aliases || []).map((alias) => alias.normalizedName)];
    if (own.includes(identity.normalizedName)) invalid(`"${identity.name}" is already a name of this genre`);
    await assertFreeName(identity, genre, session);
    const aliases = [...(genre.aliases || []), { name: identity.name, normalizedName: identity.normalizedName, slug: identity.slug }];
    return {
      set: { aliases },
      before: { aliases: (genre.aliases || []).map((alias) => alias.name) },
      after: { aliases: aliases.map((alias) => alias.name) },
    };
  }

  if (command.action === "reparent") {
    const current = genre.parent ? await withSession(Genre.findById(genre.parent), session).lean() : null;
    if (command.parentGenreId === null) {
      if (!genre.parent) invalid(`"${genre.name}" is already top-level`);
      return { set: { parent: null }, before: { parent: genreRef(current) }, after: { parent: null } };
    }
    const parent = await withSession(Genre.findOne({ genreId: command.parentGenreId }), session).lean();
    if (!parent) conflict("The parent genre doesn't exist", "GENRE_NOT_FOUND");
    if (String(parent._id) === String(genre._id)) invalid("A genre can't be its own parent");
    if (parent.status !== "active") conflict(`The parent genre "${parent.name}" is retired`, "GENRE_RETIRED");
    if (parent.parent) conflict(`"${parent.name}" isn't top-level; genres nest one level deep`, "GENRE_NOT_TOP_LEVEL");
    if (String(genre.parent || "") === String(parent._id)) invalid(`"${genre.name}" is already under "${parent.name}"`);
    if (await hasActiveChildren(genre, session)) {
      conflict(`"${genre.name}" has its own sub-genres; move them first`, "GENRE_HAS_CHILDREN");
    }
    return { set: { parent: parent._id }, before: { parent: genreRef(current) }, after: { parent: genreRef(parent) } };
  }

  // retire
  if (await hasActiveChildren(genre, session)) {
    conflict(`"${genre.name}" has active sub-genres; move or retire them first`, "GENRE_HAS_CHILDREN");
  }
  return { set: { status: "retired" }, before: { status: "active" }, after: { status: "retired" } };
}

async function runVocabularyCommand({ genreId, command, actorUserId }) {
  if (typeof mongoose.startSession !== "function") throw commandError("Transactions are unavailable", 503, "GENRE_COMMAND_UNAVAILABLE");
  let session;
  let result = null;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      result = null;
      const genre = await Genre.findOne({ genreId }).session(session).lean();
      if (!genre) throw commandError("Genre not found", 404, "GENRE_NOT_FOUND");
      const revision = revisionOf(genre);
      if (revision !== command.expectedRevision) {
        conflict("The genre changed since it was loaded; reload and try again", "GENRE_REVISION_CONFLICT", [{ revision }]);
      }
      const plan = await planCommand(command, genre, session);
      const updated = await Genre.findOneAndUpdate(
        { _id: genre._id, revision: revision === 0 ? { $in: [null, 0] } : revision },
        { $set: { ...plan.set, revision: revision + 1 } },
        { returnDocument: "after", runValidators: true, session },
      ).lean();
      if (!updated) conflict("The genre changed since it was loaded; reload and try again", "GENRE_REVISION_CONFLICT");
      await GenreEvent.create([{
        genre: genre._id,
        genreId: genre.genreId,
        action: command.action,
        actorUserId,
        reason: command.reason,
        before: plan.before,
        after: plan.after,
      }], { session });
      result = updated;
    });
    return describeGenre(result);
  } catch (error) {
    if (isTransactionUnavailable(error)) throw commandError("A replica set or sharded MongoDB deployment is required", 503, "GENRE_COMMAND_UNAVAILABLE");
    if (error?.code === 11000) throw commandError("That name or slug is already taken", 409, "GENRE_NAME_CONFLICT");
    throw error;
  } finally {
    if (session) await session.endSession();
  }
}

async function albumCounts(genreIds = null) {
  const match = genreIds ? { genres: { $in: genreIds } } : { genres: { $exists: true, $ne: [] } };
  const rows = await AlbumCatalog.aggregate([
    { $match: match },
    { $unwind: "$genres" },
    ...(genreIds ? [{ $match: { genres: { $in: genreIds } } }] : []),
    { $group: { _id: "$genres", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

// The moderator view of one genre: everything public plus status, revision,
// and usage, never the Mongo _id.
async function describeGenre(genre, { counts = null, parents = null, childCounts = null } = {}) {
  const parent = genre.parent
    ? (parents ? parents.get(String(genre.parent)) : await Genre.findById(genre.parent).lean())
    : null;
  const albumCount = counts ? counts.get(String(genre._id)) || 0 : (await albumCounts([genre._id])).get(String(genre._id)) || 0;
  const childCount = childCounts ? childCounts.get(String(genre._id)) || 0 : await Genre.countDocuments({ parent: genre._id, status: "active" });
  return {
    ...genreRef(genre),
    status: genre.status,
    revision: revisionOf(genre),
    parent: parent ? { ...genreRef(parent), status: parent.status } : null,
    aliases: (genre.aliases || []).map((alias) => alias.name),
    origin: { source: genre.origin?.source || null },
    albumCount,
    childCount,
    updatedAt: genre.updatedAt,
  };
}

async function listVocabulary({ q = "", status = "active" } = {}) {
  if (!["active", "retired", "all"].includes(status)) invalid("status must be active, retired, or all");
  if (typeof q !== "string" || q.length > MAX_LIST_QUERY_LENGTH) invalid(`q must be ${MAX_LIST_QUERY_LENGTH} characters or fewer`);
  const query = status === "all" ? {} : { status };
  const key = genreMatchKey(q);
  if (key) {
    const pattern = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    query.$or = [{ normalizedName: pattern }, { "aliases.normalizedName": pattern }];
  }
  const [rows, everything, counts] = await Promise.all([
    Genre.find(query).sort({ name: 1 }).lean(),
    Genre.find({}).select("genreId slug name status parent").lean(),
    albumCounts(),
  ]);
  const parents = new Map(everything.map((genre) => [String(genre._id), genre]));
  const childCounts = new Map();
  everything.filter((genre) => genre.parent && genre.status === "active").forEach((genre) => {
    childCounts.set(String(genre.parent), (childCounts.get(String(genre.parent)) || 0) + 1);
  });
  return Promise.all(rows.map((genre) => describeGenre(genre, { counts, parents, childCounts })));
}

async function vocabularyDetail(genreId) {
  const genre = await Genre.findOne({ genreId }).lean();
  if (!genre) return null;
  const events = await GenreEvent.find({ genre: genre._id }).sort({ createdAt: -1, _id: -1 }).limit(EVENT_LIMIT).lean();
  return {
    genre: await describeGenre(genre),
    events: events.map((event) => ({
      action: event.action,
      actorUserId: event.actorUserId,
      reason: event.reason || "",
      before: event.before,
      after: event.after,
      submissionId: event.submissionId || null,
      datasetId: event.datasetId || null,
      createdAt: event.createdAt,
    })),
  };
}

module.exports = {
  ACTIONS,
  listVocabulary,
  normalizeVocabularyCommand,
  runVocabularyCommand,
  vocabularyDetail,
};
