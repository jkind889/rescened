const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const AlbumSubmission = require("../../models/AlbumSubmission");
const Models = require("../../models/AlbumBaseline");
const Listening = require("../../models/Listening");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/iu;
const ACTIONS = new Set(["confirm", "replace", "defer", "revoke"]);
const STATUSES = new Set(["pending", "reviewed", "stale", "deferred", "revoked"]);

class BaselineError extends Error {
  constructor(message, code, status = 400, details = []) {
    super(message);
    this.name = "BaselineError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function serializeCandidate(value, { includeTrackIds = false } = {}) {
  const candidate = plain(value); if (!candidate) return null;
  return { ...candidate, tracks: (candidate.tracks || []).map((track) => {
    const source = plain(track); if (includeTrackIds) return source;
    const { trackId, ...externalTrack } = source; return externalTrack;
  }) };
}
function withSession(query, session) { return session && query?.session ? query.session(session) : query; }
async function read(query, session) { const value = withSession(query, session); return value?.exec ? value.exec() : value; }
function enabled(name) { return String(process.env[name] || "").trim().toLowerCase() === "true"; }
function flags() { return { discovery: enabled("TRACKLIST_ENRICHMENT_ENABLED"), moderation: enabled("TRACKLIST_BASELINE_MODERATION_ENABLED") && enabled("COMMUNITY_MODERATION_ENABLED") }; }
function fail(message, code = "INVALID_BASELINE_REQUEST", status = 400, details = []) { throw new BaselineError(message, code, status, details); }
function assertKind(kind) { if (!new Set(["albums", "submissions"]).has(kind)) fail("kind must be albums or submissions"); return kind; }
function assertUuid(value, name) { if (typeof value !== "string") fail(`${name} must be a UUID v4`); const normalized = value.trim().toLowerCase(); if (!UUID_V4.test(normalized)) fail(`${name} must be a UUID v4`); return normalized; }
function assertMbid(value, name) { if (typeof value !== "string") fail(`${name} must be a MusicBrainz UUID`); const normalized = value.trim().toLowerCase(); if (!MBID.test(normalized)) fail(`${name} must be a MusicBrainz UUID`); return normalized; }
function catalogRevisionOf(target) { const value = Number(plain(target)?.catalogRevision); return Number.isSafeInteger(value) && value > 0 ? value : 1; }
function catalogRevisionFilter(revision) { return Number(revision) === 1 ? { $in: [null, 1] } : Number(revision); }
function targetRevision(kind, target) { return kind === "albums" ? catalogRevisionOf(target) : Number(plain(target)?.currentRevision); }
function targetPublicId(kind, target) { return kind === "albums" ? plain(target)?.albumId : plain(target)?.submissionId; }
function targetMetadata(kind, target) { return kind === "albums" ? plain(target) : plain(target)?.proposedMetadata || {}; }
function releaseGroupFrom(value) {
  const source = plain(value) || {};
  return [...(source.externalReferences || []), ...(source.proposedMetadata?.externalReferences || [])].find((reference) => reference.provider === "musicbrainz" && reference.entityType === "release-group" && MBID.test(reference.externalId || ""))?.externalId?.toLowerCase() || "";
}
async function findTarget(kind, id, session) {
  assertKind(kind); const publicId = assertUuid(id, kind === "albums" ? "albumId" : "submissionId");
  const query = kind === "albums" ? AlbumCatalog.findOne({ albumId: publicId }) : AlbumSubmission.findOne({ submissionId: publicId });
  const target = await read(query, session);
  if (!target) fail(kind === "albums" ? "Catalog album not found" : "Suggestion not found", kind === "albums" ? "CATALOG_ALBUM_NOT_FOUND" : "SUGGESTION_NOT_FOUND", 404);
  if (kind === "submissions" && plain(target).status !== "pending") fail("Only pending suggestions may select a baseline", "INVALID_SUBMISSION_STATE", 409);
  return target;
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") fail("Provider candidate is invalid", "INVALID_PROVIDER_CANDIDATE", 502);
  ["releaseMbid", "releaseGroupMbid"].forEach((field) => assertMbid(candidate[field], field));
  if (!HASH.test(String(candidate.tracklistHash || ""))) fail("Provider candidate has no valid tracklist hash", "INVALID_PROVIDER_CANDIDATE", 502);
  if (candidate.license !== "CC0" || !candidate.retrievedAt || String(candidate.sourceUrl || "") !== `https://musicbrainz.org/release/${String(candidate.releaseMbid || "").toLowerCase()}`) fail("Provider candidate provenance is invalid", "INVALID_PROVIDER_CANDIDATE", 502);
  if (!Array.isArray(candidate.tracks) || !candidate.tracks.length || candidate.tracks.length > 200) fail("Provider candidate tracklist is incomplete", "INCOMPLETE_TRACKLIST", 409);
  const positions = new Set();
  const byDisc = new Map(); let previousPosition = null;
  candidate.tracks.forEach((track) => {
    const disc = Number(track.discNumber); const number = Number(track.trackNumber);
    if (!Number.isSafeInteger(disc) || disc < 1 || !Number.isSafeInteger(number) || number < 1 || !String(track.title || "").trim()) fail("Provider candidate has an invalid track", "INVALID_PROVIDER_CANDIDATE", 502);
    if (!MBID.test(String(track.releaseTrackMbid || "")) || !MBID.test(String(track.recordingMbid || ""))) fail("Provider candidate track identifiers are invalid", "INVALID_PROVIDER_CANDIDATE", 502);
    const key = `${disc}:${number}`; if (positions.has(key)) fail("Provider candidate has duplicate track positions", "INCOMPLETE_TRACKLIST", 409); positions.add(key);
    if (previousPosition && (disc < previousPosition.disc || (disc === previousPosition.disc && number <= previousPosition.number))) fail("Provider candidate tracks are not in disc and track order", "INCOMPLETE_TRACKLIST", 409);
    previousPosition = { disc, number };
    if (!byDisc.has(disc)) byDisc.set(disc, []); byDisc.get(disc).push(number);
  });
  const discs = [...byDisc.keys()];
  if (discs.some((disc, index) => disc !== index + 1) || [...byDisc.values()].some((numbers) => numbers.some((number, index) => number !== index + 1))) fail("Provider candidate track positions are incomplete", "INCOMPLETE_TRACKLIST", 409);
  const hashTracks = candidate.tracks.map(({ discNumber, trackNumber, title, durationMs, artistDisplayName, releaseTrackMbid, recordingMbid }) => ({ discNumber, trackNumber, title, durationMs, artistDisplayName, releaseTrackMbid, recordingMbid }));
  const calculated = crypto.createHash("sha256").update(JSON.stringify({ releaseMbid: candidate.releaseMbid, releaseGroupMbid: candidate.releaseGroupMbid, title: candidate.title, artistDisplayName: candidate.artistDisplayName, tracks: hashTracks })).digest("hex");
  if (calculated !== candidate.tracklistHash) fail("Provider candidate tracklist hash does not match its tracks", "CANDIDATE_HASH_MISMATCH", 409);
  return candidate;
}

async function storeCandidate(kind, target, candidate, { session } = {}) {
  const normalized = validateCandidate(candidate);
  const id = targetPublicId(kind, target); const revision = targetRevision(kind, target);
  const update = { $setOnInsert: { snapshotId: crypto.randomUUID(), targetKind: kind, targetId: id, targetRevision: revision, candidate: normalized, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } };
  return Models.Candidate.findOneAndUpdate({ targetKind: kind, targetId: id, targetRevision: revision, "candidate.releaseMbid": normalized.releaseMbid, "candidate.tracklistHash": normalized.tracklistHash }, update, { upsert: true, returnDocument: "after", runValidators: true, session });
}

function provider() {
  // Lazy loading keeps local baseline reads independent from provider configuration.
  // eslint-disable-next-line global-require
  return require("./musicBrainz").createBaselineMusicBrainz();
}

async function searchGroups(q, limit) {
  if (!flags().discovery) fail("Tracklist enrichment is currently disabled", "TRACKLIST_ENRICHMENT_DISABLED", 503);
  const query = String(q || "").trim(); if (query.length < 2 || query.length > 200) fail("q must contain 2 to 200 characters");
  const parsed = limit === undefined ? 10 : Number(limit); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 25) fail("limit must be between 1 and 25");
  return { items: await provider().searchReleaseGroups(query, parsed) };
}

