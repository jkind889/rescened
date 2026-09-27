const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const AlbumCatalog = require('../models/AlbumCatalog');
const Listen = require('../models/Listen');
const Listening = require('../models/Listening');
const Baselines = require('../models/AlbumBaseline');
const service = require('../lib/baselines/service');
const { hashCandidateTracklist } = require('../lib/baselines/musicBrainz');
const { mappingKey, normalize } = require('../lib/listening/common');
const { listEvents } = require('../lib/listening/connections');
const { runWorkerOnce, scheduleStaleMappingJobs } = require('../lib/listening/worker');
const enabled = process.env.RUN_MONGO_INTEGRATION === 'true';

test('reviewed baseline availability follows confirmation, revocation, and catalog invalidation without diary writes', { skip: !enabled }, async () => {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const names = ['TRACKLIST_BASELINE_MODERATION_ENABLED', 'COMMUNITY_MODERATION_ENABLED'];
  const previous = names.map((name) => process.env[name]);
  names.forEach((name) => { process.env[name] = 'true'; });
  try {
    await mongoose.connect(repl.getUri(), { dbName: 'listening_baselines_test' });
    await Promise.all([AlbumCatalog, Listen, ...Object.values(Listening), ...Object.values(Baselines)].map((model) => model.init()));
    const now = new Date();
    const group = crypto.randomUUID();
    const album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: '[#]', artistDisplayName: '이달의 소녀', releaseType: 'album', externalReferences: [{ provider: 'musicbrainz', entityType: 'release-group', externalId: group }] });
    const conn = await Listening.Connection.create({ userId: 'baseline-listener', username: 'fixture', usernameKey: 'fixture', state: 'active', revision: 1, connectedAt: now, windows: [{ start: now }] });
    const key = mappingKey('LOONA', '[#]');
    const mapping = await Listening.AlbumMapping.create({ key, artist: 'LOONA', album: '[#]', artistKey: normalize('LOONA'), albumKey: normalize('[#]'), albumId: album.albumId, catalogRevision: 1, revision: 1, status: 'active', reviewer: 'moderator', reason: 'Reviewed name pair' });
    await Listening.Scrobble.create({ connectionId: conn._id, connectionRevision: 1, identityKey: 'fixture', artist: 'LOONA', album: '[#]', track: 'So What', artistKey: normalize('LOONA'), albumKey: normalize('[#]'), trackKey: normalize('So What'), playedAt: now, expiresAt: new Date(now.getTime() + 86400000), resolution: 'matched', albumId: album.albumId, mappingId: mapping.mappingId, mappingRevision: 1, catalogRevision: 1, baselineAvailable: false });
    const releaseMbid = crypto.randomUUID();
    const candidate = { releaseMbid, releaseGroupMbid: group, title: '[#]', artistDisplayName: '이달의 소녀', date: '2020', country: 'KR', formats: ['CD'], disambiguation: '', status: 'Official', tracks: [{ discNumber: 1, trackNumber: 1, title: 'So What', durationMs: 198000, artistDisplayName: '이달의 소녀', releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID() }], retrievedAt: now.toISOString(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: 'CC0' };
    candidate.tracklistHash = hashCandidateTracklist(candidate);
    await service.storeCandidate('albums', album, candidate);
    await service.performCommand({ kind: 'albums', id: album.albumId, action: 'confirm', actorUserId: 'moderator', body: { expectedRevision: 0, expectedTargetRevision: 1, releaseMbid, releaseGroupMbid: group, candidateHash: candidate.tracklistHash, reason: 'Reviewed standard', requestId: crypto.randomUUID() } });
    const options = { types: ['reprocess'], ownerExists: async () => true, env: {}, clock: () => new Date(Date.now() + 1000) };
    await runWorkerOnce(options);
    let rows = await listEvents({ userId: conn.userId });
    assert.equal(rows.items[0].baselineAvailable, true);
    assert.equal((await Listening.Scrobble.findOne({ connectionId: conn._id })).baselineAvailable, true);
    const metrics = await require('../scripts/listeningMetrics').collectMetrics(new Date());
    assert.equal(metrics.baselineReadyNames, 1);
    assert.equal(metrics.baselineUnavailableNames, 0);
    assert.equal(metrics.baselineReviews.albums.reviewed, 1);
    const current = await service.detail('albums', album.albumId);
    await service.performCommand({ kind: 'albums', id: album.albumId, action: 'revoke', actorUserId: 'moderator', body: { expectedRevision: current.revision, expectedTargetRevision: current.target.catalogRevision, reason: 'Wrong standard release', requestId: crypto.randomUUID() } });
    rows = await listEvents({ userId: conn.userId });
    assert.equal(rows.items[0].resolution, 'matched');
    assert.equal(rows.items[0].baselineAvailable, false, 'owner reads must not trust stored true during worker lag');
    await runWorkerOnce(options);
    assert.equal((await Listening.Scrobble.findOne({ connectionId: conn._id })).baselineAvailable, false);
    await AlbumCatalog.updateOne({ albumId: album.albumId }, { $inc: { catalogRevision: 1 } });
    await scheduleStaleMappingJobs();
    await runWorkerOnce(options);
    rows = await listEvents({ userId: conn.userId });
    assert.equal(rows.items[0].resolution, 'unavailable');
    assert.equal(await Listen.countDocuments({}), 0);
  } finally {
    await mongoose.disconnect();
    await repl.stop();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});

