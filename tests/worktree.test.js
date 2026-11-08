const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const wt = require('../scripts/worktree.cjs');
const cli = path.resolve(__dirname, '../scripts/worktree.cjs');
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-worktree-test-'));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Worktree Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nfrontend/node_modules/\ndist/\n.env*\n');
  fs.mkdirSync(path.join(root, 'frontend')); fs.writeFileSync(path.join(root, 'frontend/README.md'), 'fixture\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, root, ctx: wt.context(root) };
}
function profile() { return { environment: 'shared-development', database: 'rescened_dev', mongoHost: 'dev.example.invalid', server: { MONGO_URI: 'mongodb+srv://test:fake@dev.example.invalid/rescened_dev?retryWrites=true&w=majority', CLERK_SECRET_KEY: 'sk_test_fixture', CLERK_PUBLISHABLE_KEY: 'pk_test_fixture' } }; }
async function childTree(t, name = 'example') { const f = fixture(t); const state = await wt.create(f.ctx, name, 'main'); return { ...f, state, child: wt.context(state.root) }; }
async function waitFor(check, ms = 5000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 30)); } throw new Error('Timed out waiting for fixture'); }

test('profile pins development target and rejects live, unknown, and unsafe settings', () => {
  assert.equal(wt.validateProfile(profile()).database, 'rescened_dev');
  for (const mutate of [
    (p) => { p.environment = 'production'; }, (p) => { p.database = 'rescened'; },
    (p) => { p.mongoHost = 'another.example.invalid'; },
    (p) => { p.server.MONGO_URI = 'mongodb+srv://test:PASSWORD_VALUE_SHOULD_NOT_APPEAR@dev.example.invalid/production'; },
    (p) => { p.server.CLERK_SECRET_KEY = 'sk_live_fixture'; },
    (p) => { p.server.CLERK_PUBLISHABLE_KEY = 'pk_live_fixture'; },
    (p) => { p.server.LASTFM_SYNC_ENABLED = 'true'; },
    (p) => { p.server.MONGO_URI += '&tls=false'; },
    (p) => { p.server.MONGO_URI += '&tlsAllowInvalidCertificates=true'; },
    (p) => { p.extra = true; },
    (p) => { p.preview = { LASTFM_SYNC_ENABLED: true }; },
    (p) => { p.preview = null; },
    (p) => { p.preview = []; },
  ]) { const p = profile(); mutate(p); assert.throws(() => wt.validateProfile(p), (e) => !e.message.includes('PASSWORD_VALUE_SHOULD_NOT_APPEAR')); }
});
test('preview allowlists reject broad, malformed, duplicate, and excessive entries', () => {
  for (const key of ['listeningPilotUserIds', 'moderatorUserIds']) {
    for (const value of [null, 'user_test', {}, ['*'], [''], ['user_test,user_other'], ['user_test\n'], [' user_test'], ['user_test', 'user_test'], ['user_' + 'x'.repeat(124)], Array.from({ length: 101 }, (_, i) => `user_test${i}`)]) {
      const p = profile(); p.preview = { [key]: value };
      assert.throws(() => wt.validateProfile(p), /allowlists/);
    }
    const p = profile(); p.preview = { [key]: ['user_test', 'user_other'] };
    assert.equal(wt.validateProfile(p), p);
  }
});
test('environment construction isolates frontend secrets and overrides inherited production flags', () => {
  const { backend, frontend } = wt.buildEnvironments(profile(), { apiPort: 3101, webPort: 5201 }, { PATH: '/bin', MONGO_URI: 'production', NODE_OPTIONS: '--require evil.js', VITE_SECRET: 'secret', LASTFM_SYNC_ENABLED: 'true', PORT: '9999', MODERATOR_USER_IDS: 'user_unapproved', LASTFM_PILOT_USER_IDS: 'user_unapproved' });
  assert.equal(backend.PORT, '3101'); assert.equal(backend.CORS_ALLOWED_ORIGINS, 'http://127.0.0.1:5201');
  assert.equal(frontend.VITE_API_URL, 'http://127.0.0.1:3101');
  for (const flag of wt.DISABLED) assert.equal(backend[flag], 'false');
  for (const key of ['MONGO_URI', 'CLERK_SECRET_KEY', 'NODE_OPTIONS', 'VITE_SECRET', 'LASTFM_SYNC_ENABLED']) assert.equal(frontend[key], undefined);
  assert.equal(backend.NODE_OPTIONS, undefined); assert.equal(backend.VITE_SECRET, undefined);
  assert.equal(backend.MODERATOR_USER_IDS, ''); assert.equal(backend.LASTFM_PILOT_USER_IDS, '');
});
test('approved preview enables only detection and approval flags, with server-only user scopes', () => {
  const p = profile(); p.preview = { listeningPilotUserIds: ['user_test', 'user_pilot'], moderatorUserIds: ['user_test'] };
  const { backend, frontend } = wt.buildEnvironments(p, { apiPort: 3101, webPort: 5201 }, {});
  const enabled = ['LISTENING_DETECTION_ENABLED', 'COMMUNITY_MODERATION_ENABLED', 'ALBUM_MAPPING_MODERATION_ENABLED', 'TRACKLIST_BASELINE_MODERATION_ENABLED'];
  for (const flag of wt.DISABLED) assert.equal(backend[flag], enabled.includes(flag) ? 'true' : 'false', flag);
  assert.equal(backend.LASTFM_PILOT_USER_IDS, 'user_test,user_pilot');
  assert.equal(backend.MODERATOR_USER_IDS, 'user_test');
  assert.deepEqual(Object.keys(frontend).sort(), ['NODE_ENV', 'VITE_API_URL', 'VITE_CLERK_PUBLISHABLE_KEY']);
  const { detectionEnabledFor } = require('../lib/listening/detectionView');
  assert.deepEqual(detectionEnabledFor('user_test', backend), { enabled: true, pilotAllowed: true, autoDiary: false });
  assert.deepEqual(detectionEnabledFor('user_unapproved', backend), { enabled: true, pilotAllowed: false, autoDiary: false });
  assert.equal(Object.values(frontend).some((value) => value.includes('user_test')), false);
});
test('pilot and moderator scopes are independent; empty or absent lists retain disabled defaults', () => {
  for (const preview of [{}, { listeningPilotUserIds: [], moderatorUserIds: [] }, { listeningPilotUserIds: ['user_pilot'] }, { moderatorUserIds: ['user_moderator'] }]) {
    const p = profile(); p.preview = preview;
    const { backend } = wt.buildEnvironments(p, { apiPort: 3101, webPort: 5201 }, {});
    assert.equal(backend.LISTENING_DETECTION_ENABLED, String(Boolean(preview.listeningPilotUserIds?.length)));
    for (const flag of ['COMMUNITY_MODERATION_ENABLED', 'ALBUM_MAPPING_MODERATION_ENABLED', 'TRACKLIST_BASELINE_MODERATION_ENABLED']) assert.equal(backend[flag], String(Boolean(preview.moderatorUserIds?.length)));
  }
});
test('create leaves primary unchanged; setup is idempotent and reserves distinct pairs', async (t) => {
  const f = await childTree(t);
  const again = await wt.setup(f.child); assert.deepEqual(again, f.state);
  const second = await wt.create(f.ctx, 'second', 'main');
  assert.notEqual(second.apiPort, again.apiPort); assert.notEqual(second.webPort, again.webPort);
  assert.equal(git(f.root, 'branch', '--show-current'), 'main'); assert.equal(git(f.root, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(f.state.root, '.env')), false);
  assert.equal(fs.existsSync(path.join(f.state.root, 'node_modules')), false);
  await assert.rejects(wt.setup(f.ctx), /primary/);
  await assert.rejects(wt.create(f.ctx, '../escape', 'main'), /name/);
  await assert.rejects(wt.create(f.ctx, 'example', 'main'), /exists/);
});
test('repository-local creation base is honored, explicit base wins, and removal still uses origin/main', async (t) => {
  const f = fixture(t);
  const original = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'update-ref', 'refs/remotes/origin/main', original);
  assert.equal(wt.defaultCreateBase(f.ctx), 'origin/main');
  const ordinary = await wt.create(f.ctx, 'ordinary');
  assert.equal(git(ordinary.root, 'rev-parse', 'HEAD'), original);
  fs.writeFileSync(path.join(f.root, 'setup.txt'), 'approved worktree setup\n');
  git(f.root, 'add', 'setup.txt'); git(f.root, 'commit', '-m', 'prepared base');
  const prepared = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'branch', 'prepared-base');
  git(f.root, 'config', '--local', 'rescened.worktreeBase', 'refs/heads/prepared-base');
  const child = await wt.create(f.ctx, 'inherits-setup');
  assert.equal(git(child.root, 'rev-parse', 'HEAD'), prepared);
  assert.equal(wt.defaultCreateBase(wt.context(child.root)), 'refs/heads/prepared-base');
  const explicit = await wt.create(f.ctx, 'explicit-old-base', 'origin/main');
  assert.equal(git(explicit.root, 'rev-parse', 'HEAD'), original);
  await assert.rejects(wt.remove(f.ctx, child.root), /commits not contained/);
  git(f.root, 'config', '--local', 'rescened.worktreeBase', 'missing-base');
  await assert.rejects(wt.create(f.ctx, 'invalid-base'), /Git operation failed/);
  assert.equal(fs.existsSync(path.join(f.dir, 'rescened-worktrees/invalid-base')), false);
  git(f.root, 'config', '--local', '--add', 'rescened.worktreeBase', 'main');
  assert.throws(() => wt.defaultCreateBase(f.ctx), /exactly one/);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
});
test('allocator skips occupied ports and registry locking fails closed', async (t) => {
  const f = fixture(t); const server = net.createServer();
  if (await wt.pairFree(3100, 5200)) { server.listen(3100, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close()); }
  const s = await wt.create(f.ctx, 'busy-port', 'main'); assert.notEqual(s.apiPort, 3100);
  fs.mkdirSync(path.join(f.ctx.store, 'registry.lock'));
  await assert.rejects(wt.setup(wt.context(s.root)), /locked/);
});
test('profiles stay outside every checkout and require private permissions', async (t) => {
  const f = await childTree(t); const file = path.join(f.dir, 'dev.json');
  fs.writeFileSync(file, JSON.stringify(profile()), { mode: 0o600 });
  assert.equal(wt.loadProfile(file, f.child).database, 'rescened_dev');
  fs.chmodSync(file, 0o644); assert.throws(() => wt.loadProfile(file, f.child), /private/);
  const inside = path.join(f.root, 'dev.json'); fs.writeFileSync(inside, JSON.stringify(profile()), { mode: 0o600 });
  assert.throws(() => wt.loadProfile(inside, f.child), /outside/);
});
test('dotenv guard protects root and frontend dotenv variants without modifying them', async (t) => {
  const f = await childTree(t);
  for (const rel of ['.env', '.env.development', 'frontend/.env.local']) {
    const filename = path.join(f.state.root, rel); fs.writeFileSync(filename, 'DO_NOT_COPY=true');
    assert.throws(() => wt.rejectEnvFiles(f.state.root), /dotenv/); assert.equal(fs.readFileSync(filename, 'utf8'), 'DO_NOT_COPY=true'); fs.unlinkSync(filename);
  }
  wt.rejectEnvFiles(f.state.root);
});
test('removal refuses dirty, ignored, running, unmerged, and primary checkouts', async (t) => {
  const f = await childTree(t); const root = f.state.root;
  await assert.rejects(wt.remove(f.ctx, path.join(root, 'frontend'), 'main'), /exact worktree root/);
  fs.writeFileSync(path.join(root, 'unsaved.txt'), 'keep');
  await assert.rejects(wt.remove(f.ctx, root, 'main'), /dirty/); fs.unlinkSync(path.join(root, 'unsaved.txt'));
  fs.writeFileSync(path.join(root, '.env.development'), 'keep');
  await assert.rejects(wt.remove(f.ctx, root, 'main', true), /ignored user files/); fs.unlinkSync(path.join(root, '.env.development'));
  fs.writeFileSync(wt.runPath(f.child), '{}');
  await assert.rejects(wt.remove(f.ctx, root, 'main'), /run marker/); fs.unlinkSync(wt.runPath(f.child));
  fs.appendFileSync(path.join(root, 'README.md'), 'committed work'); git(root, 'add', 'README.md'); git(root, 'commit', '-m', 'unmerged');
  await assert.rejects(wt.remove(f.ctx, root, 'main'), /commits not contained/);
  assert.equal(fs.existsSync(root), true); await assert.rejects(wt.remove(f.ctx, f.root, 'main'), /primary/);
});
test('clean merged removal keeps branch, database profile, and other trees', async (t) => {
  const f = await childTree(t); const other = await wt.create(f.ctx, 'other', 'main');
  const p = path.join(f.dir, 'private-profile.json'); fs.writeFileSync(p, 'preserved');
  fs.mkdirSync(path.join(f.state.root, 'node_modules')); fs.writeFileSync(path.join(f.state.root, 'node_modules/generated.txt'), 'generated');
  await assert.rejects(wt.remove(f.ctx, f.state.root, 'main'), /discard-generated/);
  await wt.remove(f.ctx, f.state.root, 'main', true);
  assert.equal(fs.existsSync(f.state.root), false); assert.equal(fs.existsSync(other.root), true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'preserved'); assert.equal(fs.existsSync(wt.statePath(f.child)), false);
  assert.ok(git(f.root, 'branch', '--list', 'work/example'));
});
test('foreground launcher starts only paired mock apps and stops its own child processes', async (t) => {
  const f = await childTree(t);
  const root = f.state.root;
  fs.mkdirSync(path.join(root, 'node_modules/express'), { recursive: true });
  const viteDir = path.join(root, 'frontend/node_modules/vite/bin'); fs.mkdirSync(viteDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'server.js'), `const net=require('node:net'); const assert=require('node:assert/strict'); for(const key of ['LISTENING_DETECTION_ENABLED','COMMUNITY_MODERATION_ENABLED','ALBUM_MAPPING_MODERATION_ENABLED','TRACKLIST_BASELINE_MODERATION_ENABLED']) assert.equal(process.env[key],'true'); for(const key of ['LASTFM_CONNECTION_ENABLED','LASTFM_SYNC_ENABLED','LASTFM_DISCOVERY_ENABLED','LASTFM_DEEP_SWEEP_ENABLED','LISTENING_AUTO_DIARY_ENABLED','TRACKLIST_ENRICHMENT_ENABLED','COMMUNITY_SUBMISSIONS_ENABLED']) assert.equal(process.env[key],'false'); assert.equal(process.env.MODERATOR_USER_IDS,'user_test'); assert.equal(process.env.LASTFM_PILOT_USER_IDS,'user_test'); exports.app={listen:(port,host,cb)=>net.createServer().listen(port,host,cb)}; exports.startServer=async({listen})=>{listen(Number(process.env.PORT),()=>console.log('mock-api-ready'));};`);
  fs.writeFileSync(path.join(viteDir, 'vite.js'), `const net=require('node:net'); const port=Number(process.argv[process.argv.indexOf('--port')+1]); if(process.env.MONGO_URI||process.env.CLERK_SECRET_KEY||process.env.MODERATOR_USER_IDS||process.env.LASTFM_PILOT_USER_IDS) process.exit(9); net.createServer().listen(port,'127.0.0.1',()=>console.log('mock-vite-ready'));`);
  const configured = profile(); configured.preview = { listeningPilotUserIds: ['user_test'], moderatorUserIds: ['user_test'] };
  const p = path.join(f.dir, 'profile.json'); fs.writeFileSync(p, JSON.stringify(configured), { mode: 0o600 });
  const child = spawn(process.execPath, [cli, 'start', '--profile', p], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  const finished = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  await waitFor(() => output.includes('mock-api-ready') && output.includes('mock-vite-ready'));
  assert.equal(fs.existsSync(wt.runPath(f.child)), true);
  child.kill('SIGINT'); const [code] = await finished;
  assert.equal(code, 0, output); assert.equal(fs.existsSync(wt.runPath(f.child)), false);
  assert.equal(await wt.pairFree(f.state.apiPort, f.state.webPort), true);
  assert.equal(output.includes('sk_test_fixture'), false);
  assert.equal(output.includes('user_test'), false);
});
test('argument parser rejects unknown options and missing values', () => {
  assert.throws(() => wt.parseArgs(['start', '--profile']), /Missing/);
  assert.throws(() => wt.parseArgs(['--force']), /Unknown/);
});
test('removal refuses an occupied port even without a run marker and never signals its owner', async (t) => {
  const f = await childTree(t); const server = net.createServer();
  server.listen(f.state.apiPort, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  await assert.rejects(wt.remove(f.ctx, f.state.root, 'main'), /port is occupied/);
  assert.equal(server.listening, true); assert.equal(fs.existsSync(f.state.root), true);
});
test('a failed app stops its paired mock app and releases the run marker', async (t) => {
  const f = await childTree(t); const root = f.state.root;
  fs.mkdirSync(path.join(root, 'node_modules/express'), { recursive: true });
  const viteDir = path.join(root, 'frontend/node_modules/vite/bin'); fs.mkdirSync(viteDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'server.js'), `exports.app={}; exports.startServer=async()=>{throw new Error('DO_NOT_LEAK_CONNECTION_SECRET')};`);
  fs.writeFileSync(path.join(viteDir, 'vite.js'), `require('node:net').createServer().listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`);
  const p = path.join(f.dir, 'profile.json'); fs.writeFileSync(p, JSON.stringify(profile()), { mode: 0o600 });
  const child = spawn(process.execPath, [cli, 'start', '--profile', p], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1); assert.equal(output.includes('DO_NOT_LEAK_CONNECTION_SECRET'), false);
  assert.equal(fs.existsSync(wt.runPath(f.child)), false); assert.equal(await wt.pairFree(f.state.apiPort, f.state.webPort), true);
});