async function candidates(kind, id, { releaseGroupMbid, offset = 0 } = {}) {
  if (!flags().discovery) fail("Tracklist enrichment is currently disabled", "TRACKLIST_ENRICHMENT_DISABLED", 503);
  const target = await findTarget(kind, id); const metadata = targetMetadata(kind, target);
  const knownGroup = releaseGroupFrom(target); const requestedGroup = releaseGroupMbid ? assertMbid(releaseGroupMbid, "releaseGroupMbid") : "";
  if (knownGroup && requestedGroup && knownGroup !== requestedGroup) fail("Release group conflicts with the target identity", "RELEASE_GROUP_MISMATCH", 409);
  const group = requestedGroup || knownGroup;
  if (!group) fail("A MusicBrainz release group must be selected first", "RELEASE_GROUP_REQUIRED", 409);
  const parsedOffset = Number(offset || 0); if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || parsedOffset > 1000) fail("offset is invalid");
  const result = parsedOffset === 0
    ? await provider().recommend(group, { title: metadata.title || "" })
    : { candidate: null, ...(await provider().browseReleases(group, { offset: parsedOffset, limit: 20 })), ambiguous: false, rationale: [] };
  let snapshot = null;
  if (result.candidate) snapshot = await storeCandidate(kind, target, result.candidate);
  return { ...result, candidate: result.candidate ? serializeCandidate(plain(snapshot).candidate) : null };
}

