#!/usr/bin/env node
// Clears private review-episode records (docs/LASTFM_SYNC.md, "Monitoring"). Dry run by default:
// it counts what a clear would remove up to a cutoff and changes nothing. --apply needs the dry
// run's exact cutoff and count and the connected database's name, and removes only ReviewEpisode
// records. Moderation audit history, mappings, baselines and every other collection are never touched.
const mongoose = require("mongoose");

const USAGE = "Usage: clearReviewEpisodes.js [--cutoff ISO_INSTANT] [--apply --cutoff ISO_INSTANT --confirm-count N --confirm-database NAME]";
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

class ClearError extends Error {
  constructor(code) { super(code); this.name = "ClearError"; this.code = code; }
}

function parseArgs(argv) {
  const args = { apply: false, cutoff: null, database: "", count: null }; const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--apply" && !args.apply) args.apply = true;
    else if (flag === "--cutoff" && rest.length && !args.cutoff) {
      const value = rest.shift();
      const parsed = ISO_INSTANT.test(value) ? new Date(value) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new ClearError(USAGE);
      args.cutoff = parsed;
    } else if (flag === "--confirm-database" && rest.length && !args.database) args.database = rest.shift();
    else if (flag === "--confirm-count" && rest.length && args.count === null && /^\d{1,9}$/u.test(rest[0])) args.count = Number(rest.shift());
    else throw new ClearError(USAGE);
  }
  // The confirmations belong to an apply, and an apply needs all of them.
  if (args.apply ? !(args.cutoff && args.database && args.count !== null) : Boolean(args.database || args.count !== null)) throw new ClearError(USAGE);
  return args;
}

// Records written at or before the cutoff; later decisions keep their episodes.
async function clearReviewEpisodes({ apply = false, cutoff = null, database = "", count = null, now = new Date(), connection = mongoose.connection, Episode = require("../models/ReviewObservation").Episode, audits = [require("../models/Listening").MappingAudit, require("../models/AlbumBaseline").Audit] } = {}) {
  if (cutoff && cutoff > now) throw new ClearError("CLEAR_CUTOFF_IN_FUTURE");
  const name = connection.db?.databaseName || connection.name || "";
  const until = cutoff || now;
  const filter = { recordedAt: { $lte: until } };
  const matched = await Episode.countDocuments(filter);
  const summary = { mode: apply ? "apply" : "dry-run", database: name, cutoff: until.toISOString(), episodes: matched };
  if (!apply) return { ...summary, next: "Review this count, then rerun with --apply --cutoff <cutoff> --confirm-count <episodes> --confirm-database <database>." };
  if (database !== name) throw new ClearError("CLEAR_DATABASE_MISMATCH");
  // Episodes recorded at or before a past cutoff can only expire, never appear, after the dry run.
  if (matched !== count) throw new ClearError("CLEAR_COUNT_CHANGED");
  const auditsBefore = await Promise.all(audits.map((model) => model.countDocuments()));
  const result = await Episode.deleteMany(filter);
  const auditsAfter = await Promise.all(audits.map((model) => model.countDocuments()));
  // Audit entries are append-only; concurrent decisions may add some while the clear runs.
  return { ...summary, deleted: result.deletedCount, auditEntriesNotReduced: auditsAfter.every((value, index) => value >= auditsBefore[index]) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGO_URI) throw new ClearError("MONGO_URI_REQUIRED");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try { console.log(JSON.stringify(await clearReviewEpisodes(args), null, 2)); }
  finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch((error) => { console.error(error instanceof ClearError ? error.message : "REVIEW_EPISODE_CLEAR_FAILED"); process.exitCode = 1; });
module.exports = { ClearError, clearReviewEpisodes, parseArgs };
