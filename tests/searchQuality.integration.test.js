const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { corpus, id } = require('../benchmarks/search-quality/corpus.cjs');
const { withCatalog, evaluate } = require('../benchmarks/search-quality/run.cjs');
const { makeReport, compare, validateReport } = require('../benchmarks/search-quality/report.cjs');
const enabled = process.env.RUN_MONGO_INTEGRATION === 'true';

test('reviewed artist aliases prioritize artists and preserve alternative matches', { skip: !enabled }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-alias-test-'));
  try {
    await withCatalog(corpus(), directory, async ({ url, connection }) => {
      // Synthetic albums isolate artist intent from title, label, and name collisions.
      const records = [
        ['kanye', 'Kanye West'], ['ye', 'Ye'],
        ['travis-scott', 'Travis Scott'], ['travis-band', 'Travis'], ['travis-barker', 'Travis Barker'],
        ['pierre-straight', "Pi'erre Bourne"], ['pierre-curly', 'Pi’erre Bourne'],
        ['pierre-plain', 'Pierre Bourne'], ['pierre-henry', 'Pierre Henry'],
        ['kanye-tribute', 'Kanye West Tribute'],
      ].map(([key, artistDisplayName]) => ({
        albumId: id(`alias-${key}`), title: 'Synthetic Album', artistDisplayName,
        artistCredits: [{ name: artistDisplayName }],
      }));
      records.push(
        { albumId: id('alias-title'), title: "Pi'erre Bourne", artistDisplayName: 'A Tribute Artist' },
        { albumId: id('alias-label'), title: 'Synthetic Album', artistDisplayName: 'A Label Artist', label: "Pi'erre Bourne" },
        { albumId: id('alias-credit'), title: 'Synthetic Collaboration', artistDisplayName: 'The Project', artistCredits: [{ name: 'Travis Scott' }] },
      );
      await connection.models.AlbumCatalog.insertMany(records);
      const get = async (query, suffix) => {
        const response = await fetch(`${url}/search/search?q=${encodeURIComponent(query)}&${suffix}`);
        assert.equal(response.status, 200);
        return response.json();
      };
      const pierre = ['pierre-straight', 'pierre-curly', 'pierre-plain'];
      for (const [query, preferred] of [
        ['ye', ['kanye', 'ye']], ['  YE  ', ['kanye', 'ye']],
        ['Kanye West', ['kanye', 'ye']], ['Travis', ['travis-scott', 'credit']],
        ['Pierre', pierre], ['Pierre Bourne', pierre], ["Pi'erre Bourne", pierre], ['Pi’erre', pierre],
      ]) {
        const expected = preferred.map(key => id(`alias-${key}`)).sort();
        const auto = await get(query, 'limit=5');
        const page = await get(query, 'page=1&limit=24');
        assert.deepEqual(auto.map(a => a.albumId), page.results.slice(0, 5).map(a => a.albumId), query);
        assert.deepEqual(auto.slice(0, preferred.length).map(a => a.albumId).sort(), expected, query);
        assert.ok(page.results.every(a => !('_id' in a) && !('searchRank' in a)));
      }
      const travis = (await get('Travis', 'page=1')).results.map(a => a.albumId);
      assert.ok(travis.includes(id('alias-travis-band')));
      assert.ok(travis.includes(id('alias-travis-barker')));
      const first = await get('Travis', 'page=1&limit=1');
      const second = await get('Travis', 'page=2&limit=1');
      assert.deepEqual([...first.results, ...second.results].map(a => a.albumId), travis.slice(0, 2));
      assert.equal(first.hasNextPage, true);
      const pierreResults = (await get('Pierre', 'page=1')).results.map(a => a.albumId);
      assert.ok(pierreResults.includes(id('alias-pierre-henry')));
      assert.ok(!pierreResults.includes(id('alias-title')));
      assert.ok(!pierreResults.includes(id('alias-label')));
      for (const query of ['yellow', 'Pierre.*', 'Ye|Travis']) {
        assert.deepEqual(await get(query, 'limit=5'), [], query);
      }
      assert.equal((await get('Travis Barker', 'limit=5'))[0].albumId, id('alias-travis-barker'));
      assert.equal((await get('Pierre Henry', 'limit=5'))[0].albumId, id('alias-pierre-henry'));
      assert.equal((await get('bjork', 'limit=5'))[0].albumId, id('debut'));
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

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
        Number(b.artistDisplayName === 'The Meridian Ensemble') - Number(a.artistDisplayName === 'The Meridian Ensemble')
        || Buffer.compare(Buffer.from(a.artistDisplayName), Buffer.from(b.artistDisplayName))
        || Buffer.compare(Buffer.from(a.title), Buffer.from(b.title))).map(a => a.albumId);
      assert.deepEqual(long.fullResultIds, expected);
      assert.deepEqual(long.autocomplete.ids, expected.slice(0, 5));
      assert.deepEqual(long.page.ids, expected.slice(0, 24));
      for (const [queryId, key] of [
        ['artist-album', 'discovery'], ['artist-album-reversed', 'moon-safari'],
        ['album-exact', 'discovery'], ['album-editions', 'edition'],
        ['format-accent', 'debut'], ['artist-short', 'moon-safari'],
        ['artist-credit', 'collaboration'],
      ]) {
        const result = first.find(q => q.id === queryId);
        assert.equal(result.autocomplete.ids[0], id(key), queryId);
        assert.equal(result.page.ids[0], id(key), queryId);
      }
      const homes = first.find(q => q.id === 'album-shared');
      assert.deepEqual(homes.page.ids.slice(0, 2), [id('shared-a'), id('shared-b')]);
      for (const result of first.filter(q => q.category === 'miss')) {
        assert.deepEqual(result.fullResultIds, [], result.id);
      }
      const report = makeReport(data, first, { mongo: context.mongo });
      validateReport(report);
      const changes = compare(report, makeReport(data, second, { mongo: context.mongo }));
      assert.ok(changes.cases.every(q => !q.resultOrderChanged));
      assert.equal(changes.overall.page.recallAt24, 0);
      assert.equal((await fetch(`${context.url}/search/external?q=test`)).status, 404);
      assert.equal((await fetch(`${context.url}/reviews/review`, { method: 'POST' })).status, 404);
      // Identical display metadata still has a deterministic public-ID tie break.
      const tiedIds = Array.from({ length: 25 }, (_, n) => id(`ranking-tie-${n}`)).sort();
      await context.connection.models.AlbumCatalog.insertMany([...tiedIds].reverse().map(albumId => ({
        albumId, title: 'Identical Title', artistDisplayName: 'Identical Artist',
      })));
      const tied = async (page) => (await (await fetch(
        `${context.url}/search/search?q=Identical%20Title&page=${page}`,
      )).json());
      const pageOne = await tied(1); const pageTwo = await tied(2);
      assert.deepEqual(pageOne.results.map(a => a.albumId), tiedIds.slice(0, 24));
      assert.deepEqual(pageTwo.results.map(a => a.albumId), tiedIds.slice(24));
      assert.equal(pageOne.hasNextPage, true);
      assert.equal(pageTwo.hasNextPage, false);
      assert.ok(pageOne.results.every(a => !('_id' in a) && !('searchRank' in a)));
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
