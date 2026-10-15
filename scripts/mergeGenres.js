#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const {
  GenreMergeError,
  applyGenreMerge,
  createMergeReport,
  planGenreMerge,
} = require("../lib/genres/merge");

const USAGE = `Usage:
  npm run genres:merge -- --from <slug> --into <slug> [--dry-run]
  npm run genres:merge -- --from <slug> --into <slug> --apply --expect-plan-sha256 <hex>

Remaps every album from one genre to another, moves the source genre's names
to the target as aliases, and retires the source. A dry run writes a report
and changes nothing. --apply needs the planSha256 from that reviewed report
and refuses if the plan changed.

Options:
  --from <slug>                 Genre to merge away (required)
  --into <slug>                 Active genre to keep (required)
  --report <path>               Report path (default: data/genres/merges/<from>-into-<into>.merge-report.json)
  --dry-run                     Plan only (default)
  --apply                       Apply the reviewed plan in one transaction
  --expect-plan-sha256 <hex>    planSha256 from the reviewed dry-run report
  --help                        Show this help`;

function parseArgs(argv) {
  const options = { from: "", into: "", report: "", apply: false, expectPlanSha256: "", help: false };
  const seen = new Set();
  const value = (flag, index) => {
    const next = argv[index + 1];
    if (seen.has(flag)) throw new GenreMergeError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
    if (!next || next.startsWith("--")) throw new GenreMergeError(`${flag} requires a value`, "INVALID_ARGUMENTS");
    seen.add(flag);
    return next;
  };
  let mode = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--from") options.from = value(argument, index++).toLowerCase();
    else if (argument === "--into") options.into = value(argument, index++).toLowerCase();
    else if (argument === "--report") options.report = value(argument, index++);
    else if (argument === "--expect-plan-sha256") options.expectPlanSha256 = value(argument, index++).toLowerCase();
    else if (argument === "--apply" || argument === "--dry-run") {
      if (mode) throw new GenreMergeError("Choose one of --apply or --dry-run", "INVALID_ARGUMENTS");
      mode = argument;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new GenreMergeError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
  }
  options.apply = mode === "--apply";
  if (options.help) return options;
  if (!options.from || !options.into) throw new GenreMergeError("--from and --into are required", "INVALID_ARGUMENTS");
  if (options.apply && !/^[0-9a-f]{64}$/.test(options.expectPlanSha256)) {
    throw new GenreMergeError("--apply requires --expect-plan-sha256 from the reviewed dry-run report", "INVALID_ARGUMENTS");
  }
  if (!options.apply && options.expectPlanSha256) throw new GenreMergeError("--expect-plan-sha256 is only used with --apply", "INVALID_ARGUMENTS");
  return options;
}

function writeJsonAtomic(target, value) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, resolved);
  return resolved;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  const db = dependencies.mongoose || mongoose;
  const now = dependencies.now || (() => new Date());
  let connectedHere = false;
  let committed = false;
  try {
    const options = parseArgs(argv);
    if (options.help) {
      output.log(USAGE);
      return 0;
    }
    const reportPath = path.resolve(options.report || path.join("data", "genres", "merges", `${options.from}-into-${options.into}.merge-report.json`));
    if (db.connection?.readyState !== 1) {
      const mongoUri = dependencies.mongoUri || process.env.MONGO_URI;
      if (!mongoUri) throw new GenreMergeError("MONGO_URI is required", "MISSING_MONGO_URI");
      // A dry run must not create collections or indexes as a side effect.
      await db.connect(mongoUri, { autoIndex: false, autoCreate: false });
      connectedHere = true;
    }
    const database = db.connection?.name || null;

    if (!options.apply) {
      const plan = await planGenreMerge({ fromSlug: options.from, intoSlug: options.into });
      const report = createMergeReport(plan, { mode: "dry-run", database, now });
      writeJsonAtomic(reportPath, report);
      output.log(JSON.stringify({ mode: "dry-run", database, planSha256: report.planSha256, counts: report.counts, report: reportPath }, null, 2));
      return 0;
    }

    const plan = await applyGenreMerge({ fromSlug: options.from, intoSlug: options.into, expectedPlanSha256: options.expectPlanSha256, mongoose: db, now });
    committed = true;
    const report = { ...createMergeReport(plan, { mode: "apply", database, now }), applied: true };
    writeJsonAtomic(reportPath, report);
    output.log(JSON.stringify({ mode: "apply", database, planSha256: report.planSha256, counts: report.counts, report: reportPath }, null, 2));
    return 0;
  } catch (error) {
    if (committed) {
      output.error(`GENRE_MERGE_COMMITTED_REPORT_FAILED: ${error.message}. Database changes were committed; do not treat this as a rollback.`);
      return 1;
    }
    output.error(`${error.code || "GENRE_MERGE_FAILED"}: ${error.message}`);
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
