// Identity-only artistLinks corrections: request normalization, baselines,
// serialization privacy, importer protection, bulk exclusion, and the
// required reviewed revision for every correction approval.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumSubmission = require("../models/AlbumSubmission");
const AlbumCatalog = require("../models/AlbumCatalog");
const { normalizeCorrectionPayload, serializeSubmission } = require("../routes/utils/submissions");
const { mergeImportedCatalog } = require("../lib/catalogImport/persistence");
const { bulkApprovalPlans } = require("../routes/utils/bulkApproval");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const { normalizeCommandBody } = require("../routes/utils/moderation");

const ARTIST = "11111111-1111-4111-8111-111111111111";
const MBID = "83096042-3785-481e-8843-dee69f1aad12";

function album(credits) {
  return {
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Album",
    artistDisplayName: "Display, as credited",
    artistCredits: credits,
    catalogRevision: 4,
    fieldProvenance: { artistCredits: { source: "import" }, artistIdentity: { source: "musicbrainz", method: "artist-identity-backfill" } },
  };
}

function body(target, artistLinks, extra = {}) {
  return { albumId: target.albumId, proposedChanges: { artistLinks, ...extra }, supportingSources: [{ type: "other", url: "https://example.com/c" }] };
}

const CREDITS = [
  { name: "Tyler, the Creator", role: "main" },
  { name: "Alpha & " },
  { name: "Linked", role: "main", artistId: ARTIST },
  ...Array.from({ length: 22 }, (_, index) => ({ name: `Player ${index}`, role: "performer" })),
];

test("artistLinks normalizes sparse positions against the raw stored credits", () => {
  const target = album(CREDITS.map((credit) => ({ role: "main", ...credit })));
  const payload = normalizeCorrectionPayload(body(target, {
    artistProposals: [{ proposalKey: "shared", kind: "community", canonicalName: "Shared", evidence: [{ url: "https://example.com/s" }] }],
    artistSelections: [
      { position: 24, kind: "proposal", proposalKey: "shared" },
      { position: 0, kind: "existing", artistId: ARTIST },
      { position: 1, kind: "proposal", proposalKey: "shared" },
    ],
  }), target, { rawArtistCredits: CREDITS });
  assert.deepEqual(payload.proposedChanges.artistLinks.artistSelections.map((selection) => selection.position), [0, 1, 24], "positions past the 20-credit edit limit are allowed");
  assert.deepEqual(payload.baseValues.artistLinks.artistCredits, CREDITS, "the baseline is the raw credits, not the hydrated ones with default roles");
  assert.deepEqual(payload.baseProvenance.artistLinks, { artistCredits: { source: "import" }, artistIdentity: { source: "musicbrainz", method: "artist-identity-backfill" } });
  assert.equal(payload.baseCatalogRevision, 4);
  assert.equal("artists" in payload.proposedChanges, false);
});

test("artistLinks refuses out-of-range, duplicate, already-linked, oversized, and combined requests", () => {
  const target = album(CREDITS);
  const attempt = (artistLinks, extra) => () => normalizeCorrectionPayload(body(target, artistLinks, extra), target, { rawArtistCredits: CREDITS });
  const existing = (position) => ({ position, kind: "existing", artistId: ARTIST });
  assert.throws(attempt({ artistSelections: [existing(25)] }), (error) => error.code === "ARTIST_SELECTION_OUT_OF_RANGE");
  assert.throws(attempt({ artistSelections: [existing(0), existing(0)] }), (error) => error.code === "DUPLICATE_ARTIST_SELECTION");
  assert.throws(attempt({ artistSelections: [existing(2)] }), (error) => error.code === "CREDIT_ALREADY_LINKED");
  assert.throws(attempt({ artistSelections: Array.from({ length: 21 }, (_, index) => existing(index < 2 ? index : index + 1)) }), /at most 20/);
  assert.throws(attempt({ artistSelections: [] }), /link at least one credit/);
  assert.throws(attempt({ artistSelections: [existing(0)], artistDisplayName: "X" }), /artistDisplayName is not allowed/);
  assert.throws(attempt({ artistSelections: [{ ...existing(0), name: "Rewritten" }] }), /name is not allowed/);
  assert.throws(attempt({ artistSelections: [existing(0)] }, { artists: { artistDisplayName: "X", artistCredits: [{ name: "X" }] } }), /cannot replace artists and add artistLinks/);
});

test("correction summaries drop link evidence that detail keeps; the diff ignores schema defaults", () => {
  const target = album(CREDITS);
  const links = {
    artistProposals: [{ proposalKey: "new-1", kind: "community", canonicalName: "N", evidence: [{ url: "https://example.com/private", description: "" }] }],
    artistSelections: [{ position: 1, kind: "proposal", proposalKey: "new-1" }],
  };
  const source = {
    submissionId: crypto.randomUUID(),
    submissionType: "catalog_correction",
    status: "pending",
    currentRevision: 1,
    proposedChanges: { artistLinks: links },
    baseValues: { artistLinks: { artistCredits: CREDITS } },
    // Hydrated target: Mongoose added the default role to the role-less credit.
    targetAlbumCatalogId: { ...target, artistCredits: CREDITS.map((credit) => ({ role: "main", ...credit })) },
  };
  const summary = serializeSubmission(source);
  assert.equal(JSON.stringify(summary).includes("https://example.com/private"), false);
  assert.equal(summary.proposedChanges.artistLinks.artistSelections.length, 1, "the link structure stays");
  const detail = serializeSubmission(source, { detail: true });
  assert.ok(JSON.stringify(detail).includes("https://example.com/private"));
  assert.equal(detail.correctionDiff.find((item) => item.field === "artistLinks").stale, false);
  source.targetAlbumCatalogId.artistCredits[1].artistId = ARTIST;
  assert.equal(serializeSubmission(source, { detail: true }).correctionDiff[0].stale, true, "a new identity marks the baseline stale");
});

