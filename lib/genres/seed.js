// Genre vocabulary seed: validate a checked-in dataset, plan against the
// current vocabulary, and apply only new genres inside one transaction.
// Existing genres are never modified, because moderators own them once they
// exist; differences are reported as drift for a person to review.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { genreMatchKey, validateGenreName } = require("./vocabulary");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");

const SCHEMA_VERSION = "1.0.0";
const SEED_ACTOR = "operator:genres-import";
const MAX_DATASET_BYTES = 512 * 1024;
const MAX_ROWS = 1000;
const MAX_ALIASES = 10;
const DATASET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENVELOPE_KEYS = new Set(["schemaVersion", "datasetId", "genres"]);
const ROW_KEYS = new Set(["name", "parent", "aliases"]);

class GenreSeedError extends Error {
  constructor(message, code = "GENRE_SEED_FAILED", details = []) {
    super(message);
    this.name = "GenreSeedError";
    this.code = code;
    this.details = details;
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Pure validation of a parsed dataset. Every problem is collected, and any
// problem makes the whole dataset invalid: it is small and written by hand.
function validateGenreDataset(dataset) {
  const errors = [];
  const fail = (pointer, message) => errors.push({ pointer, message });

  if (!isPlainObject(dataset)) {
    throw new GenreSeedError("Dataset must be a JSON object", "INVALID_GENRE_DATASET", [{ pointer: "", message: "not an object" }]);
  }
  for (const key of Object.keys(dataset)) if (!ENVELOPE_KEYS.has(key)) fail(`/${key}`, "unknown field");
  if (dataset.schemaVersion !== SCHEMA_VERSION) fail("/schemaVersion", `must be "${SCHEMA_VERSION}"`);
  if (typeof dataset.datasetId !== "string" || !DATASET_ID_PATTERN.test(dataset.datasetId)) fail("/datasetId", "must be a lowercase hyphenated identifier");
  if (!Array.isArray(dataset.genres) || dataset.genres.length === 0 || dataset.genres.length > MAX_ROWS) {
    fail("/genres", `must be an array of 1-${MAX_ROWS} rows`);
    throw new GenreSeedError("Genre dataset is invalid", "INVALID_GENRE_DATASET", errors);
  }

  const rows = [];
  const keyOwners = new Map();
  const slugOwners = new Map();
  const claim = (map, value, pointer, label) => {
    if (map.has(value)) fail(pointer, `${label} "${value}" is already used at ${map.get(value)}`);
    else map.set(value, pointer);
  };

  dataset.genres.forEach((row, index) => {
    const pointer = `/genres/${index}`;
    if (!isPlainObject(row)) return fail(pointer, "must be an object");
    for (const key of Object.keys(row)) if (!ROW_KEYS.has(key)) fail(`${pointer}/${key}`, "unknown field");

    let identity;
    try {
      identity = validateGenreName(row.name);
    } catch (error) {
      return fail(`${pointer}/name`, error.message);
    }
    claim(keyOwners, identity.normalizedName, `${pointer}/name`, "name");
    claim(slugOwners, identity.slug, `${pointer}/name`, "slug");

    const aliases = [];
    if (row.aliases !== undefined) {
      if (!Array.isArray(row.aliases) || row.aliases.length > MAX_ALIASES) {
        fail(`${pointer}/aliases`, `must be an array of at most ${MAX_ALIASES} names`);
      } else {
        row.aliases.forEach((alias, aliasIndex) => {
          const aliasPointer = `${pointer}/aliases/${aliasIndex}`;
          try {
            const value = validateGenreName(alias);
            claim(keyOwners, value.normalizedName, aliasPointer, "name");
            // Two spellings can share a slug ("Hip-hop", "Hip hop"); only a
            // slug owned by a different genre is a conflict.
            if (slugOwners.has(value.slug) && !slugOwners.get(value.slug).startsWith(`${pointer}/`)) {
              fail(aliasPointer, `slug "${value.slug}" is already used at ${slugOwners.get(value.slug)}`);
            } else if (!slugOwners.has(value.slug)) {
              slugOwners.set(value.slug, aliasPointer);
            }
            aliases.push(value);
          } catch (error) {
            fail(aliasPointer, error.message);
          }
        });
      }
    }

    let parentKey = null;
    if (row.parent !== undefined && row.parent !== null) {
      if (typeof row.parent !== "string") fail(`${pointer}/parent`, "must be a genre name");
      else parentKey = genreMatchKey(row.parent);
      if (parentKey === identity.normalizedName) fail(`${pointer}/parent`, "a genre cannot be its own parent");
    }
    rows.push({ index, pointer, ...identity, aliases, parentKey });
  });

  // Parents must be another row's name (not an alias) and must themselves be
  // top-level: the vocabulary has one level of nesting.
  const byKey = new Map(rows.map((row) => [row.normalizedName, row]));
  for (const row of rows) {
    if (!row.parentKey) continue;
    const parent = byKey.get(row.parentKey);
    if (!parent) fail(`${row.pointer}/parent`, "must name another genre in this dataset");
    else if (parent.parentKey) fail(`${row.pointer}/parent`, `"${parent.name}" already has a parent; one level only`);
  }

  if (errors.length) throw new GenreSeedError("Genre dataset is invalid", "INVALID_GENRE_DATASET", errors);
  return { schemaVersion: dataset.schemaVersion, datasetId: dataset.datasetId, rows };
}

// Reads the dataset and its reviewed `<file>.sha256` sidecar. A mismatch means
// the file changed after review, so nothing is planned against it.
function readGenreDataset(inputPath) {
  const sourcePath = path.resolve(String(inputPath || ""));
  let text;
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > MAX_DATASET_BYTES) throw new GenreSeedError(`Dataset exceeds ${MAX_DATASET_BYTES} bytes`, "GENRE_DATASET_TOO_LARGE");
    text = fs.readFileSync(sourcePath, "utf8");
  } catch (error) {
    if (error instanceof GenreSeedError) throw error;
    throw new GenreSeedError(`Unable to read genre dataset: ${sourcePath}`, "GENRE_DATASET_READ_FAILED");
  }
  const digest = sha256(text);
  let expected;
  try {
    expected = fs.readFileSync(`${sourcePath}.sha256`, "utf8").trim().split(/\s+/)[0];
  } catch {
    throw new GenreSeedError(`Missing checksum sidecar: ${sourcePath}.sha256`, "GENRE_DATASET_CHECKSUM_MISSING");
  }
  if (expected !== digest) {
    throw new GenreSeedError("Dataset does not match its reviewed .sha256 sidecar", "GENRE_DATASET_CHECKSUM_MISMATCH", [{ expected, actual: digest }]);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GenreSeedError("Genre dataset is not valid JSON", "GENRE_DATASET_MALFORMED_JSON");
  }
  return { ...validateGenreDataset(parsed), sourcePath, sha256: digest };
}

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

