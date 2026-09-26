const test = require('node:test');
const assert = require('node:assert/strict');
const { createNameResolver, evaluateMappedEvents, mappingReport } = require('../lib/listeningStudy/albumNameMappings');
const { createStudy } = require('../lib/listeningStudy/study');
const { normalizeRecent } = require('../lib/listeningStudy/core');
const { recent, tracks } = require('./fixtures/listeningStudy/synthetic');
const definitions = [{ id: 'test:standard', pairId: 'test', kind: 'standard', tracks: tracks(12) }];
const mappings = [{ targetStudyEditionId: 'test:standard', artist: 'Study Artist', names: ['Study Album', 'Study Album (Deluxe)', 'Study Album (Bonus Track Version)'] }];
const events = (positions, title = 'Study Album (Bonus Track Version)', start = 1600000000, artist = 'Study Artist') => normalizeRecent(recent(title, positions, start, artist)).events;
test('reviewed edition names map to standard and preserve raw evidence', () => {
  const input = events([1,2,3,4,5,6,7,8,9,10]); const before = JSON.stringify(input);
  const r = evaluateMappedEvents(input, mappings, definitions);
  assert.equal(r.proposedListens, 1); assert.equal(r.sessions[0].distinctTracks, 10);
  assert.equal(r.sessions[0].totalTracks, 12); assert.equal(JSON.stringify(input), before);
});
test('nine core tracks and three bonus songs cannot qualify; repeats cannot inflate coverage', () => {
  const r = evaluateMappedEvents(events([1,2,3,4,5,6,7,8,9,13,14,15,1,1]), mappings, definitions);
  assert.equal(r.proposedListens, 0); assert.equal(r.sessions[0].distinctTracks, 9);
  assert.equal(r.excludedTrackRows, 3); assert.equal(r.mappedRows, 14);
});
test('unknown labels, different artists and conflicting mappings remain unresolved', () => {
  for (const input of [events([1], 'Study Album (Live)'), events([1], 'Study Album', 1600000000, 'Other Artist')]) {
    assert.equal(evaluateMappedEvents(input, mappings, definitions).unmappedRows, 1);
  }
  const resolve = createNameResolver([...mappings, { ...mappings[0], targetStudyEditionId: 'other:standard' }], definitions);
  assert.equal(resolve(events([1])[0]).status, 'ambiguous_album_mapping');
  assert.equal(createNameResolver(mappings, [])(events([1])[0]).status, 'baseline_unavailable');
});
test('known aliases share a session; gaps greater than two hours separate it', () => {
  const a = events([1,2,3,4,5], 'Study Album');
  const b = events([6,7,8,9,10], 'Study Album (Deluxe)', a.at(-1).timestamp + 60);
  assert.equal(evaluateMappedEvents([...a,...b], mappings, definitions).proposedListens, 1);
  const c = events([6,7,8,9,10], 'Study Album (Deluxe)', a.at(-1).timestamp + 7201);
  const r = evaluateMappedEvents([...a,...c], mappings, definitions);
  assert.equal(r.sessions.length, 2); assert.equal(r.proposedListens, 0);
});
test('blank data and incomplete captures do not become successful controls', () => {
  const r = mappingReport(createStudy());
  assert.equal(r.controls.filter(c => c.status === 'evaluated').length, 0);
  assert.equal(r.baselineStatus[0].status, 'baseline_missing_or_changed');
  assert.throws(() => mappingReport(createStudy(), {}), /array/);
});
test('track-ID conflicts and duplicate titles cannot be rescued by album aliases', () => {
  const input = events([1]); input[0].trackMbid = 'one';
  const defs = structuredClone(definitions); defs[0].tracks[0].mbid = 'two';
  assert.equal(evaluateMappedEvents(input, mappings, defs).excludedTrackRows, 1);
  const duplicate = structuredClone(definitions); duplicate[0].tracks[1] = duplicate[0].tracks[0];
  assert.equal(evaluateMappedEvents(events([1]), mappings, duplicate).excludedTrackRows, 1);
});

test('reviewed reference remains denominator with no provider album response; changed reference blocks mapping', () => {
  const study = createStudy();
  study.references['born-to-die:standard'] = structuredClone(require('../data/listening-study/references.json')['born-to-die:standard']);
  assert.equal(mappingReport(study).baselineStatus[0].status, 'reviewed_baseline_available');
  study.references['born-to-die:standard'].tracks.pop();
  assert.equal(mappingReport(study).baselineStatus[0].status, 'baseline_missing_or_changed');
});

test('offline mapping CLI preserves frozen artifacts and counts reviewed plain-title variants', async () => {
  const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path');
  const { main } = require('../scripts/lastfmStudy'); const { hash } = require('../lib/listeningStudy/core');
  const study = createStudy(); const ref = structuredClone(require('../data/listening-study/references.json')['born-to-die:standard']);
  study.references['born-to-die:standard'] = ref;
  const control = study.controls.find(c => c.id === 'born-to-die:standard');
  Object.assign(control, { confirmed: true, from: 1600000000, to: 1600005000, recordedAt: '2020-09-13T12:26:40Z', qualifyingTrackPositions: [1,2,3,4,5,6,7,8,9,10] });
  const payload = { recenttracks: { track: ref.tracks.slice(0, 10).map((t, i) => ({ name: t.title.replace(' (remastered)', ''), artist: { '#text': ref.artist }, album: { '#text': 'Born to Die (Bonus Track Version)', mbid: 'different-edition' }, date: { uts: String(control.from + i * 200) } })) } };
  study.captures[control.id] = { complete: true, source: 'lastfm_live', controlHash: hash(control), pages: [payload] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapping-cli-'));
  try {
    const original = JSON.stringify(study);
    await fs.writeFile(path.join(dir, 'study.json'), original); await fs.writeFile(path.join(dir, 'report.json'), 'frozen');
    await main(['evaluate-mappings', '--output', dir]);
    const result = JSON.parse(await fs.readFile(path.join(dir, 'album-name-mapping-report.json')));
    const row = result.controls.find(c => c.id === control.id);
    assert.equal(row.sessions[0].distinctTracks, 10); assert.equal(row.sessions[0].totalTracks, 12); assert.equal(row.proposedListens, 1);
    assert.equal(await fs.readFile(path.join(dir, 'study.json'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(dir, 'report.json'), 'utf8'), 'frozen');
    study.captures[control.id].controlHash = 'stale';
    assert.equal(mappingReport(study).controls.find(c => c.id === control.id).status, 'incomplete');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('duplicate registry target definitions cannot silently choose the first track aliases', () => {
  const manifest = require('../data/listening-study/album-name-mappings.json');
  manifest.mappings.push(structuredClone(manifest.mappings[0]));
  try { assert.throws(() => mappingReport(createStudy()), /Duplicate target definitions/); }
  finally { manifest.mappings.pop(); }
});
