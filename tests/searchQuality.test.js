const test = require('node:test');
const assert = require('node:assert/strict');
const { corpus, validateCorpus, id, CATEGORIES } = require('../benchmarks/search-quality/corpus.cjs');
const { hash, identity, score, evaluateQuery, summarize, makeReport, validateReport, assertCompatible, compare, markdown } = require('../benchmarks/search-quality/report.cjs');
const { options, validateRows } = require('../benchmarks/search-quality/run.cjs');
const Album = require('../models/AlbumCatalog');

test('checked-in initial baseline is complete and compatible with the current corpus', () => {
  const baseline = require('../benchmarks/search-quality/baseline.json');
  assertCompatible(baseline, identity(corpus()));
});

test('quality corpus has deterministic valid catalog records and 30 independent judgments', () => {
  const data = validateCorpus(corpus());
  assert.deepEqual(identity(data), identity(corpus()));
  assert.equal(data.queries.length, 30);
  for (const category of CATEGORIES) assert.equal(data.queries.filter(q => q.category === category).length, 6);
  for (const album of data.albums) assert.equal(new Album(album).validateSync(), undefined);
  assert.equal(data.queries.find(q => q.id === 'artist-discography').relevantIds.length, 30);
  assert.equal(data.queries.find(q => q.id === 'format-unicode').query, 'Cafe\u0301 Sessions');
  assert.ok(data.queries.find(q => q.id === 'artist-album').relevantIds.includes(id('discovery')));
  data.queries[0].relevantIds.pop();
  assert.notEqual(hash(data.queries), hash(corpus().queries));
});

test('invalid fixtures and relevance judgments fail before MongoDB starts', () => {
  for (const change of [
    data => { data.albums[0].albumId = 'upstream-id'; },
    data => { data.albums[0].albumId = data.albums[1].albumId; },
    data => { data.albums[0].title = ''; },
    data => { data.albums[0].cover = 'https://example.com/image'; },
    data => { data.albums[0]._id = 'internal'; },
    data => { data.albums[0].title = data.albums[1].title; },
    data => { data.queries[0].relevantIds = [id('unknown')]; },
    data => { data.queries[0].relevantIds = []; },
    data => { data.queries[0].preferredIds = [id('moon-safari')]; },
    data => { data.queries[0].relevantIds.push(data.queries[0].relevantIds[0]); },
    data => { data.queries[0].id = data.queries[1].id; },
    data => { data.queries[0].category = 'miss'; },
    data => { data.queries.pop(); },
  ]) {
    const data = corpus(); change(data);
    assert.throws(() => validateCorpus(data));
  }
});

test('metric arithmetic uses relevance at the stated cutoff, not merely nonempty results', () => {
  const q = { relevantIds: ['a', 'b', 'c'], preferredIds: ['b'] };
  const values = score(q, ['x', 'b', 'y', 'a', 'z', 'c'], true);
  assert.equal(values.hitAt5, 1);
  assert.equal(values.mrrAt5, 0.5);
  assert.equal(values.recallAt24, 1);
  assert.equal(values.preferredRank, 2);
  assert.equal(values.preferredAt1, 0);
  assert.equal(values.correctlyEmpty, null);
  const late = score(q, ['x', 'y', 'z', 'w', 'v', 'a'], true);
  assert.equal(late.hitAt5, 0); assert.equal(late.mrrAt5, 0); assert.equal(late.recallAt24, 1 / 3);
  assert.equal(score(q, ['x'], true).recallAt24, 0);
  assert.equal(score({ relevantIds: ['a', 'b'], preferredIds: ['a', 'b'] }, ['b', 'a']).preferredAt1, 1);
  const after24 = score({ relevantIds: ['a'], preferredIds: [] }, [...Array.from({ length: 24 }, (_, i) => `x${i}`), 'a'], true);
  assert.equal(after24.recallAt24, 0);
});

test('expected misses are scored separately and null metrics never dilute averages', () => {
  const positive = evaluateQuery({ category: 'artist', relevantIds: ['a'], preferredIds: [] }, ['x', 'a'], ['x', 'a'], ['x', 'a']);
  const empty = evaluateQuery({ category: 'miss', relevantIds: [], preferredIds: [] }, [], [], []);
  const falsePositive = evaluateQuery({ category: 'miss', relevantIds: [], preferredIds: [] }, ['x'], ['x'], ['x']);
  const result = summarize([positive, empty, falsePositive]);
  assert.equal(result.overall.autocomplete.hitAt5, 1);
  assert.equal(result.overall.autocomplete.mrrAt5, 0.5);
  assert.equal(result.overall.page.recallAt24, 1);
  assert.equal(result.overall.page.correctlyEmpty, 0.5);
  assert.equal(result.categories.miss.page.mrrAt5, null);
  assert.equal(result.categories.album.page.recallAt24, null);
});

