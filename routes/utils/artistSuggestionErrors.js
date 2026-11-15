const { ArtistProposalValidationError } = require("../../lib/artists/proposals");
const { ModerationConflictError, ModerationValidationError } = require("./moderation");

// Shared error responses for the artist suggestion routes.
function sendArtistSuggestionError(res, error, fallback) {
  if (error instanceof ArtistProposalValidationError || error instanceof ModerationValidationError) {
    return res.status(400).json({ error: error.message, code: error.code, ...(error.details?.length ? { details: error.details } : {}) });
  }
  if (error instanceof ModerationConflictError) {
    return res.status(409).json({
      error: error.message,
      code: error.code,
      ...(error.details?.length ? { details: error.details } : {}),
      // The artist already on Rescened, so the page can link to it.
      ...(error.code === "ARTIST_ALREADY_EXISTS" && error.details?.[0]?.artistId ? { existingArtist: error.details[0] } : {}),
    });
  }
  if (Number.isInteger(error?.retryAfterSeconds)) res.set("Retry-After", String(error.retryAfterSeconds));
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 503 && error.code) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(Number.isInteger(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
  }
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(400).json({ error: "Artist suggestion data is invalid", code: "INVALID_ARTIST_SUGGESTION" });
  }
  console.error(fallback, error?.message || error);
  return res.status(500).json({ error: fallback });
}

module.exports = { sendArtistSuggestionError };
