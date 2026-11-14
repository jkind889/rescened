const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verify, environment, integrationComplete, execute } = require('../scripts/verify');
const evidence = '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-verify-'));
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  fs.mkdirSync(path.join(cwd, 'frontend', 'node_modules'), { recursive: true });
  const npmCli = path.join(cwd, 'npm.cjs');
  fs.writeFileSync(npmCli, '');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, source: { npm_execpath: npmCli }, log() {} };
}
test('all five real npm stage arguments run sequentially and only complete success is green', async (t) => {
  const calls = [];
  const result = await verify({ ...fixture(t), run: async (args, options) => {
    calls.push(args);
    assert.equal(options.env.RUN_MONGO_INTEGRATION, 'false');
    return { code: 0, output: evidence };
  } });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [['test'], ['run', 'test:integration', '--', '--verify'], ['run', 'check:catalog-contract'], ['--prefix', 'frontend', 'run', 'lint'], ['--prefix', 'frontend', 'run', 'build']]);
});
test('each failing stage stays failed even when later checks pass', async (t) => {
  const options = fixture(t);
  for (let failure = 0; failure < 5; failure++) {
    let index = 0;
    const result = await verify({ ...options, run: async () => ({ code: index++ === failure ? 7 : 0, output: evidence }) });
    assert.equal(index, 5);
    assert.equal(result.code, 1);
    assert.equal(result.results[failure].status, 'FAILED');
  }
});
test('spawn errors and signal exits cannot turn into passes', async (t) => {
  for (const failure of [{ code: null, error: 'ENOENT' }, { code: null, signal: 'SIGTERM' }]) {
    const result = await verify({ ...fixture(t), run: async () => failure });
    assert.equal(result.code, 1);
    assert.equal(result.results[0].status, 'FAILED');
    if (failure.signal) assert.equal(result.results[1].status, 'NOT RUN');
  }
});
test('missing prerequisites and dotenv variants fail before spawning', async (t) => {
  const options = fixture(t);
  const run = () => { throw new Error('must not spawn'); };
  for (const filename of ['.env', 'frontend/.env.test.local']) {
    fs.writeFileSync(path.join(options.cwd, filename), 'SECRET=fixture');
    const result = await verify({ ...options, run });
    assert.equal(result.code, 1);
    assert.ok(result.results.every((stage) => stage.status === 'NOT RUN'));
    fs.unlinkSync(path.join(options.cwd, filename));
  }
  fs.rmdirSync(path.join(options.cwd, 'frontend/node_modules'));
  assert.equal((await verify({ ...options, run })).code, 1);
  assert.equal((await verify({ ...options, source: {}, run })).code, 1);
});
test('skipped, empty, cancelled, TODO or missing integration evidence fails closed', async (t) => {
  for (const output of ['', evidence.replace('# tests 3', '# tests 0'), evidence.replace('# skipped 0', '# skipped 1'), evidence.replace('# cancelled 0', '# cancelled 1'), evidence.replace('# todo 0', '# todo 1'), evidence.replace('# fail 0', '# fail 1')]) {
    assert.equal(integrationComplete(output), false);
    const result = await verify({ ...fixture(t), run: async () => ({ code: 0, output }) });
    assert.equal(result.code, 1);
    assert.equal(result.results[1].status, 'FAILED');
  }
});
test('environment excludes credentials, live flags, injection and Mongo overrides', () => {
  const env = environment({ PATH: '/bin', HOME: '/fixture', MONGO_URI: 'secret', CLERK_SECRET_KEY: 'secret', NODE_OPTIONS: '--require evil', RUN_LIVE_CATALOG_FETCH: 'true', RUN_MONGO_INTEGRATION: 'true', MONGOMS_SYSTEM_BINARY: '/evil', VITE_SECRET: 'secret', npm_config_node_options: '--require evil' });
  assert.equal(env.PATH, '/bin');
  for (const key of ['MONGO_URI', 'CLERK_SECRET_KEY', 'NODE_OPTIONS', 'MONGOMS_SYSTEM_BINARY', 'VITE_SECRET', 'npm_config_node_options']) assert.equal(env[key], undefined);
  assert.equal(env.RUN_LIVE_CATALOG_FETCH, 'false');
  assert.equal(env.MONGOMS_RUNTIME_DOWNLOAD, 'false');
});
test('cancellation during a delayed stage prevents subsequent stages', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  const result = await verify({ ...fixture(t), signal: controller.signal, run: async () => {
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    return { code: 0, output: evidence };
  } });
  assert.equal(calls, 1);
  assert.equal(result.code, 1);
  assert.equal(result.results[0].status, 'FAILED');
  assert.ok(result.results.slice(1).every((stage) => stage.status === 'NOT RUN'));
});
test('actual child cancellation waits for process close', async (t) => {
  const options = fixture(t);
  fs.writeFileSync(options.source.npm_execpath, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  t.after(() => clearTimeout(timer));
  const result = await execute([], { cwd: options.cwd, env: environment(process.env), npmCli: options.source.npm_execpath, signal: controller.signal });
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.code, null);
});
test('real child nonzero exit and launch error preserve failure evidence', async (t) => {
  const options = fixture(t);
  fs.writeFileSync(options.source.npm_execpath, 'process.exitCode = 17;');
  const result = await execute([], { cwd: options.cwd, env: environment(process.env), npmCli: options.source.npm_execpath, signal: new AbortController().signal });
  assert.equal(result.code, 17);
  const missing = await execute([], { cwd: path.join(options.cwd, 'missing'), env: environment(process.env), npmCli: options.source.npm_execpath, signal: new AbortController().signal });
  assert.equal(missing.error, 'ENOENT');
  assert.notEqual(missing.code, 0);
});
test('a rejected stage is failed and later stages still run', async (t) => {
  let calls = 0;
  const result = await verify({ ...fixture(t), run: async () => {
    if (calls++ === 0) throw new Error('fixture');
    return { code: 0, output: evidence };
  } });
  assert.equal(calls, 5);
  assert.equal(result.code, 1);
  assert.equal(result.results[0].status, 'FAILED');
  assert.ok(result.results.slice(1).every((stage) => stage.status === 'PASSED'));
});

test('frontend build uses production while tests stay test and sanitization is preserved', async (t) => {
  const options = fixture(t);
  const seen = [];
  const result = await verify({
    ...options,
    source: { ...options.source, NODE_ENV: 'development', MONGO_URI: 'fixture-secret', NODE_OPTIONS: '--require evil', RUN_LIVE_CATALOG_FETCH: 'true' },
    run: async (args, { env }) => {
      seen.push(env.NODE_ENV);
      assert.equal(env.MONGO_URI, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.RUN_LIVE_CATALOG_FETCH, 'false');
      assert.equal(env.MONGOMS_RUNTIME_DOWNLOAD, 'false');
      return { code: 0, output: evidence };
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(seen, ['test', 'test', 'test', 'test', 'production']);
});
