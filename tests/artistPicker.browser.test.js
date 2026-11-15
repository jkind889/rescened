// Explicit offline browser fixture for the shared artist picker. The real
// ArtistPicker renders in a synthetic shell with a stubbed Clerk hook and an
// in-page fetch stub: no API server, database, Clerk, or MusicBrainz.
// Responses are released by the test in any order, and can be delivered even
// after the picker aborted the request, so the request guard is exercised
// rather than relying on cancellation alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
const LOCAL_A = '11111111-1111-4111-8111-111111111111';
const LOCAL_B = '22222222-2222-4222-8222-222222222222';
const REGISTERED = '33333333-3333-4333-8333-333333333333';
const MBID_A = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const MBID_B = '83096042-3785-481e-8843-dee69f1aad12';

const LOCAL_NOVA = { query: 'Nova', results: [
  { artistId: LOCAL_A, name: 'Nova', artistMbid: MBID_A, match: null, releaseCount: 3, knownFor: ['Night Drive', 'Glass'] },
  { artistId: LOCAL_B, name: 'Nova', artistMbid: '', match: { name: 'NOVA', kind: 'credit' }, releaseCount: 0, knownFor: [] },
] };
const PROVIDER_NOVA = { query: 'Nova', provider: 'musicbrainz', candidates: [
  { kind: 'external', provider: 'musicbrainz', artistMbid: MBID_A, name: 'Nova', disambiguation: 'UK synth-pop band', type: 'Group', country: 'GB', registeredArtistId: REGISTERED },
  { kind: 'external', provider: 'musicbrainz', artistMbid: MBID_B, name: 'Nova', disambiguation: 'US rapper', type: 'Person', country: 'US', registeredArtistId: null },
  { kind: 'external', provider: 'musicbrainz', artistMbid: 'not-an-mbid', name: 'Broken row' },
] };

