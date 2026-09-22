#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const files = [
  "tests/listeningDiary.integration.test.js",
  "tests/searchQuality.integration.test.js",
  "tests/benchmarks.integration.test.js",
  "tests/moderation.integration.test.js",
  "tests/coverBackfill.integration.test.js",
  "tests/catalogImport.integration.test.js",
  "tests/legacyMigration.integration.test.js",
  "tests/reviews.integration.test.js",
  "tests/profileNetwork.integration.test.js",
];
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, RUN_MONGO_INTEGRATION: "true" },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