test('LOONA / 이달의 소녀 resolves only after explicit mapping review, without a global alias', { skip: !enabled }, async () => {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const names = ['TRACKLIST_BASELINE_MODERATION_ENABLED', 'COMMUNITY_MODERATION_ENABLED', 'MODERATOR_USER_IDS'];
  const previous = names.map((name) => process.env[name]);
  process.env.TRACKLIST_BASELINE_MODERATION_ENABLED = 'true'; process.env.COMMUNITY_MODERATION_ENABLED = 'true'; process.env.MODERATOR_USER_IDS = 'moderator';
  try {
    await mongoose.connect(repl.getUri(), { dbName: 'listening_loona_review_test' });
    await Promise.all([AlbumCatalog, Listen, ...Object.values(Listening), ...Object.values(Baselines)].map((model) => model.init()));
    const { createDiscoveryService } = require('../lib/listening/discovery');
    const { moderate } = require('../lib/listening/moderation');
    const now = new Date(); const group = crypto.randomUUID();
    const tracks = ['#', 'So What', 'Number 1', 'Oh (Yes I Am)'];
    const loona = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: '[#]', artistDisplayName: '이달의 소녀', releaseType: 'ep', externalReferences: [{ provider: 'musicbrainz', entityType: 'release-group', externalId: group }] });
    const decoy = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: '[#]', artistDisplayName: 'Other Group', releaseType: 'album' });
    const releaseMbid = crypto.randomUUID();
    const candidate = { releaseMbid, releaseGroupMbid: group, title: '[#]', artistDisplayName: '이달의 소녀', date: '2020-02-05', country: 'KR', formats: ['CD'], disambiguation: '', status: 'Official', tracks: tracks.map((title, index) => ({ discNumber: 1, trackNumber: index + 1, title, durationMs: 180000, artistDisplayName: '이달의 소녀', releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID() })), retrievedAt: now.toISOString(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: 'CC0' };
    candidate.tracklistHash = hashCandidateTracklist(candidate);
    await service.storeCandidate('albums', loona, candidate);
    await service.performCommand({ kind: 'albums', id: loona.albumId, action: 'confirm', actorUserId: 'moderator', body: { expectedRevision: 0, expectedTargetRevision: 1, releaseMbid, releaseGroupMbid: group, candidateHash: candidate.tracklistHash, reason: 'Reviewed standard', requestId: crypto.randomUUID() } });

    const conn = await Listening.Connection.create({ userId: 'loona-listener', username: 'fixture', usernameKey: 'fixture', state: 'active', revision: 1, connectedAt: now, windows: [{ start: now }] });
    const scrobble = (album, track, index) => ({ connectionId: conn._id, connectionRevision: 1, identityKey: `fixture-${index}`, artist: 'LOONA', album, track, artistKey: normalize('LOONA'), albumKey: normalize(album), trackKey: normalize(track), playedAt: new Date(now.getTime() - index * 1000), expiresAt: new Date(now.getTime() + 86400000), resolution: 'unresolved', albumId: '', baselineAvailable: false });
    await Listening.Scrobble.create([scrobble('[#]', 'So What', 1), scrobble('[#] (Deluxe)', 'So What', 2)]);

    // Fixture providers only: Last.fm reports the Latin artist credit and the standard tracks.
    const discovery = createDiscoveryService({ provider: { albumInfo: async ({ album }) => ({ artist: 'LOONA', album, tracks, url: 'https://www.last.fm/music/LOONA/%5B%23%5D' }) }, musicBrainz: { searchReleaseGroups: async () => [] } });
    const found = await discovery.discover({ artist: 'LOONA', album: '[#]' });
    assert.deepEqual(found.candidates.map((item) => item.albumId).sort(), [loona.albumId, decoy.albumId].sort(), 'title-only matching surfaces both same-titled albums');
    const loonaEvidence = found.candidates.find((item) => item.albumId === loona.albumId).evidence.find((entry) => entry.source === 'candidate_comparison');
    assert.equal(loonaEvidence.comparisonBasis, 'reviewed_standard_baseline');
    assert.equal(loonaEvidence.artistCreditDifference, true);
    assert.equal(loonaEvidence.sharedTrackCount, 4);
    assert.equal(found.candidates.find((item) => item.albumId === decoy.albumId).evidence.find((entry) => entry.source === 'candidate_comparison').comparisonBasis, 'unreviewed_catalog_tracks');
    assert.equal(await Listening.AlbumMapping.countDocuments({}), 0, 'matching titles and full track overlap never create a mapping');

    const key = mappingKey('LOONA', '[#]');
    const caseId = crypto.randomUUID();
    await Listening.MappingCase.create({ caseId, key, artist: 'LOONA', album: '[#]', artistKey: normalize('LOONA'), albumKey: normalize('[#]'), status: 'pending', revision: 1, encounterCount: 1, candidates: found.candidates, evidence: found.evidence, evidenceHash: found.evidenceHash });
    await assert.rejects(moderate(caseId, 'approve', { expectedRevision: 1, albumId: loona.albumId, reason: 'Stale reviewer' }, 'not-a-moderator'), (error) => error.code === 'MODERATOR_REQUIRED');
    await moderate(caseId, 'approve', { expectedRevision: 1, albumId: loona.albumId, reason: 'LOONA is the romanized credit for 이달의 소녀 on this EP' }, 'moderator');

    const options = { types: ['reprocess'], ownerExists: async () => true, env: {}, clock: () => new Date(Date.now() + 1000) };
    await runWorkerOnce(options);
    const rows = await listEvents({ userId: conn.userId });
    const standard = rows.items.find((row) => row.album === '[#]');
    const deluxe = rows.items.find((row) => row.album === '[#] (Deluxe)');
    assert.equal(standard.resolution, 'matched'); assert.equal(standard.albumId, loona.albumId); assert.equal(standard.baselineAvailable, true);
    assert.equal(deluxe.resolution, 'unresolved', 'an edition label is a separate reviewed name pair');
    const mappings = await Listening.AlbumMapping.find({}).lean();
    assert.deepEqual(mappings.map((row) => [row.key, row.albumId]), [[key, loona.albumId]], 'only the reviewed artist/album pair is mapped');
    assert.equal((await AlbumCatalog.findOne({ albumId: loona.albumId })).artistDisplayName, '이달의 소녀', 'the catalog artist is not renamed');
    assert.equal(await Listening.AlbumMapping.countDocuments({ key: mappingKey('LOONA', '[#] (Deluxe)') }), 0);
    assert.equal(await Listen.countDocuments({}), 0);
  } finally {
    await mongoose.disconnect();
    await repl.stop();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});