// Compares validated rows with the current vocabulary. Pure apart from the
// supplied `existing` genre documents, so it runs identically in a dry run
// and inside the apply transaction.
function planGenreSeed(validation, existingGenres) {
  const existing = existingGenres.map(plain);
  const byName = new Map(existing.map((genre) => [genre.normalizedName, genre]));
  const byAlias = new Map();
  const bySlug = new Map();
  for (const genre of existing) {
    bySlug.set(genre.slug, genre);
    for (const alias of genre.aliases || []) {
      byAlias.set(alias.normalizedName, genre);
      bySlug.set(alias.slug, genre);
    }
  }
  const byId = new Map(existing.map((genre) => [String(genre._id), genre]));

  const create = [];
  const unchanged = [];
  const drift = [];
  const conflicts = [];
  for (const row of validation.rows) {
    const match = byName.get(row.normalizedName);
    if (match) {
      const differences = [];
      if (match.name !== row.name) differences.push({ field: "name", current: match.name, dataset: row.name });
      const currentParent = match.parent ? byId.get(String(match.parent))?.normalizedName || null : null;
      if (currentParent !== row.parentKey) differences.push({ field: "parent", current: currentParent, dataset: row.parentKey });
      const currentAliases = new Set((match.aliases || []).map((alias) => alias.normalizedName));
      const missingAliases = row.aliases.filter((alias) => !currentAliases.has(alias.normalizedName)).map((alias) => alias.name);
      if (missingAliases.length) differences.push({ field: "aliases", missing: missingAliases });
      if (match.status !== "active") differences.push({ field: "status", current: match.status, dataset: "active" });
      const entry = { rowIndex: row.index, name: row.name, genreId: match.genreId, slug: match.slug };
      if (differences.length) drift.push({ ...entry, differences });
      else unchanged.push(entry);
      continue;
    }

    const problems = [];
    const aliasOwner = byAlias.get(row.normalizedName);
    if (aliasOwner) problems.push(`name is an alias of existing genre "${aliasOwner.name}"`);
    if (bySlug.has(row.slug)) problems.push(`slug "${row.slug}" belongs to existing genre "${bySlug.get(row.slug).name}"`);
    for (const alias of row.aliases) {
      const owner = byName.get(alias.normalizedName) || byAlias.get(alias.normalizedName);
      if (owner) problems.push(`alias "${alias.name}" belongs to existing genre "${owner.name}"`);
      else if (bySlug.has(alias.slug)) problems.push(`alias slug "${alias.slug}" belongs to existing genre "${bySlug.get(alias.slug).name}"`);
    }
    if (problems.length) {
      conflicts.push({ rowIndex: row.index, name: row.name, problems });
      continue;
    }
    create.push(row);
  }

  // A new genre whose parent is only planned must not outlive a blocked parent.
  const createdKeys = new Set(create.map((row) => row.normalizedName));
  for (const row of create) {
    if (row.parentKey && !createdKeys.has(row.parentKey) && !byName.has(row.parentKey)) {
      conflicts.push({ rowIndex: row.index, name: row.name, problems: ["parent genre is blocked by a conflict"] });
    }
  }
  const blocked = new Set(conflicts.map((entry) => entry.rowIndex));

  return {
    datasetId: validation.datasetId,
    datasetSha256: validation.sha256 || null,
    create: create.filter((row) => !blocked.has(row.index)),
    unchanged,
    drift,
    conflicts,
  };
}

