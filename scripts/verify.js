#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const stages = [
  ['backend tests', ['test']],
  ['Mongo integration', ['run', 'test:integration', '--', '--verify']],
  ['catalog contract', ['run', 'check:catalog-contract']],
  ['frontend lint', ['--prefix', 'frontend', 'run', 'lint']],
  ['frontend build', ['--prefix', 'frontend', 'run', 'build'], 'production'],
];
const root = path.resolve(__dirname, '..');
function environment(source, nodeEnv = 'test') {
  const env = {};
  // Do not inherit credentials, feature flags, live-test switches or Node injection.
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return Object.assign(env, {
    NODE_ENV: nodeEnv, RUN_MONGO_INTEGRATION: 'false',
    RUN_LIVE_CATALOG_FETCH: 'false', RUN_LIVE_LASTFM_STUDY: 'false',
    MONGOMS_RUNTIME_DOWNLOAD: 'false', MONGOMS_MD5_CHECK: 'true',
  });
}
function integrationComplete(output) {
  const count = (name) => [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))].at(-1)?.[1];
  return Number(count('tests')) > 0 && Number(count('pass')) > 0 &&
    count('fail') === '0' && count('skipped') === '0' && count('cancelled') === '0' && count('todo') === '0';
}
function execute(args, { cwd, env, npmCli, signal }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'inherit'], detached: process.platform !== 'win32',
    });
    let tail = '';
    let error;
    let killTimer;
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      tail = (tail + data.toString()).slice(-65536);
    });
    const cancel = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* Already exited. */ }
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Already exited. */ }
      }, 5000);
      killTimer.unref();
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.on('error', (err) => { error = err.code || 'spawn error'; });
    child.on('close', (code, killedBy) => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
      resolve({ code, signal: killedBy, error, output: tail });
    });
  });
}
async function verify({ cwd = root, source = process.env, run = execute, log = console.log, signal = new AbortController().signal } = {}) {
  const results = stages.map(([name]) => ({ name, status: 'NOT RUN' }));
  try {
    if (!source.npm_execpath || !fs.existsSync(source.npm_execpath)) throw new Error('Run through npm run verify (npm CLI unavailable).');
    for (const dir of ['.', 'frontend']) {
      if (!fs.existsSync(path.join(cwd, dir, 'node_modules'))) throw new Error(`Missing ${dir}/node_modules; run npm ${dir === '.' ? '' : '--prefix frontend '}ci first.`);
      if (fs.readdirSync(path.join(cwd, dir)).some((name) => /^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name))) {
        throw new Error(`Refusing ${dir}/.env files; verification must not load local credentials or Vite settings.`);
      }
    }
    for (const [index, [name, args, nodeEnv = 'test']] of stages.entries()) {
      if (signal.aborted) break;
      log(`\n[verify] Running ${name}: npm ${args.join(' ')}`);
      let result;
      try {
        result = await run(args, { cwd, env: environment(source, nodeEnv), npmCli: source.npm_execpath, signal });
      } catch (error) {
        result = { code: null, error: error.code || 'runner error' };
      }
      const complete = index !== 1 || integrationComplete(result.output || '');
      results[index].status = result.code === 0 && !result.error && !result.signal && !signal.aborted && complete ? 'PASSED' : 'FAILED';
      if (results[index].status === 'FAILED') log(`[verify] ${name}: ${result.error || result.signal || (result.code !== 0 ? `exit ${result.code}` : 'interrupted or incomplete integration evidence')}`);
      if (result.signal || signal.aborted) break;
    }
  } catch (error) {
    log(`[verify] Unavailable: ${error.message}`);
  }
  log('\n[verify] Results');
  for (const result of results) log(`${result.status}: ${result.name}`);
  const code = results.every((result) => result.status === 'PASSED') ? 0 : 1;
  log(code === 0 ? '[verify] Full gate PASSED.' : '[verify] Full gate incomplete or FAILED.');
  return { code, results };
}
if (require.main === module) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  verify({ signal: controller.signal }).then(({ code }) => {
    process.exitCode = code;
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  });
}
module.exports = { verify, environment, integrationComplete, execute };