test('shared artist picker fixture', {
  skip: enabled ? false : 'Run npm run test:browser', timeout: 180000,
}, async (t) => {
  const { chromium } = require('./browser-support/chromium');
  const frontend = path.resolve(__dirname, '../frontend');
  const resolve = createRequire(path.join(frontend, 'package.json'));
  const { createFixtureServer } = require('./browser-support/server');
  const { default: react } = await import(pathToFileURL(resolve.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-artist-picker-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artist picker fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'auth.js'), `
import { useSyncExternalStore } from 'react';
const listeners = new Set();
let state = { isLoaded: true, isSignedIn: true, userId: 'user_fixture' };
const getToken = async () => 'fixture-token';
window.__setAuth = next => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export function useAuth() { return { ...useSyncExternalStore(subscribe, () => state), getToken }; }
`);
    await fs.writeFile(path.join(directory, 'entry.jsx'), `
import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
import ${JSON.stringify(path.join(frontend, 'src/reset.css'))}; import ${JSON.stringify(path.join(frontend, 'src/index.css'))}; import ${JSON.stringify(path.join(frontend, 'src/App.css'))};
import { ArtistPicker } from ${JSON.stringify(path.join(frontend, 'src/features/artists/ArtistPicker.jsx'))};

// In-page fetch stub. Each request waits until the test answers it. With
// ignoreAbort, an aborted request can still be answered later.
window.__requests = [];
window.__ignoreAbort = false;
window.fetch = (input, init = {}) => new Promise((resolvePromise, rejectPromise) => {
  const url = new URL(String(input));
  const entry = { path: url.pathname, q: url.searchParams.get('q'), auth: new Headers(init.headers).get('Authorization'), aborted: false, settled: false };
  entry.answer = (status, body, headers = {}) => {
    if (entry.settled) return false;
    entry.settled = true;
    resolvePromise(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
    return true;
  };
  init.signal?.addEventListener('abort', () => {
    entry.aborted = true;
    if (window.__ignoreAbort) return;
    entry.settled = true;
    rejectPromise(new DOMException('Aborted', 'AbortError'));
  });
  window.__requests.push(entry);
});
window.__answer = (index, status, body, headers) => window.__requests[index].answer(status, body, headers);

function Harness({ initialRows }) {
  const [rows, setRows] = useState(initialRows.map((name, index) => ({ key: 'row-' + index, creditName: name, selection: null })));
  const [generation, setGeneration] = useState(0);
  const [mounted, setMounted] = useState(true);
  window.__selections = rows.map(row => row.selection);
  if (!mounted) return <p>Left the page</p>;
  return (
    <main style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 760 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>Album credits</h1>
      {rows.map((row, index) => (
        <section key={row.key} aria-label={'Credit ' + (index + 1)} style={{ display: 'grid', gap: 8 }}>
          <p style={{ margin: 0 }}><strong>{row.creditName}</strong></p>
          <ArtistPicker key={row.key + '-' + generation} label={'Credit ' + (index + 1)} creditName={row.creditName} value={row.selection}
            onChange={selection => setRows(current => current.map(item => (item.key === row.key ? { ...item, selection } : item)))} />
          <button type="button" onClick={() => setRows(current => current.filter(item => item.key !== row.key))}>{'Remove credit ' + (index + 1)}</button>
        </section>
      ))}
      <button type="button" onClick={() => { setRows(current => current.map(item => ({ ...item, selection: null }))); setGeneration(value => value + 1); }}>Reset form</button>
      <button type="button" onClick={() => setMounted(false)}>Leave page</button>
    </main>
  );
}
const root = createRoot(document.getElementById('root'));
window.__mount = rows => root.render(<Harness initialRows={rows} />);
`);
    server = await createFixtureServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: { '@clerk/react': path.join(directory, 'auth.js'), ...Object.fromEntries(['react', 'react-dom'].map(name => [name, path.dirname(resolve.resolve(`${name}/package.json`))])) } },
      server: { hmr: false, watch: null, fs: { allow: [directory, frontend, require('node:fs').realpathSync(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function fixture(rows, run, viewport = { width: 1000, height: 900 }) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        await page.goto(url);
        await page.waitForFunction(() => typeof window.__mount === 'function');
        await page.evaluate(initial => window.__mount(initial), rows);
        await page.getByRole('button', { name: 'Search artists' }).first().waitFor();
        await run(page);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    const requests = page => page.evaluate(() => window.__requests.map(({ path: p, q, auth, aborted, settled }) => ({ path: p, q, auth, aborted, settled })));
    async function waitForRequests(page, count) {
      await page.waitForFunction(expected => window.__requests.length >= expected, count);
      return requests(page);
    }
    const indexOf = (list, pathname, q) => list.findIndex(entry => entry.path === pathname && entry.q === q && !entry.settled);
    async function answer(page, pathname, q, status, body, headers) {
      const list = await requests(page);
      const index = indexOf(list, pathname, q);
      assert.ok(index >= 0, `pending ${pathname}?q=${q}`);
      return page.evaluate(args => window.__answer(...args), [index, status, body, headers]);
    }
    const selections = page => page.evaluate(() => window.__selections);
    const credit = (page, n) => page.getByRole('region', { name: `Credit ${n}` });
    async function searchFor(page, n, text) {
      const section = credit(page, n);
      if (text !== undefined) await section.getByRole('searchbox', { name: 'Find the artist' }).fill(text);
      await section.getByRole('button', { name: 'Search artists' }).click();
    }
    async function settleUi(page) { await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => setTimeout(resolveFrame, 50)))); }

    await t.test('separated local and MusicBrainz results with explicit selection only', async () => {
      await fixture(['Nova (credited as N0VA)'], async page => {
        await searchFor(page, 1, 'Nova');
        const sent = await waitForRequests(page, 2);
        assert.deepEqual(sent.map(entry => [entry.path, entry.q, entry.auth]), [
          ['/artist-discovery/local', 'Nova', 'Bearer fixture-token'],
          ['/artist-discovery/musicbrainz', 'Nova', 'Bearer fixture-token'],
        ]);
        await answer(page, '/artist-discovery/local', 'Nova', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'Nova', 200, PROVIDER_NOVA);
        const local = page.getByRole('list', { name: 'Rescened artists' });
        const external = page.getByRole('list', { name: 'MusicBrainz artists' });
        await external.waitFor();
        assert.equal(await local.getByRole('listitem').count(), 2, 'same-name Rescened artists stay distinct');
        assert.equal(await external.getByRole('listitem').count(), 2, 'malformed provider rows are dropped');
        assert.match(await external.getByRole('listitem').first().textContent(), /already on Rescened/);
        assert.equal(await page.getByRole('link', { name: 'View Nova on MusicBrainz' }).first().getAttribute('href'), `https://musicbrainz.org/artist/${MBID_A}`);
        assert.deepEqual(await selections(page), [null], 'results never select anything by themselves');
        const description = await external.getByRole('listitem').nth(1).getByRole('button', { name: 'Choose Nova' })
          .evaluate(button => document.getElementById(button.getAttribute('aria-describedby'))?.textContent);
        assert.match(description, /US rapper/, 'same-name choices are told apart by their description');

        await external.getByRole('listitem').nth(1).getByRole('button', { name: 'Choose Nova' }).click();
        assert.deepEqual(await selections(page), [{ kind: 'musicbrainz', artistMbid: MBID_B, name: 'Nova', disambiguation: 'US rapper', type: 'Person', country: 'US' }]);
        await page.getByText('MusicBrainz artist, added when approved').waitFor();
        await page.getByText('The credit keeps its wording, “Nova (credited as N0VA)”.').waitFor();
        const remove = page.getByRole('button', { name: 'Remove link to Nova' });
        assert.equal(await remove.evaluate(element => element === document.activeElement), true, 'focus moves to the selection');
        await remove.click();
        assert.deepEqual(await selections(page), [null]);
        assert.equal(await page.getByRole('searchbox', { name: 'Find the artist' }).evaluate(element => element === document.activeElement), true, 'focus returns to search');
        await external.waitFor();

        await external.getByRole('listitem').first().getByRole('button', { name: 'Choose Nova' }).click();
        assert.deepEqual(await selections(page), [{ kind: 'existing', artistId: REGISTERED, name: 'Nova', artistMbid: MBID_A }], 'an exact registered MBID selects the Rescened artist');
        await page.getByRole('button', { name: 'Remove link to Nova' }).click();
        await local.getByRole('listitem').nth(1).getByRole('button', { name: 'Choose Nova' }).click();
        assert.deepEqual(await selections(page), [{ kind: 'existing', artistId: LOCAL_B, name: 'Nova', artistMbid: '' }]);
      });
    });

    await t.test('local results stay usable while MusicBrainz is throttled, with no automatic retry', async () => {
      await fixture(['Nova'], async page => {
        await searchFor(page, 1);
        await waitForRequests(page, 2);
        await answer(page, '/artist-discovery/musicbrainz', 'Nova', 503,
          { error: 'busy', code: 'ARTIST_DISCOVERY_THROTTLED', retryAfterSeconds: 9 }, { 'retry-after': '9' });
        await answer(page, '/artist-discovery/local', 'Nova', 200, LOCAL_NOVA);
        await page.getByText('MusicBrainz is busy. Try again in 9 seconds.').waitFor();
        assert.equal(await page.getByRole('list', { name: 'Rescened artists' }).getByRole('listitem').count(), 2);
        await settleUi(page);
        await page.waitForTimeout(300);
        assert.equal((await requests(page)).length, 2, 'the picker never retries by itself');

        await page.getByRole('button', { name: 'Try MusicBrainz again' }).click();
        const after = await waitForRequests(page, 3);
        assert.deepEqual(after.slice(2).map(entry => entry.path), ['/artist-discovery/musicbrainz'], 'retry asks MusicBrainz only');
        await answer(page, '/artist-discovery/musicbrainz', 'Nova', 502, { error: 'down', code: 'ARTIST_DISCOVERY_UNAVAILABLE' });
        await page.getByText('MusicBrainz is unavailable right now. Rescened results still work.').waitFor();
        assert.equal(await page.getByRole('list', { name: 'Rescened artists' }).getByRole('listitem').count(), 2, 'local results survive the provider retry');
      });
    });

    await t.test('empty, malformed, and local failure responses are reported per source', async () => {
      await fixture(['Nobody'], async page => {
        await searchFor(page, 1);
        await waitForRequests(page, 2);
        await answer(page, '/artist-discovery/local', 'Nobody', 500, { error: 'Failed to search Rescened artists' });
        await answer(page, '/artist-discovery/musicbrainz', 'Nobody', 200, 'not json');
        await page.getByText('Failed to search Rescened artists').waitFor();
        await page.getByText('MusicBrainz is unavailable right now. Rescened results still work.').waitFor();
        await searchFor(page, 1);
        await waitForRequests(page, 4);
        await answer(page, '/artist-discovery/local', 'Nobody', 200, { query: 'Nobody', results: [{ artistId: 'bad', name: 'Bad' }] });
        await answer(page, '/artist-discovery/musicbrainz', 'Nobody', 200, { candidates: [] });
        await page.getByText('No Rescened artists match.').waitFor();
        await page.getByText('No MusicBrainz artists match.').waitFor();
        assert.deepEqual(await selections(page), [null]);
      });
    });

    await t.test('stale responses never replace a newer search or a changed query', async () => {
      await fixture(['Nova'], async page => {
        await page.evaluate(() => { window.__ignoreAbort = true; });
        await searchFor(page, 1, 'Nova');
        await waitForRequests(page, 2);
        await searchFor(page, 1, 'Nova Twins');
        const sent = await waitForRequests(page, 4);
        assert.deepEqual(sent.slice(0, 2).map(entry => entry.aborted), [true, true], 'the older search was aborted');
        await answer(page, '/artist-discovery/local', 'Nova Twins', 200, { query: 'Nova Twins', results: [{ artistId: LOCAL_A, name: 'Nova Twins', releaseCount: 1, knownFor: [] }] });
        await answer(page, '/artist-discovery/musicbrainz', 'Nova Twins', 200, { candidates: [] });
        await answer(page, '/artist-discovery/local', 'Nova', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'Nova', 200, PROVIDER_NOVA);
        await settleUi(page);
        const names = await page.getByRole('list', { name: 'Rescened artists' }).getByRole('listitem').allTextContents();
        assert.equal(names.length, 1);
        assert.match(names[0], /Nova Twins/);
        assert.equal(await page.getByRole('list', { name: 'MusicBrainz artists' }).count(), 0, 'the late older provider answer is dropped');

        // Editing the query while a search is pending drops its answers.
        await searchFor(page, 1, 'Nova');
        await waitForRequests(page, 6);
        await credit(page, 1).getByRole('searchbox', { name: 'Find the artist' }).fill('Nova T');
        await answer(page, '/artist-discovery/local', 'Nova', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'Nova', 200, PROVIDER_NOVA);
        await settleUi(page);
        assert.equal(await page.getByRole('list', { name: 'MusicBrainz artists' }).count(), 0);
        assert.equal(await page.getByText('Searching for').count(), 0, 'no loading state is left behind');
        assert.equal(await page.getByText('Asking MusicBrainz…').count(), 0);
      });
    });

    await t.test('row removal, reset, navigation, and sign-out drop pending responses', async () => {
      await fixture(['First artist', 'Second artist'], async page => {
        await page.evaluate(() => { window.__ignoreAbort = true; });
        // Row removal: answers for a removed row cannot appear in another row.
        await searchFor(page, 2);
        await waitForRequests(page, 2);
        await page.getByRole('button', { name: 'Remove credit 2' }).click();
        assert.deepEqual((await requests(page)).map(entry => entry.aborted), [true, true]);
        await answer(page, '/artist-discovery/local', 'Second artist', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'Second artist', 200, PROVIDER_NOVA);
        await settleUi(page);
        assert.equal(await page.getByRole('list').count(), 0);
        assert.equal(await page.getByRole('region', { name: 'Credit 2' }).count(), 0);

        // Reset (the form remounts its pickers).
        await searchFor(page, 1);
        await waitForRequests(page, 4);
        await page.getByRole('button', { name: 'Reset form' }).click();
        await answer(page, '/artist-discovery/local', 'First artist', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'First artist', 200, PROVIDER_NOVA);
        await settleUi(page);
        assert.equal(await page.getByRole('list').count(), 0);
        assert.equal(await credit(page, 1).getByRole('searchbox', { name: 'Find the artist' }).inputValue(), 'First artist');

        // Sign-out unmounts the panel; a later sign-in starts fresh.
        await searchFor(page, 1, 'Signed out search');
        await waitForRequests(page, 6);
        await page.evaluate(() => window.__setAuth({ isSignedIn: false, userId: null }));
        await page.getByText('Sign in to link this credit to an artist.').waitFor();
        await answer(page, '/artist-discovery/local', 'Signed out search', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'Signed out search', 200, PROVIDER_NOVA);
        await page.evaluate(() => window.__setAuth({ isSignedIn: true, userId: 'user_other' }));
        await credit(page, 1).getByRole('searchbox', { name: 'Find the artist' }).waitFor();
        await settleUi(page);
        assert.equal(await page.getByRole('list').count(), 0, 'no results carried across accounts');

        // Navigation away.
        await searchFor(page, 1);
        await waitForRequests(page, 8);
        await page.getByRole('button', { name: 'Leave page' }).click();
        await answer(page, '/artist-discovery/local', 'First artist', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'First artist', 200, PROVIDER_NOVA);
        await settleUi(page);
        await page.getByText('Left the page').waitFor();
        assert.ok((await requests(page)).every(entry => entry.aborted), 'every pending request was aborted');
      });
    });

    await t.test('community fallback validates privately supplied links', async () => {
      await fixture(['Unknown Local Band'], async page => {
        await page.getByRole('button', { name: 'Not listed? Propose a new artist' }).click();
        const name = page.getByRole('textbox', { name: 'Artist name on Rescened' });
        assert.equal(await name.evaluate(element => element === document.activeElement), true);
        assert.equal(await name.inputValue(), 'Unknown Local Band', 'starts from the search text, editable');
        await page.getByRole('textbox', { name: 'Supporting link 1' }).fill('http://example.com/band');
        await page.getByRole('button', { name: 'Use this new artist' }).click();
        await page.getByText('Links must start with https://.').waitFor();
        assert.deepEqual(await selections(page), [null]);
        await page.getByRole('textbox', { name: 'Supporting link 1' }).fill('https://example.com/band');
        await page.getByRole('button', { name: 'Add another link' }).click();
        await page.getByRole('textbox', { name: 'Supporting link 2' }).fill('https://example.com/band');
        await page.getByRole('button', { name: 'Use this new artist' }).click();
        await page.getByText('This link is listed twice.').waitFor();
        await page.getByRole('textbox', { name: 'Supporting link 2' }).fill('');
        await name.fill('  Unknown Band  ');
        await page.getByRole('button', { name: 'Use this new artist' }).click();
        assert.deepEqual(await selections(page), [{ kind: 'community', canonicalName: 'Unknown Band', evidence: [{ url: 'https://example.com/band' }] }]);
        await page.getByText('New community artist, reviewed by a moderator').waitFor();
        await page.getByText('The credit keeps its wording, “Unknown Local Band”.').waitFor();
        assert.equal((await requests(page)).length, 0, 'proposing a community artist sends nothing and fetches no link');
      });
    });

    await t.test('keyboard-only search and selection', async () => {
      await fixture(['Nova'], async page => {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'search');
        await page.keyboard.press('Enter');
        await waitForRequests(page, 2);
        await answer(page, '/artist-discovery/local', 'Nova', 200, LOCAL_NOVA);
        await answer(page, '/artist-discovery/musicbrainz', 'Nova', 200, PROVIDER_NOVA);
        await page.getByRole('list', { name: 'MusicBrainz artists' }).waitFor();
        await page.getByRole('list', { name: 'Rescened artists' }).getByRole('button', { name: 'Choose Nova' }).first().focus();
        await page.keyboard.press('Enter');
        assert.deepEqual(await selections(page), [{ kind: 'existing', artistId: LOCAL_A, name: 'Nova', artistMbid: MBID_A }]);
        assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Remove link to Nova');
        await page.keyboard.press('Enter');
        assert.deepEqual(await selections(page), [null]);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('type')), 'search');
      });
    });

    await t.test('visual checkpoint at desktop and phone widths', async () => {
      for (const viewport of [{ width: 1000, height: 900, name: 'desktop' }, { width: 390, height: 844, name: '390' }]) {
        await fixture(['Nova (credited as N0VA)', 'A long credited name that keeps going, with commas, and more'], async page => {
          await searchFor(page, 1, 'Nova');
          await waitForRequests(page, 2);
          await answer(page, '/artist-discovery/local', 'Nova', 200, LOCAL_NOVA);
          await answer(page, '/artist-discovery/musicbrainz', 'Nova', 200, PROVIDER_NOVA);
          await page.getByRole('list', { name: 'MusicBrainz artists' }).waitFor();
          await credit(page, 2).getByRole('button', { name: 'Not listed? Propose a new artist' }).click();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow at ${viewport.width}px`);
          const directory = process.env.FRONTEND_BROWSER_SCREENSHOT_DIR || process.env.FRONTEND_BROWSER_ARTIFACT_DIR;
          if (directory) {
            await fs.mkdir(directory, { recursive: true });
            await page.screenshot({ path: path.join(directory, `artist-picker-${viewport.name}.png`), fullPage: true });
          }
        }, { width: viewport.width, height: viewport.height });
      }
    });
  } finally { await browser?.close(); await server?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
