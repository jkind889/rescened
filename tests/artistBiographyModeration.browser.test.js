// Explicit offline browser regression for the biography moderation panel.
// Uses installed Playwright when requested; Clerk and fetch are stubbed in
// the page, so no API server, database, Clerk, or provider is reached.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
const ARTIST = '11111111-1111-4111-8111-111111111111';

// A Clerk stand-in whose session the page can change, and a fetch stub whose
// command responses wait for window.__release().
const auth = `import { useSyncExternalStore } from 'react';
let state = { isLoaded: true, isSignedIn: true, userId: 'user_mod' };
const listeners = new Set();
window.__setAuth = (next) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()); };
const getToken = async () => 'fixture-token';
export function useAuth() { const snapshot = useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => state); return { ...snapshot, getToken }; }`;
const stub = `
const record = (revision, suppressed) => ({ artistId: '${ARTIST}', revision, identity: { state: 'verified', qid: 'Q1', reasons: [] }, moderation: { suppressed, suppressedReason: suppressed ? 'r' : '' }, display: !suppressed,
  accepted: { text: 'Synthetic band excerpt for the moderation test.', shortened: true, license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }, article: { title: 'Synthetic', url: 'https://example.invalid/a', revisionId: 5, revisionUrl: 'https://example.invalid/r' } },
  pendingRevision: revision === 1 ? { text: 'Unreviewed changed lead from a newer revision.', shortened: false, license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }, article: { title: 'Synthetic', url: 'https://example.invalid/a', revisionId: 6, revisionUrl: 'https://example.invalid/r6' } } : null,
  candidate: null, manual: null, fetch: {}, history: [] });
window.__aborts = 0; window.__pending = [];
window.__release = () => { const next = window.__pending.shift(); if (next) next(); };
window.fetch = (input, init = {}) => {
  const url = String(input);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/access')) return Promise.resolve(json({ moderator: true }));
  if ((init.method || 'GET') === 'GET') return Promise.resolve(json({ biography: record(1, false) }));
  return new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => { window.__aborts += 1; reject(new DOMException('aborted', 'AbortError')); });
    window.__pending.push(() => resolve(json({ biography: record(2, true) })));
  });
};`;

test('signing out cancels a pending biography command and leaves no stale state', { skip: enabled ? false : 'Set RUN_FRONTEND_BROWSER_TESTS=true with an available Playwright installation', timeout: 60000 }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const frontend = path.resolve(__dirname, '../frontend');
  const requireFrontend = createRequire(path.join(frontend, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(requireFrontend.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-bio-moderation-browser-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Moderation fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'auth.js'), auth);
    await fs.writeFile(path.join(directory, 'stub.js'), stub);
    await fs.writeFile(path.join(directory, 'entry.jsx'), `import './stub.js'; import React from 'react'; import { createRoot } from 'react-dom/client';
import ArtistBiographyModeration from ${JSON.stringify(path.join(frontend, 'src/features/artists/ArtistBiographyModeration.jsx'))};
createRoot(document.getElementById('root')).render(<React.StrictMode><ArtistBiographyModeration artistId="${ARTIST}" onChanged={() => { window.__changed = (window.__changed || 0) + 1; }} /></React.StrictMode>);`);
    server = await createServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: { '@clerk/react': path.join(directory, 'auth.js'), react: path.dirname(requireFrontend.resolve('react/package.json')), 'react-dom': path.dirname(requireFrontend.resolve('react-dom/package.json')) } },
      // No HMR or file watcher: a late watcher event can re-run the entry module and trigger a duplicate createRoot warning.
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [directory, frontend, await fs.realpath(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.getByText('Biography moderation').click();
    await page.getByText('Published excerpt:').waitFor();
    // A staged revision is shown to moderators with its own attribution, and keeping the current text needs a reason.
    await page.getByText("Wikipedia's lead changed").waitFor();
    await page.getByText('Unreviewed changed lead from a newer revision.').waitFor();
    assert.equal(await page.locator('a[rel~="license"]').count(), 2, 'published and staged excerpts each carry their license link');
    assert.equal(await page.getByRole('button', { name: 'Keep current text' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Publish new text' }).isEnabled(), true);
    await page.getByLabel('Reason (for suppress, reject, or keeping current text)').fill('Sensitive reason text');
    assert.equal(await page.getByRole('button', { name: 'Keep current text' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Suppress' }).click();

    // Sign out while the command is pending, then let the response arrive.
    await page.evaluate(() => window.__setAuth({ isSignedIn: false, userId: null }));
    assert.ok(await page.evaluate(() => window.__aborts) > 0, 'the pending command was aborted');
    await page.evaluate(() => window.__release());
    assert.equal(await page.getByText('Saved.').count(), 0);
    assert.equal(await page.getByText('Biography moderation').count(), 0, 'nothing is shown after sign-out');
    assert.equal(await page.evaluate(() => window.__changed || 0), 0, 'no change callback for an abandoned command');

    // Another user signs in: a fresh panel with no leftover form state.
    await page.evaluate(() => window.__setAuth({ isSignedIn: true, userId: 'user_other' }));
    await page.getByText('Biography moderation').click();
    await page.getByText('Published excerpt:').waitFor();
    assert.equal(await page.getByLabel('Reason (for suppress, reject, or keeping current text)').inputValue(), '');
    assert.equal(await page.getByText('Saved.').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
