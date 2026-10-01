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

test('a baseline that fills empty tracks before mapping review does not block approval', { skip: !enabled }, async () => {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const names = ['TRACKLIST_BASELINE_MODERATION_ENABLED', 'COMMUNITY_MODERATION_ENABLED', 'MODERATOR_USER_IDS'];
  const previous = names.map((name) => process.env[name]);
  process.env.TRACKLIST_BASELINE_MODERATION_ENABLED = 'true'; process.env.COMMUNITY_MODERATION_ENABLED = 'true'; process.env.MODERATOR_USER_IDS = 'moderator';
  try {
    await mongoose.connect(repl.getUri(), { dbName: 'listening_baseline_first_test' });
    await Promise.all([AlbumCatalog, Listen, ...Object.values(Listening), ...Object.values(Baselines)].map((model) => model.init()));
    const { detail, listCases, moderate } = require('../lib/listening/moderation');
    const now = new Date(); const group = crypto.randomUUID();
    const album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: 'Pilot', artistDisplayName: 'Artist', releaseType: 'album', externalReferences: [{ provider: 'musicbrainz', entityType: 'release-group', externalId: group }] });
    const conn = await Listening.Connection.create({ userId: 'baseline-first-listener', username: 'fixture', usernameKey: 'fixture', state: 'active', revision: 1, connectedAt: now, windows: [{ start: now }] });
    await Listening.Scrobble.create({ connectionId: conn._id, connectionRevision: 1, identityKey: 'fixture', artist: 'Artist', album: 'Pilot', track: 'One', artistKey: normalize('Artist'), albumKey: normalize('Pilot'), trackKey: normalize('One'), playedAt: now, expiresAt: new Date(now.getTime() + 86400000), resolution: 'unresolved', albumId: '', baselineAvailable: false });

    // Discovery ran while the album still had no tracks, so the case snapshot records revision 1.
    const key = mappingKey('Artist', 'Pilot'); const caseId = crypto.randomUUID();
    await Listening.MappingCase.create({ caseId, key, artist: 'Artist', album: 'Pilot', artistKey: normalize('Artist'), albumKey: normalize('Pilot'), status: 'pending', revision: 1, encounterCount: 1, candidates: [{ albumId: album.albumId, title: 'Pilot', artistDisplayName: 'Artist', catalogRevision: 1, evidence: [{ type: 'exact_local', artist: 'Artist', album: 'Pilot' }] }] });

    const releaseMbid = crypto.randomUUID();
    const candidate = { releaseMbid, releaseGroupMbid: group, title: 'Pilot', artistDisplayName: 'Artist', date: '2026', country: 'US', formats: ['CD'], disambiguation: '', status: 'Official', tracks: [{ discNumber: 1, trackNumber: 1, title: 'One', durationMs: 180000, artistDisplayName: 'Artist', releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID() }], retrievedAt: now.toISOString(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: 'CC0' };
    candidate.tracklistHash = hashCandidateTracklist(candidate);
    await service.storeCandidate('albums', album, candidate);
    await service.performCommand({ kind: 'albums', id: album.albumId, action: 'confirm', actorUserId: 'moderator', body: { expectedRevision: 0, expectedTargetRevision: 1, releaseMbid, releaseGroupMbid: group, candidateHash: candidate.tracklistHash, reason: 'Reviewed standard', requestId: crypto.randomUUID() } });
    assert.equal((await AlbumCatalog.findOne({ albumId: album.albumId })).catalogRevision, 2, 'confirmation filled the empty tracklist');
    assert.equal(await Listening.Job.countDocuments({ type: 'reprocess' }), 0, 'no mapping exists yet, so nothing is reprocessed');

    // Moderator reads report the current catalog revision, not the discovery snapshot.
    const reviewed = await detail(caseId);
    assert.equal(reviewed.case.candidates[0].catalogRevision, 2);
    assert.equal((await listCases({})).items[0].candidates[0].catalogRevision, 2);
    assert.equal((await Listening.MappingCase.findOne({ caseId }).lean()).candidates[0].catalogRevision, 1, 'the stored snapshot is not rewritten');

    // A reviewer who saw the old revision still gets a conflict; the refreshed view approves.
    await assert.rejects(moderate(caseId, 'approve', { expectedRevision: 1, albumId: album.albumId, expectedCatalogRevision: 1, reason: 'Stale view' }, 'moderator'), (error) => error.code === 'CATALOG_REVISION_CONFLICT');
    await moderate(caseId, 'approve', { expectedRevision: 1, albumId: album.albumId, expectedCatalogRevision: reviewed.case.candidates[0].catalogRevision, reason: 'Same album' }, 'moderator');
    assert.equal((await Listening.AlbumMapping.findOne({ key })).catalogRevision, 2);

    await runWorkerOnce({ types: ['reprocess'], ownerExists: async () => true, env: {}, clock: () => new Date(Date.now() + 1000) });
    const rows = await listEvents({ userId: conn.userId });
    assert.equal(rows.items[0].resolution, 'matched');
    assert.equal(rows.items[0].baselineAvailable, true, 'the earlier baseline applies once the mapping is approved');
    assert.equal(await Listen.countDocuments({}), 0);
  } finally {
    await mongoose.disconnect();
    await repl.stop();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});

