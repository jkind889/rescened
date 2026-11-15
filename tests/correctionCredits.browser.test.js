// Explicit offline browser regression for the correction form's artist credits.
// Real CorrectionForm in a synthetic shell: no Clerk, API, database or provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
const TYLER = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const ALBUM_ID = '33333333-3333-4333-8333-333333333333';

const album = {
  albumId: ALBUM_ID, title: 'Igor', artistDisplayName: 'Tyler, The Creator feat. Guest', releaseType: 'album', releaseYear: 2019, releaseDate: '2019-05-17', label: 'Columbia', cover: '', tracks: [],
  artistCredits: [
    { name: 'Tyler, The Creator', role: 'main', artistId: TYLER, artistMbid: MBID },
    { name: 'Guest', role: 'featured', artistId: GUEST },
    { name: 'Unlinked', role: 'producer' },
  ],
};
const source = { type: 'musicbrainz', url: 'https://musicbrainz.org/release-group/x', description: '' };

test('correction form keeps structured artist credits', {
  skip: enabled ? false : 'Run npm run test:browser', timeout: 120000,
}, async (t) => {
  const { chromium } = require('./browser-support/chromium');
  const frontend = path.resolve(__dirname, '../frontend');
  const resolve = createRequire(path.join(frontend, 'package.json'));
  const { createFixtureServer } = require('./browser-support/server');
  const { default: react } = await import(pathToFileURL(resolve.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-correction-credits-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Correction credits fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'entry.jsx'), `
import React from 'react'; import { createRoot } from 'react-dom/client';
import ${JSON.stringify(path.join(frontend, 'src/reset.css'))}; import ${JSON.stringify(path.join(frontend, 'src/index.css'))}; import ${JSON.stringify(path.join(frontend, 'src/App.css'))};
import CorrectionForm from ${JSON.stringify(path.join(frontend, 'src/Components/Community/CorrectionForm.jsx'))};
const root = createRoot(document.getElementById('root'));
window.__submits = [];
window.__mount = props => root.render(<CorrectionForm {...props} onSubmit={payload => window.__submits.push(JSON.parse(JSON.stringify(payload)))} />);
window.__unmount = () => root.render(null);
`);
    server = await createFixtureServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: Object.fromEntries(['react', 'react-dom'].map(name => [name, path.dirname(resolve.resolve(`${name}/package.json`))])) },
      server: { hmr: false, watch: null, fs: { allow: [directory, frontend, require('node:fs').realpathSync(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function fixture(props, run, viewport = { width: 1100, height: 900 }) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(10000); // a missing control fails the subtest quickly instead of hanging
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        await page.goto(url);
        await page.waitForFunction(() => typeof window.__mount === 'function');
        await page.evaluate(mountProps => window.__mount(mountProps), props);
        await page.getByRole('checkbox', { name: 'Title', exact: true }).waitFor();
        await run(page);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
    const fresh = { initialValue: { targetAlbumId: ALBUM_ID, targetAlbum: album }, draftKey: '' };
    const group = (page, name) => page.getByRole('checkbox', { name, exact: true });
    const submits = page => page.evaluate(() => window.__submits);
    async function send(page) {
      await page.getByRole('textbox', { name: 'HTTPS source URL' }).fill(source.url);
      await page.getByRole('button', { name: 'Send correction for review' }).click();
    }
    const names = page => page.locator('[aria-label$=" name"]').evaluateAll(inputs => inputs.map(input => input.value));

    await t.test('a comma in a name is one credit; links, roles and order survive an untouched submit', async () => {
      await fixture(fresh, async page => {
        await group(page, 'Artists').check();
        assert.deepEqual(await names(page), ['Tyler, The Creator', 'Guest', 'Unlinked']);
        assert.equal(await page.getByRole('textbox', { name: 'Artist 2 role' }).inputValue(), 'featured');
        assert.equal(await page.getByRole('link', { name: 'MusicBrainz artist' }).getAttribute('href'), `https://musicbrainz.org/artist/${MBID}`);
        assert.equal(await page.getByText('Linked to a Rescened artist.').count(), 1);
        await send(page);
        const [payload] = await submits(page);
        assert.equal(payload.albumId, ALBUM_ID);
        assert.deepEqual(payload.proposedChanges, { artists: { artistDisplayName: album.artistDisplayName, artistCredits: album.artistCredits } });
      });
    });

    await t.test('editing one row, a role, and adding or removing rows submits explicit structured credits', async () => {
      await fixture(fresh, async page => {
        await group(page, 'Artists').check();
        // Rename the linked guest: the link is dropped, role and position are kept.
        await page.getByRole('textbox', { name: 'Artist 2 name' }).fill('Guest, Jr.');
        assert.equal(await page.getByText('Linked to a Rescened artist.').count(), 0);
        // A role edit keeps the identity.
        await page.getByRole('textbox', { name: 'Artist 1 role' }).fill('lead');
        await page.getByRole('button', { name: 'Remove artist 3' }).click();
        await page.getByRole('button', { name: '+ Add artist credit' }).click();
        await page.getByRole('textbox', { name: 'Artist 3 name' }).fill('Doe, John');
        await send(page);
        assert.deepEqual((await submits(page))[0].proposedChanges.artists.artistCredits, [
          { name: 'Tyler, The Creator', role: 'lead', artistId: TYLER, artistMbid: MBID },
          { name: 'Guest, Jr.', role: 'featured' },
          { name: 'Doe, John', role: 'main' },
        ]);
      });
    });

    await t.test('the last row cannot be removed, and a blank row blocks submission with a message', async () => {
      await fixture(fresh, async page => {
        await group(page, 'Artists').check();
        await page.getByRole('button', { name: 'Remove artist 3' }).click();
        await page.getByRole('button', { name: 'Remove artist 2' }).click();
        assert.equal(await page.getByRole('button', { name: 'Remove artist 1' }).isDisabled(), true);
        await page.getByRole('button', { name: '+ Add artist credit' }).click();
        await send(page);
        await page.getByText('Artist 2 needs a name.').waitFor();
        assert.deepEqual(await submits(page), []);
        await page.getByRole('textbox', { name: 'Artist 2 name' }).fill('Second');
        await page.getByRole('button', { name: 'Send correction for review' }).click();
        assert.equal((await submits(page)).length, 1);
        assert.deepEqual((await submits(page))[0].proposedChanges.artists.artistCredits.map(credit => credit.name), ['Tyler, The Creator', 'Second']);
      });
    });

    await t.test('the add button stops at twenty credits', async () => {
      await fixture(fresh, async page => {
        await group(page, 'Artists').check();
        const add = page.getByRole('button', { name: '+ Add artist credit' });
        for (let i = 0; i < 17; i++) await add.click();
        assert.equal((await names(page)).length, 20);
        assert.equal(await add.isDisabled(), true);
      });
    });

    await t.test('unrelated groups are submitted without artists, and artists stay out when unselected', async () => {
      await fixture(fresh, async page => {
        await group(page, 'Title').check();
        await page.getByRole('textbox', { name: 'Corrected title' }).fill('Igor (Deluxe)');
        await send(page);
        assert.deepEqual((await submits(page))[0].proposedChanges, { title: 'Igor (Deluxe)' });
      });
      await fixture(fresh, async page => {
        await group(page, 'Artists').check();
        await group(page, 'Label').check();
        await page.getByRole('textbox', { name: /Label/ }).fill('Odd Future');
        await page.getByRole('textbox', { name: 'Artist 1 name' }).fill('Tyler');
        await group(page, 'Artists').uncheck();
        await send(page);
        const changes = (await submits(page))[0].proposedChanges;
        assert.deepEqual(changes, { label: 'Odd Future' });
        // Re-selecting the group keeps the earlier edit in the form.
        await group(page, 'Artists').check();
        assert.equal(await page.getByRole('textbox', { name: 'Artist 1 name' }).inputValue(), 'Tyler');
      });
    });

    await t.test('a revision starts from the stored proposal, with its identities, roles and order', async () => {
      const revision = {
        submissionId: '44444444-4444-4444-8444-444444444444', targetAlbumId: ALBUM_ID, targetAlbum: album, supportingSources: [source],
        proposedChanges: { artists: { artistDisplayName: 'Tyler, The Creator', artistCredits: [
          { name: 'Guest', role: 'featured', artistId: GUEST },
          { name: 'Tyler, The Creator', role: 'main', artistMbid: MBID },
        ] } },
      };
      await fixture({ initialValue: revision, draftKey: '' }, async page => {
        assert.deepEqual(await names(page), ['Guest', 'Tyler, The Creator']);
        await page.getByRole('button', { name: 'Send correction for review' }).click();
        const [payload] = await submits(page);
        assert.equal('albumId' in payload, false, 'a revision does not resend the album');
        assert.deepEqual(payload.proposedChanges.artists.artistCredits, revision.proposedChanges.artists.artistCredits);
      });
    });

    await t.test('draft editing stores rows with their identity and no per-load keys', async () => {
      await fixture({ ...fresh, draftKey: 'rescened:suggestion-draft:v1:fixture:correction' }, async page => {
        await group(page, 'Artists').check();
        await page.getByRole('textbox', { name: 'Artist 3 name' }).fill('Renamed, Producer');
        await page.getByRole('button', { name: 'Remove artist 2' }).click();
        await page.getByRole('button', { name: '+ Add artist credit' }).click();
        await page.getByRole('textbox', { name: 'Artist 3 name' }).fill('Added, Person');
        await page.waitForFunction(() => Object.keys(localStorage).some(key => key.includes('fixture:correction')));
        await page.waitForTimeout(600);
        const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('rescened:suggestion-draft:v1:fixture:correction')));
        assert.deepEqual(stored.value.values.artistCredits.map(row => row.name), ['Tyler, The Creator', 'Renamed, Producer', 'Added, Person']);
        assert.ok(stored.value.values.artistCredits.every(row => !('key' in row)), 'row keys are never stored');
        assert.ok(stored.value.values.artistCredits.every(row => typeof row.name === 'string' && typeof row.role === 'string'));
        assert.equal(stored.value.values.artistCredits[0].identity.artistId, TYLER, 'identity is stored with its row');
      });
    });

    await t.test('a stored draft survives a reload of the form and can be discarded', async () => {
      const draftKey = 'rescened:suggestion-draft:v1:fixture:reload';
      await fixture({ ...fresh, draftKey }, async page => {
        await group(page, 'Artists').check();
        await page.getByRole('textbox', { name: 'Artist 3 name' }).fill('Renamed, Producer');
        await page.getByRole('button', { name: 'Remove artist 2' }).click();
        await page.waitForTimeout(700);
        await page.evaluate(() => window.__unmount());
        await page.evaluate(props => window.__mount(props), { ...fresh, draftKey });
        await page.getByText(/Restored your unsent draft/).waitFor();
        assert.deepEqual(await names(page), ['Tyler, The Creator', 'Renamed, Producer']);
        assert.equal(await page.getByRole('link', { name: 'MusicBrainz artist' }).count(), 1, 'the unchanged linked credit is still linked');
        await send(page);
        assert.deepEqual((await submits(page))[0].proposedChanges.artists.artistCredits, [
          { name: 'Tyler, The Creator', role: 'main', artistId: TYLER, artistMbid: MBID },
          { name: 'Renamed, Producer', role: 'producer' },
        ]);
        // Discarding returns to the album's own credits.
        await page.evaluate(() => window.__unmount());
        await page.evaluate(props => window.__mount(props), { ...fresh, draftKey });
        await page.getByText(/Restored your unsent draft/).waitFor();
        await page.getByRole('button', { name: 'Discard draft' }).click();
        await group(page, 'Artists').check();
        assert.deepEqual(await names(page), ['Tyler, The Creator', 'Guest', 'Unlinked']);
      });
    });

    await t.test('a draft saved by the old comma-joined field is ignored, not split', async () => {
      const draftKey = 'rescened:suggestion-draft:v1:fixture:legacy';
      await fixture({ ...fresh, draftKey }, async page => {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value })), {
          key: draftKey,
          value: { enabledFields: ['artists', 'label'], values: { artistDisplayName: 'Legacy', artistCredits: 'Tyler, The Creator, Guest', label: 'Legacy label' }, source },
        });
        await page.evaluate(() => window.__unmount());
        await page.evaluate(props => window.__mount(props), { ...fresh, draftKey });
        await page.getByText(/Restored your unsent draft/).waitFor();
        assert.deepEqual(await names(page), ['Tyler, The Creator', 'Guest', 'Unlinked']);
        assert.equal(await page.getByRole('textbox', { name: 'Artist display name' }).inputValue(), 'Legacy');
        assert.equal(await page.getByRole('textbox', { name: /Label/ }).inputValue(), 'Legacy label');
      });
    });

    await t.test('an album with 21 credits keeps all of them and blocks submission instead of truncating', async () => {
      const many = { ...album, artistCredits: Array.from({ length: 21 }, (_, i) => ({ name: `Artist, ${i + 1}`, role: i === 20 ? 'featured' : 'main', ...(i === 20 ? { artistId: GUEST } : {}) })) };
      const longAlbum = { initialValue: { targetAlbumId: ALBUM_ID, targetAlbum: many }, draftKey: '' };
      await fixture(longAlbum, async page => {
        await group(page, 'Artists').check();
        assert.equal((await names(page)).length, 21, 'every credit loads');
        assert.equal(await page.getByRole('textbox', { name: 'Artist 21 name' }).inputValue(), 'Artist, 21');
        assert.equal(await page.getByRole('textbox', { name: 'Artist 21 role' }).inputValue(), 'featured');
        await page.getByText(/This album has 21 artist credits\. A correction can carry at most 20/).waitFor();
        assert.equal(await page.getByRole('button', { name: '+ Add artist credit' }).isDisabled(), true);
        await send(page);
        await page.getByText(/at most 20 artist credits, and this form has 21/).waitFor();
        assert.deepEqual(await submits(page), [], 'nothing is submitted with a credit silently missing');
        // Only an explicit removal gets under the limit.
        await page.getByRole('button', { name: 'Remove artist 21' }).click();
        await page.getByRole('button', { name: 'Send correction for review' }).click();
        const [payload] = await submits(page);
        assert.equal(payload.proposedChanges.artists.artistCredits.length, 20);
        assert.equal(payload.proposedChanges.artists.artistCredits[19].name, 'Artist, 20');
      });
      // The limit applies to the Artists group only; other groups are unaffected.
      await fixture(longAlbum, async page => {
        await group(page, 'Label').check();
        await page.getByRole('textbox', { name: /Label/ }).fill('Odd Future');
        await send(page);
        assert.deepEqual((await submits(page))[0].proposedChanges, { label: 'Odd Future' });
      });
      // A saved draft of the long album keeps all rows too.
      const draftKey = 'rescened:suggestion-draft:v1:fixture:long';
      await fixture({ ...longAlbum, draftKey }, async page => {
        await group(page, 'Artists').check();
        await page.getByRole('textbox', { name: 'Artist 1 name' }).fill('Edited, First');
        await page.waitForTimeout(700);
        await page.evaluate(() => window.__unmount());
        await page.evaluate(props => window.__mount(props), { ...longAlbum, draftKey });
        await page.getByText(/Restored your unsent draft/).waitFor();
        assert.equal((await names(page)).length, 21);
        assert.equal(await page.getByRole('textbox', { name: 'Artist 1 name' }).inputValue(), 'Edited, First');
      });
    });

    await t.test('a legacy draft with credit edits says they were not restored; an unedited one does not', async () => {
      const keyFor = name => `rescened:suggestion-draft:v1:fixture:${name}`;
      async function restoreLegacy(page, name, credits) {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value })), {
          key: keyFor(name), value: { enabledFields: ['artists'], values: { artistDisplayName: album.artistDisplayName, artistCredits: credits }, source },
        });
        await page.evaluate(() => window.__unmount());
        await page.evaluate(props => window.__mount(props), { ...fresh, draftKey: keyFor(name) });
        await page.getByText(/Restored your unsent draft/).waitFor();
      }
      await fixture(fresh, async page => {
        await restoreLegacy(page, 'legacy-edited', 'Tyler, The Creator, Someone New');
        await page.getByText(/artist credit edits in that draft could not be restored/).waitFor();
        assert.deepEqual(await names(page), ['Tyler, The Creator', 'Guest', 'Unlinked']);
        await page.getByRole('button', { name: 'Discard draft' }).click();
        assert.equal(await page.getByText(/could not be restored/).count(), 0, 'discarding clears the note');
      });
      await fixture(fresh, async page => {
        await restoreLegacy(page, 'legacy-same', 'Tyler, The Creator, Guest, Unlinked');
        assert.equal(await page.getByText(/could not be restored/).count(), 0, 'no edits were lost, so nothing is disclosed');
      });
    });

    await t.test('credit rows fit a phone width', async () => {
      await fixture(fresh, async page => {
        await group(page, 'Artists').check();
        await page.locator('.correction-credits').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 390px');
        if (process.env.FRONTEND_BROWSER_SCREENSHOT_DIR) {
          await fs.mkdir(process.env.FRONTEND_BROWSER_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.FRONTEND_BROWSER_SCREENSHOT_DIR, 'correction-credits-390.png'), fullPage: true });
        }
      }, { width: 390, height: 844 });
    });
  } finally { await browser?.close(); await server?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
