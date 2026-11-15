// Explicit offline browser fixture for artist links on album suggestions:
// the real SuggestionForm (credit rows with the shared picker), the real
// ModeratorDecision, and the real SubmissionDetails, in a synthetic shell
// with a stubbed Clerk hook and an in-page fetch stub. No API server,
// database, Clerk, or MusicBrainz.
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
const EVIDENCE = 'https://example.com/private-band-page';

const LOCAL_RESULTS = { query: 'Tyler', results: [{ artistId: LOCAL, name: 'Tyler Canonical', artistMbid: '', releaseCount: 2, knownFor: ['Igor'] }] };
const PROVIDER_RESULTS = { query: 'Tyler', candidates: [{ artistMbid: MBID, name: 'Guest Canonical', disambiguation: 'US rapper', type: 'Person', country: 'US', registeredArtistId: null }] };

function linkedSubmission(overrides = {}) {
  return {
    submissionId: '22222222-2222-4222-8222-222222222222',
    submissionType: 'new_album',
    status: 'pending',
    currentRevision: 3,
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
    proposedMetadata: {
      title: 'Linked Album', artistDisplayName: 'Tyler, the Creator feat. Guest & New Band', releaseType: 'album', releaseDate: '2026', releaseYear: 2026,
      artistCredits: [{ name: 'Tyler, the Creator', role: 'main' }, { name: 'Guest', role: 'featured' }, { name: 'New Band', role: 'producer' }],
      tracks: [],
    },
    supportingSources: [{ type: 'other', url: 'https://example.com/release', description: '' }],
    externalReferences: [],
    artistProposals: [
      { proposalKey: 'mb-1', kind: 'musicbrainz', artistMbid: MBID, observation: { artistMbid: MBID, name: 'Guest Canonical', disambiguation: 'US rapper', observedAt: '2026-11-14T10:00:00.000Z' } },
      { proposalKey: 'new-1', kind: 'community', canonicalName: 'New Band', evidence: [{ url: EVIDENCE, description: '' }] },
    ],
    artistSelections: [
      { position: 0, kind: 'existing', artistId: LOCAL },
      { position: 1, kind: 'proposal', proposalKey: 'mb-1' },
      { position: 2, kind: 'proposal', proposalKey: 'new-1' },
    ],
    revisions: [],
    moderationHistory: [],
    ...overrides,
  };
}

