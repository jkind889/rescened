// Standalone artist suggestions: request contracts, privacy of serialized
// responses, and model invariants. No database.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const ArtistSubmission = require("../models/ArtistSubmission");
const {
  normalizeCreateBody,
  normalizeModerationBody,
  normalizeReviseBody,
  serializeArtistSuggestion,
} = require("../routes/utils/artistSubmissions");

const MBID = "83096042-3785-481e-8843-dee69f1aad12";
const EVIDENCE = "https://example.com/private";
const community = { kind: "community", canonicalName: " New Band ", evidence: [{ url: EVIDENCE }] };

test("create bodies are strict and need a request key", () => {
  const requestKey = crypto.randomUUID();
  assert.deepEqual(normalizeCreateBody({ artistProposal: community, note: "  hi ", requestKey }), {
    requestKey,
    proposal: { proposalKey: "artist", kind: "community", canonicalName: "New Band", evidence: [{ url: EVIDENCE, description: "" }] },
    note: "hi",
  });
  assert.equal(normalizeCreateBody({ artistProposal: { kind: "musicbrainz", artistMbid: MBID.toUpperCase() }, requestKey }).proposal.artistMbid, MBID);
  const cases = [
    [{ artistProposal: community }, "INVALID_REQUEST_KEY"],
    [{ artistProposal: community, requestKey, extra: 1 }, "INVALID_ARTIST_SUGGESTION"],
    [{ artistProposal: { ...community, proposalKey: "x" }, requestKey }, "INVALID_ARTIST_SUGGESTION"],
    [{ artistProposal: { kind: "musicbrainz", artistMbid: MBID, name: "Client" }, requestKey }, "INVALID_ARTIST_PROPOSAL"],
    [{ artistProposal: { kind: "community", canonicalName: "X", evidence: [{ url: "http://insecure.example" }] }, requestKey }, "INVALID_ARTIST_PROPOSAL"],
    [{ artistProposal: community, requestKey, note: "x".repeat(501) }, "INVALID_ARTIST_SUGGESTION"],
    [{ requestKey }, "INVALID_ARTIST_SUGGESTION"],
  ];
  for (const [body, code] of cases) assert.throws(() => normalizeCreateBody(body), (error) => error.code === code, JSON.stringify(body));
});

test("revisions and every moderation command name the reviewed revision", () => {
  assert.throws(() => normalizeReviseBody({ artistProposal: community }), (error) => error.code === "EXPECTED_REVISION_REQUIRED");
  assert.throws(() => normalizeReviseBody({ artistProposal: community, expectedRevision: 1, requestKey: crypto.randomUUID() }), /requestKey is not allowed/);
  assert.equal(normalizeReviseBody({ artistProposal: community, expectedRevision: 3 }).expectedRevision, 3);
  for (const action of ["approve", "request_changes", "reject", "mark_duplicate"]) {
    const extra = action === "mark_duplicate" ? { duplicateOfArtistId: crypto.randomUUID() } : {};
    assert.throws(() => normalizeModerationBody({ reason: "x", ...extra }, action), (error) => error.code === "EXPECTED_REVISION_REQUIRED", action);
    assert.throws(() => normalizeModerationBody({ expectedRevision: 0, reason: "x", ...extra }, action), (error) => error.code === "EXPECTED_REVISION_REQUIRED", action);
  }
  assert.throws(() => normalizeModerationBody({ expectedRevision: 1 }, "reject"), /reason is required/);
  assert.throws(() => normalizeModerationBody({ expectedRevision: 1, duplicateOfArtistId: "nope" }, "mark_duplicate"), /Rescened artist ID/);
  assert.throws(() => normalizeModerationBody({ expectedRevision: 1, albumId: crypto.randomUUID() }, "approve"), /albumId is not allowed/);
  assert.deepEqual(normalizeModerationBody({ expectedRevision: 2 }, "approve"), { expectedRevision: 2, reason: "" });
});

test("summaries leave out evidence and notes that detail keeps", () => {
  const source = {
    submissionId: crypto.randomUUID(),
    submittedByUserId: "user",
    status: "pending",
    currentRevision: 1,
    proposal: { proposalKey: "artist", kind: "community", canonicalName: "New Band", evidence: [{ url: EVIDENCE, description: "" }] },
    note: "private note",
    revisions: [{ revision: 1, submittedAt: new Date(), proposal: { proposalKey: "artist", kind: "community", canonicalName: "New Band", evidence: [{ url: EVIDENCE }] }, note: "private note" }],
    moderationHistory: [{ actorUserId: "user", action: "submitted", reason: "", revision: 1, createdAt: new Date() }],
    creationRequestKey: crypto.randomUUID(),
    creationPayloadDigest: "a".repeat(64),
  };
  const summary = serializeArtistSuggestion(source);
  assert.equal(JSON.stringify(summary).includes(EVIDENCE), false);
  assert.equal(JSON.stringify(summary).includes("private note"), false);
  assert.equal(summary.proposal.canonicalName, "New Band");
  const detail = serializeArtistSuggestion(source, { detail: true });
  assert.ok(JSON.stringify(detail).includes(EVIDENCE));
  assert.equal(detail.note, "private note");
  assert.equal("creationRequestKey" in detail, false, "request keys stay internal");
});

async function errorsOf(document) {
  try {
    await document.validate();
    return null;
  } catch (error) {
    return error.errors;
  }
}

test("the model keeps approval and duplicate records consistent and history append-only", async () => {
  const base = {
    submittedByUserId: "user",
    proposal: { proposalKey: "artist", kind: "community", canonicalName: "N", evidence: [{ url: EVIDENCE }] },
  };
  assert.equal(await errorsOf(new ArtistSubmission(base)), null);
  assert.ok((await errorsOf(new ArtistSubmission({ ...base, status: "approved" })))?.approvedArtistId);
  assert.ok((await errorsOf(new ArtistSubmission({ ...base, status: "duplicate" })))?.duplicateOfArtistId);
  assert.ok((await errorsOf(new ArtistSubmission({ ...base, status: "rejected", duplicateOfArtistId: crypto.randomUUID() })))?.duplicateOfArtistId);
  assert.ok(await errorsOf(new ArtistSubmission({ ...base, proposal: { proposalKey: "artist", kind: "musicbrainz", artistMbid: MBID } })), "a MusicBrainz proposal needs its server observation");
  await assert.rejects(ArtistSubmission.findOneAndUpdate({ submissionId: crypto.randomUUID() }, { $set: { revisions: [] } }).exec(), /append-only/);
  await assert.rejects(ArtistSubmission.findOneAndUpdate({ submissionId: crypto.randomUUID() }, { $set: { status: "approved" } }).exec(), /record the artist/);
  await assert.rejects(ArtistSubmission.findOneAndUpdate({ submissionId: crypto.randomUUID() }, { $unset: { approvalReceipt: "" } }).exec(), /cannot be removed/);
});
