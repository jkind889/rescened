const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { seed, album, oid, uuid } = require('../benchmarks/fixtures.cjs');
const { startServer, stopChild, manifest } = require('../benchmarks/run.cjs');
const { buildCatalogSearchQuery } = require('../routes/utils/catalogSearch');
const { toSearchResult } = require('../routes/utils/albumCatalog');
const Album = require('../models/AlbumCatalog');
const enabled = process.env.RUN_MONGO_INTEGRATION === 'true';

test('isolated real-route benchmarks preserve search, social counts and cleanup', { skip: !enabled }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-benchmark-test-'));
  let repl;
  let api;
  try {
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = repl.getUri('rescened_bench_integration');
    await mongoose.connect(uri, { autoIndex: false });
    const fixture = await seed('smoke');
    assert.equal(fixture.counts.albums, 100);
    await assert.rejects(seed('smoke'), /must be empty/);
    await Album.insertMany(Array.from({ length: 49 }, (_, i) => ({ ...album(1000 + i), title: `Boundary ${String(i).padStart(3, '0')}`, artistDisplayName: 'Boundary Artist' })));
    api = await startServer(uri, path.resolve(__dirname, '../routes/search.js'), path.join(directory, 'api.log'));
    await t.test('preflight validates all public workloads', async () => { await manifest(api.url, 'smoke'); });
    await t.test('pagination matches an independent count-and-find oracle', async () => {
      for (const q of ['Boundary', 'no match', "Guns N' Roses", '[Live]', 'Cafe\u0301', 'sion', 'Label 3']) {
        const filter = buildCatalogSearchQuery(q);
        const total = await Album.countDocuments(filter);
        for (const page of [undefined, 1, 2, 3, 4]) {
          const suffix = page === undefined ? '' : `&page=${page}`;
          const result = await fetch(`${api.url}/search/search?q=${encodeURIComponent(q)}${suffix}`);
          assert.equal(result.status, 200);
          const body = await result.json();
          const expected = (await Album.find(filter).sort({ artistDisplayName: 1, title: 1 }).skip(((page || 1) - 1) * 24).limit(24)).map(toSearchResult);
          assert.deepEqual(page === undefined ? body : body.results, expected);
          if (page !== undefined) { assert.equal(body.hasNextPage, page * 24 < total); assert.equal(body.hasPreviousPage, page > 1); }
        }
      }
      for (const count of [24, 48]) {
        const q = `Exact${count}`;
        await Album.insertMany(Array.from({ length: count }, (_, i) => ({ ...album(count * 100 + i), title: `${q} ${i}`, artistDisplayName: q })));
        const result = await (await fetch(`${api.url}/search/search?q=${q}&page=${count / 24}`)).json();
        assert.equal(result.results.length, 24); assert.equal(result.hasNextPage, false);
      }
      assert.deepEqual(await (await fetch(`${api.url}/search/search?q=`)).json(), []);
    });
    await t.test('social save counts deduplicate two boards per owner', async () => {
      const Items = require('../models/BoardItem');
      const expected = await Items.distinct('userId', { albumCatalogId: oid('album', 0) });
      const count = await Items.countDocuments({ albumCatalogId: oid('album', 0) });
      const result = await (await fetch(`${api.url}/albums/album/${uuid('album', 0)}/social`)).json();
      assert.equal(result.savedCount, expected.length); assert.equal(count, expected.length * 2);
    });
    await t.test('writes and provider routes are unavailable', async () => {
      assert.equal((await fetch(`${api.url}/reviews/review`, { method: 'POST' })).status, 404);
      assert.equal((await fetch(`${api.url}/search/external?q=test`)).status, 404);
    });
    await stopChild(api.child);
    assert.notEqual(api.child.exitCode, null);
    api = null;
    await t.test('failed startup terminates its child', async () => {
      await assert.rejects(startServer('mongodb://127.0.0.1:1/not_benchmark', path.resolve(__dirname, '../routes/search.js'), path.join(directory, 'invalid.log')), /exited/);
    });
  } finally {
    await stopChild(api?.child);
    await mongoose.disconnect();
    if (repl) await repl.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
