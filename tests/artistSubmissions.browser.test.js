// Explicit offline browser fixture for standalone artist suggestions: the
// real contributor and moderator pages in a synthetic shell with a stubbed
// Clerk hook and an in-page fetch stub. No API server, database, Clerk, or
// MusicBrainz.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
const LOCAL = '11111111-1111-4111-8111-111111111111';
const MBID = '83096042-3785-481e-8843-dee69f1aad12';
const SUBMISSION = '22222222-2222-4222-8222-222222222222';
const EVIDENCE = 'https://example.com/private-evidence';

const PICKER = {
  local: { query: 'Nova', results: [{ artistId: LOCAL, name: 'Nova Local', artistMbid: '', releaseCount: 3, knownFor: ['Glass'] }] },
  musicbrainz: { query: 'Nova', candidates: [{ artistMbid: MBID, name: 'Nova Upstream', disambiguation: 'UK duo', type: 'Group', country: 'GB', registeredArtistId: null }] },
};

function suggestion(overrides = {}) {
  return {
    submissionId: SUBMISSION, submittedByUserId: 'user_fixture', status: 'pending', currentRevision: 3,
    proposal: { proposalKey: 'artist', kind: 'community', canonicalName: 'Brand New Band', evidence: [{ url: EVIDENCE, description: '' }] },
    note: 'Two releases on Bandcamp', revisions: [], moderationHistory: [{ actorUserId: 'user_fixture', action: 'submitted', reason: '', revision: 1, createdAt: '2026-11-15T00:00:00.000Z' }],
    createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z',
    ...overrides,
  };
}