test('a mapping stranded by a catalog change is flagged, then reconfirmed at the current revision', { skip: !enabled }, async () => {
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const names = ['COMMUNITY_MODERATION_ENABLED', 'MODERATOR_USER_IDS'];
  const previous = names.map((name) => process.env[name]);
  process.env.COMMUNITY_MODERATION_ENABLED = 'true'; process.env.MODERATOR_USER_IDS = 'moderator';
  try {
    await mongoose.connect(repl.getUri(), { dbName: 'listening_reconfirm_test' });
    await Promise.all([AlbumCatalog, Listen, ...Object.values(Listening), ...Object.values(Baselines)].map((model) => model.init()));
    const { detail, listCases, moderate } = require('../lib/listening/moderation');
    const now = new Date();
    const album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: 'Pilot', artistDisplayName: 'Artist', releaseType: 'album', catalogRevision: 1 });
    const conn = await Listening.Connection.create({ userId: 'reconfirm-listener', username: 'fixture', usernameKey: 'fixture', state: 'active', revision: 1, connectedAt: now, windows: [{ start: now }] });
    await Listening.Scrobble.create({ connectionId: conn._id, connectionRevision: 1, identityKey: 'fixture', artist: 'Artist', album: 'Pilot', track: 'One', artistKey: normalize('Artist'), albumKey: normalize('Pilot'), trackKey: normalize('One'), playedAt: now, expiresAt: new Date(now.getTime() + 86400000), resolution: 'unresolved', albumId: '', baselineAvailable: false });
    const key = mappingKey('Artist', 'Pilot'); const caseId = crypto.randomUUID();
    await Listening.MappingCase.create({ caseId, key, artist: 'Artist', album: 'Pilot', artistKey: normalize('Artist'), albumKey: normalize('Pilot'), status: 'pending', revision: 1, encounterCount: 1, candidates: [{ albumId: album.albumId, title: 'Pilot', artistDisplayName: 'Artist', catalogRevision: 1, evidence: [] }] });
    await moderate(caseId, 'approve', { expectedRevision: 1, albumId: album.albumId, expectedCatalogRevision: 1, reason: 'Same album' }, 'moderator');
    const worker = (offset) => runWorkerOnce({ types: ['reprocess'], ownerExists: async () => true, env: {}, clock: () => new Date(Date.now() + offset) });
    await worker(1000);
    assert.equal((await listEvents({ userId: conn.userId })).items[0].resolution, 'matched');
    assert.equal((await listCases({ status: 'approved' })).items[0].mappingStale, false);
    assert.equal((await listCases({ stale: true })).items.length, 0);
    await assert.rejects(moderate(caseId, 'reconfirm', { expectedRevision: 2, expectedCatalogRevision: 1, reason: 'Nothing changed' }, 'moderator'), (error) => error.code === 'MAPPING_NOT_STALE');

    // An identity-relevant correction (not a cover or tracklist fill) strands the mapping.
    await AlbumCatalog.updateOne({ albumId: album.albumId }, { $set: { title: 'Pilot (Remastered)', catalogRevision: 2 } });
    await scheduleStaleMappingJobs();
    await worker(2000);
    assert.equal((await listEvents({ userId: conn.userId })).items[0].resolution, 'unavailable');
    const stale = await listCases({ stale: true });
    assert.deepEqual(stale.items.map((item) => [item.caseId, item.mappingStale]), [[caseId, true]]);
    const flagged = await detail(caseId);
    assert.equal(flagged.mapping.stale, true);
    assert.equal(flagged.mapping.catalogRevision, 1);
    assert.equal(flagged.mapping.currentCatalogRevision, 2);

    // Only a moderator re-review moves it forward, against the revision they saw.
    await assert.rejects(moderate(caseId, 'reconfirm', { expectedRevision: 2, reason: 'Missing revision' }, 'moderator'), (error) => error.code === 'INVALID_REVISION');
    await assert.rejects(moderate(caseId, 'reconfirm', { expectedRevision: 2, expectedCatalogRevision: 2, albumId: album.albumId, reason: 'Retarget' }, 'moderator'), (error) => error.code === 'INVALID_REQUEST');
    await assert.rejects(moderate(caseId, 'reconfirm', { expectedRevision: 2, expectedCatalogRevision: 1, reason: 'Old view' }, 'moderator'), (error) => error.code === 'CATALOG_REVISION_CONFLICT');
    await assert.rejects(moderate(caseId, 'approve', { expectedRevision: 2, albumId: album.albumId, expectedCatalogRevision: 2, reason: 'Approve again' }, 'moderator'), (error) => error.code === 'STATE_CONFLICT');
    const reconfirmed = await moderate(caseId, 'reconfirm', { expectedRevision: 2, expectedCatalogRevision: 2, reason: 'Remaster label only; same release' }, 'moderator');
    assert.equal(reconfirmed.case.status, 'approved');
    assert.equal(reconfirmed.case.revision, 3);
    assert.equal(reconfirmed.mapping.stale, false);
    assert.equal(reconfirmed.mapping.catalogRevision, 2);
    assert.equal(reconfirmed.mapping.revision, 2);
    assert.equal(reconfirmed.mapping.albumId, album.albumId);
    assert.deepEqual(reconfirmed.history.map((entry) => entry.action), ['approved', 'reconfirmed']);
    const audit = await Listening.MappingAudit.findOne({ caseId, action: 'reconfirmed' }).lean();
    assert.equal(audit.details.previous.catalogRevision, 1);
    assert.equal(audit.details.selected.catalogRevision, 2);
    assert.equal((await listCases({ stale: true })).items.length, 0);

    await worker(3000);
    assert.equal((await listEvents({ userId: conn.userId })).items[0].resolution, 'matched');
    await assert.rejects(moderate(caseId, 'reconfirm', { expectedRevision: 2, expectedCatalogRevision: 2, reason: 'Replay' }, 'moderator'), (error) => error.code === 'REVISION_CONFLICT');
    assert.equal(await Listen.countDocuments({}), 0);
  } finally {
    await mongoose.disconnect();
    await repl.stop();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});
