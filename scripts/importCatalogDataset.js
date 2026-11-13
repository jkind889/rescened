#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const Artist = require("../models/Artist");
const { readDatasetFile } = require("../lib/catalogImport/dataset");
const {
  CatalogImportError,
  applyImport,
  createImportReport,
  parseImportArgs,
  preflightImport,
} = require("../lib/catalogImport/persistence");

const USAGE = `Usage:
  npm run catalog:import -- --input <dataset.json> [--dry-run]
  npm run catalog:import -- --input <dataset.json> --apply

Options:
  --input <path>               Validated catalog dataset (required)
  --report <path>              Import report output path
  --quarantine-report <path>   Quarantine report output path
  --dry-run                    Preflight only (default)
  --apply                      Apply accepted writes in one transaction
  --help                       Show this help`;

function artifactPath(input, suffix) {
  const parsed = path.parse(path.resolve(input));
  return path.join(parsed.dir, `${parsed.name}.${suffix}.json`);
}

function canonicalTargetPath(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let ancestor = path.dirname(resolved);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = fs.realpathSync.native(ancestor);
  return path.join(canonicalAncestor, path.relative(ancestor, resolved));
}

function resolveArtifactTargets(options) {
  const input = canonicalTargetPath(options.input);
  const report = canonicalTargetPath(options.report || artifactPath(options.input, "import-report"));
  const quarantine = canonicalTargetPath(
    options.quarantineReport || artifactPath(options.input, "quarantine-report"),
  );
  const entries = [
    ["input", input],
    ["report", report],
    ["quarantine report", quarantine],
  ];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (entries[left][1] === entries[right][1]) {
        throw new CatalogImportError(
          `${entries[left][0]} and ${entries[right][0]} paths must be different`,
          "INVALID_ARTIFACT_PATHS",
        );
      }
    }
  }
  return { input, report, quarantine };
}

