const crypto = require("node:crypto");
const mongoose = require("mongoose");

const mbid = { type: String, required: true, lowercase: true, match: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu };

const trackSchema = new mongoose.Schema({
  trackId: { type: String, required: true, default: () => crypto.randomUUID(), match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu },
  discNumber: { type: Number, required: true, min: 1, max: 999 },
  trackNumber: { type: Number, required: true, min: 1, max: 999 },
  title: { type: String, required: true, trim: true, maxlength: 500 },
  durationMs: { type: Number, default: 0, min: 0, max: 86400000 },
  artistDisplayName: { type: String, default: "", trim: true, maxlength: 500 },
  releaseTrackMbid: mbid,
  recordingMbid: mbid,
}, { _id: false, strict: "throw" });

const candidateSchema = new mongoose.Schema({
  releaseMbid: mbid,
  releaseGroupMbid: mbid,
  title: { type: String, required: true, trim: true, maxlength: 500 },
  artistDisplayName: { type: String, required: true, trim: true, maxlength: 500 },
  date: { type: String, default: "", maxlength: 10 },
  country: { type: String, default: "", maxlength: 10 },
  formats: { type: [String], default: [] },
  disambiguation: { type: String, default: "", maxlength: 500 },
  status: { type: String, default: "", maxlength: 100 },
  tracks: { type: [trackSchema], required: true },
  retrievedAt: { type: Date, required: true },
  sourceUrl: { type: String, required: true, maxlength: 2048 },
  license: { type: String, required: true, enum: ["CC0"] },
  tracklistHash: { type: String, required: true, match: /^[0-9a-f]{64}$/iu },
}, { _id: false, strict: "throw" });

module.exports = candidateSchema;
