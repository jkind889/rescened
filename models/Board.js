const crypto = require("node:crypto");
const mongoose = require("mongoose");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const boardSchema = new mongoose.Schema(
  {
    // Public, immutable identity. Mongo's _id remains an internal relation
    // key for board items and profile pins.
    // Do not generate an ID merely while hydrating a legacy document.
    boardId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      default: function defaultBoardId() { return this.isNew ? crypto.randomUUID() : undefined; },
      match: UUID_V4,
    },
    userId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    interactionRevision: { type: Number, default: 0, select: false },
  },
  { timestamps: true },
);

boardSchema.statics.isBoardId = function isBoardId(boardId) {
  return UUID_V4.test(String(boardId || "").trim());
};

boardSchema.index({ userId: 1, updatedAt: -1 });
// users limited to only one default board
boardSchema.index(
  { userId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

const Board = mongoose.model("Board", boardSchema);

module.exports = Board;