function createSeedReport(plan, { mode, now = () => new Date() } = {}) {
  return {
    reportVersion: "1.0.0",
    mode,
    generatedAt: now().toISOString(),
    datasetId: plan.datasetId,
    datasetSha256: plan.datasetSha256,
    applied: false,
    counts: {
      create: plan.create.length,
      unchanged: plan.unchanged.length,
      drift: plan.drift.length,
      conflicts: plan.conflicts.length,
    },
    create: plan.create.map((row) => ({ rowIndex: row.index, name: row.name, slug: row.slug, parent: row.parentKey, aliases: row.aliases.map((alias) => alias.name) })),
    drift: plan.drift,
    conflicts: plan.conflicts,
  };
}

// Inserts the planned genres and one `create` event each, parents first, in a
// single transaction. The plan is recomputed inside the transaction so a
// vocabulary change after the dry run aborts instead of writing stale rows.
async function applyGenreSeed({ validation, Genre, GenreEvent, mongoose, expectedCreateCount }) {
  if (typeof mongoose?.startSession !== "function") {
    throw new GenreSeedError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  }
  // Collections and indexes cannot be created inside a transaction. The CLI
  // connects with autoIndex off so a dry run creates nothing; do it here.
  for (const Model of [Genre, GenreEvent]) {
    await Model.createCollection();
    await Model.createIndexes();
  }

  const session = await mongoose.startSession();
  let committed = false;
  let created = [];
  try {
    await session.withTransaction(async () => {
      const current = await Genre.find({}).session(session).lean();
      const plan = planGenreSeed(validation, current);
      if (plan.conflicts.length) {
        throw new GenreSeedError("The vocabulary has conflicts with this dataset", "GENRE_SEED_CONFLICT", plan.conflicts);
      }
      if (Number.isInteger(expectedCreateCount) && plan.create.length !== expectedCreateCount) {
        throw new GenreSeedError(
          `The vocabulary changed after the dry run (${expectedCreateCount} planned, ${plan.create.length} now)`,
          "GENRE_SEED_PLAN_CHANGED",
        );
      }
      const idsByKey = new Map(current.map((genre) => [genre.normalizedName, genre._id]));
      const ordered = [...plan.create.filter((row) => !row.parentKey), ...plan.create.filter((row) => row.parentKey)];
      created = [];
      for (const row of ordered) {
        const document = {
          genreId: crypto.randomUUID(),
          slug: row.slug,
          name: row.name,
          normalizedName: row.normalizedName,
          aliases: row.aliases,
          parent: row.parentKey ? idsByKey.get(row.parentKey) : null,
          status: "active",
          kind: "genre",
          origin: { source: "seed", datasetId: validation.datasetId, submissionId: null },
        };
        const [genre] = await Genre.create([document], { session });
        idsByKey.set(row.normalizedName, genre._id);
        await GenreEvent.create([{
          genre: genre._id,
          genreId: genre.genreId,
          action: "create",
          actorUserId: SEED_ACTOR,
          reason: `Seeded from ${validation.datasetId}`,
          after: { name: genre.name, slug: genre.slug, parent: row.parentKey, aliases: row.aliases.map((alias) => alias.name) },
          datasetId: validation.datasetId,
          datasetSha256: validation.sha256 || null,
        }], { session });
        created.push({ genreId: genre.genreId, name: genre.name, slug: genre.slug });
      }
    });
    committed = true;
    return { applied: true, created };
  } catch (error) {
    if (!committed && isTransactionUnavailable(error)) {
      throw new GenreSeedError("A replica set or sharded MongoDB deployment is required", "TRANSACTION_UNAVAILABLE");
    }
    error.transactionState = committed ? "committed" : "rolled-back";
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  GenreSeedError,
  SCHEMA_VERSION,
  SEED_ACTOR,
  applyGenreSeed,
  createSeedReport,
  planGenreSeed,
  readGenreDataset,
  sha256,
  validateGenreDataset,
};
