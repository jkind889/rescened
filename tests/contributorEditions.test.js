const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const service = require('../lib/contributorEditions/service');
const discovery = require('../lib/baselines/discovery');
const Preview = require('../models/ContributorEditionPreview');
const { hashCandidateTracklist, BaselineMusicBrainzError } = require('../lib/baselines/musicBrainz');
const { serializeSubmission, snapshotForSubmission } = require('../routes/utils/submissions');
const originals = { preview: discovery.preview, browse: discovery.browse, searchGroups: discovery.searchGroups, create: Preview.create, findOne: Preview.findOne };
const env = { editions: process.env.CONTRIBUTOR_EDITIONS_ENABLED, submissions: process.env.COMMUNITY_SUBMISSIONS_ENABLED };
const clerkPath = require.resolve('@clerk/express');
const oldClerk = require.cache[clerkPath];
require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: { getAuth: (req) => ({ userId: req.testUserId || '' }) } };
const router = require('../routes/suggestions');
function candidate() {
  const releaseMbid = crypto.randomUUID();
  const value = { releaseMbid, releaseGroupMbid: crypto.randomUUID(), title: 'Fixture Album', artistDisplayName: 'Artist', date: '2026', country: 'US', formats: ['CD'], status: 'Official', disambiguation: '', retrievedAt: new Date(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: 'CC0', tracks: [{ trackId: crypto.randomUUID(), discNumber: 1, trackNumber: 1, title: 'One', durationMs: 1000, artistDisplayName: 'Artist', releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID() }] };
  return { ...value, tracklistHash: hashCandidateTracklist(value) };
}
function body(previewId) { return { editionPreviewId: previewId, proposedMetadata: { title: 'Fixture Album', artistCredits: [{ name: 'Artist' }], releaseType: 'album', releaseDate: '2026' }, supportingSources: [{ type: 'musicbrainz', url: 'https://musicbrainz.org/' }], externalReferences: [] }; }
async function invoke(method, path, input = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  const req = { params: {}, query: {}, body: {}, ip: '127.0.0.1', ...input };
  const res = { statusCode: 200, headers: {}, status(v) { this.statusCode = v; return this; }, set(k,v) { this.headers[k] = v; return this; }, setHeader(k,v) { this.headers[k] = v; return this; }, json(v) { this.body = v; return this; } };
  for (const layer of route.route.stack) { let next = false; await layer.handle(req,res,()=>{next=true;}); if (!next) break; }
  return res;
}
test.beforeEach(() => { process.env.CONTRIBUTOR_EDITIONS_ENABLED = 'true'; process.env.COMMUNITY_SUBMISSIONS_ENABLED = 'true'; });
test.afterEach(() => { discovery.preview = originals.preview; discovery.browse = originals.browse; discovery.searchGroups = originals.searchGroups; Preview.create = originals.create; Preview.findOne = originals.findOne; });
test.after(() => { for (const [key,value] of [['CONTRIBUTOR_EDITIONS_ENABLED',env.editions], ['COMMUNITY_SUBMISSIONS_ENABLED',env.submissions]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } if (oldClerk) require.cache[clerkPath] = oldClerk; else delete require.cache[clerkPath]; });
test('all edition routes authenticate and disabled discovery stops before provider or preview writes', async () => {
  let called = false; discovery.searchGroups = discovery.browse = discovery.preview = Preview.create = async () => { called=true; throw new Error('must not call'); };
  for (const [method,path] of [['get','/editions/capabilities'],['get','/editions/groups'],['post','/editions/candidates'],['post','/editions/preview']]) assert.equal((await invoke(method,path)).statusCode,401);
  delete process.env.CONTRIBUTOR_EDITIONS_ENABLED;
  assert.equal(service.enabled(),false);
  assert.equal((await invoke('get','/editions/capabilities',{testUserId:'flag-user'})).body.enabled,false);
  assert.equal((await invoke('post','/editions/preview',{testUserId:'flag-user'})).statusCode,503);
  assert.equal(called,false);
});
test('submission mutation gate also disables contributor provider discovery', async () => {
  let called = false; discovery.searchGroups = async () => { called = true; return {items:[]}; };
  process.env.COMMUNITY_SUBMISSIONS_ENABLED = 'false';
  assert.equal((await invoke('get','/editions/capabilities',{testUserId:'submission-gate'})).body.enabled,false);
  const result = await invoke('get','/editions/groups',{testUserId:'submission-gate',query:{q:'album'}});
  assert.equal(result.statusCode,503); assert.equal(result.body.code,'SUBMISSIONS_DISABLED'); assert.equal(called,false);
});
test('shared preview rejects a release from a different group before contributor snapshot persistence', async () => {
  const adapter = require('../lib/baselines/musicBrainz');
  const originalFactory = adapter.createBaselineMusicBrainz;
  const value = candidate(); let wrote = false;
  adapter.createBaselineMusicBrainz = () => ({ release: async () => value });
  Preview.create = async () => { wrote = true; throw new Error('must not persist'); };
  try {
    await assert.rejects(service.preview({releaseMbid:value.releaseMbid,releaseGroupMbid:crypto.randomUUID()},'owner'),error=>error.code==='RELEASE_GROUP_MISMATCH');
    assert.equal(wrote,false);
  } finally { adapter.createBaselineMusicBrainz = originalFactory; }
});
test('contributor discovery is per-user limited and preserves Retry-After', async () => {
  discovery.searchGroups = async () => ({items:[]});
  for (let i=0;i<10;i++) assert.equal((await invoke('get','/editions/groups',{testUserId:'budget-a',query:{q:'album'}})).statusCode,200);
  const blocked = await invoke('get','/editions/groups',{testUserId:'budget-a',query:{q:'album'}});
  assert.equal(blocked.statusCode,429); assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.equal((await invoke('get','/editions/groups',{testUserId:'budget-b',query:{q:'album'}})).statusCode,200);
  discovery.searchGroups = async () => { throw new BaselineMusicBrainzError('Provider throttled', {status:503,code:'MUSICBRAINZ_RATE_LIMITED',retryAfterMs:2100}); };
  const limited = await invoke('get','/editions/groups',{testUserId:'provider-limit',query:{q:'album'}});
  assert.equal(limited.statusCode,503); assert.equal(limited.body.code,'MUSICBRAINZ_RATE_LIMITED'); assert.equal(limited.headers['Retry-After'],'3');
});
test('strict requests and bad positions fail before provider work', async () => {
  let called=false; discovery.browse=async()=>{called=true;return{};};
  await assert.rejects(service.candidates({releaseGroupMbid:crypto.randomUUID(), moderator:true}), /Unknown/);
  await assert.rejects(service.candidates({releaseGroupMbid:crypto.randomUUID(), offset:'20'}), /offset/);
  assert.equal(called,false);
});
test('preview stores private server provenance and only returns sanitized candidate identity', async () => {
  const value=candidate(); let stored;
  discovery.preview=async()=>value;
  Preview.create=async(input)=>{stored=input;return {...input,previewId:crypto.randomUUID()};};
  const result=await service.preview({releaseMbid:value.releaseMbid,releaseGroupMbid:value.releaseGroupMbid},'owner');
  assert.equal(stored.ownerUserId,'owner'); assert.equal(stored.candidate.tracklistHash,value.tracklistHash); assert.equal(stored.candidate.license,'CC0'); assert.equal(stored.candidate.retrievedAt,value.retrievedAt);
  assert.equal(result.candidate.tracks[0].trackId,undefined); assert.equal(result.ownerUserId,undefined); assert.ok(result.expiresAt > new Date());
});
test('proposal normalization scopes preview lookup by owner and unexpired time; client tracks and workflow fields are rejected', async () => {
  const value=candidate(); const previewId=crypto.randomUUID(); let query;
  Preview.findOne=async(input)=>{query=input;return {previewId,candidate:value};};
  const payload=await service.normalize(body(previewId),'owner');
  assert.equal(query.ownerUserId,'owner'); assert.ok(query.expiresAt.$gt instanceof Date);
  assert.deepEqual(payload.proposedMetadata.tracks,service.tracks(value)); assert.equal(payload.editionProposal.candidate.tracklistHash,value.tracklistHash);
  assert.equal(payload.externalReferences.length,2);
  await assert.rejects(service.normalize({...body(previewId), proposedMetadata:{...body(previewId).proposedMetadata,tracks:[]}},'owner'),e=>e.code==='EDITION_TRACKS_READ_ONLY');
  await assert.rejects(service.normalize({...body(previewId), reviewed:true},'owner'),/not allowed/);
  Preview.findOne=async()=>null;
  await assert.rejects(service.normalize(body(previewId),'intruder'),e=>e.code==='EDITION_PREVIEW_UNAVAILABLE');
});
test('retained proposal can be revised by its owner after expiry and stays append-only/publicly sanitized', async () => {
  const value=candidate(); const previewId=crypto.randomUUID();
  Preview.findOne=async()=>{throw new Error('Expired preview must not be looked up');};
  const current={submittedByUserId:'owner',editionProposal:{previewId,candidate:value}};
  const payload=await service.normalize(body(previewId),'owner',current);
  const snapshot=snapshotForSubmission(payload,{fingerprint:'a'.repeat(64),candidateSubmissionIds:[],duplicateSignals:[]},new Date(),2);
  assert.equal(snapshot.editionProposal.candidate.tracklistHash,value.tracklistHash);
  const serialized=serializeSubmission({...payload,revisions:[snapshot]},{detail:true});
  assert.equal(serialized.editionProposal.candidate.tracks[0].trackId,undefined);
  assert.equal(serialized.revisions[0].editionProposal.candidate.tracks[0].trackId,undefined);
  assert.equal(serialized.status,undefined); assert.equal(value.tracks[0].title,'One');
});
test('identity conflicts and tampered server snapshots cannot become edition proposals', async () => {
  const value=candidate(); const previewId=crypto.randomUUID();
  Preview.findOne=async()=>({previewId,candidate:value});
  await assert.rejects(service.normalize({...body(previewId),externalReferences:[{provider:'musicbrainz',entityType:'release-group',externalId:crypto.randomUUID()}]},'owner'),e=>e.code==='RELEASE_GROUP_MISMATCH');
  Preview.findOne=async()=>({previewId,candidate:{...value,tracklistHash:'a'.repeat(64)}});
  await assert.rejects(service.normalize(body(previewId),'owner'),e=>e.code==='CANDIDATE_HASH_MISMATCH');
});

test('unknown provider duration remains in provenance while submission metadata uses zero', async () => {
  const value = candidate(); value.tracks[0].durationMs = null;
  value.tracklistHash = hashCandidateTracklist(value);
  const previewId = crypto.randomUUID();
  Preview.findOne = async () => ({ previewId, candidate: value });
  const payload = await service.normalize(body(previewId), 'owner');
  assert.equal(payload.proposedMetadata.tracks[0].durationMs, 0);
  assert.equal(payload.editionProposal.candidate.tracks[0].durationMs, null);
  assert.equal(payload.editionProposal.candidate.tracklistHash, value.tracklistHash);
});

test('unexpected server failures do not expose internal details', async () => {
  discovery.searchGroups = async () => { throw Object.assign(new Error('private internal detail'), {status:500}); };
  const response = await invoke('get', '/editions/groups', {testUserId:'unexpected-failure',query:{q:'album'}});
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, 'Edition search failed');
});

test('disabling new edition proposals still permits retaining the current owned revision evidence', async () => {
  const value = candidate(); const previewId = crypto.randomUUID();
  delete process.env.CONTRIBUTOR_EDITIONS_ENABLED;
  const current = { submittedByUserId:'owner', editionProposal:{ previewId, candidate:value } };
  const retained = await service.normalize(body(previewId), 'owner', current);
  assert.equal(retained.editionProposal.candidate.tracklistHash, value.tracklistHash);
  await assert.rejects(service.normalize(body(previewId), 'owner'), e => e.code === 'CONTRIBUTOR_EDITIONS_DISABLED');
  await assert.rejects(service.normalize(body(previewId), 'intruder', current), e => e.code === 'CONTRIBUTOR_EDITIONS_DISABLED');
});


test('actual shared MusicBrainz gate exhaustion keeps its safe 503 contract before any provider fetch', async () => {
  const adapter = require('../lib/baselines/musicBrainz');
  const { ProviderBudget } = require('../models/Listening');
  const originalFactory = adapter.createBaselineMusicBrainz;
  const originalSlot = ProviderBudget.findOneAndUpdate;
  let attempts = 0; const sleeps = []; let fetched = false;
  ProviderBudget.findOneAndUpdate = async () => { attempts += 1; return null; };
  adapter.createBaselineMusicBrainz = () => originalFactory({
    cache: false,
    clock: () => new Date('2026-11-06T00:00:00Z'),
    sleep: async (ms) => { sleeps.push(ms); },
    fetch: async () => { fetched = true; throw new Error('Provider network must not be contacted'); },
  });
  try {
    const response = await invoke('post', '/editions/candidates', {
      testUserId: 'actual-shared-gate-exhaustion', body: { releaseGroupMbid: crypto.randomUUID() },
    });
    assert.equal(attempts, 4); assert.deepEqual(sleeps, [1100, 1100, 1100, 1100]); assert.equal(fetched, false);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'MusicBrainz request capacity is temporarily unavailable', code: 'MUSICBRAINZ_BUDGET_EXHAUSTED' });
    // The current gate supplies no retry deadline; the route must not invent one.
    assert.equal(response.headers['Retry-After'], undefined);
  } finally {
    adapter.createBaselineMusicBrainz = originalFactory;
    ProviderBudget.findOneAndUpdate = originalSlot;
  }
});

