#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const files = [
  "tests/contributorEditions.integration.test.js",
  "tests/albumBaselines.integration.test.js",
  "tests/listeningBaselines.integration.test.js",
  "tests/listeningWorker.integration.test.js",
  "tests/listeningMeasurement.integration.test.js",
  "tests/reviewObservations.integration.test.js",
  "tests/listeningDetection.integration.test.js",
  "tests/listeningPublication.integration.test.js",
  "tests/listeningApi.integration.test.js",
  "tests/listeningSeeds.integration.test.js",
  "tests/listeningDiary.integration.test.js",
  "tests/listenQueue.integration.test.js",
  "tests/boardOrder.integration.test.js",
  "tests/boardNotes.integration.test.js",
  "tests/dataExport.integration.test.js",
  "tests/accountDeletion.integration.test.js",
  "tests/searchQuality.integration.test.js",
  "tests/benchmarks.integration.test.js",
  "tests/moderation.integration.test.js",
  "tests/coverBackfill.integration.test.js",
  "tests/catalogImport.integration.test.js",
  "tests/artistIdentity.integration.test.js",
  "tests/artistPages.integration.test.js",
  "tests/artistDiscography.integration.test.js",
  "tests/legacyMigration.integration.test.js",
  "tests/reviews.integration.test.js",
  "tests/notifications.integration.test.js",
  "tests/reviewComments.integration.test.js",
  "tests/profileNetwork.integration.test.js",
  "tests/suggestionActivity.integration.test.js",
  "tests/trackRankings.integration.test.js",
  "tests/listeningStats.integration.test.js",
  "tests/genres.integration.test.js",
  "tests/genreSuggestions.integration.test.js",
  "tests/genreApproval.integration.test.js",
  "tests/genreVocabulary.integration.test.js",
  "tests/genreBrowse.integration.test.js",
];
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, RUN_MONGO_INTEGRATION: "true" },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
