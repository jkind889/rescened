#!/usr/bin/env node
const mongoose = require("mongoose");
const ListeningModels = require("../models/Listening");
const { runWorkerOnce, scheduleDueDetectionJobs, scheduleDueSweepJobs, scheduleDueSyncJobs, scheduleStaleMappingJobs } = require("../lib/listening/worker");

const IDLE_DELAY_MS = 5_000;
const BUSY_DELAY_MS = 250;
// Syncs are due every few minutes and connect/resume enqueue their own first
// sync, so the schedule scans do not need to run on every loop.
const SCHEDULE_INTERVAL_MS = 60_000;
const FAILURE_BACKOFF_MS = 5_000;
const MAX_FAILURE_BACKOFF_MS = 5 * 60_000;
const JOBS_PER_PASS = 100;

// Codes and error class names only: messages can carry connection strings.
function errorCode(error, fallback) {
  return String(error?.code || error?.name || fallback);
}

function failureDelay(consecutiveFailures) {
  return Math.min(FAILURE_BACKOFF_MS * (2 ** Math.max(0, consecutiveFailures - 1)), MAX_FAILURE_BACKOFF_MS);
}

async function main(options = {}) {
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const log = options.log || ((line) => process.stderr.write(`${line}\n`));
  const connect = options.connect || ((uri) => mongoose.connect(uri));
  const disconnect = options.disconnect || (() => mongoose.disconnect());
  const initialize = options.initialize || (() => Promise.all(Object.values(ListeningModels).map((Model) => Model.init())));
  const schedulers = options.schedulers || [scheduleDueSyncJobs, scheduleDueSweepJobs, scheduleDueDetectionJobs, scheduleStaleMappingJobs];
  const runOnce = options.runWorkerOnce || runWorkerOnce;
  const signals = options.signals || process;

  const uri = env.MONGO_URI;
  if (!uri) throw Object.assign(new Error("MONGO_URI is required"), { code: "MONGO_URI_REQUIRED" });
  await connect(uri);
  await initialize();

  let stopping = false;
  let wake = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  // Sleeps are cut short by a stop signal so a long backoff never delays shutdown.
  const sleep = options.sleep || ((ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  }).finally(() => { wake = null; }));
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);

  let lastScheduledAt = -Infinity;
  let consecutiveFailures = 0;
  try {
    while (!stopping) {
      let processed = 0;
      // A transient database error (failover, network blip) must not end the
      // worker: log it, back off, and try again. Unfinished jobs keep their
      // lease and are retaken when it expires.
      try {
        if (clock() - lastScheduledAt >= SCHEDULE_INTERVAL_MS) {
          for (const schedule of schedulers) await schedule({ env });
          lastScheduledAt = clock();
        }
        for (; processed < JOBS_PER_PASS && !stopping; processed += 1) {
          const result = await runOnce({ env });
          if (!result.processed) break;
        }
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const delay = failureDelay(consecutiveFailures);
        log(`Listening worker pass failed: ${errorCode(error, "LISTENING_WORKER_PASS_FAILED")} (attempt ${consecutiveFailures}, retrying in ${Math.round(delay / 1000)}s)`);
        if (!stopping) await sleep(delay);
        continue;
      }
      if (!stopping) await sleep(processed ? BUSY_DELAY_MS : IDLE_DELAY_MS);
    }
  } finally {
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Listening worker stopped: ${errorCode(error, "LISTENING_WORKER_STOPPED")}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, failureDelay, FAILURE_BACKOFF_MS, MAX_FAILURE_BACKOFF_MS, SCHEDULE_INTERVAL_MS };