function releaseId(value) {
  const raw = String(value || "").trim();
  if (MBID.test(raw)) return raw.toLowerCase();
  try { const url = new URL(raw); if (url.protocol === "https:" && url.hostname === "musicbrainz.org") { const match = url.pathname.match(/^\/release\/([0-9a-f-]{36})\/?$/i); if (match && MBID.test(match[1])) return match[1].toLowerCase(); } } catch { /* handled below */ }
  fail("releaseMbid must be a MusicBrainz release UUID or URL");
}

async function preview(kind, id, { releaseMbid, releaseGroupMbid } = {}) {
  if (!flags().discovery) fail("Tracklist enrichment is currently disabled", "TRACKLIST_ENRICHMENT_DISABLED", 503);
  const target = await findTarget(kind, id); const expectedGroup = releaseGroupMbid ? assertMbid(releaseGroupMbid, "releaseGroupMbid") : releaseGroupFrom(target);
  const knownGroup = releaseGroupFrom(target);
  if (knownGroup && expectedGroup && knownGroup !== expectedGroup) fail("Release group conflicts with the target identity", "RELEASE_GROUP_MISMATCH", 409);
  const candidate = validateCandidate(await provider().release(releaseId(releaseMbid)));
  if (expectedGroup && candidate.releaseGroupMbid !== expectedGroup) fail("Release does not belong to the selected release group", "RELEASE_GROUP_MISMATCH", 409);
  const snapshot = await storeCandidate(kind, target, candidate);
  return { candidate: serializeCandidate(plain(snapshot).candidate) };
}

function trackKey(track) { return `${Number(track.discNumber)}:${Number(track.trackNumber)}:${String(track.title || "").trim().toLocaleLowerCase()}`; }
function baselineTracks(candidate, existingTracks = []) {
  const ids = new Map((existingTracks || []).map((track) => [trackKey(track), track.trackId]));
  return candidate.tracks.map((track) => ({ ...track, trackId: ids.get(trackKey(track)) || track.trackId || crypto.randomUUID() }));
}
function catalogTracks(candidateTracks) { return candidateTracks.map(({ trackId, discNumber, trackNumber, title, durationMs, artistDisplayName }) => ({ trackId, discNumber, trackNumber, title, durationMs: Number.isSafeInteger(durationMs) ? durationMs : 0, artistDisplayName })); }

async function enqueueReprocess(albumId, session, changeToken = crypto.randomUUID()) {
  const mappings = await read(Listening.AlbumMapping.find({ albumId, status: "active" }), session);
  for (const row of mappings || []) {
    const mapping = plain(row); const key = `reprocess:baseline:${mapping.mappingId}:${mapping.revision}:${changeToken}`;
    await Listening.Job.updateOne({ key }, { $setOnInsert: { key, type: "reprocess", payload: { key: mapping.key, mappingId: mapping.mappingId, mappingRevision: mapping.revision }, status: "pending", runAt: new Date(), attempts: 0, progress: {}, error: "" } }, { upsert: true, session });
  }
}

async function activeBaselineFor(album, session) {
  const source = plain(album); if (!source?.albumId) return null;
  const currentCatalogRevision = Number.isSafeInteger(Number(source.catalogRevision)) && Number(source.catalogRevision) > 0 ? Number(source.catalogRevision) : 1;
  const head = await read(Models.Head.findOne({ targetKind: "albums", targetId: source.albumId, status: "reviewed" }), session);
  if (!head || Number(plain(head).targetRevision) !== currentCatalogRevision || !plain(head).activeBaselineId) return null;
  if (session) {
    const fenced = await Models.Head.updateOne({ _id: plain(head)._id, revision: plain(head).revision, status: "reviewed", targetRevision: currentCatalogRevision }, { $set: { workerFence: crypto.randomUUID() } }, { session });
    if (Number(fenced?.matchedCount) !== 1) return null;
  }
  const baseline = await read(Models.Baseline.findOne({ _id: plain(head).activeBaselineId, albumId: source.albumId, catalogRevision: currentCatalogRevision }), session);
  if (!baseline) return null;
  const value = plain(baseline);
  return { albumId: value.albumId, catalogRevision: value.catalogRevision, baselineId: value.baselineId, tracks: value.candidate.tracks || [], tracklistHash: value.candidate.tracklistHash };
}
async function baselineForAlbum(album, { session } = {}) { return activeBaselineFor(album, session); }

