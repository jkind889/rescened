#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const Artist = require("../models/Artist");
const AlbumSubmission = require("../models/AlbumSubmission");
const { readDatasetFile } = require("../lib/catalogImport/dataset");
const { evidenceBackfillSource, readEvidenceFile } = require("../lib/artists/enrichmentEvidence");
const {
  ArtistBackfillError,
  applyPlan,
  createPlan,
  parseBackfillArgs,
  verifySealedPlan,
} = require("../lib/artists/backfill");

const USAGE = `Usage:
  npm run catalog:backfill-artists -- --input <dataset.json> [--input <dataset.json> ...] --out <plan.json>
  npm run catalog:backfill-artists -- --enrichment <evidence.json> --enrichment-sha256 <sha> --out <plan.json>
  npm run catalog:backfill-artists -- --apply --plan <plan.json> --plan-sha256 <sha> --confirm-target <database> --report <report.json>

Plan mode (the default, also --dry-run) reads validated catalog import
datasets, or pinned MusicBrainz credit evidence, and the catalog, then
writes a sealed plan. It never writes to MongoDB.
Apply reads only the sealed plan, refuses any other target database, and links
each album in its own guarded transaction.

Options:
  --input <path>            Validated catalog import dataset (repeatable; plan mode)
  --enrichment <path>       Sealed MusicBrainz credit evidence from catalog:enrich-identities
                            (plan mode; instead of --input)
  --enrichment-sha256 <sha> evidenceSha256 of the reviewed evidence (required with --enrichment)
  --out <path>              New plan file (plan mode; never overwritten)
  --link-user-owned         Also link exact matches whose credits are community- or
                            moderator-owned (adds only artistId/artistMbid; plan mode)
  --resolve-artist-names     Verify every new registry name by MusicBrainz MBID
  --artist-name-cache <dir>  Private resumable cache (required with name lookup)
  --apply                   Apply a reviewed, sealed plan
  --plan <path>             Sealed plan to apply
  --plan-sha256 <sha>       planSha256 printed when the plan was created
  --confirm-target <name>   Database name the plan targets
  --report <path>           New apply report file (never overwritten)
  --help                    Show this help`;

function writeNewJson(target, value) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  // "wx" refuses to replace an existing plan or report, so a reviewed
  // artifact can never be silently overwritten.
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return resolved;
}

function replaceReservedJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w", mode: 0o600 });
}

// Writes the final apply report into the file reserved before apply. If that
// write fails after database commits, print the report and the committed state
// instead, so a commit is never mistaken for a rollback.
function finalizeReport(reportPath, report, output) {
  try {
    replaceReservedJson(reportPath, report);
    return true;
  } catch (error) {
    output.error(`Could not write the apply report to ${reportPath}: ${error.message}`);
    output.error(`databaseCommitted=${Boolean(report.databaseCommitted)}. Full report follows:`);
    output.log(JSON.stringify(report, null, 2));
    return false;
  }
}

async function connect(db, dependencies) {
  if (db.connection?.readyState === 1) return false;
  const mongoUri = dependencies.mongoUri || process.env.MONGO_URI;
  if (!mongoUri) throw new ArtistBackfillError("MONGO_URI is required", "MISSING_MONGO_URI");
  // Connecting must not create collections or indexes, even in apply mode:
  // the sealed plan and connected target are checked before explicit writes.
  await db.connect(mongoUri, { autoCreate: false, autoIndex: false });
  return true;
}

