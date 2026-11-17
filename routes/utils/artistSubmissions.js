const mongoose = require("mongoose");
const Artist = require("../../models/Artist");
const ArtistSubmission = require("../../models/ArtistSubmission");
const { ArtistIdentityError, loadArtistsById, loadArtistsByMbid, normalizeArtistId } = require("../../lib/artists/identity");
const { ArtistProposalValidationError, normalizeArtistProposals, resolveArtistSelections } = require("../../lib/artists/proposals");
const { searchArtists, foldSearchKey } = require("../../lib/artists/read");
const { ModerationConflictError, ModerationValidationError, isTransactionUnavailable } = require("./moderation");
const { createWithRequestKey, normalizeRequestKey, payloadDigest, requestKeyFields } = require("./requestKeys");
const { publicProposal, prepareStoredProposals } = require("./artistSuggestions");

// Standalone artist suggestions (milestone 5). One proposal per suggestion,
// reusing the shared proposal contract with a fixed internal proposal key.
// Every state-changing command names the revision it was made against;
// approval creates or reuses one registry artist in a transaction with the
// submission transition and its audit event.

const PROPOSAL_KEY = "artist";
const MAX_NOTE_LENGTH = 500;

class ArtistSuggestionUnavailableError extends Error {
  constructor() {
    super("Artist suggestions are unavailable until MongoDB transactions are enabled");
    this.name = "ArtistSuggestionUnavailableError";
    this.status = 503;
    this.code = "ARTIST_SUGGESTION_UNAVAILABLE";
  }
}

function plain(value) {
  return value && typeof value.toObject === "function" ? value.toObject() : value;
}

function invalid(message) {
  throw new ArtistProposalValidationError(message, "INVALID_ARTIST_SUGGESTION");
}

function assertRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${path} must be an object`);
}

function assertKeys(value, allowed, path) {
  Object.keys(value).forEach((key) => {
    if (!allowed.includes(key)) invalid(`${path}.${key} is not allowed`);
  });
}

function expectedRevisionFrom(body) {
  if (!Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 1) {
    throw new ModerationValidationError("expectedRevision must name the revision you reviewed", "EXPECTED_REVISION_REQUIRED");
  }
  return body.expectedRevision;
}

function normalizeNote(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") invalid("note must be a string");
  const note = value.normalize("NFC").trim();
  if (note.length > MAX_NOTE_LENGTH) invalid(`note must be ${MAX_NOTE_LENGTH} characters or fewer`);
  return note;
}

// The client sends one proposal without a proposal key; the strict shared
// validator does the rest (no names or observations for MusicBrainz).
function normalizeProposal(value) {
  assertRecord(value, "artistProposal");
  if (Object.prototype.hasOwnProperty.call(value, "proposalKey")) invalid("artistProposal.proposalKey is not allowed");
  const [proposal] = normalizeArtistProposals([{ ...value, proposalKey: PROPOSAL_KEY }], "artistProposal");
  return proposal;
}

function normalizeCreateBody(body) {
  assertRecord(body, "request body");
  assertKeys(body, ["artistProposal", "note", "requestKey"], "request body");
  return {
    requestKey: normalizeRequestKey(body.requestKey, { required: true }),
    proposal: normalizeProposal(body.artistProposal),
    note: normalizeNote(body.note),
  };
}

function normalizeReviseBody(body) {
  assertRecord(body, "request body");
  assertKeys(body, ["artistProposal", "note", "expectedRevision"], "request body");
  return { expectedRevision: expectedRevisionFrom(body), proposal: normalizeProposal(body.artistProposal), note: normalizeNote(body.note) };
}

function normalizeWithdrawBody(body) {
  assertRecord(body || {}, "request body");
  assertKeys(body || {}, ["expectedRevision"], "request body");
  return { expectedRevision: expectedRevisionFrom(body) };
}

function requiredReason(value) {
  if (typeof value !== "string" || !value.trim()) throw new ModerationValidationError("reason is required");
  if (value.trim().length > 1000) throw new ModerationValidationError("reason must be 1000 characters or fewer");
  return value.trim();
}

function optionalReason(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new ModerationValidationError("reason must be a string");
  if (value.trim().length > 1000) throw new ModerationValidationError("reason must be 1000 characters or fewer");
  return value.trim();
}

function normalizeModerationBody(body, action) {
  const source = body || {};
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new ModerationValidationError("request body must be an object");
  const allowed = {
    approve: ["expectedRevision", "reason"],
    request_changes: ["expectedRevision", "reason"],
    reject: ["expectedRevision", "reason"],
    mark_duplicate: ["expectedRevision", "reason", "duplicateOfArtistId"],
  }[action];
  if (!allowed) throw new ModerationValidationError("moderation action is invalid");
  Object.keys(source).forEach((key) => {
    if (!allowed.includes(key)) throw new ModerationValidationError(`request body.${key} is not allowed`);
  });
  const result = { expectedRevision: expectedRevisionFrom(source) };
  if (action === "request_changes" || action === "reject") result.reason = requiredReason(source.reason);
  else result.reason = optionalReason(source.reason);
  if (action === "mark_duplicate") {
    const artistId = normalizeArtistId(source.duplicateOfArtistId);
    if (!artistId) throw new ModerationValidationError("duplicateOfArtistId must be a Rescened artist ID");
    result.duplicateOfArtistId = artistId;
  }
  return result;
}

// An exact MusicBrainz MBID already on Rescened is that artist: the
// contributor is pointed to it instead of proposing it again.
async function assertNotRegistered(proposal) {
  if (proposal.kind !== "musicbrainz") return;
  const existing = (await loadArtistsByMbid(Artist, [proposal.artistMbid])).get(proposal.artistMbid);
  if (existing) {
    throw new ModerationConflictError("This MusicBrainz artist is already on Rescened", "ARTIST_ALREADY_EXISTS", [{ artistId: existing.artistId, name: existing.name || "" }]);
  }
}

function serializeArtistSuggestion(value, { detail = false } = {}) {
  const source = plain(value) || {};
  const proposal = publicProposal(source.proposal);
  const result = {
    submissionId: source.submissionId,
    submittedByUserId: source.submittedByUserId,
    status: source.status,
    currentRevision: source.currentRevision,
    // Summaries name the artist; evidence and notes are detail-only.
    proposal: detail ? proposal : (({ evidence, ...rest }) => rest)(proposal),
    approvedArtistId: source.approvedArtistId || undefined,
    duplicateOfArtistId: source.duplicateOfArtistId || undefined,
    approvedAt: source.approvedAt || undefined,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  if (detail) {
    result.note = source.note || "";
    if (source.approvalReceipt) result.approvalOutcome = plain(source.approvalReceipt).outcome;
    result.revisions = (source.revisions || []).map((revision) => {
      const item = plain(revision);
      return { revision: item.revision, submittedAt: item.submittedAt, proposal: publicProposal(item.proposal), note: item.note || "" };
    });
    result.moderationHistory = (source.moderationHistory || []).map((event) => {
      const item = plain(event);
      return { actorUserId: item.actorUserId, action: item.action, reason: item.reason || "", revision: item.revision, createdAt: item.createdAt };
    });
  }
  Object.keys(result).forEach((key) => { if (result[key] === undefined) delete result[key]; });
  return result;
}

async function createArtistSuggestion({ userId, body }) {
  const { requestKey, proposal, note } = normalizeCreateBody(body);
  // The digest covers only the normalized request, so a replay is answered
  // before any registry or MusicBrainz read.
  const digest = payloadDigest({ proposal, note });
  return createWithRequestKey({
    Model: ArtistSubmission,
    userId,
    requestKey,
    digest,
    create: async () => {
      await assertNotRegistered(proposal);
      const [prepared] = await prepareStoredProposals([proposal]);
      const submittedAt = new Date();
      return ArtistSubmission.create({
        submittedByUserId: userId,
        status: "pending",
        currentRevision: 1,
        proposal: prepared,
        note,
        revisions: [{ revision: 1, submittedAt, proposal: prepared, note }],
        moderationHistory: [{ actorUserId: userId, action: "submitted", reason: "", revision: 1, createdAt: submittedAt }],
        ...requestKeyFields(requestKey, digest),
      });
    },
  });
}

async function findOwned(submissionId, userId) {
  const current = await ArtistSubmission.findOne({ submissionId: String(submissionId || "").toLowerCase() });
  if (!current || current.submittedByUserId !== userId) {
    throw Object.assign(new Error("Artist suggestion not found"), { status: 404, code: "ARTIST_SUGGESTION_NOT_FOUND" });
  }
  return current;
}

function assertRevision(current, expectedRevision, code = "REVISION_CONFLICT") {
  if (current.currentRevision !== expectedRevision) {
    throw new ModerationConflictError("The artist suggestion changed since you last loaded it", code);
  }
}

async function reviseArtistSuggestion({ userId, submissionId, body }) {
  const { expectedRevision, proposal, note } = normalizeReviseBody(body);
  const current = await findOwned(submissionId, userId);
  if (current.status !== "needs_changes") throw new ModerationConflictError("Only artist suggestions needing changes can be revised", "INVALID_SUBMISSION_STATE");
  assertRevision(current, expectedRevision);
  await assertNotRegistered(proposal);
  const [prepared] = await prepareStoredProposals([proposal], { previous: { artistProposals: [plain(current.proposal)] } });
  const revision = expectedRevision + 1;
  const submittedAt = new Date();
  const updated = await ArtistSubmission.findOneAndUpdate(
    { submissionId: current.submissionId, submittedByUserId: userId, status: "needs_changes", currentRevision: expectedRevision },
    {
      $set: { status: "pending", currentRevision: revision, proposal: prepared, note },
      $push: {
        revisions: { revision, submittedAt, proposal: prepared, note },
        moderationHistory: { actorUserId: userId, action: "revised", reason: "", revision, createdAt: submittedAt },
      },
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new ModerationConflictError("The artist suggestion changed while it was being revised", "REVISION_CONFLICT");
  return updated;
}

async function withdrawArtistSuggestion({ userId, submissionId, body }) {
  const { expectedRevision } = normalizeWithdrawBody(body);
  const current = await findOwned(submissionId, userId);
  if (!["pending", "needs_changes"].includes(current.status)) throw new ModerationConflictError("Only active artist suggestions can be withdrawn", "INVALID_SUBMISSION_STATE");
  assertRevision(current, expectedRevision, "STATE_CONFLICT");
  const updated = await ArtistSubmission.findOneAndUpdate(
    { submissionId: current.submissionId, submittedByUserId: userId, status: { $in: ["pending", "needs_changes"] }, currentRevision: expectedRevision },
    {
      $set: { status: "withdrawn" },
      $push: { moderationHistory: { actorUserId: userId, action: "withdrawn", reason: "", revision: expectedRevision, createdAt: new Date() } },
    },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new ModerationConflictError("The artist suggestion changed while it was being withdrawn", "STATE_CONFLICT");
  return updated;
}

async function inTransaction(work) {
  let session;
  try {
    if (typeof mongoose.startSession !== "function") throw new ArtistSuggestionUnavailableError();
    session = await mongoose.startSession();
    if (!session || typeof session.withTransaction !== "function") throw new ArtistSuggestionUnavailableError();
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (error instanceof ArtistSuggestionUnavailableError) throw error;
    if (isTransactionUnavailable(error)) throw new ArtistSuggestionUnavailableError();
    throw error;
  } finally {
    if (session && typeof session.endSession === "function") await session.endSession();
  }
}

const NEXT_STATUS = { request_changes: "needs_changes", reject: "rejected", mark_duplicate: "duplicate" };
const HISTORY_ACTION = { request_changes: "request_changes", reject: "rejected", mark_duplicate: "marked_duplicate" };

async function loadForModeration(submissionId, session) {
  const current = await ArtistSubmission.findOne({ submissionId: String(submissionId || "").toLowerCase() }).session(session);
  if (!current) throw Object.assign(new Error("Artist suggestion not found"), { status: 404, code: "ARTIST_SUGGESTION_NOT_FOUND" });
  return current;
}

// Request changes, reject, or mark as a duplicate of an existing public
// artist (any source, including imported artists with no submission).
async function moderateArtistSuggestion({ submissionId, actorUserId, action, body }) {
  const command = normalizeModerationBody(body, action);
  return inTransaction(async (session) => {
    const current = await loadForModeration(submissionId, session);
    if (current.status !== "pending") throw new ModerationConflictError("Only pending artist suggestions can be moderated", "INVALID_SUBMISSION_STATE");
    assertRevision(current, command.expectedRevision, "STATE_CONFLICT");
    const set = { status: NEXT_STATUS[action] };
    if (action === "mark_duplicate") {
      const target = (await loadArtistsById(Artist, [command.duplicateOfArtistId], { session })).get(command.duplicateOfArtistId);
      if (!target) throw new ModerationConflictError("duplicateOfArtistId must name an artist on Rescened", "INVALID_DUPLICATE_TARGET");
      set.duplicateOfArtistId = target.artistId;
    }
    const updated = await ArtistSubmission.findOneAndUpdate(
      { _id: current._id, status: "pending", currentRevision: command.expectedRevision },
      {
        $set: set,
        $push: { moderationHistory: { actorUserId, action: HISTORY_ACTION[action], reason: command.reason || (action === "mark_duplicate" ? "Already on Rescened." : ""), revision: command.expectedRevision, createdAt: new Date() } },
      },
      { returnDocument: "after", runValidators: true, session },
    );
    if (!updated) throw new ModerationConflictError("The artist suggestion changed while it was being moderated", "STATE_CONFLICT");
    return updated;
  });
}

// Creates or reuses the artist, then approves, in one transaction. An exact
// MBID registered meanwhile is reused without renaming; a community
// proposal always becomes a new artist. A retry at the approved revision
// returns the original result; any other revision conflicts.
async function approveArtistSuggestion({ submissionId, actorUserId, body }) {
  const command = normalizeModerationBody(body, "approve");
  return inTransaction(async (session) => {
    const current = plain(await loadForModeration(submissionId, session));
    if (current.status === "approved") {
      if (plain(current.approvalReceipt)?.revision !== command.expectedRevision) {
        throw new ModerationConflictError("This artist suggestion was approved at a different revision", "APPROVAL_CONFLICT");
      }
      return { submission: current, idempotent: true };
    }
    if (current.status !== "pending") throw new ModerationConflictError("Only pending artist suggestions can be approved", "INVALID_SUBMISSION_STATE");
    assertRevision(current, command.expectedRevision, "STATE_CONFLICT");
    const approvedAt = new Date();
    const proposal = plain(current.proposal);
    const canonical = proposal.kind === "community" ? proposal.canonicalName : plain(proposal.observation).name;
    let resolved;
    try {
      resolved = await resolveArtistSelections({
        credits: [{ name: canonical }],
        proposals: [proposal],
        selections: [{ position: 0, kind: "proposal", proposalKey: proposal.proposalKey }],
      }, {
        Artist,
        session,
        provenance: { source: "community", artistSubmissionId: current.submissionId, revision: current.currentRevision, approvedByUserId: actorUserId, approvedAt },
      });
    } catch (error) {
      if (error instanceof ArtistIdentityError) throw new ModerationConflictError(error.message, "ARTIST_IDENTITY_CONFLICT", error.details);
      throw error;
    }
    const [resolution] = resolved.resolutions;
    const receipt = { revision: current.currentRevision, artistId: resolution.artistId, outcome: resolution.outcome, approvedAt };
    const updated = await ArtistSubmission.findOneAndUpdate(
      { _id: current._id, status: "pending", currentRevision: command.expectedRevision },
      {
        $set: { status: "approved", approvedArtistId: resolution.artistId, approvedAt, approvalReceipt: receipt },
        $push: { moderationHistory: { actorUserId, action: "approved", reason: command.reason, revision: command.expectedRevision, createdAt: approvedAt } },
      },
      { returnDocument: "after", runValidators: true, session },
    );
    if (!updated) throw new ModerationConflictError("The artist suggestion changed while it was being approved", "STATE_CONFLICT");
    return { submission: updated, idempotent: false };
  });
}

// Advisory moderator context: the artist an exact MBID would reuse, and
// registry artists whose name matches the proposal, as possible duplicate
// targets. Nothing here links or merges anything.
async function moderatorContext(value) {
  const proposal = plain(plain(value)?.proposal) || {};
  const context = { registeredArtist: null, sameNameArtists: [] };
  try {
    if (proposal.kind === "musicbrainz") {
      const existing = (await loadArtistsByMbid(Artist, [proposal.artistMbid])).get(proposal.artistMbid);
      if (existing) context.registeredArtist = { artistId: existing.artistId, name: existing.name || "" };
    }
    const name = proposal.kind === "community" ? proposal.canonicalName : plain(proposal.observation)?.name;
    if (name) {
      const { results } = await searchArtists({ q: name.slice(0, 200), limit: "6" });
      const key = foldSearchKey(name);
      context.sameNameArtists = results
        .filter((artist) => foldSearchKey(artist.name) === key)
        .map((artist) => ({ artistId: artist.artistId, name: artist.name, releaseCount: artist.releaseCount || 0 }));
    }
  } catch (error) {
    console.error("Failed to load artist suggestion moderator context", error?.message || error);
  }
  return context;
}

module.exports = {
  ArtistSuggestionUnavailableError,
  approveArtistSuggestion,
  createArtistSuggestion,
  moderateArtistSuggestion,
  moderatorContext,
  normalizeCreateBody,
  normalizeModerationBody,
  normalizeReviseBody,
  reviseArtistSuggestion,
  serializeArtistSuggestion,
  withdrawArtistSuggestion,
};
