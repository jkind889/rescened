#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { environment, integrationComplete } = require('./verify');
const root = path.resolve(__dirname, '..');
const files = ['artistCoverCycle', 'artistDiscography', 'artistBiographyModeration', 'baselineProposal', 'coreFlows'].map(name => `tests/${name}.browser.test.js`);
function prerequisites(cwd, executable) {
  for (const dir of ['.', 'frontend']) {
    if (!fs.existsSync(path.join(cwd, dir, 'node_modules'))) throw new Error(`Install locked ${dir} dependencies first.`);
    if (fs.readdirSync(path.join(cwd, dir)).some(name => /^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name))) throw new Error(`Refusing ${dir}/.env files.`);
  }
  if (!fs.existsSync(executable)) throw new Error('Missing pinned Chromium. Prepare explicitly with node node_modules/playwright/cli.js install chromium; no automatic download or skip.');
}
// Resolve in a fresh process: Playwright caches browser discovery on import.
// Preflight and test execution must see the exact same sanitized environment.
function discoverBrowser(source) {
  const env = environment(source);
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(require('playwright').chromium.executablePath())"], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  if (result.error || result.status !== 0 || !result.stdout) throw new Error(`Cannot resolve pinned Chromium: ${result.error?.message || result.stderr || 'empty discovery'}`);
  return { env, executable: result.stdout };
}
async function main() {
  try {
    const { env, executable } = discoverBrowser(process.env);
    prerequisites(root, executable);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-browser-'));
    console.log(`Browser artifacts (including TAP): ${directory}`);
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], {
      cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, RUN_FRONTEND_BROWSER_TESTS: 'true', PLAYWRIGHT_CHROMIUM_EXECUTABLE: executable, FRONTEND_BROWSER_ARTIFACT_DIR: directory },
    });
    let output = ''; let interrupted = false; let timer;
    const log = fs.createWriteStream(path.join(directory, 'run.log'));
    child.stdout.on('data', data => { output = (output + data).slice(-65536); log.write(data); process.stdout.write(data); });
    child.stderr.on('data', data => { log.write(data); process.stderr.write(data); });
    const kill = signal => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Already closed. */ } };
    const cancel = () => {
      interrupted = true; kill('SIGTERM');
      timer = setTimeout(() => kill('SIGKILL'), 5000); timer.unref();
    };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    const result = await new Promise(resolve => {
      child.once('error', error => { console.error(error); });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await new Promise(resolve => log.end(resolve));
    process.exitCode = result.code === 0 && !result.signal && !interrupted && integrationComplete(output) ? 0 : 1;
    console.log(process.exitCode === 0 ? 'Browser suite PASSED (no skipped tests).' : 'Browser suite FAILED or incomplete.');
  } catch (error) { console.error(`Browser suite unavailable: ${error.message}`); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = { prerequisites, files, discoverBrowser };