function exitCodeForPlan(plan) {
  return plan.counts.flagged || plan.counts.review ? 2 : 0;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  const db = dependencies.mongoose || mongoose;
  const AlbumModel = dependencies.AlbumCatalog || AlbumCatalog;
  const ArtistModel = dependencies.Artist || Artist;
  let connectedHere = false;
  try {
    const options = parseBackfillArgs(argv);
    if (options.help) {
      output.log(USAGE);
      return 0;
    }

    if (options.mode === "plan") {
      const outPath = path.resolve(options.out);
      if (fs.existsSync(outPath)) throw new ArtistBackfillError(`Plan file already exists: ${outPath}`, "ARTIFACT_EXISTS");
      // Validate every dataset, or the pinned evidence, completely before
      // opening a database connection.
      let validations;
      let unresolved;
      if (options.enrichment) {
        const evidence = (dependencies.readEvidenceFile || readEvidenceFile)(options.enrichment, options.enrichmentSha256);
        const source = evidenceBackfillSource(evidence);
        validations = [source.validation];
        unresolved = source.unresolved;
      } else {
        validations = options.inputs.map((input) => (dependencies.readDatasetFile || readDatasetFile)(input));
      }
      connectedHere = await connect(db, dependencies);
      let plan = await createPlan({
        validations,
        unresolved,
        linkUserOwned: options.linkUserOwned,
        AlbumSubmission: options.linkUserOwned ? dependencies.AlbumSubmission || AlbumSubmission : undefined,
        AlbumCatalog: AlbumModel,
        Artist: ArtistModel,
        databaseName: db.connection.name,
        now: dependencies.now,
      });
      if (options.resolveArtistNames) {
        const resolveNames = dependencies.resolvePlanArtistNames || require("../lib/artists/names").resolvePlanArtistNames;
        plan = await resolveNames(plan, {
          cacheDir: options.artistNameCache,
          onProgress: ({ completed, total, cached }) => {
            if (completed % 25 === 0 || completed === total) output.log(`Verified artist names: ${completed}/${total} (${cached} cached)`);
          },
        });
      }
      const written = writeNewJson(outPath, plan);
      output.log(JSON.stringify({ mode: "plan", target: plan.target, counts: plan.counts, artistNameResolution: plan.artistNameResolution || null, plan: written, planSha256: plan.planSha256 }, null, 2));
      output.log(`Review ${written} before any apply. Apply command:\n  npm run catalog:backfill-artists -- --apply --plan ${written} --plan-sha256 ${plan.planSha256} --confirm-target ${plan.target.databaseName} --report <new-report.json>`);
      return exitCodeForPlan(plan);
    }

    const reportPath = path.resolve(options.report);
    if (fs.existsSync(reportPath)) throw new ArtistBackfillError(`Report file already exists: ${reportPath}`, "ARTIFACT_EXISTS");
    const plan = JSON.parse(fs.readFileSync(path.resolve(options.plan), "utf8"));
    // Reserve the report path before any database write.
    writeNewJson(reportPath, { status: "running", planSha256: plan.planSha256 || null, startedAt: new Date().toISOString() });
    let report;
    try {
      // Reject an edited plan or unconfirmed target before connecting. The
      // connected database must also match before even an index is created.
      verifySealedPlan(plan, options.planSha256);
      if (!plan.target?.databaseName || plan.target.databaseName !== options.confirmTarget) {
        throw new ArtistBackfillError("--confirm-target does not match the sealed plan target", "TARGET_MISMATCH");
      }
      connectedHere = await connect(db, dependencies);
      if (db.connection.name !== plan.target.databaseName) {
        throw new ArtistBackfillError(
          `Target mismatch: plan targets ${plan.target.databaseName}, connected to ${db.connection.name || "(none)"}`,
          "TARGET_MISMATCH",
        );
      }
      // The unique MusicBrainz index is the registry's duplicate guard. Build
      // it explicitly only after all plan and target checks have passed.
      if (typeof ArtistModel.createIndexes === "function") await ArtistModel.createIndexes();
      report = await applyPlan({
        plan,
        expectedSha256: options.planSha256,
        confirmTarget: options.confirmTarget,
        databaseName: db.connection.name,
        AlbumCatalog: AlbumModel,
        Artist: ArtistModel,
        mongoose: db,
        carryRevision: dependencies.carryRevision,
        now: dependencies.now,
      });
    } catch (error) {
      const failureReport = error.backfillReport || { status: "failed", databaseCommitted: false, error: { message: error.message, code: error.code || null } };
      finalizeReport(reportPath, failureReport, output);
      if (failureReport.databaseCommitted) {
        output.error(`Some changes were committed before the failure; see ${reportPath}. Rerunning the same plan skips albums already linked.`);
      }
      throw error;
    }
    if (!finalizeReport(reportPath, report, output)) return 1;
    output.log(JSON.stringify({ mode: "apply", target: report.target, registry: report.registry, counts: report.counts, report: reportPath }, null, 2));
    return report.counts.conflict ? 2 : 0;
  } catch (error) {
    output.error(`${error.code || "ARTIST_BACKFILL_FAILED"}: ${error.message}`);
    if (Array.isArray(error.details) && error.details.length) output.error(JSON.stringify(error.details, null, 2));
    return 1;
  } finally {
    if (connectedHere) await db.disconnect();
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { USAGE, main };
