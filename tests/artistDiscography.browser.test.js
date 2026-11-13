// Explicit offline browser regression for the artist discography section.
// Uses installed Playwright when requested; fetch is stubbed in the page, so
// no API server, database, Clerk, or MusicBrainz access is possible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
const ARTIST = '11111111-1111-4111-8111-111111111111';

// Page-side fetch stub. Load-more responses wait for window.__release() so
// the test can act while a request is in flight.
const stub = `
const id = (n) => String(n).padStart(8, '0') + '-0000-4000-8000-000000000000';
const external = (n) => ({ kind: 'external', provider: 'musicbrainz', entityType: 'release-group', externalId: id(n), title: 'Group ' + n, artistDisplayName: 'Fixture Artist', artistCredits: [], releaseType: 'album', releaseYear: 2000 + n, cover: '', sourceUrl: 'https://musicbrainz.org/release-group/' + id(n) });
window.__requests = []; window.__aborts = 0; window.__pending = [];
window.__release = () => { const next = window.__pending.shift(); if (next) next(); };
window.fetch = (input, init = {}) => {
  const url = new URL(String(input)); window.__requests.push(url.search);
  const type = url.searchParams.get('type'); const cursor = url.searchParams.get('cursor');
  const body = cursor === 'empty'
    ? { releases: [], providerCount: 230, filteredOut: 100, nextCursor: 'last', source: { artistUrl: 'https://musicbrainz.org/artist/x' }, suggestionsAvailable: false }
    : cursor === 'last'
      ? { releases: [external(1), external(3)], providerCount: 230, filteredOut: 0, nextCursor: null, suggestionsAvailable: false }
      : { releases: type === 'ep' ? [external(7)] : [external(1), external(2)], providerCount: 230, filteredOut: 98, nextCursor: 'empty', source: { artistUrl: 'https://musicbrainz.org/artist/x' }, suggestionsAvailable: false };
  return new Promise((resolve, reject) => {
    const respond = () => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    init.signal?.addEventListener('abort', () => { window.__aborts += 1; reject(new DOMException('aborted', 'AbortError')); });
    if (cursor) window.__pending.push(respond); else respond();
  });
};`;

test('artist discography paging, filters, and unmount cancel in-flight requests', { skip: enabled ? false : 'Set RUN_FRONTEND_BROWSER_TESTS=true with an available Playwright installation', timeout: 60000 }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const frontend = path.resolve(__dirname, '../frontend');
  const requireFrontend = createRequire(path.join(frontend, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(requireFrontend.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-discography-browser-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Discography fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'stub.js'), stub);
    // The real app, community, and artist styles, so the overflow check tests actual layout.
    const styles = ['src/reset.css', 'src/index.css', 'src/App.css', 'src/Components/Community/GenreSuggestion.css', 'src/features/artists/ArtistPage.css']
      .map((file) => `import ${JSON.stringify(path.join(frontend, file))};`).join(' ');
    await fs.writeFile(path.join(directory, 'entry.jsx'), `import './stub.js'; ${styles} import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { MemoryRouter } from 'react-router-dom';
import ArtistDiscography from ${JSON.stringify(path.join(frontend, 'src/features/artists/ArtistDiscography.jsx'))};
function Harness() { const [shown, setShown] = useState(true); return <MemoryRouter><main className="app-shell"><section className="community-page artist-page"><button id="toggle" onClick={() => setShown(false)}>Leave</button>{shown ? <ArtistDiscography artistId="${ARTIST}" /> : <p id="gone">Left</p>}</section></main></MemoryRouter>; }
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness /></React.StrictMode>);`);
    server = await createServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: { react: path.dirname(requireFrontend.resolve('react/package.json')), 'react-dom': path.dirname(requireFrontend.resolve('react-dom/package.json')), 'react-router-dom': path.dirname(requireFrontend.resolve('react-router-dom/package.json')) } },
      // No HMR or file watcher: a late watcher event can re-run the entry module and trigger a duplicate createRoot warning.
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [directory, frontend, await fs.realpath(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(url);
    await page.getByText('Group 2').waitFor();
    assert.match(await page.locator('.artist-discography-summary').innerText(), /230 album-type groups .* Showing 2 verified album groups without a secondary type so far/);
    assert.equal(await page.getByText('Suggest this album').count(), 0, 'no suggestion action while its prefill is unavailable');

    // Repeated clicks while a page is in flight send one request.
    const more = page.getByRole('button', { name: /Load more from MusicBrainz|Loading/ });
    await more.click(); await more.click({ force: true }); await more.click({ force: true });
    const cursorRequests = () => page.evaluate(() => window.__requests.filter((search) => search.includes('cursor=')).length);
    assert.equal(await cursorRequests(), 1);
    await page.evaluate(() => window.__release());
    await page.getByText(/no new verified matching release groups/).waitFor();

    // Changing the filter during an in-flight load aborts it and drops its result.
    await page.getByRole('button', { name: /Load more/ }).click();
    const abortsBefore = await page.evaluate(() => window.__aborts);
    await page.getByRole('button', { name: 'EPs', exact: true }).click();
    await page.getByText('Group 7').waitFor();
    assert.ok(await page.evaluate(() => window.__aborts) > abortsBefore);
    await page.evaluate(() => window.__release());
    assert.equal(await page.getByText('Group 3').count(), 0, 'a stale page never lands in the new list');

    // Leaving the page during an in-flight load aborts it.
    await page.getByRole('button', { name: /Load more/ }).click();
    const beforeLeave = await page.evaluate(() => window.__aborts);
    await page.click('#toggle');
    await page.locator('#gone').waitFor();
    assert.ok(await page.evaluate(() => window.__aborts) > beforeLeave);
    await page.evaluate(() => window.__release());
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 390px');
  } finally {
    await browser?.close();
    await server?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
