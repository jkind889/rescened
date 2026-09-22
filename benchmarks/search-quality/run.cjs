const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { startServer, stopChild } = require('../run.cjs');
const AlbumCatalog = require('../../models/AlbumCatalog');
const { corpus, validateCorpus, UUID } = require('./corpus.cjs');
const { hash, identity, evaluateQuery, makeReport, validateReport, assertCompatible, compare, markdown } = require('./report.cjs');

const ROOT = path.resolve(__dirname, '../..');
function options(args) {
  if (!args.length) return {};
  if (args.length === 2 && args[0] === '--compare' && args[1] && !args[1].startsWith('--')) return { comparePath: path.resolve(args[1]) };
  throw new Error('Usage: npm run search:evaluate -- [--compare <report.json>]');
}
function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Unable to record Git provenance');
  return result.stdout.trim();
}
function environment() {
  const files = ['routes/search.js', 'routes/utils/catalogSearch.js', 'routes/utils/searchArtistAliases.js', 'routes/utils/albumCatalog.js',
    'routes/utils/rateLimit.js', 'routes/utils/serverConfig.js', 'routes/health.js', 'models/AlbumCatalog.js',
    'benchmarks/server.cjs', 'benchmarks/run.cjs', 'benchmarks/fixtures.cjs', 'benchmarks/workload.cjs', 'benchmarks/report.cjs',
    ...fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs')).map(name => `benchmarks/search-quality/${name}`)];
  return {
    recordedAt: new Date().toISOString(), revision: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])),
    node: process.version, mongoose: mongoose.version,
    sourceHashes: Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.join(ROOT, file), 'utf8'))])),
    lockfileSha256: hash(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')),
  };
}
function checkAbort(signal) { signal?.throwIfAborted(); }
async function withCatalog(data, directory, work, { signal } = {}) {
  validateCorpus(data);
  let repl; let connection; let api;
  try {
    checkAbort(signal);
    // Never accepts a database URI, imports dotenv, or reads application env files.
    repl = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' } });
    checkAbort(signal);
    const uri = repl.getUri(`rescened_bench_search_${process.pid}_${Date.now()}`);
    connection = mongoose.createConnection(uri, { autoIndex: false });
    await connection.asPromise();
    const Album = connection.model('AlbumCatalog', AlbumCatalog.schema);
    const documents = data.albums.map(item => {
      const document = new Album({ ...item, createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z') });
      const error = document.validateSync();
      if (error) throw error;
      return document.toObject();
    });
    await Album.createIndexes();
    await Album.collection.insertMany(documents);
    assert.equal(await Album.countDocuments(), data.albums.length, 'Incomplete fixture seed');
    checkAbort(signal);
    api = await startServer(uri, path.join(ROOT, 'routes/search.js'), path.join(directory, 'api.log'));
    checkAbort(signal);
    const mongo = (await connection.db.admin().command({ buildInfo: 1 })).version;
    const indexes = await Album.collection.indexes();
    return await work({ url: api.url, mongo, indexes, connection, apiChild: api.child, repl });
  } finally {
    // Attempt every cleanup even when an earlier cleanup fails.
    try { await stopChild(api?.child); }
    finally {
      try { if (connection) await connection.close(); }
      finally { if (repl) await repl.stop(); }
    }
  }
}
async function request(url, signal) {
  checkAbort(signal);
  const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) });
  if (!response.ok) throw new Error(`Search evaluation request failed: HTTP ${response.status}`);
  return response.json();
}
function rejectInternalIds(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(!Object.hasOwn(value, '_id') && !Object.hasOwn(value, '__v'), 'Response leaked an internal MongoDB field');
  for (const entry of Object.values(value)) rejectInternalIds(entry);
}
function validateRows(rows, limit, albums) {
  assert.ok(Array.isArray(rows) && rows.length <= limit, 'Invalid search result array');
  rejectInternalIds(rows);
  const ids = new Set();
  for (const row of rows) {
    assert.ok(row && UUID.test(row.albumId) && !ids.has(row.albumId), 'Invalid or duplicate public album ID');
    ids.add(row.albumId);
    const expected = albums.get(row.albumId);
    assert.ok(expected, 'Search returned an unknown fixture album');
    for (const field of ['title', 'artistDisplayName', 'artistCredits', 'releaseType', 'releaseDate',
      'releaseDatePrecision', 'releaseYear', 'cover', 'tracks', 'label', 'externalReferences', 'catalogSource']) {
      assert.deepEqual(row[field], expected[field], `Missing or incorrect public album field: ${field}`);
    }
  }
  return rows.map(row => row.albumId);
}
async function evaluate(url, data, { signal } = {}) {
  const albums = new Map(data.albums.map(a => [a.albumId, a]));
  const cases = [];
  for (const q of data.queries) {
    const base = `${url}/search/search?q=${encodeURIComponent(q.query)}`;
    const autocomplete = validateRows(await request(`${base}&limit=5`, signal), 5, albums);
    let firstPage; let page = 1; const full = [];
    while (true) {
      assert.ok(page <= Math.ceil(data.albums.length / 24) + 1, 'Search pagination did not terminate');
      const body = await request(`${base}&page=${page}&limit=24`, signal);
      assert.ok(body && !Array.isArray(body), 'Expected paginated response');
      rejectInternalIds(body);
      assert.equal(body.page, page); assert.equal(body.limit, 24);
      assert.equal(body.hasPreviousPage, page > 1);
      assert.equal(typeof body.hasNextPage, 'boolean');
      const ids = validateRows(body.results, 24, albums);
      if (body.hasNextPage) assert.equal(ids.length, 24, 'Partial page claims a next page');
      assert.ok(ids.every(value => !full.includes(value)), 'Duplicate result across pages');
      full.push(...ids);
      if (page === 1) firstPage = ids;
      if (!body.hasNextPage) break;
      page++;
    }
    assert.deepEqual(autocomplete, firstPage.slice(0, 5), 'Autocomplete and first-page order disagree');
    cases.push(evaluateQuery(q, autocomplete, firstPage, full));
  }
  return cases;
}
async function run({ comparePath, signal } = {}) {
  const data = validateCorpus(corpus());
  const previous = comparePath ? JSON.parse(fs.readFileSync(comparePath, 'utf8')) : null;
  if (previous) assertCompatible(previous, identity(data));
  const parent = path.join(ROOT, '.benchmarks/search-quality');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  const destination = path.join(directory, 'report.json');
  try {
    const provenance = environment();
    const report = await withCatalog(data, directory, async ({ url, mongo, indexes }) => {
      const cases = await evaluate(url, data, { signal });
      return makeReport(data, cases, { ...provenance, mongo, indexes });
    }, { signal });
    checkAbort(signal);
    validateReport(report);
    if (previous) report.comparison = compare(previous, report);
    fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, 'report.md'), markdown(report));
    return { directory, report };
  } catch (error) {
    fs.writeFileSync(destination, `${JSON.stringify({ schemaVersion: 1, status: signal?.aborted ? 'interrupted' : 'failed', corpus: identity(data), error: error.message }, null, 2)}\n`);
    throw new Error(`${error.message}\nIncomplete report: ${destination}`, { cause: error });
  }
}
async function main() {
  const config = options(process.argv.slice(2));
  const controller = new AbortController();
  const interrupt = signal => controller.abort(new Error(`Interrupted by ${signal}`));
  const onInt = () => interrupt('SIGINT'); const onTerm = () => interrupt('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  try {
    const { directory, report } = await run({ ...config, signal: controller.signal });
    console.log(`Search quality evaluation complete: ${report.cases.length} queries\n${path.join(directory, 'report.md')}\n${path.join(directory, 'report.json')}`);
    console.log(JSON.stringify(report.summary.overall, null, 2));
  } finally {
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { options, environment, withCatalog, validateRows, evaluate, run };
