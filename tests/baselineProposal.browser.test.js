// Explicit offline browser regression. Uses installed Playwright when requested;
// no live Clerk, provider, database or application-server access is permitted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
test('moderator proposal evidence remains visible with discovery disabled', { skip: enabled ? false : 'Set RUN_FRONTEND_BROWSER_TESTS=true with an available Playwright installation', timeout: 60000 }, async (t) => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const frontend = path.resolve(__dirname, '../frontend');
  const requireFrontend = createRequire(path.join(frontend, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(requireFrontend.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-baseline-browser-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Baseline review fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'auth.js'), 'const getToken = async () => "fixture-token"; export function useAuth() { return { getToken, isLoaded: true, isSignedIn: true }; }');
    await fs.writeFile(path.join(directory, 'entry.jsx'), `import React from 'react'; import { createRoot } from 'react-dom/client'; import ${JSON.stringify(path.join(frontend, 'src/reset.css'))}; import ${JSON.stringify(path.join(frontend, 'src/index.css'))}; import ${JSON.stringify(path.join(frontend, 'src/App.css'))}; import BaselineReviewPanel from ${JSON.stringify(path.join(frontend, 'src/Components/Community/BaselineReviewPanel.jsx'))}; createRoot(document.getElementById('root')).render(<BaselineReviewPanel kind="submissions" id="11111111-1111-4111-8111-111111111111" />);`);
    server = await createServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: { '@clerk/react': path.join(directory, 'auth.js'), react: path.dirname(requireFrontend.resolve('react/package.json')), 'react-dom': path.dirname(requireFrontend.resolve('react-dom/package.json')) } },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [directory, frontend, await fs.realpath(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const candidate = { releaseMbid: '22222222-2222-4222-8222-222222222222', releaseGroupMbid: '33333333-3333-4333-8333-333333333333', title: 'Fixture edition', artistDisplayName: 'Fixture Artist', date: '2026', country: 'US', formats: ['CD'], sourceUrl: 'https://musicbrainz.org/release/22222222-2222-4222-8222-222222222222', tracklistHash: 'a'.repeat(64), tracks: [
      { discNumber: 1, trackNumber: 1, title: 'Opening evidence', artistDisplayName: 'Fixture Artist', durationMs: 180000, releaseTrackMbid: 'track-one' },
      { discNumber: 2, trackNumber: 1, title: 'Second disc evidence', artistDisplayName: 'Fixture Artist', durationMs: null, releaseTrackMbid: 'track-two' },
    ] };
    async function fixture(options, run) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; const commands = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const detail = { target: { kind: 'submissions', id: '11111111-1111-4111-8111-111111111111', title: 'Fixture Album', releaseGroupMbid: candidate.releaseGroupMbid, submissionRevision: 1 }, revision: 0, status: 'pending', proposal: candidate, selection: options.persisted ? candidate : null, flags: { discovery: options.discovery, moderation: options.moderation }, history: [] };
      await page.route('**/*', async route => {
        const request = route.request(); const requestUrl = new URL(request.url());
        if (requestUrl.origin === url) return route.continue();
        assert.equal(requestUrl.origin, 'http://fixture.invalid', 'browser fixture must not contact external services');
        assert.equal(request.headers().authorization, 'Bearer fixture-token');
        if (request.method() === 'GET') return route.fulfill({ json: detail });
        const action = requestUrl.pathname.split('/').at(-1); const body = request.postDataJSON(); commands.push({ action, body });
        if (action === 'proposal') { assert.equal(body.expectedTargetRevision, 1); return route.fulfill({ json: { candidate: options.incomplete ? { ...candidate, tracks: [] } : options.missingSource ? { ...candidate, sourceUrl: '' } : candidate } }); }
        assert.equal(action, 'confirm'); assert.equal(body.candidateHash, candidate.tracklistHash);
        return route.fulfill({ json: { ...detail, status: 'reviewed', revision: 1, selection: candidate } });
      });
      try { await page.goto(url); await page.getByRole('heading', { name: 'Contributor edition', exact: true }).waitFor(); await run(page, commands); assert.deepEqual(errors, []); }
      finally { await page.close(); }
    }
    for (const discovery of [false, true]) await t.test(`selected proposal: discovery=${discovery}`, async () => {
      await fixture({ discovery, moderation: true }, async (page, commands) => {
        const confirm = page.getByRole('button', { name: 'Confirm baseline', exact: true });
        assert.equal(await confirm.isDisabled(), true);
        await page.getByRole('button', { name: 'Review proposed edition', exact: true }).click();
        await page.getByRole('cell', { name: 'Opening evidence', exact: true }).waitFor();
        assert.equal(await page.getByRole('cell', { name: 'Second disc evidence', exact: true }).isVisible(), true);
        assert.equal(await page.locator('.baseline-track-table tbody tr').count(), 2);
        assert.equal(await page.getByRole('link', { name: 'Open MusicBrainz release' }).getAttribute('href'), candidate.sourceUrl);
        assert.equal(await confirm.isEnabled(), true);
        assert.equal(await page.locator('.baseline-discovery').count(), discovery ? 1 : 0);
        if (!discovery && process.env.FRONTEND_BROWSER_SCREENSHOT_DIR) {
          await fs.mkdir(process.env.FRONTEND_BROWSER_SCREENSHOT_DIR, { recursive: true });
          await page.locator('[aria-labelledby="baseline-candidate-heading"]').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.FRONTEND_BROWSER_SCREENSHOT_DIR, 'baseline-discovery-off.png') });
        }
        await confirm.click(); await page.getByRole('button', { name: 'Replace baseline', exact: true }).waitFor();
        assert.deepEqual(commands.map(command => command.action), ['proposal', 'confirm']);
      });
    });
    await t.test('persisted selection remains reviewable with discovery disabled', async () => {
      await fixture({ discovery: false, moderation: true, persisted: true }, async page => {
        await page.getByRole('cell', { name: 'Second disc evidence', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Confirm baseline', exact: true }).isEnabled(), true);
      });
    });
    await t.test('missing complete evidence keeps confirmation disabled', async () => {
      await fixture({ discovery: false, moderation: true, incomplete: true }, async page => {
        await page.getByRole('button', { name: 'Review proposed edition', exact: true }).click();
        await page.getByText('No complete tracklist is available for this release.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Confirm baseline', exact: true }).isDisabled(), true);
      });
    });
    await t.test('missing source evidence keeps confirmation disabled', async () => {
      await fixture({ discovery: false, moderation: true, missingSource: true }, async page => {
        await page.getByRole('button', { name: 'Review proposed edition', exact: true }).click();
        await page.getByText('No source is available for this release.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Open MusicBrainz release' }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Confirm baseline', exact: true }).isDisabled(), true);
      });
    });
    await t.test('persisted evidence never bypasses disabled moderation', async () => {
      await fixture({ discovery: false, moderation: false, persisted: true }, async page => {
        await page.getByRole('cell', { name: 'Opening evidence', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Review proposed edition', exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Confirm baseline', exact: true }).isDisabled(), true);
      });
    });
  } finally { await browser?.close(); await server?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