test('artist links on album suggestions', {
  skip: enabled ? false : 'Run npm run test:browser', timeout: 180000,
}, async (t) => {
  const { chromium } = require('./browser-support/chromium');
  const frontend = path.resolve(__dirname, '../frontend');
  const resolve = createRequire(path.join(frontend, 'package.json'));
  const { createFixtureServer } = require('./browser-support/server');
  const { default: react } = await import(pathToFileURL(resolve.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-artist-suggestion-form-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artist suggestion fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'auth.js'), `
const getToken = async () => 'fixture-token';
export function useAuth() { return { isLoaded: true, isSignedIn: true, userId: 'user_fixture', getToken }; }
`);
    await fs.writeFile(path.join(directory, 'entry.jsx'), `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { MemoryRouter } from 'react-router-dom';
import ${JSON.stringify(path.join(frontend, 'src/reset.css'))}; import ${JSON.stringify(path.join(frontend, 'src/index.css'))}; import ${JSON.stringify(path.join(frontend, 'src/App.css'))};
import SuggestionForm from ${JSON.stringify(path.join(frontend, 'src/Components/Community/SuggestionForm.jsx'))};
import ModeratorDecision from ${JSON.stringify(path.join(frontend, 'src/Components/Community/ModeratorDecision.jsx'))};
import SubmissionDetails from ${JSON.stringify(path.join(frontend, 'src/Components/Community/SubmissionDetails.jsx'))};

// Fetch stub: capability answers come from window.__linking; discovery
// answers are canned; everything else reports a disabled feature.
window.__linking = true;
window.__requests = [];
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  window.__requests.push(url.pathname);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/artist-discovery/capabilities') {
    if (window.__capabilityHold) await new Promise(resolveHold => { window.__releaseCapabilities = resolveHold; });
    if (window.__capabilityError) return json(500, { error: 'capability check failed' });
    return json(200, { enabled: window.__linking });
  }
  if (url.pathname === '/artist-discovery/local') return json(200, ${JSON.stringify(LOCAL_RESULTS)});
  if (url.pathname === '/artist-discovery/musicbrainz') return json(200, ${JSON.stringify(PROVIDER_RESULTS)});
  if (url.pathname.endsWith('/capabilities')) return json(200, { enabled: false });
  return json(503, { error: 'disabled in fixture', code: 'DISABLED' });
};
const getToken = async () => 'fixture-token';
const root = createRoot(document.getElementById('root'));
window.__payloads = [];
window.__commands = [];
window.__mountForm = initialValue => root.render(<MemoryRouter><SuggestionForm initialValue={initialValue} getToken={getToken} onSubmit={payload => { window.__payloads.push(JSON.parse(JSON.stringify(payload))); }} /></MemoryRouter>);
window.__mountReview = (submission, props = {}) => root.render(<MemoryRouter>
  <SubmissionDetails submission={submission} showContributor artistRegistry={{ ${JSON.stringify(LOCAL)}: { artistId: ${JSON.stringify(LOCAL)}, name: 'Tyler Canonical', artistMbid: '' } }} artistProposalRegistry={props.proposalRegistry || null} />
  <ModeratorDecision submission={submission} duplicateCandidates={props.duplicateCandidates || {}} onCommand={(action, body) => window.__commands.push({ action, body })} />
</MemoryRouter>);
`);
    server = await createFixtureServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: { '@clerk/react': path.join(directory, 'auth.js'), ...Object.fromEntries(['react', 'react-dom', 'react-router-dom'].map(name => [name, path.dirname(resolve.resolve(`${name}/package.json`))])) } },
      server: { hmr: false, watch: null, fs: { allow: [directory, frontend, require('node:fs').realpathSync(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function fixture(run, viewport = { width: 1200, height: 1000 }) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        await page.goto(url);
        await page.waitForFunction(() => typeof window.__mountForm === 'function');
        await run(page);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    const initial = {
      proposedMetadata: {
        title: 'Fixture Album', releaseType: 'album', releaseDate: '2026',
        artistCredits: [
          { name: 'Tyler, the Creator', role: 'main' },
          { name: 'Prefilled', role: 'featured', artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711' },
          { name: 'Guest', role: 'featured' },
        ],
      },
      supportingSources: [{ type: 'other', url: 'https://example.com/source' }],
    };
    const row = (page, n) => page.locator('.suggestion-form-repeater-row').filter({ has: page.getByText(`Artist ${String(n).padStart(2, '0')}`, { exact: true }) });

    await t.test('credit rows link artists explicitly without changing credit wording', async () => {
      await fixture(async page => {
        await page.evaluate(value => window.__mountForm(value), initial);
        await row(page, 1).getByRole('searchbox', { name: 'Find the artist' }).waitFor();
        assert.equal(await row(page, 2).getByRole('searchbox').count(), 0, 'a credit with its prefill identity gets no picker');

        // Enter in the picker searches; it must not submit the suggestion.
        await row(page, 1).getByRole('searchbox', { name: 'Find the artist' }).fill('Tyler');
        await row(page, 1).getByRole('searchbox', { name: 'Find the artist' }).press('Enter');
        await row(page, 1).getByRole('list', { name: 'Rescened artists' }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__payloads), [], 'the surrounding form was not submitted');
        await row(page, 1).getByRole('button', { name: 'Choose Tyler Canonical' }).click();
        await row(page, 1).getByText('The credit keeps its wording, “Tyler, the Creator”.').waitFor();

        await row(page, 3).getByRole('button', { name: 'Search artists' }).click();
        await row(page, 3).getByRole('list', { name: 'MusicBrainz artists' }).waitFor();
        await row(page, 3).getByRole('button', { name: 'Choose Guest Canonical' }).click();

        await page.getByRole('button', { name: '+ Add artist credit' }).click();
        const added = row(page, 4);
        await added.getByRole('textbox', { name: 'Name *' }).fill('New Band, Ltd.');
        await added.getByRole('button', { name: 'Not listed? Propose a new artist' }).click();
        await added.getByRole('textbox', { name: 'Supporting link 1' }).fill(EVIDENCE);
        await added.getByRole('textbox', { name: 'Supporting link 1' }).press('Enter');
        await added.getByText('New community artist, reviewed by a moderator').waitFor();
        assert.deepEqual(await page.evaluate(() => window.__payloads), [], 'Enter in the community fields did not submit the suggestion');

        await page.getByRole('button', { name: 'Send for review' }).click();
        const [payload] = await page.evaluate(() => window.__payloads);
        assert.deepEqual(payload.proposedMetadata.artistCredits, [
          { name: 'Tyler, the Creator', role: 'main' },
          { name: 'Prefilled', role: 'featured', artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711' },
          { name: 'Guest', role: 'featured' },
          { name: 'New Band, Ltd.', role: 'main' },
        ]);
        assert.deepEqual(payload.artistProposals, [
          { proposalKey: 'mb-1', kind: 'musicbrainz', artistMbid: MBID },
          { proposalKey: 'new-1', kind: 'community', canonicalName: 'New Band, Ltd.', evidence: [{ url: EVIDENCE }] },
        ]);
        assert.deepEqual(payload.artistSelections, [
          { position: 0, kind: 'existing', artistId: LOCAL },
          { position: 2, kind: 'proposal', proposalKey: 'mb-1' },
          { position: 3, kind: 'proposal', proposalKey: 'new-1' },
        ]);
        assert.equal('requestKey' in payload, false, 'the editor page, not the form, adds the request key');
      });
    });

    await t.test('removing a linked credit renumbers positions and drops its link', async () => {
      await fixture(async page => {
        await page.evaluate(value => window.__mountForm(value), { ...initial, proposedMetadata: { ...initial.proposedMetadata, artistCredits: [{ name: 'First' }, { name: 'Second' }, { name: 'Third' }] } });
        await row(page, 2).getByRole('button', { name: 'Search artists' }).click();
        await row(page, 2).getByRole('button', { name: 'Choose Tyler Canonical' }).click();
        await row(page, 3).getByRole('button', { name: 'Search artists' }).click();
        await row(page, 3).getByRole('button', { name: 'Choose Guest Canonical' }).click();
        await row(page, 2).getByRole('button', { name: 'Remove', exact: true }).click();
        await page.getByRole('button', { name: 'Send for review' }).click();
        const [payload] = await page.evaluate(() => window.__payloads);
        assert.deepEqual(payload.proposedMetadata.artistCredits.map(credit => credit.name), ['First', 'Third']);
        assert.deepEqual(payload.artistSelections, [{ position: 1, kind: 'proposal', proposalKey: 'mb-1' }]);
      });
    });

    await t.test('with linking off the form keeps the legacy payload and shows no picker', async () => {
      await fixture(async page => {
        await page.evaluate(() => { window.__linking = false; });
        await page.evaluate(value => window.__mountForm(value), initial);
        await page.getByRole('button', { name: 'Send for review' }).waitFor();
        await page.waitForFunction(() => window.__requests.includes('/artist-discovery/capabilities'));
        assert.equal(await page.getByRole('searchbox', { name: 'Find the artist' }).count(), 0);
        await page.getByRole('button', { name: 'Send for review' }).click();
        const [payload] = await page.evaluate(() => window.__payloads);
        assert.equal('artistSelections' in payload, false);
        assert.equal('artistProposals' in payload, false);
      });
    });

    await t.test('a revision restores stored links onto their credits', async () => {
      await fixture(async page => {
        await page.evaluate(value => window.__mountForm(value), linkedSubmission());
        await row(page, 2).getByRole('button', { name: 'Remove link to Guest Canonical' }).waitFor();
        assert.equal(await row(page, 1).locator('.artist-picker-selection-name').textContent(), 'Tyler, the Creator', 'existing links show the credit wording without registry access');
        await row(page, 3).getByText('New community artist, reviewed by a moderator').waitFor();
        await page.getByRole('button', { name: 'Send for review' }).click();
        const [payload] = await page.evaluate(() => window.__payloads);
        assert.deepEqual(payload.artistSelections.map(selection => selection.position), [0, 1, 2]);
        assert.deepEqual(payload.artistProposals[1], { proposalKey: 'new-1', kind: 'community', canonicalName: 'New Band', evidence: [{ url: EVIDENCE }] });
      });
    });

    await t.test('a revision waits for the capability answer instead of dropping its stored links', async () => {
      await fixture(async page => {
        await page.evaluate(() => { window.__capabilityHold = true; });
        await page.evaluate(value => window.__mountForm(value), linkedSubmission());
        await page.getByText('Checking whether artist linking is available. This credit’s artist link is kept.').first().waitFor();
        await page.getByRole('button', { name: 'Send for review' }).click();
        await page.getByText('Still checking whether artist linking is available. Try again in a moment so your artist links are kept.').waitFor();
        assert.deepEqual(await page.evaluate(() => window.__payloads), [], 'nothing is submitted while the answer is unknown');
        await page.evaluate(() => window.__releaseCapabilities());
        await row(page, 2).getByRole('button', { name: 'Remove link to Guest Canonical' }).waitFor();
        await page.getByRole('button', { name: 'Send for review' }).click();
        const [payload] = await page.evaluate(() => window.__payloads);
        assert.deepEqual(payload.artistSelections.map(selection => selection.position), [0, 1, 2], 'the stored links are sent once linking is confirmed');
      });
    });

    await t.test('a failed capability check blocks a linked revision; legacy suggestions still send', async () => {
      await fixture(async page => {
        await page.evaluate(() => { window.__capabilityError = true; });
        await page.evaluate(value => window.__mountForm(value), linkedSubmission());
        await page.getByText('Artist linking could not be checked, so this credit’s artist link cannot be sent until you reload.').first().waitFor();
        await page.getByRole('button', { name: 'Send for review' }).click();
        await page.getByText(/Could not check whether artist linking is available, so your artist links cannot be sent/).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__payloads), []);
      });
      await fixture(async page => {
        await page.evaluate(() => { window.__capabilityError = true; });
        await page.evaluate(value => window.__mountForm(value), initial);
        await page.waitForFunction(() => window.__requests.includes('/artist-discovery/capabilities'));
        await page.getByRole('button', { name: 'Send for review' }).click();
        const [payload] = await page.evaluate(() => window.__payloads);
        assert.equal('artistSelections' in payload, false, 'a suggestion without links is not blocked by the capability check');
      });
    });

    await t.test('a confirmed "off" says the links will not be sent before omitting them', async () => {
      await fixture(async page => {
        await page.evaluate(() => { window.__linking = false; });
        await page.evaluate(value => window.__mountForm(value), linkedSubmission());
        await page.getByText('Artist linking is turned off, so this credit’s artist link will not be sent.').first().waitFor();
        await page.getByRole('button', { name: 'Send for review' }).click();
        const [payload] = await page.evaluate(() => window.__payloads);
        assert.equal('artistSelections' in payload, false);
      });
    });

    await t.test('moderators review each link and approve only the displayed revision as a new album', async () => {
      await fixture(async page => {
        await page.evaluate(value => window.__mountReview(value, { proposalRegistry: {} }), linkedSubmission());
        await page.getByText('Linked to Rescened artist').waitFor();
        assert.match(await page.locator('.suggestion-credit-item').nth(0).textContent(), /Tyler Canonical/);
        assert.match(await page.locator('.suggestion-credit-item').nth(1).textContent(), /Proposed MusicBrainz artist Guest Canonical \(US rapper\), checked 2026-11-14/);
        assert.match(await page.locator('.suggestion-credit-item').nth(2).textContent(), /Proposed new artist New Band/);
        assert.equal(await page.locator('.suggestion-credit-item').nth(2).getByRole('link', { name: 'link 1' }).getAttribute('href'), EVIDENCE);
        await page.getByText('This suggestion can only be approved as a new album.').waitFor();
        assert.equal(await page.getByLabel('Existing catalog album ID').count(), 0, 'no link-existing input for artist links');
        await page.getByRole('button', { name: 'Approve & publish' }).click();
        assert.deepEqual(await page.evaluate(() => window.__commands), [{ action: 'approve', body: { expectedRevision: 3 } }]);
      });
    });

    await t.test('every album approval names the displayed revision, linked or not', async () => {
      await fixture(async page => {
        const plain = linkedSubmission({ artistProposals: undefined, artistSelections: undefined, currentRevision: 2 });
        await page.evaluate(value => window.__mountReview(value), plain);
        await page.getByLabel('Existing catalog album ID').fill('33333333-3333-4333-8333-333333333333');
        await page.getByRole('button', { name: 'Approve & publish' }).click();
        assert.deepEqual(await page.evaluate(() => window.__commands), [{ action: 'approve', body: { expectedRevision: 2, albumId: '33333333-3333-4333-8333-333333333333' } }]);
        assert.equal(await page.getByText('This suggestion can only be approved as a new album.').count(), 0);
      });
    });

    await t.test('approved resolutions and the reuse hint are shown; 390 px fits', async () => {
      await fixture(async page => {
        const approved = linkedSubmission({
          status: 'approved',
          artistResolutions: [
            { position: 0, kind: 'existing', proposalKey: '', artistId: LOCAL, artistMbid: '', outcome: 'linked' },
            { position: 1, kind: 'musicbrainz', proposalKey: 'mb-1', artistId: '44444444-4444-4444-8444-444444444444', artistMbid: MBID, outcome: 'reused' },
            { position: 2, kind: 'community', proposalKey: 'new-1', artistId: '55555555-5555-4555-8555-555555555555', artistMbid: '', outcome: 'created' },
          ],
        });
        await page.evaluate(value => window.__mountReview(value, { proposalRegistry: { [value.artistProposals[0].artistMbid]: { artistId: '44444444-4444-4444-8444-444444444444', name: 'Guest Registry', artistMbid: value.artistProposals[0].artistMbid } } }), approved);
        await page.getByText('Already on Rescened as').waitFor();
        assert.match(await page.locator('.suggestion-credit-item').nth(1).textContent(), /Linked to existing 44444444/);
        assert.match(await page.locator('.suggestion-credit-item').nth(2).textContent(), /Added as 55555555/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 390px');
        const directory = process.env.FRONTEND_BROWSER_SCREENSHOT_DIR || process.env.FRONTEND_BROWSER_ARTIFACT_DIR;
        if (directory) {
          await fs.mkdir(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, 'artist-suggestion-review-390.png'), fullPage: true });
        }
      }, { width: 390, height: 844 });
      await fixture(async page => {
        await page.evaluate(value => window.__mountForm(value), initial);
        await row(page, 1).getByRole('button', { name: 'Search artists' }).click();
        await row(page, 1).getByRole('list', { name: 'MusicBrainz artists' }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the form with a picker fits at 390px');
        const directory = process.env.FRONTEND_BROWSER_SCREENSHOT_DIR || process.env.FRONTEND_BROWSER_ARTIFACT_DIR;
        if (directory) await page.screenshot({ path: path.join(directory, 'artist-suggestion-form-390.png'), fullPage: true });
      }, { width: 390, height: 844 });
    });
  } finally { await browser?.close(); await server?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
