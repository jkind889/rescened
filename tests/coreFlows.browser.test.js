// Real components in a synthetic shell, not app routing or Clerk/API E2E.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';

test('review submission survives navigation, isolates users, and retries the same request; public biography carries attribution', {
  skip: enabled ? false : 'Run npm run test:browser', timeout: 60000,
}, async () => {
  const { chromium } = require('./browser-support/chromium');
  const frontend = path.resolve(__dirname, '../frontend');
  const resolve = createRequire(path.join(frontend, 'package.json'));
  const { createFixtureServer } = require('./browser-support/server');
  const { default: react } = await import(pathToFileURL(resolve.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-core-browser-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Core fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'entry.jsx'), `
import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
import ReviewForm from ${JSON.stringify(path.join(frontend, 'src/Components/ReviewForm.jsx'))};
import ArtistBiography from ${JSON.stringify(path.join(frontend, 'src/features/artists/ArtistBiography.jsx'))};
import BoardItemNote from ${JSON.stringify(path.join(frontend, 'src/Components/BoardItemNote.jsx'))};
window.__requests = []; window.__completed = 0;
const album = { albumId: '11111111-1111-4111-8111-111111111111', title: 'Fixture Album' };
window.fetch = async (url) => ({ ok: true, json: async () => ({ biography: String(url).includes('/visible/') ? {
 text: 'A synthetic artist biography.', language: 'en', shortened: true, edited: true,
 article: { title: 'Fixture Artist', url: 'https://example.invalid/article', revisionUrl: 'https://example.invalid/revision', revisionId: 42 },
 license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }
} : null }) });
function App() {
 const [shown, show] = useState(true), [user, setUser] = useState('one'), [artist, setArtist] = useState('visible');
 const [note, setNote] = useState(''), [editor, setEditor] = useState(null);
 return <main><h1>{album.title}</h1><button onClick={() => show(!shown)}>Navigate</button><button onClick={() => setUser(user === 'one' ? 'two' : 'one')}>Switch user</button>
 <button onClick={() => setArtist(artist === 'visible' ? 'hidden' : 'visible')}>Toggle biography</button>
 {shown && <ReviewForm key={user} album={album} userId={user} isOpen={true} onClose={() => show(false)} onSubmitted={() => { window.__completed++; }}
 onAddReview={(body, key) => new Promise(resolve => { window.__requests.push({ body, key }); window.__resolveReview = resolve; })} />}
 <ArtistBiography artistId={artist} />
 <BoardItemNote album={{ ...album, note }} editor={editor} onEdit={() => setEditor({ draft: note })} onChange={draft => setEditor({ draft })} onCancel={() => setEditor(null)} onSave={event => { event.preventDefault(); setNote(editor.draft.trim()); setEditor(null); }} />
 </main>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
`);
    server = await createFixtureServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://fixture.invalid') },
      resolve: { alias: Object.fromEntries(['react', 'react-dom'].map(name => [name, path.dirname(resolve.resolve(`${name}/package.json`))])) },
      server: { hmr: false, watch: null, fs: { allow: [directory, frontend] } },
    });
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await page.getByRole('heading', { name: 'Fixture Album' }).waitFor();
    await page.getByText('A synthetic artist biography.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'revision 42' }).getAttribute('href'), 'https://example.invalid/revision');
    assert.equal(await page.locator('a[rel~="license"]').getAttribute('href'), 'https://creativecommons.org/licenses/by-sa/4.0/');
    assert.match(await page.locator('.artist-biography-attribution').innerText(), /shortened, edited by Rescened moderators/);
    await page.getByRole('button', { name: 'Toggle biography' }).click();
    await page.waitForFunction(() => !document.querySelector('.artist-biography'));
    // Happy review submission; the callback models an API response, not persistence.
    await page.getByRole('spinbutton', { name: 'Rating', exact: true }).fill('4.5');
    await page.getByRole('textbox', { name: 'Review', exact: true }).fill('First review');
    await page.getByRole('button', { name: 'Post review', exact: true }).click();
    await page.evaluate(() => window.__resolveReview(true));
    await page.waitForFunction(() => window.__completed === 1 && document.querySelector('textarea')?.value === '');
    assert.equal(await page.getByRole('textbox', { name: 'Review', exact: true }).inputValue(), '');
    // Leave while posting. A late completion must not notify the abandoned view.
    await page.getByRole('spinbutton', { name: 'Rating', exact: true }).fill('5');
    await page.getByRole('textbox', { name: 'Review', exact: true }).fill('Pending review');
    await page.getByRole('button', { name: 'Post review', exact: true }).click();
    await page.getByRole('button', { name: 'Navigate', exact: true }).click();
    await page.evaluate(() => window.__resolveReview(true));
    await page.getByRole('button', { name: 'Navigate', exact: true }).click();
    await page.getByRole('button', { name: 'Retry submission' }).waitFor();
    assert.equal(await page.evaluate(() => window.__completed), 1);
    await page.getByRole('button', { name: 'Switch user' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Review', exact: true }).inputValue(), '', 'another user sees no draft');
    await page.getByRole('button', { name: 'Switch user' }).click();
    await page.getByRole('button', { name: 'Retry submission' }).click();
    const requests = await page.evaluate(() => window.__requests);
    assert.deepEqual(requests[2], requests[1], 'retry keeps payload and idempotency key');
    await page.evaluate(() => window.__resolveReview(true));
    await page.waitForFunction(() => window.__completed === 2);
    await page.getByRole('button', { name: 'Add note for Fixture Album' }).click();
    await page.getByRole('textbox', { name: 'Note for Fixture Album' }).fill('Listen again');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    assert.equal(await page.locator('.board-item-note-text').innerText(), 'Listen again');
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { await server?.close(); await fs.rm(directory, { recursive: true, force: true }); }
  }
});
