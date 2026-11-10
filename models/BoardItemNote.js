const mongoose = require("mongoose");
const { BOARD_NOTE_LIMIT, normalizeBoardNote, boardNoteLength } = require("../lib/boardNoteText");

// Metadata only: a note never creates a saved album or a listen membership.
const schema = new mongoose.Schema({
  userId: { type: String, required: true },
  boardId: { type: mongoose.Schema.Types.ObjectId, ref: "Board", required: true },
  albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
  note: { type: String, required: true, validate: {
    validator: (value) => value === normalizeBoardNote(value) && boardNoteLength(value) <= BOARD_NOTE_LIMIT,
    message: "Board notes must be single-line text of 100 characters or fewer",
  } },
});
schema.index({ boardId: 1, albumCatalogId: 1 }, { unique: true });
schema.index({ userId: 1 });
module.exports = mongoose.model("BoardItemNote", schema);
