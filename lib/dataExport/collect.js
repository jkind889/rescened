const AlbumCatalog = require("../../models/AlbumCatalog");
const Board = require("../../models/Board");
const Listen = require("../../models/Listen");
const Review = require("../../models/Reviews");
const { normalizeCatalogAlbum } = require("../../routes/utils/albumCatalog");
const { formatBoards } = require("../../routes/utils/boardLibrary");
const { fail } = require("../../routes/utils/diaryValidation");

const BATCH_SIZE = 500;
const MAX_EXPORT_ROWS = 50000;
const ALBUM_FIELDS = "albumId title artistDisplayName";

function tooLarge() {
  return fail(413, "EXPORT_TOO_LARGE", `Exports are limited to ${MAX_EXPORT_ROWS.toLocaleString("en-US")} rows.`);
}

// Albums for one batch, keyed by internal _id. Only public fields leave here.
async function catalogAlbums(docs) {
  const ids = [...new Set(docs.map((doc) => String(doc.albumCatalogId)))];
  const albums = await AlbumCatalog.find({ _id: { $in: ids } }, ALBUM_FIELDS).lean();
  return new Map(albums.map((album) => [String(album._id), normalizeCatalogAlbum(album)]));
}

// Streams one user's documents in BATCH_SIZE pages along the given index
// order, resolving each page's catalog albums with one read.
async function collectBatches(cursor, take) {
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const albums = await catalogAlbums(batch);
    for (const doc of batch) take(doc, albums.get(String(doc.albumCatalogId)) || null);
    batch = [];
  };
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length === BATCH_SIZE) await flush();
  }
  await flush();
}

function userCursor(Model, userId, projection, sort) {
  return Model.find({ userId }, projection).sort(sort).lean().cursor({ batchSize: BATCH_SIZE });
}

// A review keeps its row when its album is gone: the text is the user's own.
async function collectReviews(userId) {
  const items = [];
  await collectBatches(
    userCursor(Review, userId, "reviewId albumCatalogId rating reviewText date editedAt", { date: -1, _id: -1 }),
    (review, album) => {
      if (items.length === MAX_EXPORT_ROWS) throw tooLarge();
      items.push({ review, album });
    },
  );
  return { items };
}

// A listen whose album is gone has no public album to name, so it is counted
// in omitted instead, matching the diary, which hides it too.
async function collectListens(userId) {
  const items = [];
  let omitted = 0;
  await collectBatches(
    userCursor(Listen, userId, "listenId albumCatalogId listenedOn source createdAt", { listenedOn: -1, createdAt: -1, _id: -1 }),
    (listen, album) => {
      if (!album?.albumId) { omitted += 1; return; }
      if (items.length === MAX_EXPORT_ROWS) throw tooLarge();
      items.push({ listen, album });
    },
  );
  return { items, omitted };
}

// Membership, order, and live-membership checks come from boardLibrary, the
// same reads the profile's board pages use.
async function collectBoards(userId) {
  const boards = await Board.find({ userId }, "boardId userId title description isDefault orderMode displayStyle albumOrder")
    .sort({ isDefault: -1, updatedAt: -1 }).limit(MAX_EXPORT_ROWS + 1).lean();
  if (boards.length > MAX_EXPORT_ROWS) throw tooLarge();
  const items = await formatBoards(boards, { albums: true, maxRows: MAX_EXPORT_ROWS, albumFields: ALBUM_FIELDS, batchSize: BATCH_SIZE });
  return { items };
}

const collectors = { reviews: collectReviews, listens: collectListens, boards: collectBoards };

function collectExport(dataset, userId) {
  return collectors[dataset](userId);
}

module.exports = { BATCH_SIZE, MAX_EXPORT_ROWS, collectExport };