async function nextVersion(albumId, session) {
  const latest = await read(Models.Baseline.findOne({ albumId }).sort({ version: -1 }), session);
  return Number(plain(latest)?.version || 0) + 1;
}
async function existingRequest(kind, id, requestId, session) { return read(Models.Audit.findOne({ targetKind: kind, targetId: id, requestId }), session); }

async function performCommand({ kind, id, action, body, actorUserId }) {
  assertKind(kind); if (!ACTIONS.has(action)) fail("Unknown baseline action");
  if (!flags().moderation) fail("Tracklist baseline moderation is currently disabled", "TRACKLIST_BASELINE_MODERATION_DISABLED", 503);
  const allowed = new Set(["expectedRevision", "expectedTargetRevision", "candidateHash", "releaseMbid", "releaseGroupMbid", "reason", "requestId"]);
  Object.keys(body || {}).forEach((key) => { if (!allowed.has(key)) fail(`request body.${key} is not allowed`); });
  const requestId = assertUuid(body?.requestId, "requestId"); const reason = String(body?.reason || "").trim();
  if (!reason || reason.length > 1000) fail("reason is required and must be 1000 characters or fewer");
  if (typeof body.expectedRevision !== "number" || typeof body.expectedTargetRevision !== "number") fail("expected revisions are invalid");
  const expectedRevision = body.expectedRevision; const expectedTargetRevision = body.expectedTargetRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(expectedTargetRevision) || expectedTargetRevision < 1) fail("expected revisions are invalid");
  let session; let response;
  try {
    session = await mongoose.startSession(); if (!session?.withTransaction) fail("Baseline moderation requires MongoDB transactions", "BASELINE_UNAVAILABLE", 503);
    await session.withTransaction(async () => {
      const target = await findTarget(kind, id, session); const targetId = targetPublicId(kind, target); const actualTargetRevision = targetRevision(kind, target);
      const prior = await existingRequest(kind, targetId, requestId, session);
      if (prior) {
        if (plain(prior).action !== action) fail("requestId was already used for another action", "REQUEST_ID_CONFLICT", 409);
        response = await detail(kind, targetId, { session }); return;
      }
      if (actualTargetRevision !== expectedTargetRevision) fail("Target changed while it was being reviewed", "TARGET_REVISION_CONFLICT", 409);
      let head = await read(Models.Head.findOne({ targetKind: kind, targetId }), session);
      const currentRevision = Number(plain(head)?.revision || 0);
      if (currentRevision !== expectedRevision) fail("Baseline state changed while it was being reviewed", "BASELINE_REVISION_CONFLICT", 409);
      if (action === "replace" && (!head || plain(head).status !== "reviewed")) fail("replace requires a reviewed baseline or selection", "INVALID_BASELINE_STATE", 409);
      // A reviewed head bound to an older target revision is effectively stale and may be re-confirmed.
      if (action === "confirm" && head && plain(head).status === "reviewed" && Number(plain(head).targetRevision) === actualTargetRevision) fail("Use replace to change a reviewed baseline or selection", "INVALID_BASELINE_STATE", 409);
      let newStatus; let baseline = null; let snapshot = null; let catalogRevision = actualTargetRevision;
      if (action === "confirm" || action === "replace") {
        const releaseMbid = assertMbid(body.releaseMbid, "releaseMbid"); const candidateHash = String(body.candidateHash || "").toLowerCase();
        if (!HASH.test(candidateHash)) fail("candidateHash must be a tracklist hash");
        snapshot = await read(Models.Candidate.findOne({ targetKind: kind, targetId, targetRevision: actualTargetRevision, "candidate.releaseMbid": releaseMbid, "candidate.tracklistHash": candidateHash, $or: [{ expiresAt: { $gt: new Date() } }, { expiresAt: { $exists: false } }] }), session);
        if (!snapshot) fail("Candidate snapshot was not found for this target revision", "CANDIDATE_NOT_FOUND", 409);
        const candidate = validateCandidate(plain(snapshot).candidate);
        const knownGroup = releaseGroupFrom(target); const requestedGroup = body.releaseGroupMbid ? assertMbid(body.releaseGroupMbid, "releaseGroupMbid") : "";
        if (knownGroup && requestedGroup && knownGroup !== requestedGroup) fail("Release group conflicts with the target identity", "RELEASE_GROUP_MISMATCH", 409);
        const selectedGroup = requestedGroup || knownGroup;
        if (selectedGroup && candidate.releaseGroupMbid !== selectedGroup) fail("Candidate release group does not match the selected identity", "RELEASE_GROUP_MISMATCH", 409);
        if (kind === "albums") {
          const album = plain(target); if (!["album", "ep"].includes(album.releaseType)) fail("Only albums and EPs can have a standard baseline", "UNSUPPORTED_RELEASE_TYPE", 409);
          const tracks = baselineTracks(candidate, album.tracks || []); const fill = !Array.isArray(album.tracks) || album.tracks.length === 0;
          if (fill) {
            const updated = await AlbumCatalog.findOneAndUpdate({ _id: album._id, catalogRevision: catalogRevisionFilter(actualTargetRevision), "tracks.0": { $exists: false } }, { $set: { tracks: catalogTracks(tracks), catalogRevision: actualTargetRevision + 1, "fieldProvenance.tracks": { source: "musicbrainz", license: "CC0", releaseMbid: candidate.releaseMbid, releaseGroupMbid: candidate.releaseGroupMbid, reviewedByUserId: actorUserId, reviewedAt: new Date() } } }, { session, returnDocument: "after", runValidators: true });
            if (!updated) fail("Catalog album changed while tracks were being filled", "TARGET_REVISION_CONFLICT", 409);
            catalogRevision = actualTargetRevision + 1;
            await Listening.AlbumMapping.updateMany({ albumId: album.albumId, catalogRevision: actualTargetRevision, status: "active" }, { $set: { catalogRevision } }, { session });
          }
          const version = await nextVersion(album.albumId, session);
          const created = await Models.Baseline.create([{ baselineId: crypto.randomUUID(), albumId: album.albumId, version, catalogRevision, candidate: { ...candidate, tracks }, reviewedByUserId: actorUserId, reviewedAt: new Date(), reason }], { session });
          baseline = created[0]; newStatus = "reviewed";
        } else { newStatus = "reviewed"; }
      } else if (action === "defer") newStatus = "deferred";
      else newStatus = "revoked";
      const nextRevision = currentRevision + 1;
      let updatedHead;
      if (!head) {
        const created = await Models.Head.create([{ targetKind: kind, targetId, revision: nextRevision, status: newStatus, targetRevision: catalogRevision, activeBaselineId: baseline?._id || null, selectedSnapshotId: snapshot?._id || null, reason }], { session });
        [updatedHead] = created;
      } else {
        updatedHead = await Models.Head.findOneAndUpdate({ _id: head._id, revision: Number(plain(head).revision) }, { $set: { status: newStatus, targetRevision: catalogRevision, activeBaselineId: baseline?._id || null, selectedSnapshotId: snapshot?._id || null, reason }, $inc: { revision: 1 } }, { session, returnDocument: "after", runValidators: true });
        if (!updatedHead) fail("Baseline state changed while it was being reviewed", "BASELINE_REVISION_CONFLICT", 409);
      }
      await Models.Audit.create([{ targetKind: kind, targetId, requestId, action, revision: nextRevision, actorUserId, reason, baselineId: plain(baseline)?.baselineId || "", details: snapshot ? { releaseMbid: plain(snapshot).candidate.releaseMbid, tracklistHash: plain(snapshot).candidate.tracklistHash, targetRevision: actualTargetRevision } : { targetRevision: actualTargetRevision } }], { session });
      if (snapshot) await Models.Candidate.updateOne({ _id: plain(snapshot)._id }, { $unset: { expiresAt: "" } }, { session });
      if (kind === "albums") await enqueueReprocess(targetId, session, nextRevision);
      response = await detail(kind, targetId, { session });
    });
    return response;
  } catch (error) {
    if (error instanceof BaselineError) throw error;
    if (isTransactionUnavailable(error)) throw new BaselineError("Baseline moderation requires MongoDB transactions", "BASELINE_UNAVAILABLE", 503);
    if (error?.code === 11000) throw new BaselineError("Baseline command conflicted with another command", "BASELINE_REVISION_CONFLICT", 409);
    throw error;
  } finally { if (session?.endSession) await session.endSession(); }
}

