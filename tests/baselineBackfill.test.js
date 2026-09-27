const test = require('node:test');
const assert = require('node:assert/strict');
const { preparePlan, summarizePlan, verifyPlan, applyPlan, digest } = require('../lib/baselines/backfill');
const { parseArgs } = require('../scripts/enrichAlbumTracklists');
const albumId = 'aab1557c-cc11-478b-832e-60fc8046d949';
const group = '11223344-5566-7788-99aa-bbccddeeff00';
const fingerprint = 'a'.repeat(64);
const album = { albumId, title: 'Album', artistDisplayName: 'Artist', catalogRevision: 3, externalReferences: [{ provider: 'musicbrainz', entityType: 'release-group', externalId: group }] };
test('enrichment report records unresolved groups and provider failures without writes', async () => {
  const plan = await preparePlan({ albums: [album], environment: 'pilot', fingerprint, baselineForAlbum: async () => null, provider: { recommend: async () => { throw new Error('sensitive'); } } });
  assert.equal(plan.entries[0].status, 'unavailable');
  assert.equal(JSON.stringify(plan).includes('sensitive'), false);
  const missing = await preparePlan({ albums: [{ ...album, externalReferences: [] }], environment: 'pilot', fingerprint, baselineForAlbum: async () => null, provider: {} });
  assert.equal(missing.entries[0].status, 'group_required');
});
test('reviewed report is bound to checksum and named target', async () => {
  const candidate = { releaseGroupMbid: group, tracklistHash: 'b'.repeat(64) };
  const plan = await preparePlan({ albums: [album], environment: 'pilot', fingerprint, baselineForAlbum: async () => null, provider: { recommend: async () => ({ candidate }) } });
  const bytes = JSON.stringify(plan);
  assert.equal(verifyPlan(bytes, digest(bytes), 'pilot', fingerprint).entries[0].catalogRevision, 3);
  assert.throws(() => verifyPlan(bytes + ' ', digest(bytes), 'pilot', fingerprint), /CHECKSUM/);
  assert.throws(() => verifyPlan(bytes, digest(bytes), 'production', fingerprint), /TARGET/);
  let queued;
  const session = { withTransaction: async (fn) => fn(), endSession: async () => {} };
  const result = await applyPlan(plan, { mongoose: { startSession: async () => session }, reviewer: 'moderator', planHash: digest(bytes), queueCandidate: async (input) => { queued = input; } });
  assert.equal(result.queued, 1);
  assert.equal(queued.expectedCatalogRevision, 3);
  assert.equal(queued.candidate, candidate);
  assert.equal(queued.session, session);
});
test('operator CLI defaults to dry run and requires explicit matching apply target', () => {
  assert.equal(parseArgs(['--environment', 'pilot', '--output', '/private/tmp/report.json']).mode, 'dry-run');
  assert.throws(() => parseArgs(['--apply', '--environment', 'production']), /EXPLICIT/);
  assert.throws(() => parseArgs(['--environment', 'pilot', '--output', '/tmp/report', '--limit', '101']), /INVALID_LIMIT/);
});
test('batch summary counts outcomes and failure codes without naming albums', async () => {
  const other = { ...album, albumId: 'bbb1557c-cc11-478b-832e-60fc8046d949' };
  const third = { ...album, albumId: 'ccc1557c-cc11-478b-832e-60fc8046d949', externalReferences: [] };
  const fourth = { ...album, albumId: 'ddd1557c-cc11-478b-832e-60fc8046d949' };
  const results = [
    async () => { throw Object.assign(new Error('x'), { code: 'MUSICBRAINZ_RATE_LIMITED' }); },
    async () => ({ candidate: { releaseGroupMbid: group, tracklistHash: 'b'.repeat(64) }, incomplete: true, ambiguous: true }),
    async () => ({ candidate: null }),
  ];
  const plan = await preparePlan({ albums: [album, other, third, fourth], environment: 'pilot', fingerprint, baselineForAlbum: async () => null, provider: { recommend: () => results.shift()() } });
  const summary = summarizePlan(plan);
  assert.deepEqual(summary, { entries: 4, byStatus: { candidate: 1, reviewed: 0, conflict: 0, group_required: 1, unavailable: 2 }, failureCodes: { MUSICBRAINZ_RATE_LIMITED: 1, NO_COMPLETE_RELEASE: 1 }, incompleteDiscovery: 1, ambiguousRecommendations: 1 });
  assert.equal(JSON.stringify(summary).includes(album.albumId), false);
});
