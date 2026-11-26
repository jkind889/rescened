const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
const createPath = '/suggestions/new';
const A = '83096042-3785-481e-8843-dee69f1aad12';
const B = 'ae115ca1-d7c5-45b6-a1b6-ff6d9c031824';
const suggestion = (mbid) => `${createPath}?mbid=${mbid}`;
const searchWithFilters = '/search?q=album&view=list';
const protectedPaths = [
  '/notifications', '/viewreviews', '/suggestions', '/suggestions/123/revise',
  '/moderation/album-suggestions', '/account/edit',
];

const authFixture = `
import React, { cloneElement, useSyncExternalStore } from 'react';

const getToken = async () => 'fixture-token';
const listeners = new Set();
let auth = { isLoaded: false, isSignedIn: undefined, userId: undefined, getToken };
const closedModals = { 'sign-in': null, 'sign-up': null };
let modals = closedModals;
const record = (action, props) => {
  const { pathname, search, hash } = window.location;
  window.fixture.authEvents.push({ action, props, path: pathname + search + hash });
};
const notify = () => listeners.forEach((listener) => listener());
function setAuth(isSignedIn) {
  auth = { isLoaded: true, isSignedIn, userId: isSignedIn ? 'fixture-user' : null, getToken };
  modals = closedModals;
  notify();
}
window.fixture = { load: setAuth, authEvents: [] };
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const useAuth = () => useSyncExternalStore(subscribe, () => auth);
export function Show({ when, children }) {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && isSignedIn === (when === 'signed-in') ? children : null;
}
function open(kind, props) {
  record('open-' + kind, props);
  modals = { ...modals, [kind]: props };
  notify();
}
function close(kind) {
  record('close-' + kind);
  if (modals[kind]) {
    modals = { ...modals, [kind]: null };
    notify();
  }
}
const clerk = {
  openSignIn: (props) => open('sign-in', props),
  openSignUp: (props) => open('sign-up', props),
  closeSignIn: () => close('sign-in'),
  closeSignUp: () => close('sign-up'),
};
export const useClerk = () => clerk;
export function SignInButton({ children, mode, ...props }) {
  if (mode !== 'modal') throw new Error('Expected modal sign-in');
  return cloneElement(children, { onClick: () => clerk.openSignIn(props) });
}
export function SignUpButton({ children, mode, ...props }) {
  if (mode !== 'modal') throw new Error('Expected modal sign-up');
  return cloneElement(children, { onClick: () => clerk.openSignUp(props) });
}
export function UserButton() { return <button type="button">Fixture account</button>; }

export function AuthModals() {
  const openModals = useSyncExternalStore(subscribe, () => modals);
  return Object.entries(openModals).map(([kind, props]) => props && <AuthModal key={kind} kind={kind} props={props} />);
}

function AuthModal({ kind, props }) {
  function finish(outcome, callback = false) {
    const sameFlow = kind === outcome;
    const prefix = outcome === 'sign-in' ? 'signIn' : 'signUp';
    const forced = sameFlow ? props.forceRedirectUrl : props[prefix + 'ForceRedirectUrl'];
    // Simulate a Clerk instance with a forced default home destination.
    const destination = forced || '/';
    if (callback) {
      window.location.assign('/fixture-auth-callback?' + new URLSearchParams({ redirect: destination }));
    } else {
      setAuth(true);
      if (window.location.pathname + window.location.search !== destination) {
        window.location.assign(destination);
      }
    }
  }
  return <div role="dialog" aria-label={kind === 'sign-in' ? 'Fixture sign-in' : 'Fixture sign-up'}>
    <button onClick={() => close(kind)}>Dismiss</button>
    {kind === 'sign-in' ? <>
      <button onClick={() => finish('sign-in')}>Complete sign in</button>
      <button onClick={() => finish('sign-up', true)}>Continue with provider as new user</button>
    </> : <button onClick={() => finish('sign-up', true)}>Complete sign up with provider</button>}
  </div>;
}
`;

