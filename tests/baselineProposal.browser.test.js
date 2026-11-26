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
  const { chromium } = require('./browser-support/chromium');
  const frontend = path.resolve(__dirname, '../frontend');
  const requireFrontend = createRequire(path.join(frontend, 'package.json'));
  const { createFixtureServer } = require('./browser-support/server');
  const { default: react } = await import(pathToFileURL(requireFrontend.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-baseline-browser-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Baseline review fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'auth.js'), `
let holdNextToken = false;
window.holdNextBaselineToken = () => { holdNextToken = true; };
const getToken = async () => {
  if (holdNextToken) {
    holdNextToken = false;
    await new Promise(resolve => { window.releaseBaselineToken = resolve; });
  }
  return "fixture-token";
};
export function useAuth() { return { getToken, isLoaded: true, isSignedIn: true }; }
`);
    await fs.writeFile(path.join(directory, 'entry.jsx'), `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ${JSON.stringify(path.join(frontend, 'src/reset.css'))};
import ${JSON.stringify(path.join(frontend, 'src/index.css'))};
import ${JSON.stringify(path.join(frontend, 'src/App.css'))};
import BaselineReviewPanel from ${JSON.stringify(path.join(frontend, 'src/Components/Community/BaselineReviewPanel.jsx'))};

function Fixture() {
  const [target, setTarget] = useState(null);
  useEffect(() => { window.setBaselineTarget = setTarget; }, []);
  return <main data-fixture-release-group={target?.releaseGroupMbid || ""}>
    <BaselineReviewPanel kind="submissions" id="11111111-1111-4111-8111-111111111111" target={target} />
  </main>;
}

createRoot(document.getElementById('root')).render(<Fixture />);
`);
    server = await createFixtureServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: { '@clerk/react': path.join(directory, 'auth.js'), react: path.dirname(requireFrontend.resolve('react/package.json')), 'react-dom': path.dirname(requireFrontend.resolve('react-dom/package.json')) } },
      server: { fs: { allow: [directory, frontend, await fs.realpath(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const candidate = { releaseMbid: '22222222-2222-4222-8222-222222222222', releaseGroupMbid: '33333333-3333-4333-8333-333333333333', title: 'Fixture edition', artistDisplayName: 'Fixture Artist', date: '2026', country: 'US', formats: ['CD'], sourceUrl: 'https://musicbrainz.org/release/22222222-2222-4222-8222-222222222222', tracklistHash: 'a'.repeat(64), tracks: [
      { discNumber: 1, trackNumber: 1, title: 'Opening evidence', artistDisplayName: 'Fixture Artist', durationMs: 180000, releaseTrackMbid: 'track-one' },
      { discNumber: 2, trackNumber: 1, title: 'Second disc evidence', artistDisplayName: 'Fixture Artist', durationMs: null, releaseTrackMbid: 'track-two' },
    ] };
    const manualGroupMbid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const manualCandidate = {
      ...candidate,
      releaseMbid: '44444444-4444-4444-8444-444444444444',
      releaseGroupMbid: manualGroupMbid,
      title: 'Manual group edition',
      sourceUrl: 'https://musicbrainz.org/release/44444444-4444-4444-8444-444444444444',
      tracklistHash: 'b'.repeat(64),
      tracks: [{ discNumber: 1, trackNumber: 1, title: 'Manual group track', artistDisplayName: 'Fixture Artist', durationMs: 180000, releaseTrackMbid: 'track-manual' }],
    };
    async function fixture(options, run) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; const commands = [];
      let detailReads = 0;
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const detail = { target: { kind: 'submissions', id: '11111111-1111-4111-8111-111111111111', title: 'Fixture Album', releaseGroupMbid: options.lateTarget ? '' : candidate.releaseGroupMbid, submissionRevision: 1 }, revision: 0, status: 'pending', proposal: candidate, selection: options.persisted ? candidate : null, flags: { discovery: options.discovery, moderation: options.moderation }, history: [] };
      await page.route('**/*', async route => {
        const request = route.request(); const requestUrl = new URL(request.url());
        if (requestUrl.origin === url) return route.continue();
        assert.equal(requestUrl.origin, 'http://fixture.invalid', 'browser fixture must not contact external services');
        assert.equal(request.headers().authorization, 'Bearer fixture-token');
        if (request.method() === 'GET') {
          if (requestUrl.pathname === '/moderation/review-effort') return route.fulfill({ json: { enabled: false } });
          if (requestUrl.pathname === '/moderation/album-baselines/groups') {
            return route.fulfill({ json: { items: [{ releaseGroupMbid: manualGroupMbid, title: 'Manual Group A', artistDisplayName: 'Fixture Artist', date: '2025' }] } });
          }
          detailReads += 1;
          return route.fulfill({ json: detail });
        }
        const action = requestUrl.pathname.split('/').at(-1); const body = request.postDataJSON(); commands.push({ action, body });
        if (action === 'candidates') {
          if (body.releaseGroupMbid === manualGroupMbid) return route.fulfill({ json: { candidate: manualCandidate, items: [], coverage: null, incomplete: false, ambiguous: false, rationale: [] } });
          if (body.releaseGroupMbid === candidate.releaseGroupMbid) return route.fulfill({ json: { candidate, items: [], coverage: null, incomplete: false, ambiguous: false, rationale: [] } });
          return route.fulfill({ status: 409, json: { error: 'Release group conflicts with the target identity', code: 'RELEASE_GROUP_MISMATCH' } });
        }
        if (action === 'proposal') { assert.equal(body.expectedTargetRevision, 1); return route.fulfill({ json: { candidate: options.incomplete ? { ...candidate, tracks: [] } : options.missingSource ? { ...candidate, sourceUrl: '' } : candidate } }); }
        if (action === 'defer' && options.lateTarget) return route.fulfill({ json: { ...detail, status: 'deferred', revision: 1 } });
        assert.equal(action, 'confirm'); assert.equal(body.candidateHash, candidate.tracklistHash);
        return route.fulfill({ json: { ...detail, status: 'reviewed', revision: 1, selection: candidate } });
      });
      try { await page.goto(url); await page.getByRole('heading', { name: 'Contributor edition', exact: true }).waitFor(); await run(page, commands, () => detailReads); assert.deepEqual(errors, []); }
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
    await t.test('late release-group metadata preserves a pending defer decision', async () => {
      await fixture({ discovery: false, moderation: true, lateTarget: true }, async (page, commands, detailReads) => {
        const releaseGroup = page.locator('[data-fixture-release-group]');
        const pickerHeading = page.getByRole('heading', { name: 'Choose a MusicBrainz release group', exact: true });
        const selectedGroupCode = page.locator('.baseline-group-selected code');
        const changeGroupButton = page.getByRole('button', { name: 'Change', exact: true });
        const defer = page.getByRole('button', { name: 'Defer', exact: true });
        assert.equal(await releaseGroup.getAttribute('data-fixture-release-group'), '');
        await pickerHeading.waitFor();
        await page.getByRole('textbox', { name: 'Reason optional' }).fill('Waiting for source confirmation');
        await page.evaluate(() => window.holdNextBaselineToken());
        await defer.click();
        await page.waitForFunction(() => Boolean(window.releaseBaselineToken));
        assert.deepEqual(commands, []);

        await page.evaluate(async releaseGroupMbid => {
          window.setBaselineTarget({ releaseGroupMbid });
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }, candidate.releaseGroupMbid);
        assert.equal(await releaseGroup.getAttribute('data-fixture-release-group'), candidate.releaseGroupMbid);
        await selectedGroupCode.waitFor();
        assert.equal(await selectedGroupCode.textContent(), candidate.releaseGroupMbid);
        assert.equal(await pickerHeading.count(), 0);
        assert.equal(await changeGroupButton.isDisabled(), true);
        assert.equal(await defer.isDisabled(), true);
        await page.evaluate(() => window.releaseBaselineToken());

        await page.getByText('Baseline defer recorded.', { exact: true }).waitFor();
        assert.deepEqual(commands.map(({ action, body }) => [action, body.reason]), [['defer', 'Waiting for source confirmation']]);
        assert.equal(detailReads(), 1);
      });
    });
    await t.test('conflicting late release-group metadata replaces a manual choice and clears its preview while preserving a pending defer', async () => {
      await fixture({ discovery: true, moderation: true, lateTarget: true }, async (page, commands, detailReads) => {
        const selectedGroupCode = page.locator('.baseline-group-selected code');
        const changeGroupButton = page.getByRole('button', { name: 'Change', exact: true });
        const confirm = page.getByRole('button', { name: 'Confirm baseline', exact: true });
        const defer = page.getByRole('button', { name: 'Defer', exact: true });

        await page.getByRole('textbox', { name: 'MusicBrainz release-group search' }).fill('Manual Group');
        await page.getByRole('button', { name: 'Search MusicBrainz', exact: true }).click();
        await page.getByRole('button', { name: /Manual Group A/ }).click();
        await page.getByRole('cell', { name: 'Manual group track', exact: true }).waitFor();
        assert.equal(await selectedGroupCode.textContent(), manualGroupMbid);
        assert.equal(await confirm.isEnabled(), true);

        await page.getByRole('textbox', { name: 'Reason optional' }).fill('Waiting for source confirmation');
        await page.evaluate(() => window.holdNextBaselineToken());
        await defer.click();
        await page.waitForFunction(() => Boolean(window.releaseBaselineToken));

        await page.evaluate(async releaseGroupMbid => {
          window.setBaselineTarget({ releaseGroupMbid });
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }, candidate.releaseGroupMbid);
        assert.equal(await selectedGroupCode.textContent(), candidate.releaseGroupMbid);
        assert.equal(await changeGroupButton.isDisabled(), true);
        assert.equal(await page.getByRole('cell', { name: 'Manual group track', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Saving…', exact: true }).isDisabled(), true);
        assert.equal(await defer.isDisabled(), true);

        await page.evaluate(() => window.releaseBaselineToken());
        await page.getByText('Baseline defer recorded.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('cell', { name: 'Manual group track', exact: true }).count(), 0);
        assert.equal(await confirm.isDisabled(), true);
        assert.equal(detailReads(), 1);
        assert.deepEqual(commands.filter(command => command.action === 'defer').map(({ action, body }) => [action, body.reason]), [['defer', 'Waiting for source confirmation']]);

        await page.getByRole('button', { name: 'Suggest a release', exact: true }).click();
        await page.getByRole('cell', { name: 'Opening evidence', exact: true }).waitFor();
        assert.equal(await confirm.isEnabled(), true);
        assert.deepEqual(commands.filter(command => command.action === 'candidates').map(command => command.body.releaseGroupMbid), [manualGroupMbid, candidate.releaseGroupMbid]);
      });
    });
  } finally { await browser?.close(); await server?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
