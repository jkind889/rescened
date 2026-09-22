const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync, fork } = require('node:child_process');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { PRESETS, seed } = require('./fixtures.cjs');
const { cases, hash, validateBody } = require('./workload.cjs');
const { digest, summarize, markdown, compare } = require('./report.cjs');
const ROOT = path.resolve(__dirname, '..');
function options(argv) {
  const result = { mode: 'compare', datasets: 'small,main', variant: 'baseline', baseline: '94c6008', warmup: 30, stage: 120, duration: 300, rates: '5,10,25,50,100' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!Object.hasOwn(result, key) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option ${argv[i]}`);
    result[key] = argv[i + 1];
  }
  if (!['smoke', 'explore', 'compare', 'explain'].includes(result.mode)) throw new Error('Invalid mode');
  if (!['baseline', 'current'].includes(result.variant)) throw new Error('Invalid variant');
  for (const key of ['warmup', 'stage', 'duration']) {
    result[key] = Number(result[key]);
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 3600) throw new Error(`Invalid ${key}`);
  }
  result.datasets = result.mode === 'smoke' ? ['smoke'] : result.datasets.split(',');
  if (result.datasets.some((d) => !PRESETS[d])) throw new Error('Invalid dataset');
  result.rates = String(result.rates).split(',').map(Number);
  if (result.rates.some((n, i, a) => !Number.isInteger(n) || n < 1 || n > 1000 || (i && n <= a[i - 1]))) throw new Error('Rates must be increasing integers from 1 to 1000');
  return result;
}
function command(bin, args) {
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`${bin} failed: ${r.error?.message || r.stderr}`);
  return r.stdout.trim();
}
function environment() {
  return {
    revision: command('git', ['rev-parse', 'HEAD']), dirty: Boolean(command('git', ['status', '--porcelain'])),
    trackedDiffSha256: digest(command('git', ['diff', 'HEAD'])),
    lockfileSha256: digest(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')),
    harnessHashes: Object.fromEntries(fs.readdirSync(__dirname).filter((name) => /\.(?:cjs|js)$/.test(name)).sort().map((name) => [name, digest(fs.readFileSync(path.join(__dirname, name), 'utf8'))])),
    node: process.version, k6: command('k6', ['version']), os: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model, cpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
  };
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  });
}
async function preventIdleSleep() {
  if (os.platform() !== 'darwin') return null;
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
}
function samplingGap(previous, current) {
  return current - previous > 5000 || current < previous;
}
async function startServer(uri, sourcePath, logPath) {
  const fd = fs.openSync(logPath, 'a');
  const child = fork(path.join(__dirname, 'server.cjs'), [uri, sourcePath], {
    cwd: ROOT, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), NODE_ENV: 'test' },
    stdio: ['ignore', fd, fd, 'ipc'],
  });
  fs.closeSync(fd);
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Benchmark API startup timed out')), 30000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Benchmark API exited ${code}; inspect ${logPath}`)); });
      child.once('message', (m) => { clearTimeout(timer); resolve(m.port); });
    });
    const url = `http://127.0.0.1:${port}`;
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok || (await res.json()).status !== 'ok') throw new Error('Benchmark API is unhealthy');
    return { child, url };
  } catch (error) { await stopChild(child); throw error; }
}
async function manifest(url, preset) {
  const result = {};
  for (const [name, urls] of Object.entries(cases(preset))) {
    result[name] = [];
    for (const relative of urls) {
      const response = await fetch(`${url}${relative}`, { signal: AbortSignal.timeout(30000) });
      const body = await response.text();
      if (!response.ok) throw new Error(`Preflight ${relative}: HTTP ${response.status}`);
      validateBody(name, JSON.parse(body));
      result[name].push({ path: relative, hash: hash(body) });
    }
  }
  return result;
}
async function explain() {
  const Album = require('../models/AlbumCatalog');
  const { buildCatalogSearchQuery, buildRankedCatalogSearchPipeline } = require('../routes/utils/catalogSearch');
  const feeds = require('../routes/utils/reviewFeeds');
  const Review = require('../models/Reviews');
  const queries = {};
  for (const q of ['Sessions', 'Blue', '000019', 'no-such-album-xyz']) {
    const filter = buildCatalogSearchQuery(q);
    queries[q] = {
      count: await Album.aggregate([{ $match: filter }, { $count: 'count' }]).explain('executionStats'),
      find24: await Album.find(filter).sort({ artistDisplayName: 1, title: 1 }).limit(24).explain('executionStats'),
      lookahead25: await Album.find(filter).sort({ artistDisplayName: 1, title: 1 }).limit(25).explain('executionStats'),
      ranked24: await Album.aggregate(buildRankedCatalogSearchPipeline(q)).explain('executionStats'),
      rankedLookahead25: await Album.aggregate(buildRankedCatalogSearchPipeline(q, { limit: 25 })).explain('executionStats'),
    };
  }
  queries.catalog = await Album.find({}).sort({ artistDisplayName: 1, title: 1 }).skip(240).limit(24).explain('executionStats');
  queries.recent = await Review.aggregate(feeds.buildRecentlyReviewedAlbumsPipeline()).explain('executionStats');
  queries.popular = await Review.aggregate(feeds.buildPopularAlbumsPipeline({ window: 'all' })).explain('executionStats');
  return queries;
}
async function runLoad({ url, manifestPath, directory, rate, duration, focus, pids, raw = true }) {
  fs.mkdirSync(directory);
  const fd = fs.openSync(path.join(directory, 'k6.log'), 'w');
  const args = ['run', '--quiet', '--no-usage-report'];
  if (raw) args.push('--out', `json=${path.join(directory, 'samples.json')}`);
  args.push(path.join(__dirname, 'load.js'));
  const child = spawn('k6', args, {
    cwd: ROOT, env: {
      PATH: process.env.PATH, BASE_URL: url, MANIFEST: manifestPath,
      SUMMARY: path.join(directory, 'summary.json'), RATE: String(rate), DURATION: String(duration), FOCUS: focus,
    }, stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const samples = [];
  let previousSample = Date.now();
  let interruptedSampling = false;
  const sample = () => {
    const now = Date.now();
    if (samplingGap(previousSample, now)) {
      interruptedSampling = true;
      child.kill('SIGTERM');
    }
    previousSample = now;
    const stats = spawnSync('ps', ['-o', 'pid=,%cpu=,rss=', '-p', [...pids, child.pid].filter(Boolean).join(',')], { encoding: 'utf8' });
    samples.push({ time: new Date().toISOString(), ps: stats.stdout?.trim(), error: stats.error?.message });
  };
  const timer = setInterval(sample, 1000);
  const deadline = setTimeout(() => child.kill('SIGTERM'), (duration + 60) * 1000);
  const abort = () => child.kill('SIGTERM');
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code) => resolve(code));
    });
    if (interruptedSampling || samplingGap(previousSample, Date.now())) throw new Error(`Measurement interrupted: resource sampling paused for more than five seconds or the clock moved backwards; inspect ${directory}`);
    if (![0, 99].includes(exitCode)) throw new Error(`k6 failed (${exitCode}); inspect ${directory}`);
    const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
    const names = focus === 'search' ? ['search', 'search_page'] : Object.keys(JSON.parse(fs.readFileSync(manifestPath)));
    return { exitCode, metrics: summarize(summary, names, duration, exitCode) };
  } finally {
    clearInterval(timer); clearTimeout(deadline);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await stopChild(child);
    fs.writeFileSync(path.join(directory, 'resources.json'), JSON.stringify({
      description: 'ps %cpu and RSS KiB sampled once per second; ps CPU is platform-defined, not a per-second utilization delta.',
      apiPid: pids[0], mongoPid: pids[1], generatorPid: child.pid, interruptedSampling, samples,
    }, null, 2));
  }
}
async function main(argv) {
  const config = options(argv);
  const env = environment();
  const baselineRef = command('git', ['rev-parse', '--verify', `${config.baseline}^{commit}`]);
  const source = {
    baseline: command('git', ['show', `${baselineRef}:routes/search.js`]) + '\n',
    current: fs.readFileSync(path.join(ROOT, 'routes/search.js'), 'utf8'),
  };
  const outputRoot = path.join(ROOT, '.benchmarks');
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
  const report = { version: 1, status: 'running', config, environment: env, baselineRef, sourceHashes: {}, datasets: {}, runs: [] };
  fs.mkdirSync(path.join(output, 'harness'));
  for (const name of Object.keys(env.harnessHashes)) fs.copyFileSync(path.join(__dirname, name), path.join(output, 'harness', name));
  for (const variant of Object.keys(source)) {
    fs.writeFileSync(path.join(output, `${variant}-search.cjs`), source[variant]);
    report.sourceHashes[variant] = digest(source[variant]);
  }
  const save = () => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, 'report.md'), markdown(report));
  };
  console.log(`Artifacts: ${output}`);
  let repl;
  let api;
  let sleepGuard;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    sleepGuard = await preventIdleSleep();
    report.idleSleepPrevented = Boolean(sleepGuard);
    for (const dataset of config.datasets) {
      if (interrupted) throw new Error('Interrupted');
      console.log(`Preparing ${dataset} synthetic dataset`);
      repl = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ ip: '127.0.0.1' }] });
      const uri = repl.getUri(`rescened_bench_${crypto.randomBytes(8).toString('hex')}`);
      await mongoose.connect(uri, { autoIndex: false });
      const mongoVersion = (await mongoose.connection.db.admin().command({ buildInfo: 1 })).version;
      report.datasets[dataset] = { ...(await seed(dataset)), mongoVersion };
      console.log(`Seeded ${dataset}: ${JSON.stringify(report.datasets[dataset].counts)}`);
      fs.writeFileSync(path.join(output, `${dataset}-query-plans.json`), JSON.stringify(await explain(), null, 2));
      save();
      if (config.mode !== 'explain') {
        let expected;
        let serial = 0;
        const run = async (variant, phase, focus, rate, duration) => {
          if (interrupted) throw new Error('Interrupted');
          await stopChild(api?.child);
          api = await startServer(uri, path.join(output, `${variant}-search.cjs`), path.join(output, 'api.log'));
          const actual = await manifest(api.url, dataset);
          if (expected) assert.deepEqual(actual, expected, 'Baseline and current public responses must match');
          else expected = actual;
          const manifestPath = path.join(output, `${dataset}-manifest.json`);
          fs.writeFileSync(manifestPath, JSON.stringify(expected));
          const label = `${dataset}-${String(serial++).padStart(3, '0')}-${variant}-${phase}-${focus}-${rate}`;
          console.log(`${label}: ${duration}s + ${config.warmup}s warmup`);
          const mongoPid = repl.servers[0].instanceInfo.instance.mongodProcess.pid;
          const params = { url: api.url, manifestPath, rate, focus, pids: [api.child.pid, mongoPid] };
          await runLoad({ ...params, duration: config.warmup, directory: path.join(output, `${label}-warmup`), raw: false });
          const result = await runLoad({ ...params, duration, directory: path.join(output, label) });
          report.runs.push({
            dataset, variant, phase, focus, rate, duration, warmup: config.warmup, artifact: label,
            compatibility: digest({ dataset: report.datasets[dataset], environment: env, expected, focus, rate, duration, warmup: config.warmup }), ...result,
          });
          save();
          console.log(`${label}: qualified=${result.metrics.qualified}, successfulRps=${result.metrics.successfulRps.toFixed(2)}, dropped=${result.metrics.dropped}`);
          return result.metrics.qualified;
        };
        if (config.mode === 'smoke') {
          if (!await run('baseline', 'smoke', 'mixed', 5, 10)) throw new Error('Baseline smoke failed');
          if (!await run('current', 'smoke', 'mixed', 5, 10)) throw new Error('Current smoke failed');
        } else {
          const variants = config.mode === 'compare' ? ['baseline', 'current'] : [config.variant];
          const highest = {};
          for (const variant of variants) {
            highest[variant] = null;
            for (const rate of config.rates) {
              if (!await run(variant, 'explore', 'mixed', rate, config.stage)) break;
              highest[variant] = rate;
            }
          }
          if (config.mode === 'compare') {
            const common = highest.baseline && highest.current ? Math.min(highest.baseline, highest.current) : config.rates[0];
            for (const focus of ['mixed', 'search']) {
              for (let repeat = 0; repeat < 3; repeat++) {
                for (const variant of repeat % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
                  await run(variant, 'confirm', focus, common, config.duration);
                }
              }
            }
          }
        }
      }
      await stopChild(api?.child); api = null;
      await mongoose.disconnect(); await repl.stop(); repl = null;
    }
    report.status = 'complete'; report.comparisons = compare(report);
  } catch (error) {
    report.status = 'failed'; report.error = error.message; throw error;
  } finally {
    await stopChild(api?.child); await mongoose.disconnect();
    if (repl) await repl.stop();
    await stopChild(sleepGuard);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    save(); console.log(`Report: ${path.join(output, 'report.md')}`);
  }
}
if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { options, stopChild, startServer, manifest, samplingGap };
