const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prerequisites, files, discoverBrowser } = require('../scripts/runBrowserTests');
test('browser prerequisites refuse dotenv, missing installs and missing browser without skipping', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-prerequisites-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'chromium');
  assert.throws(() => prerequisites(directory, executable), /dependencies/);
  fs.mkdirSync(path.join(directory, 'node_modules'));
  fs.mkdirSync(path.join(directory, 'frontend', 'node_modules'), { recursive: true });
  assert.throws(() => prerequisites(directory, executable), /Missing pinned Chromium/);
  fs.writeFileSync(executable, 'fixture');
  for (const name of ['.env', 'frontend/.env.local']) {
    fs.writeFileSync(path.join(directory, name), 'SYNTHETIC=value');
    assert.throws(() => prerequisites(directory, executable), /Refusing/);
    fs.unlinkSync(path.join(directory, name));
  }
  fs.writeFileSync(path.join(directory, '.env.example'), '');
  assert.doesNotThrow(() => prerequisites(directory, executable));
  assert.equal(files.length, 10);
  for (const name of files) assert.ok(fs.existsSync(path.join(__dirname, '..', name)));
});

test('browser preflight and execution ignore hostile inherited browser discovery paths', () => {
  const clean = discoverBrowser(process.env);
  // A new process starts hostile before any Playwright import, avoiding a
  // falsely green result from a registry cached by earlier tests.
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./scripts/runBrowserTests').discoverBrowser(process.env)))"], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    env: { ...clean.env, PLAYWRIGHT_BROWSERS_PATH: '/nonexistent/hostile-browser', npm_config_playwright_browsers_path: '/another/hostile-path' },
  });
  assert.equal(result.status, 0, result.stderr);
  const hostile = JSON.parse(result.stdout);
  assert.equal(hostile.executable, clean.executable);
  assert.equal(hostile.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
  assert.equal(hostile.env.npm_config_playwright_browsers_path, undefined);
  assert.ok(!hostile.executable.includes('hostile'), 'regression does not require a provisioned browser');
});