function jsonContents(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stageJsonAtomic(target, value) {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isFile()) {
    throw new CatalogImportError(`Artifact target is not a file: ${resolved}`, "ARTIFACT_STAGE_FAILED");
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, jsonContents(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  return { targetPath: resolved, temporaryPath, finalized: false };
}

function replaceStagedJson(stage, value) {
  if (!stage || stage.finalized || !stage.temporaryPath) {
    throw new CatalogImportError("Cannot replace a finalized artifact", "ARTIFACT_STAGE_FAILED");
  }
  fs.writeFileSync(stage.temporaryPath, jsonContents(value), { encoding: "utf8", flag: "w", mode: 0o600 });
  return stage;
}

function finalizeStagedArtifacts(stages) {
  const failures = [];
  for (const stage of stages) {
    if (!stage || stage.finalized) continue;
    try {
      fs.renameSync(stage.temporaryPath, stage.targetPath);
      stage.finalized = true;
    } catch (error) {
      failures.push({
        targetPath: stage.targetPath,
        temporaryPath: stage.temporaryPath,
        message: error.message,
      });
    }
  }
  if (failures.length > 0) {
    const error = new CatalogImportError(
      `Could not finalize ${failures.length} staged catalog import artifact(s)`,
      "ARTIFACT_FINALIZATION_FAILED",
      failures,
    );
    error.stagedArtifacts = stages;
    throw error;
  }
  return stages.map((stage) => stage.targetPath);
}

function discardStagedArtifacts(stages) {
  for (const stage of stages || []) {
    if (!stage || stage.finalized || !stage.temporaryPath) continue;
    try {
      fs.unlinkSync(stage.temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function writeJsonAtomic(target, value) {
  const stage = stageJsonAtomic(target, value);
  try {
    finalizeStagedArtifacts([stage]);
  } catch (error) {
    discardStagedArtifacts([stage]);
    throw error;
  }
  return stage.targetPath;
}

function quarantineEntries(error, plan) {
  if (Array.isArray(plan?.quarantined)) return plan.quarantined;
  if (Array.isArray(error?.quarantined)) return error.quarantined;
  return [];
}

function quarantinePayload(plan, generatedAt, entries = plan?.quarantined || []) {
  return {
    reportVersion: "1.0.0",
    datasetId: plan?.datasetId || null,
    generatedAt,
    count: entries.length,
    entries,
  };
}

function errorPayload(error, mode, plan) {
  const entries = quarantineEntries(error, plan);
  return {
    reportVersion: "1.0.0",
    datasetId: plan?.datasetId || null,
    schemaVersion: plan?.schemaVersion || null,
    mode,
    generatedAt: new Date().toISOString(),
    applied: false,
    fatal: true,
    transactionState: error.transactionState || "not-started",
    counts: plan?.counts || null,
    quarantine: entries,
    error: {
      code: error.importErrorCode || error.code || "CATALOG_IMPORT_FAILED",
      message: error.message,
      details: error.errors || error.details || [],
      quarantined: Array.isArray(error.quarantined) ? error.quarantined : [],
    },
  };
}

const defaultArtifactIO = {
  stage: stageJsonAtomic,
  replace: replaceStagedJson,
  finalize: finalizeStagedArtifacts,
  discard: discardStagedArtifacts,
};

async function emitFailureArtifacts({ artifactIO, stages, targets, error, plan, mode }) {
  const generatedAt = new Date().toISOString();
  const entries = quarantineEntries(error, plan);
  const report = errorPayload(error, mode, plan);
  const quarantine = quarantinePayload(plan, generatedAt, entries);

  if (stages.length === 2) {
    try {
      await artifactIO.replace(stages[0], report);
      await artifactIO.replace(stages[1], quarantine);
      await artifactIO.finalize(stages);
      return;
    } catch (stageError) {
      await artifactIO.discard(stages);
    }
  }

  if (stages.length > 0) await artifactIO.discard(stages);

  // No database changes were committed on this path. Fall back to ordinary
  // atomic writes so validation/preflight failures still get useful reports.
  writeJsonAtomic(targets.report, report);
  writeJsonAtomic(targets.quarantine, quarantine);
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  const artifactIO = { ...defaultArtifactIO, ...(dependencies.artifactIO || {}) };
  let options;
  let targets;
  let connectedHere = false;
  let plan;
  let databaseApplyCompleted = false;
  const staged = [];
  try {
    options = parseImportArgs(argv);
    if (options.help) {
      output.log(USAGE);
      return 0;
    }
    targets = resolveArtifactTargets(options);

    // Validate the entire envelope and all rows before opening a database connection.
    const validation = await (dependencies.readDatasetFile || readDatasetFile)(options.input);
    const db = dependencies.mongoose || mongoose;
    const Model = dependencies.AlbumCatalog || AlbumCatalog;
    const ArtistModel = dependencies.Artist || Artist;
    if (db.connection?.readyState !== 1) {
      const mongoUri = dependencies.mongoUri || process.env.MONGO_URI;
      if (!mongoUri) throw new CatalogImportError("MONGO_URI is required", "MISSING_MONGO_URI");
      // Connecting must not build collections or indexes: a dry run stays read-only.
      await db.connect(mongoUri, { autoCreate: false, autoIndex: false });
      connectedHere = true;
    }

    plan = await preflightImport({ validation, AlbumCatalog: Model, Artist: ArtistModel });
    const report = createImportReport(plan, { apply: options.apply, now: dependencies.now });
    const quarantine = quarantinePayload(plan, report.generatedAt);

    // Stage both complete success artifacts before any database mutation. The
    // post-commit path only performs same-directory atomic renames.
    staged.push(await artifactIO.stage(targets.report, report));
    staged.push(await artifactIO.stage(targets.quarantine, quarantine));

    if (options.apply) {
      // Apply only: build the catalog and registry indexes (including the unique
      // MusicBrainz index) before inserting, since connecting does not.
      if (typeof Model.createIndexes === "function") await Model.createIndexes();
      if (typeof ArtistModel.createIndexes === "function") await ArtistModel.createIndexes();
      await applyImport({ plan, AlbumCatalog: Model, Artist: ArtistModel, mongoose: db });
      databaseApplyCompleted = true;
    }

    try {
      await artifactIO.finalize(staged);
    } catch (error) {
      if (databaseApplyCompleted) {
        const committedError = new CatalogImportError(
          "Database apply completed, but one or more staged report artifacts could not be finalized",
          "IMPORT_COMMITTED_ARTIFACT_FINALIZATION_FAILED",
          error.details || [],
        );
        committedError.databaseCommitted = true;
        committedError.stagedArtifacts = error.stagedArtifacts || staged;
        throw committedError;
      }
      throw error;
    }
    staged.length = 0;

    output.log(JSON.stringify({
      mode: report.mode,
      counts: report.counts,
      artistRegistry: report.artistRegistry,
      report: targets.report,
      quarantineReport: targets.quarantine,
    }, null, 2));
    return plan.quarantined.length ? 2 : 0;
  } catch (error) {
    if (error.databaseCommitted || databaseApplyCompleted) {
      output.error(
        `${error.code || "IMPORT_COMMITTED_ARTIFACT_FINALIZATION_FAILED"}: ${error.message}. `
        + "Database changes were committed; do not treat this as a rollback.",
      );
      return 1;
    }

    const failurePlan = error.importPlan || plan;
    if (targets) {
      try {
        await emitFailureArtifacts({
          artifactIO,
          stages: staged,
          targets,
          error,
          plan: failurePlan,
          mode: options?.apply ? "apply" : "dry-run",
        });
        staged.length = 0;
      } catch (reportError) {
        try {
          await artifactIO.discard(staged);
        } catch (cleanupError) {
          output.error(`Could not clean staged import artifacts: ${cleanupError.message}`);
        }
        output.error(`Could not write fatal import artifacts: ${reportError.message}`);
      }
    }
    output.error(`${error.importErrorCode || error.code || "CATALOG_IMPORT_FAILED"}: ${error.message}`);
    return 1;
  } finally {
    if (connectedHere) await (dependencies.mongoose || mongoose).disconnect();
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

module.exports = {
  USAGE,
  artifactPath,
  canonicalTargetPath,
  discardStagedArtifacts,
  errorPayload,
  finalizeStagedArtifacts,
  main,
  parseImportArgs,
  quarantinePayload,
  replaceStagedJson,
  resolveArtifactTargets,
  stageJsonAtomic,
  writeJsonAtomic,
};
