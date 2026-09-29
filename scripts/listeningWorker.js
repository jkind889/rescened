#!/usr/bin/env node
const mongoose = require("mongoose");
const ListeningModels = require("../models/Listening");
const { runWorkerOnce, scheduleDueDetectionJobs, scheduleDueSweepJobs, scheduleDueSyncJobs, scheduleStaleMappingJobs } = require("../lib/listening/worker");

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main(options = {}) {
  const env = options.env || process.env;
  const uri = env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is required");
  await mongoose.connect(uri);
  await Promise.all(Object.values(ListeningModels).map((Model) => Model.init()));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      await scheduleDueSyncJobs({ env });
      await scheduleDueSweepJobs({ env });
      await scheduleDueDetectionJobs({ env });
      await scheduleStaleMappingJobs();
      let processed = 0;
      for (; processed < 100 && !stopping; processed += 1) {
        const result = await runWorkerOnce({ env });
        if (!result.processed) break;
      }
      if (!stopping) await delay(processed ? 250 : 5_000);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Listening worker stopped: ${String(error?.code || "LISTENING_WORKER_STOPPED")}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
