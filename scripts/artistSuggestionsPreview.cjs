#!/usr/bin/env node
// SYNTHETIC local preview of the artist suggestion UI: the real frontend
// components (album suggestion form with the artist picker, identity-only
// correction links, standalone artist suggestion pages, moderator review)
// served by Vite on one loopback port, talking to an in-page fake API
// (scripts/preview/artistSuggestionsFakeApi.mjs). No API server, database,
// Clerk, or MusicBrainz is contacted, nothing is written anywhere, and every
// page says it is synthetic. Usage:
//   npm run preview:artist-suggestions -- [--port 5390]
// The port must be free; the preview never moves to another port.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const frontend = path.join(root, 'frontend');
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const DEFAULT_PORT = 5390;

function parsePort(args) {
  const index = args.indexOf('--port');
  if (index === -1) return DEFAULT_PORT;
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an integer from 1024 to 65535');
  return port;
}

function entrySource() {
  const src = (file) => JSON.stringify(path.join(frontend, 'src', file));
  return `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import ${src('reset.css')}; import ${src('index.css')}; import ${src('App.css')};
import SuggestionForm from ${src('Components/Community/SuggestionForm.jsx')};
import CorrectionForm from ${src('Components/Community/CorrectionForm.jsx')};
import ArtistSuggestions from ${src('Pages/ArtistSuggestions.jsx')};
import ModerationArtistSuggestions from ${src('Pages/ModerationArtistSuggestions.jsx')};
import { createFakeApi } from ${JSON.stringify(path.join(__dirname, 'preview/artistSuggestionsFakeApi.mjs'))};

const api = createFakeApi();
window.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const result = api.handle((init.method || 'GET').toUpperCase(), url.pathname + url.search, init.body ? JSON.parse(init.body) : undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
};
const getToken = async () => 'synthetic-token';
const album = {
  albumId: '66666666-6666-4666-8666-666666666666', title: 'Many Credits (synthetic)', artistDisplayName: 'Tyler, the Creator & Many', releaseType: 'album', releaseYear: 2020, releaseDate: '2020', tracks: [],
  artistCredits: [{ name: 'Tyler, the Creator', role: 'main' }, { name: 'Already Linked', role: 'main', artistId: '33333333-3333-4333-8333-333333333333' },
    ...Array.from({ length: 22 }, (_, index) => ({ name: index === 21 ? 'Last, Credit!' : 'Player ' + (index + 1), role: 'performer' }))],
};

function usePayload({ title }) {
  const [payload, setPayload] = useState(null);
  return { setPayload, view: payload ? <section className="community-panel"><h3>{title}</h3><p>Synthetic: shown here instead of being sent.</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(payload, null, 2)}</pre></section> : null };
}

function AlbumForm() {
  const { setPayload, view } = usePayload({ title: 'Request body the form would send' });
  return <>{view}<SuggestionForm getToken={getToken} onSubmit={setPayload} initialValue={{ proposedMetadata: { title: 'Synthetic Album', releaseType: 'album', releaseDate: '2026', artistCredits: [{ name: 'Nova', role: 'main' }, { name: 'Tyler, the Creator', role: 'featured' }] }, supportingSources: [{ type: 'other', url: 'https://example.com/source' }] }} /></>;
}

function Correction() {
  const { setPayload, view } = usePayload({ title: 'Request body the correction would send' });
  return <>{view}<CorrectionForm getToken={getToken} draftKey="" onSubmit={setPayload} initialValue={{ targetAlbumId: album.albumId, targetAlbum: album }} /></>;
}

function Shell() {
  const location = useLocation();
  const links = [['/album-suggestion', 'Album suggestion form'], ['/correction', 'Correction: artist links'], ['/artist-suggestions', 'Suggest an artist'], ['/moderation/artist-suggestions', 'Moderate artist suggestions']];
  return (
    <main style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 1000, margin: '0 auto' }}>
      <p role="note" style={{ margin: 0, padding: 12, border: '2px dashed currentColor', fontWeight: 700 }}>
        SYNTHETIC PREVIEW — fixture data in this browser tab only. No server, database, sign-in, or MusicBrainz; nothing is saved. The signed-in user is a stand-in and is also treated as a moderator.
      </p>
      <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{links.map(([to, label]) => <Link key={to} to={to} aria-current={location.pathname.startsWith(to) ? 'page' : undefined}>{label}</Link>)}</nav>
      <Routes>
        <Route path="/" element={<p>Choose a page above. Try searching for "Nova" or "Echo".</p>} />
        <Route path="/album-suggestion" element={<AlbumForm />} />
        <Route path="/correction" element={<Correction />} />
        <Route path="/artist-suggestions" element={<ArtistSuggestions />} />
        <Route path="/artist-suggestions/:submissionId" element={<ArtistSuggestions />} />
        <Route path="/moderation/artist-suggestions" element={<ModerationArtistSuggestions />} />
        <Route path="/moderation/artist-suggestions/:submissionId" element={<ModerationArtistSuggestions />} />
        <Route path="*" element={<p>Not part of the synthetic preview.</p>} />
      </Routes>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<MemoryRouter><Shell /></MemoryRouter>);
`;
}

async function main(args = process.argv.slice(2)) {
  const port = parsePort(args);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rescened-artist-suggestions-preview-'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SYNTHETIC artist suggestions preview</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
  fs.writeFileSync(path.join(directory, 'auth.js'), "const getToken = async () => 'synthetic-token';\nexport function useAuth() { return { isLoaded: true, isSignedIn: true, userId: 'user_preview', getToken }; }\n");
  fs.writeFileSync(path.join(directory, 'entry.jsx'), entrySource());
  const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(frontendRequire.resolve('@vitejs/plugin-react')).href);
  // As in the browser fixtures: keep Vite's CSS helpers but drop the client's
  // automatic HMR websocket (HMR is off); fail closed if Vite changes.
  const noHmrClient = {
    name: 'preview-no-hmr-client', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').split('?')[0].endsWith('/vite/dist/client/client.mjs')) return undefined;
      const connect = 'transport.connect(createHMRHandler(handleMessage));';
      if (code.split(connect).length !== 2) throw new Error('Preview HMR client guard needs review for this Vite version.');
      return { code: code.replace(connect, '/* preview: automatic HMR connection disabled */'), map: null };
    },
  };
  const vite = await createServer({
    configFile: false, root: directory, envDir: false, plugins: [react(), noHmrClient], logLevel: 'warn',
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://synthetic.invalid') },
    resolve: { alias: { '@clerk/react': path.join(directory, 'auth.js'), ...Object.fromEntries(['react', 'react-dom', 'react-router-dom'].map((name) => [name, path.dirname(frontendRequire.resolve(`${name}/package.json`))])) } },
    server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [directory, frontend, path.join(__dirname, 'preview'), fs.realpathSync(path.join(frontend, 'node_modules'))] } },
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/__preview/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ status: 'ok', synthetic: true, database: 'none', providers: 'none', auth: 'stub' }));
    }
    return vite.middlewares(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use; nothing was stopped. Choose another with --port.`) : error));
    server.listen({ host: '127.0.0.1', port }, resolve);
  });
  console.log(`SYNTHETIC artist suggestions preview: http://127.0.0.1:${port}/  (health: /__preview/health)`);
  console.log('No API server, database, Clerk, or MusicBrainz. Ctrl+C stops it.');
  const stop = async () => {
    server.close();
    await vite.close();
    fs.rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Preview: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_PORT, parsePort, entrySource };
