const Listen = require("../../models/Listen");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { normalizeCatalogAlbum } = require("./albumCatalog");

async function getListenActivity(userIds, limit) {
  const listens = await Listen.aggregate([
    { $match: { userId: { $in: userIds } } },
    { $sort: { createdAt: -1, _id: -1 } },
    { $lookup: { from: AlbumCatalog.collection.name, localField: "albumCatalogId", foreignField: "_id", as: "catalogAlbum" } },
    // Deleted catalog albums must neither produce broken links nor consume slots.
    { $unwind: "$catalogAlbum" },
    { $limit: limit },
    { $project: { _id: 0, listenId: 1, userId: 1, createdAt: 1, listenedOn: 1, catalogAlbum: 1 } },
  ]);
  return listens.map((listen) => ({
    id: listen.listenId,
    listenId: listen.listenId,
    type: "listen",
    userId: listen.userId,
    createdAt: listen.createdAt,
    listenedOn: listen.listenedOn,
    album: normalizeCatalogAlbum(listen.catalogAlbum),
  }));
}

module.exports = { getListenActivity };
