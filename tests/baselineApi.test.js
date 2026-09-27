const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../lib/baselines/service');
const clerkPath = require.resolve('@clerk/express');
const routerPath = require.resolve('../routes/albumBaselines');
const originalClerk = require.cache[clerkPath];
require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: { getAuth: (req) => ({ userId: req.testUserId || '' }) } };
const router = require('../routes/albumBaselines');
const originals = { detail: service.detail, list: service.list, candidates: service.candidates };
const oldModerator = process.env.MODERATOR_USER_IDS;
process.env.MODERATOR_USER_IDS = 'baseline-moderator';
test.after(() => {
  Object.assign(service, originals);
  if (originalClerk) require.cache[clerkPath] = originalClerk; else delete require.cache[clerkPath];
  delete require.cache[routerPath];
  if (oldModerator === undefined) delete process.env.MODERATOR_USER_IDS; else process.env.MODERATOR_USER_IDS = oldModerator;
});
async function invoke(method, path, input = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  const req = { params: { kind: 'albums', id: '11111111-1111-4111-8111-111111111111' }, query: {}, body: {}, ...input };
  const res = { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; }, set(name, value) { this.headers[name] = value; return this; }, setHeader(name, value) { this.headers[name] = value; return this; }, json(value) { this.body = value; return this; } };
  for (const layer of route.route.stack) { let next = false; await layer.handle(req, res, () => { next = true; }); if (!next) break; }
  return res;
}
test('every baseline endpoint enforces Clerk authentication and server moderator membership', async () => {
  for (const layer of router.stack.filter((entry) => entry.route)) {
    const method = Object.keys(layer.route.methods)[0];
    assert.equal((await invoke(method, layer.route.path)).statusCode, 401);
    assert.equal((await invoke(method, layer.route.path, { testUserId: 'outsider' })).statusCode, 403);
  }
});
test('persisted moderator reads remain available while discovery and decisions are disabled', async () => {
  service.detail = async () => ({ status: 'reviewed', flags: { discovery: false, moderation: false } });
  const result = await invoke('get', '/:kind/:id', { testUserId: 'baseline-moderator' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'reviewed');
});
test('unknown query keys are rejected before queue reads', async () => {
  let called = false;
  service.list = async () => { called = true; return { items: [] }; };
  const result = await invoke('get', '/', { testUserId: 'baseline-moderator', query: { moderator: 'client-owned' } });
  assert.equal(result.statusCode, 400);
  assert.equal(called, false);
});
test('provider rate limits preserve the stable code and expose Retry-After', async () => {
  const { BaselineMusicBrainzError } = require('../lib/baselines/musicBrainz');
  service.candidates = async () => { throw new BaselineMusicBrainzError('MusicBrainz is unavailable', { code: 'MUSICBRAINZ_RATE_LIMITED', status: 503, retryAfterMs: 2500 }); };
  const limited = await invoke('post', '/:kind/:id/candidates', { testUserId: 'baseline-moderator' });
  assert.equal(limited.statusCode, 503);
  assert.equal(limited.body.code, 'MUSICBRAINZ_RATE_LIMITED');
  assert.equal(limited.headers['Retry-After'], '3');
  service.candidates = async () => { throw new BaselineMusicBrainzError('MusicBrainz request timed out', { code: 'MUSICBRAINZ_TIMEOUT', status: 503 }); };
  const timeout = await invoke('post', '/:kind/:id/candidates', { testUserId: 'baseline-moderator' });
  assert.equal(timeout.statusCode, 503);
  assert.equal('Retry-After' in timeout.headers, false);
});
