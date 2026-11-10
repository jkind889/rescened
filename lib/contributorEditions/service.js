const Preview = require('../../models/ContributorEditionPreview');
const discovery = require('../baselines/discovery');
const { BaselineError, validateCandidate, serializeCandidate, assertMbid } = require('../baselines/candidate');
const { normalizeSubmissionPayload } = require('../../routes/utils/submissions');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function enabled() { return String(process.env.CONTRIBUTOR_EDITIONS_ENABLED || '').toLowerCase() === 'true'; }
function assertEnabled() { if (!enabled()) throw new BaselineError('Contributor editions are currently disabled', 'CONTRIBUTOR_EDITIONS_DISABLED', 503); }
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BaselineError('Request must be an object', 'INVALID_EDITION_REQUEST');
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new BaselineError('Unknown edition request field', 'INVALID_EDITION_REQUEST');
}
async function candidates(body) {
  assertEnabled(); keys(body, ['releaseGroupMbid', 'offset']);
  const group = assertMbid(body.releaseGroupMbid, 'releaseGroupMbid');
  const offset = body.offset === undefined ? 0 : body.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw new BaselineError('offset is invalid');
  // Browse rather than an automatic multi-request recommendation for contributors.
  return { ...(await discovery.browse(group, offset)), candidate: null };
}
async function preview(body, ownerUserId) {
  assertEnabled(); keys(body, ['releaseMbid', 'releaseGroupMbid']);
  const group = assertMbid(body.releaseGroupMbid, 'releaseGroupMbid');
  const candidate = await discovery.preview(body.releaseMbid, group);
  // Fail unsupported submission field lengths now instead of truncating provider data.
  validateSubmissionTracks(candidate);
  const row = await Preview.create({ ownerUserId, candidate, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  return { previewId: row.previewId, candidate: serializeCandidate(row.candidate), expiresAt: row.expiresAt };
}
function tracks(candidate) {
  return candidate.tracks.map(({ discNumber, trackNumber, title, durationMs = 0, artistDisplayName = '' }) => ({ discNumber, trackNumber, title, durationMs: durationMs ?? 0, artistDisplayName }));
}
function validateSubmissionTracks(candidate) {
  if (candidate.tracks.some((track) => track.title.length > 200 || (track.artistDisplayName || '').length > 300 || track.discNumber > 999 || track.trackNumber > 999 || !Number.isSafeInteger(track.durationMs ?? 0) || (track.durationMs ?? 0) < 0 || (track.durationMs ?? 0) > 86400000)) {
    throw new BaselineError('Edition exceeds suggestion track limits', 'EDITION_TRACKS_UNSUPPORTED', 409);
  }
}
async function normalize(body, ownerUserId, current = null) {
  // Legacy/manual suggestions keep their existing contract; edition proposals are opt-in.
  if (!Object.hasOwn(body || {}, 'editionPreviewId')) return normalizeSubmissionPayload(body);
  const retainCurrent = current?.submittedByUserId === ownerUserId && current.editionProposal?.previewId === body.editionPreviewId;
  if (!retainCurrent) assertEnabled();
  const { editionPreviewId, ...input } = body;
  if (typeof editionPreviewId !== 'string' || !UUID.test(editionPreviewId)) throw new BaselineError('Invalid edition preview ID', 'INVALID_EDITION_REQUEST');
  if (Object.hasOwn(input.proposedMetadata || {}, 'tracks')) throw new BaselineError('Edition tracks are server-authored in v1', 'EDITION_TRACKS_READ_ONLY');
  let proposal;
  if (retainCurrent) {
    proposal = current.editionProposal.toObject ? current.editionProposal.toObject() : current.editionProposal;
  } else {
    const row = await Preview.findOne({ previewId: editionPreviewId, ownerUserId, expiresAt: { $gt: new Date() } });
    if (!row) throw new BaselineError('Edition preview expired or is unavailable; preview it again', 'EDITION_PREVIEW_UNAVAILABLE', 409);
    proposal = { previewId: row.previewId, candidate: row.candidate.toObject ? row.candidate.toObject() : row.candidate };
  }
  validateCandidate(proposal.candidate); validateSubmissionTracks(proposal.candidate);
  const payload = normalizeSubmissionPayload({ ...input, proposedMetadata: { ...input.proposedMetadata, tracks: tracks(proposal.candidate) } });
  for (const ref of payload.externalReferences.filter((ref) => ref.provider === 'musicbrainz')) {
    const expected = ref.entityType === 'release-group' ? proposal.candidate.releaseGroupMbid : ref.entityType === 'release' ? proposal.candidate.releaseMbid : null;
    if (expected && ref.externalId.toLowerCase() !== expected) throw new BaselineError('Edition conflicts with the proposed release identity', 'RELEASE_GROUP_MISMATCH', 409);
  }
  payload.externalReferences = payload.externalReferences.filter((ref) => !(ref.provider === 'musicbrainz' && ['release', 'release-group'].includes(ref.entityType)));
  for (const [entityType, externalId] of [['release', proposal.candidate.releaseMbid], ['release-group', proposal.candidate.releaseGroupMbid]]) {
    payload.externalReferences.push({ provider: 'musicbrainz', entityType, externalId, url: `https://musicbrainz.org/${entityType}/${externalId}` });
  }
  if (payload.externalReferences.length > 20) throw new BaselineError('Too many external references', 'INVALID_EDITION_REQUEST');
  payload.editionProposal = proposal;
  return payload;
}
module.exports = { enabled, assertEnabled, keys, candidates, preview, normalize, tracks };