function fixtureEntry(frontend) {
  const fromApp = (file) => JSON.stringify(path.join(frontend, 'src', file));
  const styles = ['reset.css', 'index.css', 'App.css'].map((file) => `import ${fromApp(file)};`).join('\n');
  return `
import React, { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthModals } from './auth.jsx';
import ExternalAlbumCard from ${fromApp('Components/ExternalAlbumCard.jsx')};
import ProtectedRoute from ${fromApp('Components/ProtectedRoute.jsx')};
import Navbar from ${fromApp('Components/Navbar.jsx')};
import SuggestionEditor from ${fromApp('Pages/SuggestionEditor.jsx')};
${styles}

const albums = [
  { externalId: '${A}', title: 'Release group A', artistDisplayName: 'Fixture Artist', releaseType: 'album' },
  { externalId: '${B}', title: 'Release group B', artistDisplayName: 'Fixture Artist', releaseType: 'album' },
];
const takenPaths = [];
const requests = [];
const deferred = [];
const fixture = Object.assign(window.fixture, {
  takenPaths, requests, hold: '', fail: '',
  release: () => deferred.splice(0).forEach((respond) => respond()),
});
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
window.fetch = async (input, { signal } = {}) => {
  const { pathname } = new URL(input);
  if (pathname === '/notifications/unread-count') return json({ unreadCount: 0 });
  if (pathname === '/moderation/album-suggestions/access') return json({ moderator: false });
  if (pathname.endsWith('/capabilities')) return json({ enabled: false });
  const album = albums.find(({ externalId }) => pathname === '/search/musicbrainz/release-group/' + externalId);
  if (!album) throw new Error('Unexpected fixture request: ' + pathname);

  const { externalId, ...metadata } = album;
  const request = { externalId, aborted: false };
  requests.push(request);
  signal?.addEventListener('abort', () => { request.aborted = true; });
  // Let the obsolete response complete after abort, so ignoring it is tested.
  if (fixture.hold === externalId) await new Promise((respond) => deferred.push(respond));
  if (fixture.fail === externalId) return json({ error: 'Fixture prefill unavailable' }, 503);
  return json({
    proposedMetadata: metadata,
    externalReferences: [{ provider: 'musicbrainz', entityType: 'release-group', externalId }],
  });
};

function Shell() {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    takenPaths.push(pathname + search + hash);
    fixture.navigate = navigate;
  }, [navigate, pathname, search, hash]);
  return <div className="app-shell">
    <Navbar />
    <main>
      <Routes>
        <Route path="/" element={<h1>Fixture home</h1>} />
        <Route path="/search" element={<section><h1>Fixture search</h1>{albums.map((candidate) =>
          <ExternalAlbumCard key={candidate.externalId} candidate={candidate} />
        )}</section>} />
        <Route path="${createPath}" element={<ProtectedRoute preserveSuggestionReturn><SuggestionEditor /></ProtectedRoute>} />
        {${JSON.stringify(protectedPaths)}.map((path) =>
          <Route key={path} path={path} element={<ProtectedRoute><h1>Protected content</h1></ProtectedRoute>} />
        )}
      </Routes>
    </main>
    <AuthModals />
  </div>;
}

if (window.location.pathname === '/fixture-auth-callback') {
  const redirect = new URLSearchParams(window.location.search).get('redirect');
  sessionStorage.setItem('fixture-callback', redirect);
  window.location.replace(redirect);
} else {
  if (sessionStorage.getItem('fixture-callback')) fixture.load(true);
  const app = <BrowserRouter><Shell /></BrowserRouter>;
  createRoot(document.getElementById('root')).render(window.fixtureStrictMode === false ? app : <StrictMode>{app}</StrictMode>);
}
`;
}

