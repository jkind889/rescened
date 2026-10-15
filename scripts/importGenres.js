#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { Genre, GenreEvent } = require("../models/Genre");
const {
  GenreSeedError,
  applyGenreSeed,
  createSeedReport,
  planGenreSeed,
  readGenreDataset,
} = require("../lib/genres/seed");

const USAGE = `Usage:
  npm run genres:import -- --input <genres.json> [--dry-run]
  npm run genres:import -- --input <genres.json> --apply --expect-sha256 <hex>

The dataset needs a reviewed <genres.json>.sha256 sidecar. A dry run writes a
report and changes nothing. --apply inserts only the genres the report lists
under "create", in one transaction, and requires the datasetSha256 from that
reviewed report. Existing genres are never modified.

Options:
  --input <path>          Genre dataset (required)
  --report <path>         Report path (default: <input>.import-report.json)
  --dry-run               Plan only (default)
  --apply                 Insert the planned genres
  --expect-sha256 <hex>   Dataset checksum from the reviewed dry-run report
  --help                  Show this help`;

function parseArgs(argv) {
  const options = { input: "", report: "", apply: false, expectSha256: "", help: false };
  const seen = new Set();
  const value = (flag, index) => {
    const next = argv[index + 1];
    if (seen.has(flag)) throw new GenreSeedError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
    if (!next || next.startsWith("--")) throw new GenreSeedError(`${flag} requires a value`, "INVALID_ARGUMENTS");
    seen.add(flag);
    return next;
  };
  let mode = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = value(argument, index++);
    else if (argument === "--report") options.report = value(argument, index++);
    else if (argument === "--expect-sha256") options.expectSha256 = value(argument, index++).toLowerCase();
    else if (argument === "--apply" || argument === "--dry-run") {
      if (mode) throw new GenreSeedError("Choose one of --apply or --dry-run", "INVALID_ARGUMENTS");
      mode = argument;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new GenreSeedError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
  }
  options.apply = mode === "--apply";
  if (options.help) return options;
  if (!options.input) throw new GenreSeedError("--input is required", "INVALID_ARGUMENTS");
  if (options.apply && !/^[0-9a-f]{64}$/.test(options.expectSha256)) {
    throw new GenreSeedError("--apply requires --expect-sha256 with the reviewed dataset checksum", "INVALID_ARGUMENTS");
  }
  if (!options.apply && options.expectSha256) {
    throw new GenreSeedError("--expect-sha256 is only used with --apply", "INVALID_ARGUMENTS");
  }
  return options;
}

function defaultReportPath(input) {
  const parsed = path.parse(path.resolve(input));
  return path.join(parsed.dir, `${parsed.name}.import-report.json`);
}

function writeJsonAtomic(target, value) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, resolved);
  return resolved;
}

function databaseName(db) {
  return db.connection?.name || db.connection?.db?.databaseName || null;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  const db = dependencies.mongoose || mongoose;
  const models = { Genre: dependencies.Genre || Genre, GenreEvent: dependencies.GenreEvent || GenreEvent };
  const now = dependencies.now || (() => new Date());
  let options;
  let connectedHere = false;
  let committed = false;
  try {
    options = parseArgs(argv);
    if (options.help) {
      output.log(USAGE);
      return 0;
    }
    const reportPath = options.report ? path.resolve(options.report) : defaultReportPath(options.input);
    if (reportPath === path.resolve(options.input)) {
      throw new GenreSeedError("The report path must differ from the input", "INVALID_ARGUMENTS");
    }

    // Validate the dataset and its checksum before connecting to anything.
    const validation = readGenreDataset(options.input);
    if (options.apply && validation.sha256 !== options.expectSha256) {
      throw new GenreSeedError("Dataset checksum does not match --expect-sha256", "GENRE_DATASET_CHECKSUM_MISMATCH", [{ expected: options.expectSha256, actual: validation.sha256 }]);
    }

    if (db.connection?.readyState !== 1) {
      const mongoUri = dependencies.mongoUri || process.env.MONGO_URI;
      if (!mongoUri) throw new GenreSeedError("MONGO_URI is required", "MISSING_MONGO_URI");
      // A dry run must not create collections or indexes as a side effect.
      await db.connect(mongoUri, { autoIndex: false, autoCreate: false });
      connectedHere = true;
    }

    const plan = planGenreSeed(validation, await models.Genre.find({}).lean());
    const report = { ...createSeedReport(plan, { mode: options.apply ? "apply" : "dry-run", now }), database: databaseName(db) };

    if (!options.apply) {
      writeJsonAtomic(reportPath, report);
      output.log(JSON.stringify({ mode: report.mode, database: report.database, datasetSha256: report.datasetSha256, counts: report.counts, report: reportPath }, null, 2));
      return plan.conflicts.length || plan.drift.length ? 2 : 0;
    }

    if (plan.conflicts.length) {
      writeJsonAtomic(reportPath, report);
      throw new GenreSeedError("The vocabulary has conflicts with this dataset; nothing was written", "GENRE_SEED_CONFLICT", plan.conflicts);
    }
    const result = await applyGenreSeed({ validation, ...models, mongoose: db, expectedCreateCount: plan.create.length });
    committed = true;
    const applied = { ...report, applied: true, created: result.created };
    writeJsonAtomic(reportPath, applied);
    output.log(JSON.stringify({ mode: "apply", database: applied.database, datasetSha256: applied.datasetSha256, created: result.created.length, report: reportPath }, null, 2));
    return 0;
  } catch (error) {
    if (committed) {
      output.error(`GENRE_SEED_COMMITTED_REPORT_FAILED: ${error.message}. Database changes were committed; do not treat this as a rollback.`);
      return 1;
    }
    output.error(`${error.code || "GENRE_SEED_FAILED"}: ${error.message}`);
    if (Array.isArray(error.details) && error.details.length) output.error(JSON.stringify(error.details, null, 2));
    return 1;
  } finally {
    if (connectedHere) await db.disconnect();
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { USAGE, main, parseArgs };
