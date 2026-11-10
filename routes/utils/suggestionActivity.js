const AlbumSubmission = require("../../models/AlbumSubmission");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { UUID_V4 } = require("./albumCatalog");
const { APPROVAL_PUBLICATION_TYPES, serializeApprovedFeedItem } = require("./submissions");

// Approval is already an atomic, durable event. Read it rather than writing a
// second activity record, so retries cannot duplicate it. Callers enforce
// profile visibility; only the contributor, never the moderator, is credited.
async function getSuggestionActivity(userIds, limit) {
  if (!userIds.length) return [];
  const rows = await AlbumSubmission.aggregate([
    { $match: {
      submittedByUserId: { $in: userIds },
      status: "approved",
      approvedAt: { $type: "date" },
      approvalPublicationType: { $in: APPROVAL_PUBLICATION_TYPES },
      submissionId: UUID_V4,
    } },
    { $sort: { approvedAt: -1, submissionId: -1 } },
    { $lookup: { from: AlbumCatalog.collection.name, localField: "approvedAlbumCatalogId", foreignField: "_id", as: "approvedAlbum" } },
    // Missing or non-public catalog records must not consume a feed slot.
    { $unwind: "$approvedAlbum" },
    { $match: { "approvedAlbum.albumId": UUID_V4 } },
    { $limit: limit },
    { $project: {
      _id: 0, submissionId: 1, submittedByUserId: 1, status: 1,
      approvedAt: 1, approvalPublicationType: 1,
      approvedAlbumCatalogId: "$approvedAlbum",
    } },
  ]);
  return rows.flatMap((row) => {
    const item = serializeApprovedFeedItem(row);
    return item ? [{
      id: `suggestion:${item.submissionId}`,
      type: "suggestion_approved",
      userId: row.submittedByUserId,
      createdAt: item.approvedAt,
      submissionId: item.submissionId,
      publicationType: item.publicationType,
      album: item.album,
    }] : [];
  });
}

module.exports = { getSuggestionActivity };
