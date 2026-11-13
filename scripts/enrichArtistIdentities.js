#!/usr/bin/env node

const path = require("node:path");
const { readIdsFile, readPlanNoSourceIds, evidenceExitCode } = require("../lib/artists/enrichmentEvidence");
const { EnrichmentStop, runReleaseGroupEnrichment, validateBudgetMinutes } = require("../lib/artists/releaseGroupCredits");

const USAGE = `Usage:
  npm run catalog:enrich-identities -- --ids-file <ids.json> --cache-dir <private-directory> --out <new-evidence.json> [--budget-minutes 30]
  npm run catalog:enrich-identities -- --from-plan <plan.json> --plan-sha256 <sha> --cache-dir <private-directory> --out <new-evidence.json> [--budget-minutes 30]

Fetches MusicBrainz artist credits for explicit release-group MBIDs and
writes sealed evidence for npm run catalog:backfill-artists -- --enrichment.
It never connects to MongoDB and never searches by name or title.

Options:
  --ids-file <path>         JSON array of MusicBrainz release-group MBIDs (at most 5000 unique)
  --from-plan <path>        Sealed backfill plan; its noSource release groups are fetched
  --plan-sha256 <sha>       planSha256 of --from-plan
  --cache-dir <path>        Private resumable cache (reused for 7 days; rerun to resume)
  --out <path>              New evidence file (never overwritten)
  --budget-minutes <n>      Stop after this many minutes, keeping the cache (default 30)
  --help                    Show this help

Exit codes: 0 every ID resolved; 2 evidence written with unresolved or
deferred IDs; 1 nothing written (invalid input, interruption, budget,
MusicBrainz throttle, or repeated transient failures).

A MusicBrainz pause is recorded in the cache directory and enforced only
for runs that use the same --cache-dir; reuse it rather than starting a new
one. Run one fetch at a time per network address. Pressing Ctrl-C twice
exits immediately; the next run then removes the dead process's lock.`;

function parseArgs(argv = []) {
  const options = { idsFile: "", fromPlan: "", planSha256: "", cacheDir: "", out: "", budgetMinutes: undefined, help: false };
  const flags = { "--ids-file": "idsFile", "--from-plan": "fromPlan", "--plan-sha256": "planSha256", "--cache-dir": "cacheDir", "--out": "out", "--budget-minutes": "budgetMinutes" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const key = flags[argument];
    if (!key) throw new EnrichmentStop(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
    if (seen.has(argument)) throw new EnrichmentStop(`${argument} may only be supplied once`, "INVALID_ARGUMENTS");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new EnrichmentStop(`${argument} requires a value`, "INVALID_ARGUMENTS");
    seen.add(argument);
    options[key] = value;
    index += 1;
  }
  if (options.help) return options;
  if (Boolean(options.idsFile) === Boolean(options.fromPlan)) throw new EnrichmentStop("Supply exactly one of --ids-file or --from-plan", "INVALID_ARGUMENTS");
  if (Boolean(options.fromPlan) !== Boolean(options.planSha256)) throw new EnrichmentStop("--from-plan and --plan-sha256 must be supplied together", "INVALID_ARGUMENTS");
  if (options.planSha256) {
    options.planSha256 = options.planSha256.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(options.planSha256)) throw new EnrichmentStop("--plan-sha256 must be a SHA-256 hex digest", "INVALID_ARGUMENTS");
  }
  if (!options.cacheDir) throw new EnrichmentStop("--cache-dir <private-directory> is required", "INVALID_ARGUMENTS");
  if (!options.out) throw new EnrichmentStop("--out <new-evidence.json> is required", "INVALID_ARGUMENTS");
  options.budgetMinutes = validateBudgetMinutes(options.budgetMinutes);
  const input = path.resolve(options.idsFile || options.fromPlan);
  if (path.resolve(options.out) === input) throw new EnrichmentStop("--out must not be the input file", "INVALID_ARGUMENTS");
  if (path.resolve(options.cacheDir) === input) throw new EnrichmentStop("--cache-dir must not be the input file", "INVALID_ARGUMENTS");
  return options;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  const processRef = dependencies.process || process;
  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) processRef.exit(130);
    output.error("Stopping after the current request; the cache is kept and no evidence is written.");
    controller.abort();
  };
  try {
    const options = parseArgs(argv);
    if (options.help) {
      output.log(USAGE);
      return 0;
    }
    // Every ID is validated before any network request.
    const request = options.idsFile ? readIdsFile(options.idsFile) : readPlanNoSourceIds(options.fromPlan, options.planSha256);
    output.log(`Release groups to resolve: ${request.ids.length}`);
    processRef.on("SIGINT", onSignal);
    processRef.on("SIGTERM", onSignal);
    const result = await (dependencies.runReleaseGroupEnrichment || runReleaseGroupEnrichment)({
      ...(dependencies.runOptions || {}),
      ids: request.ids,
      originPlanSha256: request.originPlanSha256,
      cacheDir: options.cacheDir,
      outPath: options.out,
      budgetMinutes: options.budgetMinutes,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.completed % 25 === 0 || progress.completed === progress.total) {
          output.log(`Resolved ${progress.completed}/${progress.total} (${progress.cached} cached, ${progress.unresolved} unresolved, ${progress.deferred} deferred)`);
        }
      },
    });
    const { evidence } = result;
    output.log(JSON.stringify({
      evidence: result.outPath,
      evidenceSha256: evidence.evidenceSha256,
      datasetId: evidence.datasetId,
      counts: evidence.counts,
      failureReasons: evidence.failureReasons,
    }, null, 2));
    output.log(`Review ${result.outPath}, then plan with:\n  npm run catalog:backfill-artists -- --enrichment ${result.outPath} --out <new-plan.json>`);
    return evidenceExitCode(evidence);
  } catch (error) {
    output.error(`${error.code || "ENRICHMENT_FAILED"}: ${error.message}`);
    if (error.notBefore) output.error(`Do not rerun before ${error.notBefore}.`);
    if (error.cooldownWriteError) output.error(`Could not record the cooldown (${error.cooldownWriteError}); wait before rerunning.`);
    if (error.progress) output.error(`Progress kept in the cache: ${JSON.stringify(error.progress)}`);
    if (Array.isArray(error.details) && error.details.length) output.error(JSON.stringify(error.details, null, 2));
    return 1;
  } finally {
    processRef.off?.("SIGINT", onSignal);
    processRef.off?.("SIGTERM", onSignal);
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { USAGE, main, parseArgs };
