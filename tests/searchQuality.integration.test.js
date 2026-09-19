const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { corpus, id } = require('../benchmarks/search-quality/corpus.cjs');
const { withCatalog, evaluate } = require('../benchmarks/search-quality/run.cjs');
const { makeReport, compare, validateReport } = require('../benchmarks/search-quality/report.cjs');
const enabled = process.env.RUN_MONGO_INTEGRATION === 'true';

test('search quality executes real routes and indexes with stable independent judgments', { skip: !enabled }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-quality-test-'));
  const data = corpus(); let resources;
  try {
    await withCatalog(data, directory, async context => {
      resources = context;
      assert.ok(context.indexes.some(index => index.name === 'artistDisplayName_1_title_1'));
      assert.ok(context.indexes.some(index => index.name === 'albumId_1' && index.unique));
      const health = await (await fetch(`${context.url}/health`)).json();
      assert.equal(health.status, 'ok');
      const collections = await context.connection.db.listCollections().toArray();
      assert.deepEqual(collections.map(c => c.name), ['albumcatalogs']);
      const first = await evaluate(context.url, data);
      const second = await evaluate(context.url, data);
      assert.deepEqual(first, second, 'Unchanged run must produce identical ranking and scores');
      assert.equal(first.length, 30);
      const long = first.find(q => q.id === 'artist-discography');
      // Independent hand-selected membership, sorted with Mongo's binary string ordering.
      const members = new Set([...data.queries.find(q => q.id === 'artist-discography').relevantIds,
        ...Array.from({ length: 6 }, (_, n) => id(`meridian-tribute-${n + 1}`))]);
      const expected = data.albums.filter(a => members.has(a.albumId)).sort((a, b) =>
        Buffer.compare(Buffer.from(a.artistDisplayName), Buffer.from(b.artistDisplayName)) || Buffer.compare(Buffer.from(a.title), Buffer.from(b.title))).map(a => a.albumId);
      assert.deepEqual(long.fullResultIds, expected);
      assert.deepEqual(long.autocomplete.ids, expected.slice(0, 5));
      assert.deepEqual(long.page.ids, expected.slice(0, 24));
      const report = makeReport(data, first, { mongo: context.mongo });
      validateReport(report);
      const changes = compare(report, makeReport(data, second, { mongo: context.mongo }));
      assert.ok(changes.cases.every(q => !q.resultOrderChanged));
      assert.equal(changes.overall.page.recallAt24, 0);
      assert.equal((await fetch(`${context.url}/search/external?q=test`)).status, 404);
      assert.equal((await fetch(`${context.url}/reviews/review`, { method: 'POST' })).status, 404);
    });
    assert.equal(resources.connection.readyState, 0);
    assert.notEqual(resources.apiChild.exitCode, null);
    assert.equal(resources.repl.state, 'stopped');
    await assert.rejects(fetch(`${resources.url}/health`));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('search quality tears down its API and MongoDB after errors and interruptions', { skip: !enabled }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-quality-cleanup-'));
  try {
    for (const mode of ['failure', 'interrupt']) {
      const controller = new AbortController(); let resources;
      await assert.rejects(withCatalog(corpus(), directory, async context => {
        resources = context;
        if (mode === 'failure') throw new Error('deliberate failure');
        controller.abort(new Error('deliberate interrupt'));
        return evaluate(context.url, corpus(), { signal: controller.signal });
      }, { signal: controller.signal }), /deliberate/);
      assert.equal(resources.connection.readyState, 0);
      assert.notEqual(resources.apiChild.exitCode, null);
      assert.equal(resources.repl.state, 'stopped');
      await assert.rejects(fetch(`${resources.url}/health`));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
