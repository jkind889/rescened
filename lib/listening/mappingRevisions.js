const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { catalogRevisionOf } = require("./common");

const STATE_SCAN_LIMIT = 10_000;

function models() { return require("../../models/Listening"); }
function withSession(query, session) { return session && typeof query?.session === "function" ? query.session(session) : query; }

// An active mapping is stale when its album is gone or has moved past the
// catalog revision the moderator reviewed. Stale mappings resolve nothing until
// a moderator reconfirms or revokes them.
async function activeMappingStates(filter = {}) {
  const { AlbumMapping } = models();
  const mappings = await AlbumMapping.find({ ...filter, status: "active" })
    .select("key mappingId revision albumId catalogRevision").limit(STATE_SCAN_LIMIT).lean();
  if (!mappings.length) return [];
  const albums = await AlbumCatalog.find({ albumId: { $in: [...new Set(mappings.map((row) => row.albumId))] } })
    .select("albumId catalogRevision").lean();
  const revisions = new Map(albums.map((row) => [row.albumId, catalogRevisionOf(row)]));
  return mappings.map((row) => {
    const currentCatalogRevision = revisions.get(row.albumId) ?? null;
    return { ...row, currentCatalogRevision, stale: currentCatalogRevision !== row.catalogRevision };
  });
}

// Moves active mappings reviewed at `fromRevision` to `toRevision` after a
// catalog change that cannot alter album identity (a filled cover), and queues
// reprocessing so cached resolutions pick up the new revision. Mappings
// reviewed at any other revision are already stale and stay that way.
async function carryMappingsForward({ albumId, fromRevision, toRevision, session = null, now = new Date() }) {
  const { AlbumMapping, Job } = models();
  const mappings = await withSession(
    AlbumMapping.find({ albumId, status: "active", catalogRevision: fromRevision }).select("key mappingId revision"),
    session,
  ).lean();
  let carried = 0;
  for (const mapping of mappings) {
    const updated = await AlbumMapping.updateOne(
      { _id: mapping._id, revision: mapping.revision, status: "active", catalogRevision: fromRevision },
      { $set: { catalogRevision: toRevision } },
      { session },
    );
    if (updated.modifiedCount !== 1) continue;
    carried += 1;
    const key = `reprocess:catalog:${mapping.mappingId}:${mapping.revision}:${toRevision}`;
    await Job.updateOne(
      { key },
      { $setOnInsert: { key, type: "reprocess", payload: { key: mapping.key, mappingId: mapping.mappingId, mappingRevision: mapping.revision }, status: "pending", runAt: now, attempts: 0, progress: {}, error: "" } },
      { upsert: true, session },
    );
  }
  return carried;
}

// A cover write cannot change album identity or the reviewed tracklist, so the
// reviewed baseline and active mappings follow the album to its new revision
// together. Nothing is carried if the album has already moved past
// `toRevision`; those records stay stale for review.
async function carryCoverRevision({ albumId, fromRevision, toRevision, now = new Date() }) {
  const session = await mongoose.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      result = { baselineCarried: false, mappingsCarried: 0 };
      const album = await AlbumCatalog.findOne({ albumId, catalogRevision: toRevision }).select("_id").session(session).lean();
      if (!album) return;
      // Baseline first: the reprocess jobs queued for carried mappings must see it.
      result.baselineCarried = await require("../baselines/service").carryReviewedBaseline({
        albumId, fromRevision, toRevision, session,
        actorUserId: "system:cover-backfill", reason: "A cover update cannot change the reviewed tracklist",
      });
      result.mappingsCarried = await carryMappingsForward({ albumId, fromRevision, toRevision, session, now });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { activeMappingStates, carryCoverRevision, carryMappingsForward };