async function derivedHead(kind, target, session) {
  const id = targetPublicId(kind, target); const head = await read(Models.Head.findOne({ targetKind: kind, targetId: id }).populate("activeBaselineId").populate("selectedSnapshotId"), session);
  if (!head) return { revision: 0, status: "pending", targetRevision: targetRevision(kind, target), activeBaselineId: null, selectedSnapshotId: null, reason: "" };
  const source = plain(head);
  if (source.status === "reviewed" && Number(source.targetRevision) !== targetRevision(kind, target)) source.status = "stale";
  return source;
}
async function detail(kind, id, { session } = {}) {
  const target = await findTarget(kind, id, session); const source = plain(target); const head = await derivedHead(kind, target, session);
  const history = await read(Models.Audit.find({ targetKind: kind, targetId: targetPublicId(kind, target) }).sort({ revision: 1 }), session);
  const metadata = targetMetadata(kind, target);
  return {
    target: { kind, id: targetPublicId(kind, target), title: metadata.title || "", artistDisplayName: metadata.artistDisplayName || "", ...(kind === "albums" ? { catalogRevision: source.catalogRevision } : { submissionRevision: source.currentRevision }), releaseGroupMbid: releaseGroupFrom(source) },
    revision: head.revision,
    status: head.status,
    activeBaseline: head.activeBaselineId ? (() => { const value = plain(head.activeBaselineId); return value?.baselineId ? { baselineId: value.baselineId, albumId: value.albumId, version: value.version, catalogRevision: value.catalogRevision, candidate: serializeCandidate(value.candidate, { includeTrackIds: true }), reviewedByUserId: value.reviewedByUserId, reviewedAt: value.reviewedAt, reason: value.reason } : null; })() : null,
    selection: serializeCandidate(plain(head.selectedSnapshotId)?.candidate),
    history: (history || []).map((row) => { const value = plain(row); return { auditId: value.auditId, action: value.action, revision: value.revision, actorUserId: value.actorUserId, reason: value.reason, baselineId: value.baselineId || "", details: value.details || {}, createdAt: value.createdAt }; }),
    flags: flags(),
  };
}

