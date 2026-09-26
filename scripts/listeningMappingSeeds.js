#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { digest, targetFingerprint, prepareSeedPlan, verifySeedPlan, applySeedPlan } = require("../lib/listening/seeds");

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--dry-run" || name === "--apply") {
      if (options.mode) throw new Error("ONE_MODE_REQUIRED");
      options.mode = name.slice(2);
    } else if (["--bindings", "--output", "--plan", "--sha256", "--environment", "--confirm-environment", "--reviewer"].includes(name)) {
      if (options[name] || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("INVALID_ARGUMENTS");
      options[name] = args[++index];
    } else throw new Error("INVALID_ARGUMENTS");
  }
  if (!options.mode || !/^[\w-]{1,80}$/.test(options["--environment"] || "")) throw new Error("MODE_AND_NAMED_ENVIRONMENT_REQUIRED");
  if (options.mode === "dry-run" && (!options["--bindings"] || !options["--output"])) throw new Error("BINDINGS_AND_OUTPUT_REQUIRED");
  if (options.mode === "apply" && (!options["--plan"] || !options["--sha256"] || !options["--reviewer"] || options["--confirm-environment"] !== options["--environment"])) throw new Error("EXPLICIT_APPLY_CONFIRMATION_REQUIRED");
  return options;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  const models = require("../models/Listening");
  const AlbumCatalog = require("../models/AlbumCatalog");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try {
    const fingerprint = targetFingerprint(mongoose.connection);
    if (options.mode === "dry-run") {
      const bindings = JSON.parse(fs.readFileSync(options["--bindings"], "utf8"));
      const plan = await prepareSeedPlan({ bindings, environment: options["--environment"], fingerprint, AlbumCatalog, ...models });
      const bytes = JSON.stringify(plan, null, 2) + "\n";
      fs.writeFileSync(path.resolve(options["--output"]), bytes, { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ mode: "dry-run", environment: plan.environment, count: plan.entries.length, sha256: digest(bytes) }));
    } else {
      const bytes = fs.readFileSync(options["--plan"], "utf8");
      const plan = verifySeedPlan(bytes, options["--sha256"], options["--environment"], fingerprint);
      // Index provisioning is a write and belongs only to the explicitly authorized apply.
      await Promise.all([models.MappingCase, models.AlbumMapping, models.MappingAudit, models.Job].map((Model) => Model.createIndexes()));
      const result = await applySeedPlan(plan, { reviewer: options["--reviewer"], mongoose, AlbumCatalog, models });
      console.log(JSON.stringify({ ...result, committed: true, sha256: options["--sha256"] }));
    }
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch((error) => {
  const code = /^[A-Z_]+$/.test(error.code || error.message || "") ? (error.code || error.message) : "MAPPING_SEEDS_FAILED";
  console.error(code); process.exitCode = 1;
});
module.exports = { parseArgs, main };
