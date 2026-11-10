// Shared provider-only operations. No target, snapshot, head or review-episode writes.
// The adapter still maintains the shared provider cache and request budget.
const { BaselineError, assertMbid, validateCandidate, releaseId } = require('./candidate');
function provider() { return require('./musicBrainz').createBaselineMusicBrainz(); }
async function searchGroups(q, limit = 10) {
  if (typeof q !== 'string' || q.trim().length < 2 || q.trim().length > 200) throw new BaselineError('q must contain 2 to 200 characters');
  const parsed = Number(limit);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 25) throw new BaselineError('limit must be between 1 and 25');
  return { items: await provider().searchReleaseGroups(q.trim(), parsed) };
}
async function recommend(group, title = '') { return provider().recommend(assertMbid(group, 'releaseGroupMbid'), { title }); }
async function browse(group, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw new BaselineError('offset is invalid');
  return provider().browseReleases(assertMbid(group, 'releaseGroupMbid'), { offset, limit: 20 });
}
async function preview(release, group) {
  const expected = group ? assertMbid(group, 'releaseGroupMbid') : '';
  const candidate = validateCandidate(await provider().release(releaseId(release)));
  if (expected && candidate.releaseGroupMbid !== expected) throw new BaselineError('Release does not belong to the selected release group', 'RELEASE_GROUP_MISMATCH', 409);
  return candidate;
}
module.exports = { searchGroups, recommend, browse, preview };