test('standalone artist suggestion pages', {
  skip: enabled ? false : 'Run npm run test:browser', timeout: 180000,
}, async (t) => {
  const { chromium } = require('./browser-support/chromium');
  const frontend = path.resolve(__dirname, '../frontend');
  const resolve = createRequire(path.join(frontend, 'package.json'));
  const { createFixtureServer } = require('./browser-support/server');
  const { default: react } = await import(pathToFileURL(resolve.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-artist-submissions-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artist suggestions fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'auth.js'), `
const getToken = async () => 'fixture-token';
export function useAuth() { return { isLoaded: true, isSignedIn: true, userId: 'user_fixture', getToken }; }
`);
    await fs.writeFile(path.join(directory, 'entry.jsx'), `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ${JSON.stringify(path.join(frontend, 'src/reset.css'))}; import ${JSON.stringify(path.join(frontend, 'src/index.css'))}; import ${JSON.stringify(path.join(frontend, 'src/App.css'))};
import ArtistSuggestions from ${JSON.stringify(path.join(frontend, 'src/Pages/ArtistSuggestions.jsx'))};
import ModerationArtistSuggestions from ${JSON.stringify(path.join(frontend, 'src/Pages/ModerationArtistSuggestions.jsx'))};

// Fetch stub: window.__routes maps "METHOD path" to [status, body] or a
// list of them consumed in order; every request is recorded.
window.__linking = true;
window.__routes = {};
window.__requests = [];
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  window.__requests.push({ method, path: url.pathname, search: url.search, body });
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/artist-discovery/capabilities') return json(200, { enabled: window.__linking });
  if (url.pathname === '/artist-discovery/local') return json(200, ${JSON.stringify(PICKER.local)});
  if (url.pathname === '/artist-discovery/musicbrainz') return json(200, ${JSON.stringify(PICKER.musicbrainz)});
  const route = window.__routes[method + ' ' + url.pathname];
  let next = Array.isArray(route?.[0]) || (Array.isArray(route) && route[0]?.hold) ? route.shift() : route;
  // { hold: name, response } waits until the test calls window.__release(name).
  if (next && !Array.isArray(next) && next.hold) {
    const held = next;
    await new Promise(resolveHold => { window.__holds = { ...(window.__holds || {}), [held.hold]: resolveHold }; });
    next = held.response;
    window.__completedHolds = [...(window.__completedHolds || []), held.hold];
  }
  return next ? json(next[0], next[1]) : json(404, { error: 'not stubbed', code: 'NOT_FOUND' });
};
window.__release = name => window.__holds?.[name]?.();
function Where() { const location = useLocation(); window.__location = location.pathname; return null; }
const root = createRoot(document.getElementById('root'));
window.__mount = (entry) => root.render(<MemoryRouter initialEntries={[entry]}><Where /><Routes>
  <Route path="/artist-suggestions" element={<ArtistSuggestions />} />
  <Route path="/artist-suggestions/:submissionId" element={<ArtistSuggestions />} />
  <Route path="/moderation/artist-suggestions" element={<ModerationArtistSuggestions />} />
  <Route path="/moderation/artist-suggestions/:submissionId" element={<ModerationArtistSuggestions />} />
  <Route path="*" element={<p>Elsewhere</p>} />
</Routes></MemoryRouter>);
`);
    server = await createFixtureServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: { '@clerk/react': path.join(directory, 'auth.js'), ...Object.fromEntries(['react', 'react-dom', 'react-router-dom'].map(name => [name, path.dirname(resolve.resolve(`${name}/package.json`))])) } },
      server: { hmr: false, watch: null, fs: { allow: [directory, frontend, require('node:fs').realpathSync(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function fixture(setup, run, viewport = { width: 1100, height: 1000 }) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
      try {
        await page.goto(url);
        await page.waitForFunction(() => typeof window.__mount === 'function');
        await page.evaluate(setup.routes ? (routes) => { window.__routes = routes; } : () => {}, setup.routes || null);
        if (setup.linking === false) await page.evaluate(() => { window.__linking = false; });
        await page.evaluate(entry => window.__mount(entry), setup.entry);
        await run(page);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    const posts = page => page.evaluate(() => window.__requests.filter(request => request.method === 'POST'));
    const created = suggestion({ submissionId: SUBMISSION, currentRevision: 1, proposal: { proposalKey: 'artist', kind: 'musicbrainz', artistMbid: MBID, observation: { artistMbid: MBID, name: 'Nova Upstream', observedAt: '2026-11-15T00:00:00.000Z' } } });

    await t.test('suggesting a MusicBrainz artist sends one proposal and keeps its request key on retry', async () => {
      await fixture({ entry: '/artist-suggestions', routes: {
        'GET /artist-suggestions/mine': [200, { suggestions: [] }],
        'POST /artist-suggestions': [[500, { error: 'Temporary failure' }], [201, created]],
        [`GET /artist-suggestions/${SUBMISSION}`]: [200, created],
      } }, async page => {
        await page.getByRole('searchbox', { name: 'Find the artist' }).fill('Nova');
        await page.getByRole('button', { name: 'Search artists' }).click();
        await page.getByRole('button', { name: 'Choose Nova Upstream' }).click();
        await page.getByLabel(/Note for moderators/).fill('  UK duo, see MusicBrainz  ');
        await page.getByRole('button', { name: 'Send for review' }).click();
        await page.getByText('Temporary failure').waitFor();
        await page.getByRole('button', { name: 'Send for review' }).click();
        await page.waitForFunction(id => window.__location === '/artist-suggestions/' + id, SUBMISSION);
        const [first, second] = await posts(page);
        assert.deepEqual(first.body.artistProposal, { kind: 'musicbrainz', artistMbid: MBID });
        assert.equal(first.body.note, 'UK duo, see MusicBrainz');
        assert.match(first.body.requestKey, /^[0-9a-f-]{36}$/);
        assert.equal(second.body.requestKey, first.body.requestKey, 'a retry of the same suggestion reuses its key');
        await page.getByText('Waiting for review').waitFor();
      });
    });

    await t.test('an artist already on Rescened is pointed to, not suggested', async () => {
      await fixture({ entry: '/artist-suggestions', routes: {
        'GET /artist-suggestions/mine': [200, { suggestions: [] }],
        'POST /artist-suggestions': [409, { error: 'already', code: 'ARTIST_ALREADY_EXISTS', details: [{ artistId: LOCAL, name: 'Nova Local' }], existingArtist: { artistId: LOCAL, name: 'Nova Local' } }],
      } }, async page => {
        await page.getByRole('searchbox', { name: 'Find the artist' }).fill('Nova');
        await page.getByRole('button', { name: 'Search artists' }).click();
        await page.getByRole('button', { name: 'Choose Nova Local' }).click();
        await page.getByText('is already on Rescened.').waitFor();
        assert.equal(await page.getByRole('link', { name: 'Open the artist' }).getAttribute('href'), `/artist/${LOCAL}`);
        assert.equal(await page.getByRole('button', { name: 'Send for review' }).isDisabled(), true);
        assert.deepEqual(await posts(page), [], 'nothing is sent for an existing artist');
        // The server's exact-MBID check is shown the same way.
        await page.getByRole('button', { name: 'Remove link to Nova Local' }).click();
        await page.getByRole('button', { name: 'Choose Nova Upstream' }).click();
        await page.getByRole('button', { name: 'Send for review' }).click();
        await page.getByText(/This MusicBrainz artist is already on Rescened as Nova Local/).waitFor();
      });
    });

    await t.test('with artist suggestions off the page explains and sends nothing', async () => {
      await fixture({ entry: '/artist-suggestions', linking: false, routes: { 'GET /artist-suggestions/mine': [200, { suggestions: [] }] } }, async page => {
        await page.getByText('Artist suggestions are turned off right now.').first().waitFor();
        assert.equal(await page.getByRole('searchbox', { name: 'Find the artist' }).count(), 0);
        await page.getByRole('button', { name: 'Send for review' }).click();
        assert.deepEqual(await posts(page), []);
      });
    });

    await t.test('revising and withdrawing name the displayed revision', async () => {
      const needsChanges = suggestion({ status: 'needs_changes', currentRevision: 3 });
      await fixture({ entry: `/artist-suggestions/${SUBMISSION}`, routes: {
        [`GET /artist-suggestions/${SUBMISSION}`]: [200, needsChanges],
        [`POST /artist-suggestions/${SUBMISSION}/revise`]: [200, suggestion({ currentRevision: 4 })],
        [`POST /artist-suggestions/${SUBMISSION}/withdraw`]: [200, suggestion({ status: 'withdrawn', currentRevision: 4 })],
      } }, async page => {
        await page.getByText('Changes requested').first().waitFor();
        assert.equal(await page.getByRole('link', { name: 'link 1' }).first().getAttribute('href'), EVIDENCE, 'the owner sees their evidence');
        await page.getByRole('button', { name: 'Remove link to Brand New Band' }).waitFor();
        await page.getByRole('button', { name: 'Send revision' }).click();
        await page.getByText('Waiting for review').waitFor();
        const [revise] = await posts(page);
        assert.equal(revise.body.expectedRevision, 3);
        assert.deepEqual(revise.body.artistProposal, { kind: 'community', canonicalName: 'Brand New Band', evidence: [{ url: EVIDENCE }] });
        assert.equal(revise.body.note, 'Two releases on Bandcamp');
        await page.getByRole('button', { name: 'Withdraw' }).click();
        await page.getByText('Withdrawn').first().waitFor();
        assert.equal((await posts(page))[1].body.expectedRevision, 4, 'withdrawal names the revision now shown');
      });
    });

    await t.test('moderators decide on the displayed revision with duplicate targets from context', async () => {
      const pending = suggestion({ currentRevision: 2 });
      const context = { registeredArtist: null, sameNameArtists: [{ artistId: LOCAL, name: 'Brand New Band', releaseCount: 4 }] };
      await fixture({ entry: `/moderation/artist-suggestions/${SUBMISSION}`, routes: {
        'GET /moderation/artist-suggestions': [200, { suggestions: [pending] }],
        [`GET /moderation/artist-suggestions/${SUBMISSION}`]: [200, { suggestion: pending, context }],
        [`POST /moderation/artist-suggestions/${SUBMISSION}/request-changes`]: [409, { error: 'The artist suggestion changed since you last loaded it', code: 'STATE_CONFLICT' }],
        [`POST /moderation/artist-suggestions/${SUBMISSION}/mark-duplicate`]: [200, { suggestion: suggestion({ status: 'duplicate', duplicateOfArtistId: LOCAL, currentRevision: 2 }), context }],
      } }, async page => {
        await page.getByRole('button', { name: 'Apply decision' }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'link 1' }).first().getAttribute('href'), EVIDENCE);
        await page.getByRole('radio', { name: /Request changes/ }).check();
        await page.getByRole('button', { name: 'Apply decision' }).click();
        await page.getByText('Add a reason for the contributor.').waitFor();
        await page.getByLabel(/^Reason/).fill('Add a label page');
        await page.getByRole('button', { name: 'Apply decision' }).click();
        await page.getByText('The artist suggestion changed since you last loaded it').waitFor();
        await page.getByRole('radio', { name: /Already on Rescened/ }).check();
        await page.getByRole('radio', { name: /Brand New Band.*Same name/ }).check();
        await page.getByRole('button', { name: 'Apply decision' }).click();
        await page.getByText('Already on Rescened:').waitFor();
        const sent = (await posts(page)).map(request => [request.path.split('/').pop(), request.body]);
        assert.deepEqual(sent, [
          ['request-changes', { expectedRevision: 2, reason: 'Add a label page' }],
          ['mark-duplicate', { expectedRevision: 2, reason: 'Add a label page', duplicateOfArtistId: LOCAL }],
        ]);
      });
    });

    const OTHER = '33333333-3333-4333-8333-333333333333';
    const other = suggestion({ submissionId: OTHER, currentRevision: 1, proposal: { proposalKey: 'artist', kind: 'community', canonicalName: 'Other Band', evidence: [{ url: 'https://example.com/other', description: '' }] } });
    for (const [label, response] of [['success', [200, suggestion({ status: 'withdrawn', currentRevision: 3 })]], ['error', [409, { error: 'Stale withdrawal for the first suggestion', code: 'STATE_CONFLICT' }]]]) {
      await t.test(`a delayed command ${label} for one suggestion never replaces another suggestion's page`, async () => {
        await fixture({ entry: `/artist-suggestions/${SUBMISSION}`, routes: {
          [`GET /artist-suggestions/${SUBMISSION}`]: [200, suggestion()],
          [`POST /artist-suggestions/${SUBMISSION}/withdraw`]: [{ hold: 'withdraw', response }],
          'GET /artist-suggestions/mine': [200, { suggestions: [suggestion(), other], nextCursor: null }],
          [`GET /artist-suggestions/${OTHER}`]: [200, other],
        } }, async page => {
          await page.getByRole('button', { name: 'Withdraw' }).click();
          await page.waitForFunction(() => Boolean(window.__holds?.withdraw));
          await page.getByRole('link', { name: 'All artist suggestions' }).click();
          await page.getByRole('link', { name: 'Other Band' }).click();
          await page.getByRole('heading', { name: 'Other Band' }).waitFor();
          await page.evaluate(() => window.__release('withdraw'));
          await page.evaluate(() => new Promise(done => setTimeout(done, 150)));
          assert.equal(await page.getByRole('heading', { name: 'Other Band' }).count(), 1, 'the open suggestion stays on screen');
          assert.equal(await page.getByText('Loading…').count(), 0);
          assert.equal(await page.getByText('Stale withdrawal for the first suggestion').count(), 0, 'no error from the other suggestion');
          assert.equal(await page.evaluate(() => window.__location), `/artist-suggestions/${OTHER}`);
          assert.equal(await page.getByText('Withdrawn').count(), 0);
        });
      });
    }

    await t.test('older suggestions stay reachable with Show older suggestions', async () => {
      const older = suggestion({ submissionId: OTHER, status: 'needs_changes', proposal: { proposalKey: 'artist', kind: 'community', canonicalName: 'Older Band', evidence: [] } });
      await fixture({ entry: '/artist-suggestions', routes: {
        'GET /artist-suggestions/mine': [[200, { suggestions: [suggestion()], nextCursor: 'cursor-1' }], [200, { suggestions: [older, suggestion()], nextCursor: null }]],
        [`GET /artist-suggestions/${OTHER}`]: [200, older],
      } }, async page => {
        await page.getByRole('link', { name: 'Brand New Band' }).waitFor();
        await page.getByRole('button', { name: 'Show older suggestions' }).click();
        await page.getByRole('link', { name: 'Older Band' }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Brand New Band' }).count(), 1, 'a repeated row is not duplicated');
        assert.equal(await page.getByRole('button', { name: 'Show older suggestions' }).count(), 0, 'the end of the list has no more button');
        const more = await page.evaluate(() => window.__requests.filter(request => request.path === '/artist-suggestions/mine').map(request => request.search));
        assert.deepEqual(more, ['', '?cursor=cursor-1']);
        await page.getByRole('link', { name: 'Older Band' }).click();
        await page.getByText('Changes requested').first().waitFor();
        await page.getByRole('button', { name: 'Send revision' }).waitFor();
      });
    });

    await t.test('moderator queue appends pages, deduplicates rows, and retries without losing the cursor', async () => {
      await fixture({ entry: '/moderation/artist-suggestions', routes: {
        'GET /moderation/artist-suggestions': [
          [200, { suggestions: [suggestion()], nextCursor: 'next/+=' }],
          [503, { error: 'Page temporarily unavailable' }],
          [200, { suggestions: [suggestion(), other], nextCursor: null }],
        ],
      } }, async page => {
        await page.getByRole('button', { name: 'Load more', exact: true }).click();
        await page.getByText('Page temporarily unavailable').waitFor();
        assert.equal(await page.getByRole('link', { name: 'Brand New Band' }).count(), 1);
        await page.getByRole('button', { name: 'Retry loading suggestions' }).click();
        await page.getByRole('link', { name: 'Other Band' }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Brand New Band' }).count(), 1);
        assert.equal(await page.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
        const queries = await page.evaluate(() => window.__requests.filter(r => r.path === '/moderation/artist-suggestions').map(r => r.search));
        assert.deepEqual(queries, ['?status=pending', '?status=pending&cursor=next%2F%2B%3D', '?status=pending&cursor=next%2F%2B%3D']);
      });
    });

    for (const response of [[200, { suggestions: [other], nextCursor: 'stale-cursor' }], [503, { error: 'Stale page error' }]]) {
      await t.test(`filter changes ignore delayed page ${response[0]} and reset the cursor`, async () => {
        await fixture({ entry: '/moderation/artist-suggestions', routes: {
          'GET /moderation/artist-suggestions': [
            [200, { suggestions: [suggestion()], nextCursor: 'pending-next' }],
            { hold: 'page', response },
            [200, { suggestions: [], nextCursor: null }],
          ],
        } }, async page => {
          await page.getByRole('button', { name: 'Load more', exact: true }).click();
          await page.waitForFunction(() => Boolean(window.__holds?.page));
          assert.equal(await page.getByRole('button', { name: 'Load more', exact: true }).isDisabled(), true);
          await page.getByRole('combobox').selectOption('approved');
          await page.getByText('No artist suggestions here.').waitFor();
          await page.evaluate(() => window.__release('page'));
          await page.waitForFunction(() => window.__completedHolds?.includes('page'));
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await page.getByRole('link', { name: 'Other Band' }).count(), 0);
          assert.equal(await page.getByRole('link', { name: 'Brand New Band' }).count(), 0);
          assert.equal(await page.getByText('Stale page error').count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
          const queries = await page.evaluate(() => window.__requests.filter(r => r.path === '/moderation/artist-suggestions').map(r => r.search));
          assert.deepEqual(queries, ['?status=pending', '?status=pending&cursor=pending-next', '?status=approved']);
        });
      });
    }

    await t.test('a delayed moderator decision never lands on another suggestion', async () => {
      const pending = suggestion({ currentRevision: 2 });
      await fixture({ entry: `/moderation/artist-suggestions/${SUBMISSION}`, routes: {
        'GET /moderation/artist-suggestions': [200, { suggestions: [pending, other] }],
        [`GET /moderation/artist-suggestions/${SUBMISSION}`]: [200, { suggestion: pending, context: { registeredArtist: null, sameNameArtists: [] } }],
        [`GET /moderation/artist-suggestions/${OTHER}`]: [200, { suggestion: other, context: { registeredArtist: null, sameNameArtists: [] } }],
        [`POST /moderation/artist-suggestions/${SUBMISSION}/reject`]: [{ hold: 'reject', response: [409, { error: 'Stale decision for the first suggestion', code: 'STATE_CONFLICT' }] }],
      } }, async page => {
        await page.getByRole('radio', { name: /Reject/ }).check();
        await page.getByLabel(/^Reason/).fill('No evidence');
        await page.getByRole('button', { name: 'Apply decision' }).click();
        await page.waitForFunction(() => Boolean(window.__holds?.reject));
        await page.getByRole('link', { name: 'Other Band' }).click();
        await page.getByRole('heading', { name: 'Other Band' }).waitFor();
        await page.evaluate(() => window.__release('reject'));
        await page.evaluate(() => new Promise(done => setTimeout(done, 150)));
        assert.equal(await page.getByText('Stale decision for the first suggestion').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Apply decision' }).isDisabled(), false, 'the other suggestion is not left pending');
        assert.equal(await page.getByRole('heading', { name: 'Other Band' }).count(), 1);
      });
    });

    for (const [label, response] of [
      ['success', [200, { suggestion: suggestion({ status: 'needs_changes', currentRevision: 1 }), context: { registeredArtist: null, sameNameArtists: [] } }]],
      ['error', [409, { error: 'Stale request-changes from the first visit', code: 'STATE_CONFLICT' }]],
    ]) {
      await t.test(`returning to a suggestion ignores a delayed ${label} sent from the earlier visit`, async () => {
        const firstVisit = suggestion({ currentRevision: 1 });
        const returnVisit = suggestion({ currentRevision: 2 });
        const empty = { registeredArtist: null, sameNameArtists: [] };
        await fixture({ entry: `/moderation/artist-suggestions/${SUBMISSION}`, routes: {
          'GET /moderation/artist-suggestions': [200, { suggestions: [firstVisit, other] }],
          [`GET /moderation/artist-suggestions/${SUBMISSION}`]: [[200, { suggestion: firstVisit, context: empty }], [200, { suggestion: returnVisit, context: empty }]],
          [`GET /moderation/artist-suggestions/${OTHER}`]: [200, { suggestion: other, context: empty }],
          [`POST /moderation/artist-suggestions/${SUBMISSION}/request-changes`]: [{ hold: 'changes', response }],
        } }, async page => {
          const revision = page.locator('.suggestion-detail-revision');
          const status = page.locator('.suggestion-detail .suggestion-status');
          await revision.filter({ hasText: 'Revision 1' }).waitFor();
          await page.getByRole('radio', { name: /Request changes/ }).check();
          await page.getByLabel(/^Reason/).fill('Add a label page');
          await page.getByRole('button', { name: 'Apply decision' }).click();
          await page.waitForFunction(() => Boolean(window.__holds?.changes));
          await page.getByRole('link', { name: 'Other Band' }).click();
          await page.getByRole('heading', { name: 'Other Band' }).waitFor();
          await page.getByRole('link', { name: 'Brand New Band' }).click();
          await revision.filter({ hasText: 'Revision 2' }).waitFor();
          await page.evaluate(() => window.__release('changes'));
          await page.evaluate(() => new Promise(done => setTimeout(done, 150)));
          assert.deepEqual(await revision.allTextContents(), ['Revision 2'], 'the freshly loaded revision stays on screen');
          assert.deepEqual(await status.allTextContents(), ['Waiting for review'], 'the earlier visit\'s result is not applied');
          assert.equal(await page.getByText('Stale request-changes from the first visit').count(), 0, 'nor its error');
          assert.equal(await page.getByRole('button', { name: 'Apply decision' }).isDisabled(), false, 'nor its pending state');
        });
      });
    }

    await t.test('pages fit a phone width', async () => {
      await fixture({ entry: `/moderation/artist-suggestions/${SUBMISSION}`, routes: {
        'GET /moderation/artist-suggestions': [200, { suggestions: [suggestion()] }],
        [`GET /moderation/artist-suggestions/${SUBMISSION}`]: [200, { suggestion: suggestion(), context: { registeredArtist: null, sameNameArtists: [] } }],
      } }, async page => {
        await page.getByRole('button', { name: 'Apply decision' }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        const directory = process.env.FRONTEND_BROWSER_SCREENSHOT_DIR || process.env.FRONTEND_BROWSER_ARTIFACT_DIR;
        if (directory) {
          await fs.mkdir(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, 'artist-suggestion-moderation-390.png'), fullPage: true });
        }
      }, { width: 390, height: 844 });
    });
  } finally { await browser?.close(); await server?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