test('diagnostics separate retrieval failures from ranking and page truncation', () => {
  const full = [...Array.from({ length: 25 }, (_, i) => `x${i}`), 'late'];
  const q = { relevantIds: ['x2', 'late', 'absent'], preferredIds: ['late'] };
  const result = evaluateQuery(q, full.slice(0, 5), full.slice(0, 24), full);
  assert.deepEqual(result.diagnostics.notRetrievedIds, ['absent']);
  assert.deepEqual(result.diagnostics.belowTop5Ids, ['late']);
  assert.deepEqual(result.diagnostics.beyondFirstPageIds, ['late']);
  assert.equal(result.diagnostics.unmetPreference, true);
  assert.equal(result.page.metrics.recallAt24, 1 / 3);
  const many = evaluateQuery({ relevantIds: Array.from({ length: 30 }, (_, i) => `x${i}`), preferredIds: [] }, [], [], []);
  assert.equal(many.diagnostics.recallAt24Ceiling, 0.8);
});

function sampleReport(change = () => {}) {
  const data = corpus();
  const cases = data.queries.map(q => {
    const full = [...q.relevantIds]; change(q, full);
    return evaluateQuery(q, full.slice(0, 5), full.slice(0, 24), full);
  });
  return makeReport(data, cases, { revision: 'test-revision', dirty: false, node: 'test-node', mongo: 'test-mongo' });
}

test('reports retain inspectable results and comparison explains gains and regressions', () => {
  const before = sampleReport();
  validateReport(before);
  const after = sampleReport((q, full) => { if (q.id === 'artist-exact') full.shift(); });
  const comparison = compare(before, after);
  const changed = comparison.cases.find(q => q.id === 'artist-exact');
  assert.deepEqual(changed.newlyMissingIds, [id('discovery')]);
  assert.equal(changed.metrics.page.recallAt24, -0.5);
  assert.equal(changed.resultOrderChanged, true);
  assert.equal(comparison.overall.page.recallAt24, after.summary.overall.page.recallAt24 - before.summary.overall.page.recallAt24);
  const same = compare(before, sampleReport());
  assert.ok(same.cases.every(q => !q.resultOrderChanged));
  assert.equal(same.overall.page.mrrAt5, 0);
  const text = markdown({ ...after, comparison });
  for (const expected of ['Not retrieved on any page', 'Matched but beyond first page', 'Autocomplete, ranked', 'Preferred rank', 'artist-exact', 'Change from comparison', 'Daft Punk — Discovery']) assert.ok(text.includes(expected), expected);
  assert.ok(text.includes('Daft Punk&#124;Air'), 'Escape literal pipes in Markdown');
  assert.throws(() => makeReport(corpus(), [], {}), /Incomplete/);
});

test('comparison rejects incompatible or corrupt evidence instead of comparing partial runs', () => {
  const valid = sampleReport();
  for (const change of [
    report => { report.status = 'failed'; },
    report => { report.schemaVersion = 99; },
    report => { report.cases.pop(); },
    report => { report.cases[0].page.metrics.mrrAt5 = 0.123; },
    report => { report.summary.overall.page.hitAt5 = 0; },
    report => { report.cases[0].intent = 'A changed judgment'; },
    report => { report.cases[0].fullResultIds.push('unknown'); },
  ]) {
    const report = structuredClone(valid); change(report);
    assert.throws(() => compare(report, valid));
  }
  for (const key of ['version', 'fixtureSha256', 'querySha256']) {
    assert.throws(() => assertCompatible(valid, { ...valid.corpus, [key]: 'different' }), /Incompatible/);
  }
});

test('CLI and response validation reject targets, malformed data and internal identifiers', () => {
  assert.deepEqual(options([]), {});
  assert.ok(options(['--compare', 'baseline.json']).comparePath.endsWith('/baseline.json'));
  for (const args of [['--uri', 'mongodb://production'], ['--compare'], ['--compare', 'x', '--other', 'x']]) assert.throws(() => options(args));
  const data = corpus(); const albums = new Map(data.albums.map(a => [a.albumId, a]));
  const row = data.albums[0];
  assert.deepEqual(validateRows([row], 5, albums), [row.albumId]);
  for (const rows of [{}, [row, row], [{ ...row, _id: 'internal' }], [{ ...row, artistCredits: [{ name: 'x', _id: 'internal' }] }], [{ ...row, albumId: id('unknown') }], [{ ...row, title: 'wrong' }], [{ ...row, tracks: null }]]) assert.throws(() => validateRows(rows, 5, albums));
  assert.throws(() => validateRows([row], 0, albums));
});
