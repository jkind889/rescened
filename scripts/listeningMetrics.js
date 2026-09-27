#!/usr/bin/env node
const mongoose = require("mongoose");
const { catalogRevisionOf } = require("../lib/listening/common");
const { Connection, Scrobble, MappingCase, AlbumMapping, Job } = require("../models/Listening");

async function collectMetrics(now = new Date()) {
  const active = await Connection.find({ state: "active" }).select("_id connectedAt completedThrough lastSuccessfulSync").lean();
  const names = await Scrobble.aggregate([
    { $match: { connectionId: { $in: active.map((connection) => connection._id) }, expiresAt: { $gt: now }, artistKey: { $ne: "" }, albumKey: { $ne: "" } } },
    { $group: { _id: { artist: "$artistKey", album: "$albumKey" } } },
  ]);
  const mappings = await AlbumMapping.find({ status: "active", key: { $in: names.map(({ _id }) => JSON.stringify(["lastfm", _id.artist, _id.album])) } }).select("albumId catalogRevision").lean();
  const AlbumCatalog = require("../models/AlbumCatalog");
  const albums = await AlbumCatalog.find({ albumId: { $in: mappings.map((mapping) => mapping.albumId) } }).select("albumId catalogRevision").lean();
  const revisions = new Map(albums.map((album) => [album.albumId, catalogRevisionOf(album)]));
  const covered = mappings.filter((mapping) => revisions.get(mapping.albumId) === mapping.catalogRevision).length;
  const oldest = await MappingCase.findOne({ status: "pending" }).sort({ createdAt: 1 }).select("createdAt").lean();
  return {
    observedAt: now.toISOString(), activeConnections: active.length,
    maximumSyncLagSeconds: active.length ? Math.max(...active.map((connection) => Math.max(0, (now - new Date(connection.completedThrough || connection.lastSuccessfulSync || connection.connectedAt)) / 1000))) : 0,
    incompleteWindows: await Job.countDocuments({ type: "sync", status: { $in: ["pending", "running"] }, "progress.window": { $exists: true }, "payload.connectionId": { $in: active.map((connection) => String(connection._id)) } }),
    eligibleObservedNames: names.length, approvedObservedNames: covered,
    approvedNameCoverage: names.length ? covered / names.length : null,
    unresolvedObservedNames: names.length - covered,
    baselineUnavailableNames: covered,
    pendingCases: await MappingCase.countDocuments({ status: "pending" }),
    oldestQueueAgeSeconds: oldest ? Math.max(0, (now - oldest.createdAt) / 1000) : 0,
    revokedMappings: await AlbumMapping.countDocuments({ status: "revoked" }),
    deferredJobs: await Job.countDocuments({ status: "pending", runAt: { $gt: now } }),
    expiredLeases: await Job.countDocuments({ status: "running", leaseUntil: { $lt: now } }),
    providerErrors: await Connection.countDocuments({ "error.code": { $exists: true, $nin: [null, ""] } }),
    throttledJobs: await Job.countDocuments({ status: "pending", error: /budget|throttl|rate_limit/i }),
  };
}

async function main() {
  if (process.argv[2] !== "--environment" || !/^[\w-]{1,80}$/.test(process.argv[3] || "") || process.argv.length !== 4) throw new Error("Usage: listeningMetrics.js --environment NAME");
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI_REQUIRED");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try { console.log(JSON.stringify({ environment: process.argv[3], ...await collectMetrics() }, null, 2)); }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error("LISTENING_METRICS_FAILED"); process.exitCode = 1; });
module.exports = { collectMetrics };
