const { digest, targetFingerprint } = require('../listening/seeds');
const { catalogRevisionOf, assertPublicAlbumId, safeError } = require('../listening/common');
const SCHEMA = 'rescened-baseline-enrichment/v1';
const fail = (code) => { throw safeError(code); };

async function preparePlan({ albums, environment, fingerprint, provider, baselineForAlbum, now = new Date() }) {
  if (!/^[\w-]{1,80}$/.test(environment || '') || !/^[a-f0-9]{64}$/.test(fingerprint || '')) fail('INVALID_ENRICHMENT_TARGET');
  if (!Array.isArray(albums) || albums.length > 100) fail('INVALID_ENRICHMENT_BATCH');
  const entries = [];
  for (const album of albums) {
    assertPublicAlbumId(album.albumId);
    const entry = { albumId: album.albumId, catalogRevision: catalogRevisionOf(album), title: album.title, artistDisplayName: album.artistDisplayName };
    if (await baselineForAlbum(album)) { entries.push({ ...entry, status: 'reviewed' }); continue; }
    const groups = [...new Set((album.externalReferences || []).filter((ref) => ref.provider === 'musicbrainz' && ref.entityType === 'release-group').map((ref) => ref.externalId))];
    if (groups.length !== 1) { entries.push({ ...entry, status: groups.length ? 'conflict' : 'group_required' }); continue; }
    try {
      const result = await provider.recommend(groups[0], { title: album.title });
      entries.push({ ...entry, status: result.candidate ? 'candidate' : 'unavailable', releaseGroupMbid: groups[0], candidate: result.candidate || null, incomplete: Boolean(result.incomplete), ambiguous: Boolean(result.ambiguous), rationale: result.rationale || [] });
    } catch (error) {
      entries.push({ ...entry, status: 'unavailable', code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'MUSICBRAINZ_UNAVAILABLE' });
    }
  }
  return { schema: SCHEMA, environment, fingerprint, createdAt: now.toISOString(), entries };
}

// Aggregate-only batch summary for pilot reporting; it names no albums.
function summarizePlan(plan) {
  const byStatus = { candidate: 0, reviewed: 0, conflict: 0, group_required: 0, unavailable: 0 };
  const failureCodes = {};
  let incomplete = 0; let ambiguous = 0;
  for (const entry of plan.entries) {
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    if (entry.status === 'unavailable') { const code = entry.code || 'NO_COMPLETE_RELEASE'; failureCodes[code] = (failureCodes[code] || 0) + 1; }
    if (entry.incomplete) incomplete += 1;
    if (entry.ambiguous) ambiguous += 1;
  }
  return { entries: plan.entries.length, byStatus, failureCodes, incompleteDiscovery: incomplete, ambiguousRecommendations: ambiguous };
}

function verifyPlan(bytes, checksum, environment, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(checksum || '') || digest(bytes) !== checksum) fail('ENRICHMENT_CHECKSUM_MISMATCH');
  let plan;
  try { plan = JSON.parse(bytes); } catch { fail('INVALID_ENRICHMENT_PLAN'); }
  if (plan.schema !== SCHEMA || plan.environment !== environment || plan.fingerprint !== fingerprint) fail('ENRICHMENT_TARGET_MISMATCH');
  if (!Array.isArray(plan.entries) || plan.entries.length > 100) fail('INVALID_ENRICHMENT_PLAN');
  const ids = new Set();
  for (const entry of plan.entries) {
    assertPublicAlbumId(entry.albumId);
    if (ids.has(entry.albumId) || !Number.isSafeInteger(entry.catalogRevision) || entry.catalogRevision < 1 || !['candidate', 'reviewed', 'conflict', 'group_required', 'unavailable'].includes(entry.status)) fail('INVALID_ENRICHMENT_PLAN');
    ids.add(entry.albumId);
    if (entry.status === 'candidate' && (!entry.candidate || entry.candidate.releaseGroupMbid !== entry.releaseGroupMbid || !/^[a-f0-9]{64}$/.test(entry.candidate.tracklistHash || ''))) fail('INVALID_ENRICHMENT_PLAN');
  }
  return plan;
}

async function applyPlan(plan, { mongoose, reviewer, planHash, queueCandidate }) {
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 200) fail('ENRICHMENT_REVIEWER_REQUIRED');
  const session = await mongoose.startSession();
  let queued = 0;
  try {
    await session.withTransaction(async () => {
      queued = 0;
      for (const entry of plan.entries.filter((item) => item.status === 'candidate')) {
        await queueCandidate({ albumId: entry.albumId, expectedCatalogRevision: entry.catalogRevision, candidate: entry.candidate, reviewer, planHash, session });
        queued += 1;
      }
    });
  } catch (error) {
    if (require('../../routes/utils/transactions').isTransactionUnavailable(error)) throw safeError('TRANSACTIONS_UNAVAILABLE', 503);
    throw error;
  } finally { await session.endSession(); }
  return { queued, environment: plan.environment, committed: true };
}
module.exports = { preparePlan, summarizePlan, verifyPlan, applyPlan, digest, targetFingerprint };