test('known plain gate errors sanitize messages and preserve only finite positive retry delays', async () => {
  for (const [retryAfterMs, expected] of [[2100, '3'], [86401000, '86400'], [0, undefined], [-1, undefined], [Infinity, undefined], [NaN, undefined]]) {
    discovery.searchGroups = async () => { throw Object.assign(new Error('private provider budget detail'), { status: 503, code: 'MUSICBRAINZ_BUDGET_EXHAUSTED', retryAfterMs }); };
    const response = await invoke('get', '/editions/groups', { testUserId: 'safe-gate-delays', query: { q: 'album' } });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { error: 'MusicBrainz request capacity is temporarily unavailable', code: 'MUSICBRAINZ_BUDGET_EXHAUSTED' });
    assert.equal(response.headers['Retry-After'], expected);
  }
});

test('unknown plain 503 errors and mismatched gate statuses stay generic without private details', async () => {
  for (const error of [
    Object.assign(new Error('private upstream detail'), { status: 503, code: 'UNKNOWN_PROVIDER_FAILURE', retryAfterMs: 2000 }),
    Object.assign(new Error('private gate detail'), { status: 500, code: 'MUSICBRAINZ_BUDGET_EXHAUSTED', retryAfterMs: 2000 }),
  ]) {
    discovery.searchGroups = async () => { throw error; };
    const response = await invoke('get', '/editions/groups', { testUserId: 'unknown-plain-503', query: { q: 'album' } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'Edition search failed' });
    assert.equal(response.headers['Retry-After'], undefined);
  }
});