test("re-imports keep credits whose identities were linked by an approved correction", () => {
  const existing = {
    albumId: crypto.randomUUID(), catalogRevision: 3,
    artistCredits: [{ name: "Alpha & " }, { name: "Beta", role: "main", artistId: ARTIST }],
    fieldProvenance: { artistCredits: { source: "import" }, artistIdentity: { source: "community", method: "artist-link-correction" } },
    externalReferences: [],
  };
  const incoming = {
    title: "Album", artistDisplayName: "Alpha & Beta", artistCredits: [{ name: "Alpha", role: "main" }, { name: "Beta", role: "main" }],
    externalReferences: [], fieldProvenance: { artistCredits: { source: "musicbrainz" } },
  };
  const merged = mergeImportedCatalog(existing, incoming);
  assert.deepEqual(merged.artistCredits, existing.artistCredits, "community-linked identities are not dropped by a refresh");
  assert.deepEqual(merged.fieldProvenance.artistIdentity, existing.fieldProvenance.artistIdentity);
  const backfilled = mergeImportedCatalog({ ...existing, fieldProvenance: { artistCredits: { source: "import" }, artistIdentity: { source: "musicbrainz" } } }, incoming);
  assert.deepEqual(backfilled.artistCredits, incoming.artistCredits, "dataset-derived identities still refresh as before");
});

test("bulk approval refuses corrections with artist links; others keep their plan", async () => {
  const base = { submissionType: "catalog_correction", status: "pending", currentRevision: 1 };
  const linked = { ...base, submissionId: crypto.randomUUID(), proposedChanges: { title: "T", artistLinks: { artistSelections: [{ position: 0, kind: "existing", artistId: ARTIST }] } } };
  const plain = { ...base, submissionId: crypto.randomUUID(), proposedChanges: { title: "T" } };
  const plans = await bulkApprovalPlans([linked, plain]);
  assert.deepEqual(plans.get(linked.submissionId), { eligible: false, reason: "artist_links" });
  assert.deepEqual(plans.get(plain.submissionId), { eligible: true, body: { applyFields: ["title"] } });
  assert.deepEqual(normalizeCommandBody({ applyFields: ["artistLinks", "title"], expectedRevision: 2 }, "approve").applyFields, ["artistLinks", "title"]);
});

test("every correction approval names the reviewed revision before any transaction", async (t) => {
  const originals = { findOne: AlbumSubmission.findOne, catalogFindOne: AlbumCatalog.findOne, startSession: mongoose.startSession };
  t.after(() => {
    AlbumSubmission.findOne = originals.findOne;
    AlbumCatalog.findOne = originals.catalogFindOne;
    mongoose.startSession = originals.startSession;
  });
  let stored = { submissionId: crypto.randomUUID(), submissionType: "catalog_correction", status: "pending", currentRevision: 2, proposedChanges: { title: "T" } };
  AlbumSubmission.findOne = () => ({ exec: async () => stored });
  mongoose.startSession = async () => { throw new Error("no transaction should start"); };
  await assert.rejects(approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", applyFields: ["title"] }), (error) => error.code === "EXPECTED_REVISION_REQUIRED");
  await assert.rejects(approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", applyFields: ["title"], expectedRevision: 1 }), (error) => error.code === "STATE_CONFLICT");
  const albumRow = { _id: new mongoose.Types.ObjectId(), albumId: crypto.randomUUID(), title: "A", artistDisplayName: "A", artistCredits: [] };
  stored = { ...stored, status: "approved", approvedAlbumCatalogId: albumRow._id, approvalReceipt: { revision: 2, publicationType: "catalog_corrected", targetAlbumId: albumRow.albumId, appliedFields: ["title"], artistResolutions: [] } };
  AlbumCatalog.findOne = () => ({ exec: async () => albumRow });
  await assert.rejects(approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", applyFields: ["title"] }), (error) => error.code === "EXPECTED_REVISION_REQUIRED", "a retry must name it too");
  const retry = await approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m", applyFields: ["title"], expectedRevision: 2 });
  assert.equal(retry.idempotent, true);
  // Genre approvals keep the optional guard.
  stored = { ...stored, submissionType: "genre_suggestion", approvalReceipt: undefined };
  const genreRetry = await approveAlbumSubmission({ submissionId: stored.submissionId, actorUserId: "m" }).catch((error) => error);
  assert.notEqual(genreRetry?.code, "EXPECTED_REVISION_REQUIRED");
});