test('suggestion sign-in returns to the selected release group', {
  skip: enabled ? false : 'Run npm run test:browser', timeout: 120000,
}, async (t) => {
  const { chromium } = require('./browser-support/chromium');
  const { createFixtureServer } = require('./browser-support/server');
  const frontend = path.resolve(__dirname, '../frontend');
  const resolve = createRequire(path.join(frontend, 'package.json'));
  const { default: react } = await import(pathToFileURL(resolve.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-suggestion-return-'));
  let server;
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      await server?.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  await Promise.all([
    fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Suggestion return fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>'),
    fs.writeFile(path.join(directory, 'auth.jsx'), authFixture),
    fs.writeFile(path.join(directory, 'entry.jsx'), fixtureEntry(frontend)),
  ]);
  server = await createFixtureServer({
    configFile: false, root: directory, envDir: false, plugins: [react()],
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
    resolve: { alias: {
      '@clerk/react': path.join(directory, 'auth.jsx'),
      ...Object.fromEntries(['react', 'react-dom', 'react-router-dom'].map((name) => [name, path.dirname(resolve.resolve(`${name}/package.json`))])),
    } },
    server: { watch: null, fs: { allow: [directory, frontend, await fs.realpath(path.join(frontend, 'node_modules'))] } },
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });

  async function newPage(t, viewport = { width: 1280, height: 800 }) {
    const page = await browser.newPage({ viewport });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    t.after(async () => {
      await page.context().close();
      assert.deepEqual(errors, []);
    });
    return page;
  }

  async function visit(page, target, signedIn) {
    await page.goto(base + target);
    await page.waitForFunction(() => window.fixture?.takenPaths?.length);
    assert.equal(new URL(page.url()).pathname, new URL(base + target).pathname, 'URL stays put while auth loads');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.evaluate((value) => window.fixture.load(value), signedIn);
  }

  async function expectModal(page, target, kind = 'sign-in', count = 1) {
    await page.waitForURL(base + target);
    const modal = page.getByRole('dialog', { name: `Fixture ${kind}` });
    await modal.waitFor();
    const opens = await page.evaluate(() => window.fixture.authEvents.filter(({ action }) => action.startsWith('open-')));
    assert.equal(opens.length, count, 'only the expected modal opens, including under StrictMode');
    const other = kind === 'sign-in' ? 'signUp' : 'signIn';
    assert.deepEqual(opens.at(-1), {
      action: 'open-' + kind, path: target,
      props: { forceRedirectUrl: target, fallbackRedirectUrl: target, [other + 'ForceRedirectUrl']: target, [other + 'FallbackRedirectUrl']: target },
    });
    return modal;
  }

  async function expectEditor(page, mbid) {
    const target = mbid ? suggestion(mbid) : createPath;
    await page.waitForURL(base + target);
    await page.getByRole('heading', { name: 'Suggest an album', exact: true }).waitFor();
    const title = page.getByRole('textbox', { name: 'Release title *' });
    await title.waitFor();
    assert.equal(await title.inputValue(), mbid === A ? 'Release group A' : mbid === B ? 'Release group B' : '');
    if (mbid) assert.equal(await page.getByRole('textbox', { name: 'External ID *' }).inputValue(), mbid);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.ok((await page.evaluate(() => window.fixture.takenPaths)).every((url) => url !== '/'));
  }

  const searchCard = (page, label) => page.locator('article.external-album-card').filter({ hasText: label }).getByRole('link', { name: 'Suggest this album' });
  const gate = (page) => page.locator('.suggestion-editor-blocked');
  const opens = (page) => page.evaluate(() => window.fixture.authEvents.filter(({ action }) => action.startsWith('open-')));

  await t.test('the signed-out card opens sign-in once and prefills the exact selected album', async (t) => {
    const page = await newPage(t);
    await visit(page, '/search', false);
    assert.equal(await page.getByRole('link', { name: 'Suggest this album' }).count(), 2);
    await searchCard(page, 'Release group A').click();
    const modal = await expectModal(page, suggestion(A));
    await modal.getByRole('button', { name: 'Complete sign in' }).click();
    await expectEditor(page, A);
    assert.deepEqual(await page.evaluate(() => [...new Set(window.fixture.requests.map(({ externalId }) => externalId))]), [A]);
  });

  await t.test('gate sign-up from a direct visit returns through a full-page callback to B', async (t) => {
    const page = await newPage(t);
    await visit(page, suggestion(B), false);
    await (await expectModal(page, suggestion(B))).getByRole('button', { name: 'Dismiss' }).click();
    await gate(page).getByRole('button', { name: 'Sign up' }).click();
    const modal = await expectModal(page, suggestion(B), 'sign-up', 2);
    await modal.getByRole('button', { name: 'Complete sign up with provider' }).click();
    await expectEditor(page, B);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('fixture-callback')), suggestion(B));
  });

  await t.test('sign-in can become sign-up during a provider callback', async (t) => {
    const page = await newPage(t);
    await visit(page, suggestion(B), false);
    const modal = await expectModal(page, suggestion(B));
    await modal.getByRole('button', { name: 'Continue with provider as new user' }).click();
    await expectEditor(page, B);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('fixture-callback')), suggestion(B));
  });

  for (const source of ['gate', 'Navbar']) {
    await t.test(`dismissal allows signing in again from the ${source}`, async (t) => {
      const page = await newPage(t);
      await visit(page, suggestion(A), false);
      await (await expectModal(page, suggestion(A))).getByRole('button', { name: 'Dismiss' }).click();
      await page.getByRole('heading', { name: 'Sign in to suggest an album' }).waitFor();
      const area = source === 'gate' ? gate(page) : page.getByRole('navigation', { name: 'Main' });
      await area.getByRole('button', { name: 'Sign in', exact: true }).click();
      const modal = await expectModal(page, suggestion(A), 'sign-in', 2);
      await modal.getByRole('button', { name: 'Complete sign in' }).click();
      await expectEditor(page, A);
    });
  }

  await t.test('a direct visit without an MBID opens a blank editor after sign-in', async (t) => {
    const page = await newPage(t);
    await visit(page, createPath, false);
    const modal = await expectModal(page, createPath);
    await modal.getByRole('button', { name: 'Complete sign in' }).click();
    await expectEditor(page, '');
    assert.deepEqual(await page.evaluate(() => window.fixture.requests), []);
  });

  await t.test('canonicalization discards extra parameters, hashes, and invalid or duplicate MBIDs before Clerk opens', async (t) => {
    const page = await newPage(t);
    for (const [input, expected] of [
      [`${suggestion(A.toUpperCase())}&next=https://evil.com&sign_in_force_redirect_url=https://evil.com#untrusted`, suggestion(A)],
      [`${suggestion('invalid')}&redirect=https://evil.com#untrusted`, createPath],
      [`${suggestion(A)}&mbid=${B}`, createPath],
    ]) {
      await visit(page, input, false);
      await expectModal(page, expected);
    }
  });

  await t.test('signed-in direct and card visits wait for auth without opening a modal', async (t) => {
    const page = await newPage(t);
    await visit(page, suggestion(B), true);
    await expectEditor(page, B);
    assert.deepEqual(await opens(page), []);

    await visit(page, '/search', true);
    await searchCard(page, 'Release group A').click();
    await expectEditor(page, A);
    assert.deepEqual(await opens(page), []);
  });

  await t.test('losing a signed-in session on the editor leaves a prompt without auto-opening', async (t) => {
    const page = await newPage(t);
    await visit(page, suggestion(A), true);
    await expectEditor(page, A);
    await page.evaluate(() => window.fixture.load(false));
    await page.getByRole('heading', { name: 'Sign in to suggest an album' }).waitFor();
    await gate(page).getByRole('button', { name: 'Sign in', exact: true }).click();
    await expectModal(page, suggestion(A), 'sign-in', 1);
  });

  await t.test('other protected pages still go home without opening auth', async (t) => {
    const page = await newPage(t);
    for (const target of [...protectedPaths, createPath + '/']) {
      await visit(page, target, false);
      await page.getByRole('heading', { name: 'Fixture home' }).waitFor();
      assert.equal(page.url(), base + '/');
      assert.deepEqual(await opens(page), []);
    }
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(await opens(page), [{ action: 'open-sign-in', path: '/', props: {} }]);
  });

  await t.test('browser Back closes the modal and the search link works at 390px', async (t) => {
    const page = await newPage(t, { width: 390, height: 844 });
    await visit(page, searchWithFilters, false);
    await searchCard(page, 'Release group A').click();
    await expectModal(page, suggestion(A));
    const eventCount = await page.evaluate(() => window.fixture.authEvents.length);
    await page.goBack();
    await page.getByRole('heading', { name: 'Fixture search' }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.ok(await page.evaluate((index) => window.fixture.authEvents.slice(index).some(({ action }) => action === 'close-sign-in'), eventCount));

    await searchCard(page, 'Release group B').click();
    const modal = await expectModal(page, suggestion(B), 'sign-in', 2);
    await modal.getByRole('button', { name: 'Dismiss' }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole('link', { name: 'Back to search' }).click();
    await page.getByRole('heading', { name: 'Fixture search' }).waitFor();
    assert.equal(page.url(), base + searchWithFilters);
    assert.equal((await opens(page)).length, 2);
  });

  for (const strict of [true, false]) {
    await t.test(`browser Forward replaces the previous auth modal ${strict ? 'with' : 'without'} StrictMode`, async (t) => {
      const page = await newPage(t);
      if (!strict) await page.addInitScript(() => { window.fixtureStrictMode = false; });
      await visit(page, searchWithFilters, false);
      await searchCard(page, 'Release group A').click();
      await expectModal(page, suggestion(A));

      await page.goBack();
      await page.waitForURL(base + searchWithFilters);
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sign up', exact: true }).click();
      await page.getByRole('dialog', { name: 'Fixture sign-up' }).waitFor();
      assert.deepEqual((await opens(page)).at(-1), { action: 'open-sign-up', path: searchWithFilters, props: {} });

      await page.goForward();
      await expectModal(page, suggestion(A), 'sign-in', 3);
      assert.equal(await page.getByRole('dialog', { name: 'Fixture sign-up' }).count(), 0);
      assert.equal(await page.getByRole('dialog').count(), 1);
    });
  }

  await t.test('the back link retains search state when the suggestion URL is canonicalized', async (t) => {
    const page = await newPage(t);
    await visit(page, searchWithFilters, false);
    await page.evaluate(({ target, from }) => {
      window.fixture.navigate(target, { state: { backToSearch: from } });
    }, { target: `${suggestion(A)}&next=/unrelated#extra`, from: searchWithFilters });
    const modal = await expectModal(page, suggestion(A));
    await modal.getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('link', { name: 'Back to search' }).click();
    await page.waitForURL(base + searchWithFilters);
  });

  await t.test('the back link from a direct suggestion visit opens Search', async (t) => {
    const page = await newPage(t);
    await visit(page, suggestion(A), false);
    const modal = await expectModal(page, suggestion(A));
    await modal.getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('link', { name: 'Back to search' }).click();
    await page.waitForURL(base + '/search');
  });

  await t.test('switching release groups aborts obsolete prefill and ignores its late response', async (t) => {
    const page = await newPage(t);
    await visit(page, '/search', true);
    await page.evaluate((id) => { window.fixture.hold = id; }, A);
    await searchCard(page, 'Release group A').click();
    await page.getByText('Preparing MusicBrainz release group…').waitFor();
    await page.waitForFunction((id) => window.fixture.requests.some(({ externalId, aborted }) => externalId === id && !aborted), A);
    await page.evaluate((target) => window.fixture.navigate(target), suggestion(B));
    await expectEditor(page, B);
    assert.equal(await page.evaluate((id) => window.fixture.requests.filter(({ externalId }) => externalId === id).every(({ aborted }) => aborted), A), true);
    await page.evaluate(async () => {
      window.fixture.release();
      await new Promise((next) => requestAnimationFrame(() => requestAnimationFrame(next)));
    });
    await expectEditor(page, B);
    assert.deepEqual(await opens(page), []);
  });

  await t.test('retrying an unavailable prefill after sign-in keeps the same release group', async (t) => {
    const page = await newPage(t);
    await visit(page, suggestion(A), false);
    const modal = await expectModal(page, suggestion(A));
    await page.evaluate((id) => { window.fixture.fail = id; }, A);
    await modal.getByRole('button', { name: 'Complete sign in' }).click();
    await page.getByRole('alert').filter({ hasText: 'Fixture prefill unavailable' }).waitFor();
    await page.evaluate(() => { window.fixture.fail = ''; });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectEditor(page, A);
    assert.equal((await opens(page)).length, 1);
  });
});
