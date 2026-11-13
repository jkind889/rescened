#!/usr/bin/env node
// Operator command for cached artist biographies. Plan mode is read-only
// against MongoDB and makes serial, rate-gated public MusicBrainz, Wikidata,
// and Wikipedia requests. Writes happen only with --apply (an exact sealed
// plan) or --refresh, both of which require --confirm-target.

// Reads MONGO_URI from the root .env, like the other operator commands.
require("dotenv").config({ quiet: true });

const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const ArtistBiography = require("../models/ArtistBiography");
const {
  BiographyOperationError,
  applyBiographyPlan,
  createBiographyPlan,
  refreshBiographies,
  verifyBiographyPlan,
} = require("../lib/artists/biographyOperations");
const { createBiographySources } = require("../lib/artists/biographySources");

const USAGE = `Usage:
  npm run artists:biographies -- --out <plan.json> [--limit 25] [--artist <artistId>]...
  npm run artists:biographies -- --apply --plan <plan.json> --plan-sha256 <sha> --confirm-target <database> --report <report.json>
  npm run artists:biographies -- --refresh --confirm-target <database> --report <report.json> [--limit 25]

Plan mode reads the database, resolves biographies from public providers,
and writes a sealed plan. It never writes to MongoDB. Apply re-resolves only
the reviewed artists and writes those whose record and outcome still match.
Refresh checks due accepted biographies and never accepts a new match.`;

function parseArgs(argv) {
  const options = { mode: "plan", artistIds: [], limit: 25, out: "", plan: "", planSha256: "", confirmTarget: "", report: "", help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new BiographyOperationError(`${flag} needs a value`, "INVALID_ARGUMENTS");
      index += 1;
      return next;
    };
    if (flag !== "--artist" && seen.has(flag)) throw new BiographyOperationError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
    seen.add(flag);
    if (flag === "--help") options.help = true;
    else if (flag === "--apply") options.mode = "apply";
    else if (flag === "--refresh") options.mode = "refresh";
    else if (flag === "--artist") options.artistIds.push(value());
    else if (flag === "--limit") options.limit = Number(value());
    else if (flag === "--out") options.out = value();
    else if (flag === "--plan") options.plan = value();
    else if (flag === "--plan-sha256") options.planSha256 = value();
    else if (flag === "--confirm-target") options.confirmTarget = value();
    else if (flag === "--report") options.report = value();
    else throw new BiographyOperationError(`Unknown option ${flag}`, "INVALID_ARGUMENTS");
  }
  if (seen.has("--apply") && seen.has("--refresh")) throw new BiographyOperationError("Choose one of --apply or --refresh", "INVALID_ARGUMENTS");
  if (options.mode === "plan") {
    if (!options.out && !options.help) throw new BiographyOperationError("--out <plan.json> is required", "INVALID_ARGUMENTS");
    if (options.plan || options.planSha256 || options.confirmTarget || options.report) throw new BiographyOperationError("--plan, --plan-sha256, --confirm-target, and --report are not used in plan mode", "INVALID_ARGUMENTS");
  } else {
    if (!options.confirmTarget || !options.report) throw new BiographyOperationError("--confirm-target and --report are required", "INVALID_ARGUMENTS");
    if (options.out) throw new BiographyOperationError("--out is plan-only", "INVALID_ARGUMENTS");
    if (options.mode === "apply" && (!options.plan || !options.planSha256)) throw new BiographyOperationError("--plan and --plan-sha256 are required with --apply", "INVALID_ARGUMENTS");
    if (options.mode === "apply" && (options.artistIds.length || seen.has("--limit"))) throw new BiographyOperationError("--apply uses only the sealed plan", "INVALID_ARGUMENTS");
    if (options.mode === "refresh" && (options.plan || options.planSha256 || options.artistIds.length)) throw new BiographyOperationError("--refresh selects due records itself", "INVALID_ARGUMENTS");
  }
  return options;
}

function writeNewJson(target, value) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // "wx": a reviewed plan or report is never overwritten.
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return resolved;
}

