#!/usr/bin/env node
// Local Git/process lifecycle only. No database, provider, deployment, or credential-copy operations.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const DISABLED = [
  'LASTFM_CONNECTION_ENABLED', 'LASTFM_SYNC_ENABLED', 'LASTFM_DISCOVERY_ENABLED',
  'LASTFM_DEEP_SWEEP_ENABLED', 'LISTENING_AUTO_DIARY_ENABLED', 'LISTENING_DETECTION_ENABLED',
  'ALBUM_MAPPING_MODERATION_ENABLED', 'TRACKLIST_ENRICHMENT_ENABLED',
  'TRACKLIST_BASELINE_MODERATION_ENABLED', 'EXTERNAL_ALBUM_SEARCH_ENABLED',
  'COMMUNITY_SUBMISSIONS_ENABLED', 'COMMUNITY_MODERATION_ENABLED', 'GENRES_ENABLED',
  'DATA_EXPORT_ENABLED', 'REVIEW_COMMENTS_ENABLED', 'REVIEW_EPISODES_ENABLED',
  'REVIEW_EFFORT_TIMER_ENABLED', 'SHARE_PREVIEWS_ENABLED', 'CONTRIBUTOR_EDITIONS_ENABLED',
];
const fail = (message) => { throw new Error(message); };
function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { fail(`Git operation failed: ${args[0]}. Inspect the checkout; nothing was force-removed.`); }
}
function context(cwd = process.cwd()) {
  const root = fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
  const common = fs.realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const gitDir = fs.realpathSync(git(root, ['rev-parse', '--absolute-git-dir']));
  return { root, common, gitDir, store: path.join(common, 'rescened-worktrees'), id: crypto.createHash('sha256').update(root).digest('hex').slice(0, 24) };
}
function statePath(ctx) { return path.join(ctx.store, `${ctx.id}.json`); }
function runPath(ctx) { return path.join(ctx.store, `${ctx.id}.running`); }
function readState(ctx) {
  const s = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8'));
  if (s.version !== 1 || s.root !== ctx.root || s.gitDir !== ctx.gitDir || s.id !== ctx.id ||
      !Number.isInteger(s.slot) || s.slot < 0 || s.slot >= 100 || s.apiPort !== 3100 + s.slot || s.webPort !== 5200 + s.slot) fail('Worktree metadata does not match this checkout. Inspect it before proceeding.');
  return s;
}
async function locked(ctx, fn) {
  fs.mkdirSync(ctx.store, { recursive: true });
  const lock = path.join(ctx.store, 'registry.lock');
  try { fs.mkdirSync(lock); } catch { fail('Worktree registry is locked. Wait for the other command; inspect an abandoned lock manually.'); }
  try { return await fn(); } finally { fs.rmdirSync(lock); }
}
function requireLinked(ctx) {
  if (ctx.gitDir === ctx.common) fail('Use a linked worktree, not the primary checkout. Run create first.');
}
function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL'));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}
async function pairFree(apiPort, webPort) {
  for (const port of [apiPort, webPort]) for (const host of ['127.0.0.1', '::1']) if (!await portFree(port, host)) return false;
  return true;
}
async function setup(ctx) {
  requireLinked(ctx);
  return locked(ctx, async () => {
    if (fs.existsSync(statePath(ctx))) return readState(ctx);
    const entries = fs.readdirSync(ctx.store).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(ctx.store, f), 'utf8')));
    const reserved = new Set(entries.flatMap((s) => [s.apiPort, s.webPort]));
    for (let slot = 0; slot < 100; slot++) {
      const apiPort = 3100 + slot, webPort = 5200 + slot;
      if (reserved.has(apiPort) || reserved.has(webPort) || !await pairFree(apiPort, webPort)) continue;
      const s = { version: 1, id: ctx.id, root: ctx.root, gitDir: ctx.gitDir, slot, apiPort, webPort, databaseMode: 'shared-development', workers: false };
      fs.writeFileSync(statePath(ctx), `${JSON.stringify(s, null, 2)}\n`, { flag: 'wx' });
      return s;
    }
    fail('No free port pair in API 3100–3199 / frontend 5200–5299.');
  });
}
function validateProfile(p) {
  if (!p || Array.isArray(p) || typeof p !== 'object') fail('Development profile must be an object.');
  const allowed = ['environment', 'database', 'mongoHost', 'server', 'preview'];
  if (Object.keys(p).some((k) => !allowed.includes(k)) || p.environment !== 'shared-development') fail('Only an explicit shared-development profile is accepted.');
  if (!/^rescened_dev(?:_[a-z0-9]+)*$/.test(p.database || '')) fail('Database must be rescened_dev or a rescened_dev_ prefixed development name.');
  if (typeof p.mongoHost !== 'string' || !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(p.mongoHost)) fail('Pin one development Mongo host (and port, if used).');
  const serverKeys = ['MONGO_URI', 'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'];
  if (!p.server || Array.isArray(p.server) || typeof p.server !== 'object' || Object.keys(p.server).some((k) => !serverKeys.includes(k)) || serverKeys.some((k) => typeof p.server[k] !== 'string' || !p.server[k])) fail('Profile server settings must contain only MONGO_URI, CLERK_SECRET_KEY, and CLERK_PUBLISHABLE_KEY.');
  // Do not reflect parser errors or credential-bearing input into logs.
  let uri;
  try { uri = new URL(p.server.MONGO_URI); } catch { fail('Invalid development Mongo URI.'); }
  if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol) || uri.host !== p.mongoHost || uri.pathname !== `/${p.database}` || uri.hash) fail('Mongo URI must exactly match the pinned development host and database.');
  for (const [key, value] of uri.searchParams) {
    if (!['retryWrites', 'w', 'authSource', 'replicaSet', 'appName', 'tls'].includes(key) || (key === 'tls' && value !== 'true')) fail('Mongo URI contains an unsupported or unsafe option.');
  }
  if (!/^sk_test_[A-Za-z0-9_-]+$/.test(p.server.CLERK_SECRET_KEY) || !/^pk_test_[A-Za-z0-9_-]+$/.test(p.server.CLERK_PUBLISHABLE_KEY)) fail('Use Clerk test keys, never live keys.');
  if (p.preview !== undefined) {
    const keys = ['listeningPilotUserIds', 'moderatorUserIds'];
    if (!p.preview || Array.isArray(p.preview) || typeof p.preview !== 'object' || Object.keys(p.preview).some((key) => !keys.includes(key))) fail('Preview accepts only listeningPilotUserIds and moderatorUserIds.');
    for (const key of keys) {
      const ids = p.preview[key] === undefined ? [] : p.preview[key];
      if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string' || id.length > 128 || id.trim() !== id || !/^user_[A-Za-z0-9]+$/.test(id)) || new Set(ids).size !== ids.length) fail('Preview allowlists must contain at most 100 unique Clerk test user IDs, without spaces or wildcards.');
    }
  }
  return p;
}
function loadProfile(filename, ctx) {
  if (!filename || !path.isAbsolute(filename)) fail('Pass --profile with an absolute path to an approved development-only JSON file outside the repository.');
  const real = fs.realpathSync(filename);
  // Reject profiles in any checkout of this repository, including the primary.
  const roots = git(ctx.root, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  if (roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) fail('Keep the development profile outside every checkout.');
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) fail('Profile must be a private file (chmod 600), at most 16 KiB.');
  let p;
  try { p = JSON.parse(fs.readFileSync(real, 'utf8')); } catch { fail('Could not parse development profile JSON.'); }
  return validateProfile(p);
}
function buildEnvironments(profile, state, inherited = process.env) {
  validateProfile(profile);
  const base = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM']) if (inherited[key]) base[key] = inherited[key];
  const frontendOrigin = `http://127.0.0.1:${state.webPort}`;
  const pilots = profile.preview?.listeningPilotUserIds || [];
  const moderators = profile.preview?.moderatorUserIds || [];
  const backend = { ...base, ...Object.fromEntries(DISABLED.map((key) => [key, 'false'])), ...profile.server,
    NODE_ENV: 'development', PORT: String(state.apiPort), CORS_ALLOWED_ORIGINS: frontendOrigin,
    FRONTEND_URL: frontendOrigin, TRUST_PROXY_HOPS: '0', DOTENV_CONFIG_QUIET: 'true',
    LASTFM_PILOT_USER_IDS: pilots.join(','), MODERATOR_USER_IDS: moderators.join(','),
    LISTENING_DETECTION_ENABLED: String(pilots.length > 0),
    COMMUNITY_MODERATION_ENABLED: String(moderators.length > 0),
    ALBUM_MAPPING_MODERATION_ENABLED: String(moderators.length > 0),
    TRACKLIST_BASELINE_MODERATION_ENABLED: String(moderators.length > 0) };
  const frontend = { ...base, NODE_ENV: 'development', VITE_API_URL: `http://127.0.0.1:${state.apiPort}`, VITE_CLERK_PUBLISHABLE_KEY: profile.server.CLERK_PUBLISHABLE_KEY };
  return { backend, frontend };
}
function rejectEnvFiles(root) {
  for (const dir of [root, path.join(root, 'frontend')]) {
    const files = fs.readdirSync(dir).filter((f) => /^\.env(?:$|\.)/.test(f) && !/\.(example|sample|template)$/.test(f));
    if (files.length) fail('This worktree contains dotenv files. Preserve/move them yourself before using the isolated profile launcher. No files were overwritten.');
  }
}
function display(state) {
  console.log(`Worktree: ${state.root}\nDatabase: shared development\nAPI: http://127.0.0.1:${state.apiPort}\nFrontend: http://127.0.0.1:${state.webPort}\nWorkers/providers: off`);
}
async function start(ctx, profilePath) {
  requireLinked(ctx);
  const state = readState(ctx);
  rejectEnvFiles(ctx.root);
  const profile = loadProfile(profilePath, ctx);
  const envs = buildEnvironments(profile, state);
  const vite = path.join(ctx.root, 'frontend/node_modules/vite/bin/vite.js');
  if (!fs.existsSync(path.join(ctx.root, 'node_modules/express')) || !fs.existsSync(vite)) fail('Install each package first: npm ci && npm --prefix frontend ci.');
  await locked(ctx, async () => {
    if (!await pairFree(state.apiPort, state.webPort)) fail('A reserved port is occupied. Nothing was stopped; inspect the conflicting process.');
    try { fs.writeFileSync(runPath(ctx), JSON.stringify({ pid: process.pid, root: ctx.root, started: new Date().toISOString() }), { flag: 'wx' }); }
    catch { fail('A run marker already exists. Stop the owning terminal, or inspect an abandoned run before removing its marker manually.'); }
  });
  const children = [];
  let stopping = false;
  let failure = false;
  let escalator;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // ChildProcess handles belong to this exact invocation. Never kill a saved PID or a port owner.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    escalator = setTimeout(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    escalator.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    display(state);
    console.log(`Detection pilots: ${profile.preview?.listeningPilotUserIds?.length || 0}; moderators with approval access: ${profile.preview?.moderatorUserIds?.length || 0}.`);
    console.log('Starting API + Vite only. Ctrl+C stops this pair. Shared development writes persist after worktree removal.');
    const specs = [
      { args: [path.join(__dirname, 'worktree-server.cjs'), path.join(ctx.root, 'server.js')], cwd: ctx.root, env: envs.backend },
      { args: [vite, '--host', '127.0.0.1', '--port', String(state.webPort), '--strictPort'], cwd: path.join(ctx.root, 'frontend'), env: envs.frontend },
    ];
    const completions = specs.map((spec) => new Promise((resolve) => {
      const child = spawn(process.execPath, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'inherit' });
      children.push(child);
      child.once('error', () => { failure = true; stop(); resolve(); });
      child.once('exit', (code) => { if (!stopping) { failure = code !== 0; stop(); } resolve(); });
    }));
    await Promise.all(completions);
  } finally {
    clearTimeout(escalator);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    fs.unlinkSync(runPath(ctx));
  }
  if (failure) fail('One app exited unexpectedly. Its paired process was stopped.');
}
function defaultCreateBase(ctx) {
  let configured;
  try { configured = execFileSync('git', ['-C', ctx.root, 'config', '--local', '--get-all', 'rescened.worktreeBase'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) {
    if (error.status === 1) return 'origin/main';
    fail('Could not read the repository-local worktree base. Inspect Git configuration.');
  }
  if (!configured || /[\r\n\0]/.test(configured)) fail('Configure exactly one nonempty rescened.worktreeBase value.');
  return configured;
}
async function create(ctx, name, base) {
  if (!/^[a-z][a-z0-9-]{0,59}$/.test(name || '')) fail('Use a short lowercase worktree name containing letters, digits, and hyphens.');
  if (base === undefined) base = defaultCreateBase(ctx);
  const primary = git(ctx.root, ['worktree', 'list', '--porcelain']).split('\n')[0].slice(9);
  const destination = path.join(path.dirname(primary), 'rescened-worktrees', name);
  const commit = git(ctx.root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
  if (fs.existsSync(destination)) fail('Destination already exists; it was not changed.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  git(ctx.root, ['worktree', 'add', '--no-track', '-b', `work/${name}`, destination, commit]);
  console.log(`Created work/${name} from ${base} (${commit.slice(0, 12)}). No fetch, installs, secrets, or services were run.`);
  return setup(context(destination));
}
async function remove(ctx, target, base = 'origin/main', discardGenerated = false) {
  if (!target || !path.isAbsolute(target)) fail('Pass the absolute worktree path to remove.');
  const victim = context(target);
  if (fs.realpathSync(target) !== victim.root) fail('Pass the exact worktree root, not a subdirectory.');
  requireLinked(victim);
  if (victim.common !== ctx.common) fail('Target belongs to a different repository.');
  if (process.cwd() === victim.root || process.cwd().startsWith(`${victim.root}${path.sep}`)) fail('Run remove from a different checkout.');
  return locked(ctx, async () => {
    const state = readState(victim); // Only remove a worktree explicitly enrolled with setup.
    if (fs.existsSync(runPath(victim))) fail('Worktree has a run marker. Stop its owning terminal before cleanup.');
    if (!await pairFree(state.apiPort, state.webPort)) fail('A worktree port is occupied. Inspect and stop its exact owner before cleanup; nothing was signaled.');
    if (git(victim.root, ['status', '--porcelain=v1', '--untracked-files=all'])) fail('Refusing to remove a dirty worktree (including untracked files). Commit or preserve your work first.');
    const ignored = git(victim.root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    if (ignored.some((p) => !/^(node_modules\/|frontend\/node_modules\/|dist\/|frontend\/dist\/)/.test(p))) fail('Refusing to remove ignored user files (for example .env, data, or reports). Preserve them first.');
    if (ignored.length && !discardGenerated) fail('Generated dependencies/build output remain. Add --discard-generated to explicitly discard only node_modules and dist.');
    const baseCommit = git(ctx.root, ['rev-parse', '--verify', `${base}^{commit}`]);
    try { git(ctx.root, ['merge-base', '--is-ancestor', git(victim.root, ['rev-parse', 'HEAD']), baseCommit]); }
    catch { fail('Refusing to remove a worktree with commits not contained in the selected base. Merge/preserve them first; squash merges require manual review.'); }
    git(ctx.root, ['worktree', 'remove', victim.root]); // No --force; branch is deliberately retained.
    fs.unlinkSync(statePath(victim));
    console.log(`Removed ${victim.root}. Branch retained; shared database and profile untouched.`);
  });
}
function parseArgs(args) {
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--discard-generated') options.discardGenerated = true;
    else if (['--profile', '--base'].includes(args[i])) { const key = args[i].slice(2); if (options[key] || !args[i + 1] || args[i + 1].startsWith('--')) fail(`Missing or duplicate ${args[i]}.`); options[key] = args[++i]; }
    else if (args[i].startsWith('--')) fail(`Unknown option: ${args[i]}`);
    else positional.push(args[i]);
  }
  return { positional, options };
}
async function main(args = process.argv.slice(2)) {
  const { positional: [command, target, ...extra], options } = parseArgs(args);
  if (!command || command === 'help') {
    console.log('worktree create NAME [--base REF]\nworktree setup\nworktree status\nworktree start --profile /absolute/private/dev.json\nworktree remove /absolute/worktree [--base origin/main] [--discard-generated]\n\nCreate uses repository-local rescened.worktreeBase, otherwise origin/main.\nSee docs/WORKTREES.md. Setup never copies secrets or connects to a database.');
    return;
  }
  if (extra.length || (target && !['create', 'remove'].includes(command))) fail('Unexpected positional argument.');
  const allowedOptions = { create: ['base'], setup: [], status: [], start: ['profile'], remove: ['base', 'discardGenerated'] };
  if (allowedOptions[command] && Object.keys(options).some((key) => !allowedOptions[command].includes(key))) fail('Option is not supported by this command.');
  const ctx = context();
  if (command === 'create') display(await create(ctx, target, options.base));
  else if (command === 'setup') display(await setup(ctx));
  else if (command === 'status') { display(readState(ctx)); console.log(`Run marker: ${fs.existsSync(runPath(ctx)) ? 'present (inspect owning terminal)' : 'absent'}`); }
  else if (command === 'start') await start(ctx, options.profile);
  else if (command === 'remove') await remove(ctx, target, options.base, options.discardGenerated);
  else fail(`Unknown command: ${command}`);
}
if (require.main === module) main().catch((error) => { console.error(`Worktree: ${error.message}`); process.exitCode = 1; });
module.exports = { DISABLED, context, statePath, runPath, setup, defaultCreateBase, create, remove, validateProfile, loadProfile, buildEnvironments, rejectEnvFiles, pairFree, parseArgs, main };
