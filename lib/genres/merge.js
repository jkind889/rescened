// Operator merge of one genre into another. Every album tagged with the
// source genre is remapped to the target (keeping its position, or dropping
// the source when the album already has the target); the source's names move
// to the target as aliases so its links keep resolving; and the source is
// retired. The dry run's plan checksum must match at apply time.

const crypto = require("node:crypto");
const AlbumCatalog = require("../../models/AlbumCatalog");
const AlbumSubmission = require("../../models/AlbumSubmission");
const { Genre, GenreEvent } = require("../../models/Genre");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");
const { genreProvenanceSet } = require("./provenance");

const MERGE_ACTOR = "operator:genres-merge";
const MAX_MERGE_ALBUMS = 5000;

class GenreMergeError extends Error {
  constructor(message, code = "GENRE_MERGE_FAILED", details = []) {
    super(message);
    this.name = "GenreMergeError";
    this.code = code;
    this.details = details;
  }
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function genreRef(genre) {
  return { genreId: genre.genreId, slug: genre.slug, name: genre.name };
}

function revisionOf(value) {
  return Number.isInteger(value) ? value : 0;
}

async function planGenreMerge({ fromSlug, intoSlug, session = null }) {
  // Sequential on purpose: a transaction's session can't run operations in parallel.
  const from = await withSession(Genre.findOne({ slug: String(fromSlug || "").toLowerCase() }), session).lean();
  const into = await withSession(Genre.findOne({ slug: String(intoSlug || "").toLowerCase() }), session).lean();
  if (!from) throw new GenreMergeError(`No genre has the slug "${fromSlug}"`, "GENRE_NOT_FOUND");
  if (!into) throw new GenreMergeError(`No genre has the slug "${intoSlug}"`, "GENRE_NOT_FOUND");
  if (String(from._id) === String(into._id)) throw new GenreMergeError("A genre can't be merged into itself", "INVALID_ARGUMENTS");
  if (into.status !== "active") throw new GenreMergeError(`"${into.name}" is retired; merge into an active genre`, "GENRE_RETIRED");
  const children = await withSession(Genre.find({ parent: from._id, status: "active" }), session).select("slug name").lean();
  if (children.length) {
    throw new GenreMergeError(`"${from.name}" has active sub-genres; move them first`, "GENRE_HAS_CHILDREN", children.map((child) => child.slug));
  }

  const albums = await withSession(
    AlbumCatalog.find({ genres: from._id }).select("albumId title genres genresRevision fieldProvenance").sort({ _id: 1 }),
    session,
  ).lean();
  if (albums.length > MAX_MERGE_ALBUMS) {
    throw new GenreMergeError(`${albums.length} albums exceed the ${MAX_MERGE_ALBUMS}-album limit for one merge transaction`, "GENRE_MERGE_TOO_LARGE");
  }
  const referenced = [...new Set(albums.flatMap((album) => album.genres.map(String)))];
  const names = new Map((await withSession(Genre.find({ _id: { $in: referenced } }), session).select("slug").lean())
    .map((genre) => [String(genre._id), genre.slug]));
  const fromId = String(from._id);
  const intoId = String(into._id);
  const operations = albums.map((album) => {
    const before = album.genres.map(String);
    const after = before.includes(intoId)
      ? before.filter((id) => id !== fromId)
      : before.map((id) => (id === fromId ? intoId : id));
    return {
      _id: album._id,
      albumId: album.albumId,
      fieldProvenance: album.fieldProvenance,
      title: album.title,
      genresRevision: revisionOf(album.genresRevision),
      before,
      after,
      beforeSlugs: before.map((id) => names.get(id) || id),
      afterSlugs: after.map((id) => (id === intoId ? into.slug : names.get(id) || id)),
    };
  });

  // The source's name and aliases become the target's aliases, except
  // spellings the target already has.
  const intoKeys = new Set([into.normalizedName, ...(into.aliases || []).map((alias) => alias.normalizedName)]);
  const aliasesToMove = [{ name: from.name, normalizedName: from.normalizedName, slug: from.slug }, ...(from.aliases || [])]
    .filter((alias, index, all) => !intoKeys.has(alias.normalizedName) && all.findIndex((other) => other.normalizedName === alias.normalizedName) === index)
    .map((alias) => ({ name: alias.name, normalizedName: alias.normalizedName, slug: alias.slug }));

  const openSuggestions = await withSession(AlbumSubmission.countDocuments({
    submissionType: "genre_suggestion",
    status: { $in: ["pending", "needs_changes"] },
    $or: [
      { "genreChanges.additions.genre.genreId": from.genreId },
      { "genreChanges.removals.genreId": from.genreId },
      { "genreChanges.primary.genre.genreId": from.genreId },
    ],
  }), session);

  const fingerprint = {
    from: { genreId: from.genreId, revision: revisionOf(from.revision), status: from.status },
    into: { genreId: into.genreId, revision: revisionOf(into.revision) },
    albums: operations.map((operation) => ({ albumId: operation.albumId, genresRevision: operation.genresRevision, before: operation.beforeSlugs, after: operation.afterSlugs })),
    aliases: aliasesToMove.map((alias) => alias.normalizedName),
  };
  return {
    from,
    into,
    operations,
    aliasesToMove,
    openSuggestions,
    planSha256: crypto.createHash("sha256").update(stableJson(fingerprint), "utf8").digest("hex"),
  };
}

function createMergeReport(plan, { mode, database = null, now = () => new Date() }) {
  return {
    reportVersion: "1.0.0",
    mode,
    database,
    generatedAt: now().toISOString(),
    planSha256: plan.planSha256,
    from: { ...genreRef(plan.from), status: plan.from.status },
    into: genreRef(plan.into),
    counts: { albums: plan.operations.length, aliasesMoved: plan.aliasesToMove.length, openSuggestionsReferencingFrom: plan.openSuggestions },
    aliasesMoved: plan.aliasesToMove.map((alias) => alias.name),
    albums: plan.operations.map((operation) => ({ albumId: operation.albumId, title: operation.title, before: operation.beforeSlugs, after: operation.afterSlugs })),
    applied: false,
  };
}

// Re-plans inside one transaction and applies only if the plan is exactly the
// one that was reviewed.
async function applyGenreMerge({ fromSlug, intoSlug, expectedPlanSha256, mongoose, now = () => new Date() }) {
  if (typeof mongoose?.startSession !== "function") throw new GenreMergeError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  const session = await mongoose.startSession();
  let committed = false;
  let applied = null;
  try {
    await session.withTransaction(async () => {
      applied = null;
      const plan = await planGenreMerge({ fromSlug, intoSlug, session });
      if (plan.planSha256 !== expectedPlanSha256) {
        throw new GenreMergeError("The merge plan changed since the reviewed dry run; run the dry run again", "GENRE_MERGE_PLAN_CHANGED", [{ expected: expectedPlanSha256, actual: plan.planSha256 }]);
      }
      const appliedAt = now();
      const provenance = {
        source: "manual",
        reason: "genre merge",
        fromGenreId: plan.from.genreId,
        intoGenreId: plan.into.genreId,
        planSha256: plan.planSha256,
        actorUserId: MERGE_ACTOR,
        appliedAt,
      };
      for (const operation of plan.operations) {
        const result = await AlbumCatalog.updateOne(
          { _id: operation._id, genresRevision: operation.genresRevision === 0 ? { $in: [null, 0] } : operation.genresRevision },
          { $set: { genres: operation.after, genresRevision: operation.genresRevision + 1, ...genreProvenanceSet(operation, provenance) } },
          { session, runValidators: true },
        );
        if (result.matchedCount !== 1) throw new GenreMergeError(`Album ${operation.albumId} changed during the merge`, "GENRE_MERGE_PLAN_CHANGED");
      }
      const intoRevision = revisionOf(plan.into.revision);
      if (plan.aliasesToMove.length) {
        const result = await Genre.updateOne(
          { _id: plan.into._id, revision: intoRevision === 0 ? { $in: [null, 0] } : intoRevision },
          { $push: { aliases: { $each: plan.aliasesToMove } }, $set: { revision: intoRevision + 1 } },
          { session, runValidators: true },
        );
        if (result.matchedCount !== 1) throw new GenreMergeError(`"${plan.into.name}" changed during the merge`, "GENRE_MERGE_PLAN_CHANGED");
        await GenreEvent.create([{
          genre: plan.into._id,
          genreId: plan.into.genreId,
          action: "alias_add",
          actorUserId: MERGE_ACTOR,
          reason: `Merged from "${plan.from.name}"`,
          before: { aliases: (plan.into.aliases || []).map((alias) => alias.name) },
          after: { aliases: [...(plan.into.aliases || []), ...plan.aliasesToMove].map((alias) => alias.name) },
        }], { session });
      }
      const fromRevision = revisionOf(plan.from.revision);
      const retired = await Genre.updateOne(
        { _id: plan.from._id, revision: fromRevision === 0 ? { $in: [null, 0] } : fromRevision },
        { $set: { status: "retired", revision: fromRevision + 1 } },
        { session },
      );
      if (retired.matchedCount !== 1) throw new GenreMergeError(`"${plan.from.name}" changed during the merge`, "GENRE_MERGE_PLAN_CHANGED");
      await GenreEvent.create([{
        genre: plan.from._id,
        genreId: plan.from.genreId,
        action: "merge",
        actorUserId: MERGE_ACTOR,
        reason: `Merged into "${plan.into.name}"`,
        before: { status: plan.from.status },
        after: { status: "retired", mergedInto: genreRef(plan.into), albums: plan.operations.length, planSha256: plan.planSha256 },
      }], { session });
      applied = plan;
    });
    committed = true;
    return applied;
  } catch (error) {
    if (!committed && isTransactionUnavailable(error)) {
      throw new GenreMergeError("A replica set or sharded MongoDB deployment is required", "TRANSACTION_UNAVAILABLE");
    }
    error.transactionState = committed ? "committed" : "rolled-back";
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  GenreMergeError,
  MAX_MERGE_ALBUMS,
  MERGE_ACTOR,
  applyGenreMerge,
  createMergeReport,
  planGenreMerge,
};