async function connect(db, mongoUri) {
  if (!mongoUri) throw new BiographyOperationError("MONGO_URI is required", "MISSING_MONGO_URI");
  // No automatic collection or index creation on connect.
  await db.connect(mongoUri, { autoCreate: false, autoIndex: false });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  const db = dependencies.mongoose || mongoose;
  const options = parseArgs(argv);
  if (options.help) { output.log(USAGE); return 0; }
  const sources = dependencies.sources || createBiographySources();
  const now = dependencies.now || new Date();
  let connected = false;
  try {
    if (options.mode === "plan") {
      if (fs.existsSync(path.resolve(options.out))) throw new BiographyOperationError(`Plan file already exists: ${path.resolve(options.out)}`, "ARTIFACT_EXISTS");
      await connect(db, dependencies.mongoUri || process.env.MONGO_URI);
      connected = true;
      const plan = await createBiographyPlan({
        sources, artistIds: options.artistIds, limit: options.limit, now, databaseName: db.connection.name,
        onProgress: ({ completed, total }) => { if (completed % 10 === 0 || completed === total) output.log(`Resolved ${completed}/${total}`); },
      });
      const written = writeNewJson(options.out, plan);
      output.log(JSON.stringify({ mode: "plan", target: plan.target, counts: plan.counts, plan: written, planSha256: plan.planSha256 }, null, 2));
      output.log(`Review ${written}, then: npm run artists:biographies -- --apply --plan ${written} --plan-sha256 ${plan.planSha256} --confirm-target ${plan.target.databaseName} --report <new-report.json>`);
      return plan.counts.needs_review || plan.counts.conflict ? 2 : 0;
    }

    let plan = null;
    if (options.mode === "apply") {
      plan = JSON.parse(fs.readFileSync(path.resolve(options.plan), "utf8"));
      verifyBiographyPlan(plan, options.planSha256);
      if (plan.target?.databaseName !== options.confirmTarget) throw new BiographyOperationError("--confirm-target does not match the plan target", "TARGET_MISMATCH");
    }
    // Reserve the report before any database write, then checkpoint it after
    // every row, so committed rows are recorded even if a later row fails.
    const reportPath = writeNewJson(options.report, { status: "running", mode: options.mode, startedAt: now.toISOString() });
    const operations = { applyBiographyPlan, refreshBiographies, ...dependencies.operations };
    const report = { status: "running", mode: options.mode, target: options.confirmTarget, planSha256: plan?.planSha256 || null, startedAt: now.toISOString(), databaseCommitted: false, uncertainWrites: 0, counts: {}, statusCounts: {}, results: [] };
    const record = (rows) => {
      report.results = [...rows];
      report.counts = {};
      for (const row of rows) report.counts[row.result] = (report.counts[row.result] || 0) + 1;
      // Outcome statuses, so "written" backoff records for provider errors are
      // told apart from written biographies.
      report.statusCounts = {};
      for (const row of rows) if (row.status) report.statusCounts[row.status] = (report.statusCounts[row.status] || 0) + 1;
      report.databaseCommitted = rows.some((row) => row.result === "written");
      report.uncertainWrites = rows.filter((row) => row.result === "uncertain").length;
    };
    const save = (writeFile = dependencies.writeReport || ((target, text) => fs.writeFileSync(target, text, { encoding: "utf8", mode: 0o600 }))) => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const onResult = (row, rows) => { record(rows); save(); };
    try {
      await connect(db, dependencies.mongoUri || process.env.MONGO_URI);
      connected = true;
      if (db.connection.name !== options.confirmTarget) throw new BiographyOperationError(`Connected to ${db.connection.name || "(none)"}, not ${options.confirmTarget}`, "TARGET_MISMATCH");
      // The unique (artistId, language) index is the duplicate guard; build
      // it explicitly only after the target is confirmed.
      await (dependencies.BiographyModel || ArtistBiography).createIndexes();
      const results = options.mode === "apply"
        ? await operations.applyBiographyPlan({ plan, sources, now, onResult })
        : await operations.refreshBiographies({ sources, limit: options.limit, now, onResult });
      record(results);
      report.status = "completed";
    } catch (error) {
      // Rows already reported stay recorded. A row that failed while writing
      // may or may not have committed, so it is marked uncertain.
      const failed = error.biographyRow;
      if (failed) record([...report.results, { artistId: failed.artistId, result: failed.stage === "writing" ? "uncertain" : "not_written", errorCode: error.code || "BIOGRAPHY_OPERATION_FAILED" }]);
      report.status = report.databaseCommitted || report.uncertainWrites ? "partial" : "failed";
      report.error = { code: error.code || "BIOGRAPHY_OPERATION_FAILED", message: String(error.message || "").replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") };
      report.completedAt = new Date().toISOString();
      try { save(); } catch { output.log(JSON.stringify({ reportWriteFailed: true, report }, null, 2)); }
      throw error;
    }
    report.completedAt = new Date().toISOString();
    try {
      save();
    } catch (writeError) {
      // The database work is done; never let a report failure hide it.
      output.log(JSON.stringify({ reportWriteFailed: true, report }, null, 2));
      throw Object.assign(new BiographyOperationError(`Writes finished but the report could not be saved: ${writeError.message}`, "REPORT_WRITE_FAILED"), { databaseCommitted: report.databaseCommitted });
    }
    output.log(JSON.stringify({ mode: options.mode, counts: report.counts, statusCounts: report.statusCounts, databaseCommitted: report.databaseCommitted, report: reportPath }, null, 2));
    return Object.keys(report.counts).some((key) => !["written", "not_applicable"].includes(key)) ? 2 : 0;
  } finally {
    if (connected) await db.disconnect();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Artist biographies: ${error.code || "BIOGRAPHY_OPERATION_FAILED"}: ${error.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>")}`);
    process.exitCode = 1;
  });
}

module.exports = { USAGE, main, parseArgs };