function decodeCursor(value) { if (!value) return null; try { const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); const date = new Date(decoded.updatedAt); if (!decoded.kind || !decoded.id || Number.isNaN(date.getTime())) throw new Error(); return { updatedAt: date, kind: decoded.kind, id: decoded.id }; } catch { fail("cursor is invalid", "INVALID_CURSOR"); } }
async function list({ status = "pending", limit = 20, cursor, q = "" } = {}) {
  if (!STATUSES.has(status)) fail("status is invalid"); const size = Number(limit); if (!Number.isSafeInteger(size) || size < 1 || size > 50) fail("limit must be between 1 and 50");
  const after = decodeCursor(cursor); const query = String(q || "").trim(); if (query.length > 200) fail("q is too long");
  const pipeline = [
    { $match: { releaseType: { $in: ["album", "ep"] } } },
    { $project: { kind: { $literal: "albums" }, id: "$albumId", title: 1, artistDisplayName: 1, targetRevision: { $ifNull: ["$catalogRevision", 1] }, updatedAt: 1, externalReferences: 1 } },
    { $unionWith: { coll: AlbumSubmission.collection.name, pipeline: [
      { $match: { status: "pending", submissionType: "new_album", "proposedMetadata.releaseType": { $in: ["album", "ep"] } } },
      { $project: { kind: { $literal: "submissions" }, id: "$submissionId", title: "$proposedMetadata.title", artistDisplayName: "$proposedMetadata.artistDisplayName", targetRevision: "$currentRevision", updatedAt: 1, externalReferences: 1 } },
    ] } },
    { $lookup: { from: Models.Head.collection.name, let: { targetKind: "$kind", targetId: "$id" }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$targetKind", "$$targetKind"] }, { $eq: ["$targetId", "$$targetId"] }] } } }], as: "heads" } },
    { $set: { head: { $first: "$heads" } } },
    { $set: { revision: { $ifNull: ["$head.revision", 0] }, status: { $cond: [{ $and: [{ $eq: [{ $ifNull: ["$head.status", "pending"] }, "reviewed"] }, { $ne: ["$head.targetRevision", "$targetRevision"] }] }, "stale", { $ifNull: ["$head.status", "pending"] }] } } },
    { $match: { status } },
  ];
  if (query) pipeline.push({ $match: { $or: [{ title: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }, { artistDisplayName: { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }] } });
  if (after) pipeline.push({ $match: { $or: [{ updatedAt: { $gt: after.updatedAt } }, { updatedAt: after.updatedAt, kind: { $gt: after.kind } }, { updatedAt: after.updatedAt, kind: after.kind, id: { $gt: after.id } }] } });
  pipeline.push({ $sort: { updatedAt: 1, kind: 1, id: 1 } }, { $limit: size + 1 }, { $project: { _id: 0, heads: 0, head: 0 } });
  const rows = await AlbumCatalog.aggregate(pipeline); const rawPage = rows.slice(0, size); const last = rawPage[rawPage.length - 1];
  const next = rows.length > size && last ? Buffer.from(JSON.stringify({ updatedAt: new Date(last.updatedAt).toISOString(), kind: last.kind, id: last.id })).toString("base64url") : null;
  const items = rawPage.map(({ externalReferences, ...row }) => ({ ...row, releaseGroupMbid: releaseGroupFrom({ externalReferences }) }));
  return { items, nextCursor: next };
}

async function invalidateAlbumBaseline(album, { session, actorUserId = "system", reason = "Catalog album changed", requestId = crypto.randomUUID() } = {}) {
  const source = plain(album); if (!source?.albumId) return false;
  const head = await read(Models.Head.findOne({ targetKind: "albums", targetId: source.albumId, status: "reviewed" }), session); if (!head) return false;
  const current = plain(head); if (Number(current.targetRevision) === catalogRevisionOf(source)) return false;
  const updated = await Models.Head.findOneAndUpdate({ _id: current._id, revision: current.revision, status: "reviewed" }, { $set: { status: "stale", activeBaselineId: null, reason }, $inc: { revision: 1 } }, { session, returnDocument: "after" });
  if (!updated) return false;
  await Models.Audit.create([{ targetKind: "albums", targetId: source.albumId, requestId, action: "invalidate", revision: current.revision + 1, actorUserId, reason, details: { catalogRevision: source.catalogRevision } }], { session });
  await enqueueReprocess(source.albumId, session, current.revision + 1);
  return true;
}

async function publishSubmissionBaseline({ submission, album, actorUserId, session }) {
  const source = plain(submission); const catalog = plain(album);
  const head = await read(Models.Head.findOne({ targetKind: "submissions", targetId: source.submissionId, status: "reviewed", targetRevision: source.currentRevision }).populate("selectedSnapshotId"), session);
  const snapshot = plain(head)?.selectedSnapshotId; if (!snapshot?.candidate) return null;
  const candidate = validateCandidate(snapshot.candidate); const knownGroup = releaseGroupFrom(source);
  if (knownGroup && candidate.releaseGroupMbid !== knownGroup) fail("Selected baseline no longer matches the submission identity", "RELEASE_GROUP_MISMATCH", 409);
  const tracks = baselineTracks(candidate, catalog.tracks || []); const version = await nextVersion(catalog.albumId, session); const now = new Date();
  const publicationRevision = catalogRevisionOf(catalog);
  if (!Array.isArray(catalog.tracks) || catalog.tracks.length === 0) {
    const filled = await AlbumCatalog.updateOne(
      { _id: catalog._id, catalogRevision: publicationRevision, "tracks.0": { $exists: false } },
      { $set: { tracks: catalogTracks(tracks), "fieldProvenance.tracks": { source: "musicbrainz", license: "CC0", releaseMbid: candidate.releaseMbid, releaseGroupMbid: candidate.releaseGroupMbid, reviewedByUserId: actorUserId, reviewedAt: now } } },
      { session, runValidators: true },
    );
    if (Number(filled?.matchedCount) !== 1) fail("Catalog album changed while the selected baseline was published", "TARGET_REVISION_CONFLICT", 409);
  }
  const created = await Models.Baseline.create([{ baselineId: crypto.randomUUID(), albumId: catalog.albumId, version, catalogRevision: publicationRevision, candidate: { ...candidate, tracks }, reviewedByUserId: actorUserId, reviewedAt: now, reason: plain(head).reason }], { session });
  const baseline = created[0];
  await Models.Head.create([{ targetKind: "albums", targetId: catalog.albumId, revision: 1, status: "reviewed", targetRevision: publicationRevision, activeBaselineId: baseline._id, reason: plain(head).reason }], { session });
  await Models.Audit.create([{ targetKind: "albums", targetId: catalog.albumId, requestId: crypto.randomUUID(), action: "publish", revision: 1, actorUserId, reason: plain(head).reason, baselineId: baseline.baselineId, details: { submissionId: source.submissionId, submissionRevision: source.currentRevision } }], { session });
  const consumed = await Models.Head.findOneAndUpdate({ _id: plain(head)._id, revision: plain(head).revision, status: "reviewed", targetRevision: source.currentRevision }, { $set: { status: "revoked", selectedSnapshotId: null, reason: "Published with approved catalog album" }, $inc: { revision: 1 } }, { session, returnDocument: "after" });
  if (!consumed) fail("Baseline selection changed during approval", "BASELINE_REVISION_CONFLICT", 409);
  await enqueueReprocess(catalog.albumId, session, 1);
  return baseline;
}

async function queueEnrichmentCandidate({ albumId, expectedCatalogRevision, candidate, reviewer, planHash, session }) {
  const id = assertUuid(albumId, "albumId");
  const revision = Number(expectedCatalogRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) fail("expectedCatalogRevision is invalid");
  if (!/^[0-9a-f]{64}$/iu.test(String(planHash || ""))) fail("planHash must be a SHA-256 checksum");
  const normalizedPlanHash = String(planHash).toLowerCase();
  if (!String(reviewer || "").trim() || String(reviewer).length > 128) fail("reviewer is invalid");
  const album = await read(AlbumCatalog.findOne({ albumId: id, catalogRevision: catalogRevisionFilter(revision) }), session);
  if (!album) fail("Catalog album changed after the enrichment plan was reviewed", "TARGET_REVISION_CONFLICT", 409);
  const source = plain(album);
  const prior = await read(Models.Audit.findOne({ targetKind: "albums", targetId: id, requestId: normalizedPlanHash, action: "queue" }), session);
  if (prior) {
    const priorHead = await read(Models.Head.findOne({ targetKind: "albums", targetId: id }).populate("selectedSnapshotId"), session);
    return { albumId: id, revision: plain(priorHead)?.revision || plain(prior).revision, status: plain(priorHead)?.status || "pending", candidate: serializeCandidate(plain(priorHead)?.selectedSnapshotId?.candidate), idempotent: true };
  }
  if (!["album", "ep"].includes(source.releaseType)) fail("Only albums and EPs can have a standard baseline", "UNSUPPORTED_RELEASE_TYPE", 409);
  const knownGroup = releaseGroupFrom(source);
  const normalized = validateCandidate(candidate);
  if (knownGroup && normalized.releaseGroupMbid !== knownGroup) fail("Candidate release group does not match the catalog identity", "RELEASE_GROUP_MISMATCH", 409);
  const snapshot = await storeCandidate("albums", album, normalized, { session });
  let head = await read(Models.Head.findOne({ targetKind: "albums", targetId: id }), session);
  if (head && ["reviewed", "stale"].includes(plain(head).status)) fail("Album already has baseline history and requires interactive review", "BASELINE_STATE_CONFLICT", 409);
  if (!head) {
    const created = await Models.Head.create([{ targetKind: "albums", targetId: id, revision: 1, status: "pending", targetRevision: revision, selectedSnapshotId: snapshot._id, reason: `Queued from reviewed plan ${normalizedPlanHash}` }], { session });
    head = created[0];
  } else {
    head = await Models.Head.findOneAndUpdate({ _id: plain(head)._id, revision: plain(head).revision, targetRevision: revision }, { $set: { status: "pending", selectedSnapshotId: snapshot._id, reason: `Queued from reviewed plan ${normalizedPlanHash}` }, $inc: { revision: 1 } }, { session, returnDocument: "after", runValidators: true });
    if (!head) fail("Baseline queue changed while the plan was applied", "BASELINE_REVISION_CONFLICT", 409);
  }
  const headSource = plain(head);
  await Models.Audit.findOneAndUpdate(
    { targetKind: "albums", targetId: id, requestId: normalizedPlanHash },
    { $setOnInsert: { auditId: crypto.randomUUID(), action: "queue", revision: headSource.revision, actorUserId: String(reviewer).trim(), reason: `Queued from reviewed enrichment plan ${normalizedPlanHash}`, details: { releaseMbid: normalized.releaseMbid, tracklistHash: normalized.tracklistHash, catalogRevision: revision } } },
    { upsert: true, session, runValidators: true },
  );
  return { albumId: id, revision: headSource.revision, status: headSource.status, candidate: serializeCandidate(plain(snapshot).candidate) };
}

module.exports = { BaselineError, baselineForAlbum, candidates, detail, enqueueReprocess, flags, invalidateAlbumBaseline, list, performCommand, preview, publishSubmissionBaseline, queueEnrichmentCandidate, searchGroups, storeCandidate, validateCandidate };
