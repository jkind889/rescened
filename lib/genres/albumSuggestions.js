// Optional genres travel with a new album proposal. They are not published
// with the album: approval queues a separate, linked genre review in the same
// transaction, preserving the existing per-operation moderation workflow.
const crypto = require("node:crypto");
const AlbumSubmission = require("../../models/AlbumSubmission");
const { Genre } = require("../../models/Genre");
const { SubmissionValidationError } = require("../../routes/utils/submissions");
const { ModerationConflictError } = require("../../routes/utils/moderation");
const { isGenresEnabled } = require("../../routes/utils/serverConfig");
const {
  normalizeGenreSuggestion,
  genreSuggestionFields,
  genreSuggestionSnapshot,
  openGenreSuggestionKey,
} = require("./suggestions");

async function normalizeAlbumGenreProposal(value, options) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubmissionValidationError("proposedGenres must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!["add", "note"].includes(key)) throw new SubmissionValidationError(`proposedGenres.${key} is not allowed`);
  }
  if (!isGenresEnabled()) {
    const error = new Error("Genres are currently disabled; remove the optional genres to submit the album alone");
    error.status = 503;
    error.code = "GENRES_DISABLED";
    throw error;
  }
  // An empty, ephemeral target allows the shared vocabulary validator to
  // validate additions and primary choice without creating a catalog record.
  const albumId = crypto.randomUUID();
  const payload = await normalizeGenreSuggestion({ ...value, albumId }, { albumId, genres: [], genresRevision: 0 }, options);
  return payload.genreChanges;
}

async function queueAlbumGenreProposal({ submission, album, submittedAt, session }) {
  if (!submission.genreChanges?.additions?.length) return null;
  const key = openGenreSuggestionKey(submission.submittedByUserId, album);
  const existing = await AlbumSubmission.findOne({ openGenreSuggestionKey: key }).session(session).select("submissionId").lean();
  if (existing) {
    throw new ModerationConflictError(
      "The contributor already has an open genre suggestion for this album. Ask them to withdraw it or remove the genres from this album proposal before approving.",
      "GENRE_SUGGESTION_EXISTS",
    );
  }
  const rows = album.genres?.length ? await Genre.find({ _id: { $in: album.genres } }).session(session).lean() : [];
  const byId = new Map(rows.map((genre) => [String(genre._id), genre]));
  const genres = (album.genres || []).map((id) => byId.get(String(id))).filter(Boolean)
    .map(({ genreId, slug, name }) => ({ genreId, slug, name }));
  const payload = {
    targetAlbumCatalogId: album._id,
    genreBaseline: { genres, genresRevision: album.genresRevision || 0 },
    genreChanges: submission.genreChanges,
    normalizedFingerprint: crypto.createHash("sha256").update(JSON.stringify({
      sourceAlbumSubmissionId: submission.submissionId,
      revision: submission.currentRevision,
      albumId: album.albumId,
      changes: submission.genreChanges,
    })).digest("hex"),
  };
  const [created] = await AlbumSubmission.create([{
    submittedByUserId: submission.submittedByUserId,
    sourceAlbumSubmissionId: submission.submissionId,
    ...genreSuggestionFields(payload, 1, "pending"),
    openGenreSuggestionKey: key,
    revisions: [genreSuggestionSnapshot(payload, submittedAt, 1)],
    moderationHistory: [{ actorUserId: submission.submittedByUserId, action: "submitted", reason: "Submitted with the album proposal; queued after album approval.", createdAt: submittedAt }],
  }], { session });
  return created.submissionId;
}

module.exports = { normalizeAlbumGenreProposal, queueAlbumGenreProposal };
