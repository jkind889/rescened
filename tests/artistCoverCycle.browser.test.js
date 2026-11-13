// Explicit offline browser regression for the artist header cover cycle.
// Uses installed Playwright when requested (RUN_FRONTEND_BROWSER_TESTS=true,
// optionally PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE). Images
// are answered by route stubs and time is controlled by Playwright's clock,
// so no API server, database, provider, or real wait is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === 'true';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const covers = (n) => Array.from({ length: n }, (_, i) => ({ albumId: `album-${i + 1}`, title: `Release ${i + 1}`, releaseYear: 2000 + i, cover: `https://img.test/${i + 1}.png` }));

test('the cover cycle advances, pauses, respects reduced motion, and drops broken covers', { skip: enabled ? false : 'Set RUN_FRONTEND_BROWSER_TESTS=true with an available Playwright installation', timeout: 120000 }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const frontend = path.resolve(__dirname, '../frontend');
  const requireFrontend = createRequire(path.join(frontend, 'package.json'));
  const { createServer } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(requireFrontend.resolve('@vitejs/plugin-react')).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rescened-cover-cycle-browser-'));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Cover cycle fixture</title><link rel="icon" href="data:,"></head><body><button id="elsewhere" type="button">elsewhere</button><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, 'entry.jsx'), `import React from 'react'; import { createRoot } from 'react-dom/client'; import { MemoryRouter } from 'react-router-dom';
import ArtistCoverCycle from ${JSON.stringify(path.join(frontend, 'src/features/artists/ArtistCoverCycle.jsx'))};
import ${JSON.stringify(path.join(frontend, 'src/features/artists/ArtistPage.css'))};
const covers = JSON.parse(new URLSearchParams(location.search).get('covers'));
createRoot(document.getElementById('root')).render(<React.StrictMode><MemoryRouter><ArtistCoverCycle artistName="Fixture Artist" covers={covers} /></MemoryRouter></React.StrictMode>);`);
    server = await createServer({ configFile: false, root: directory, envDir: false, plugins: [react()],
      resolve: { alias: { react: path.dirname(requireFrontend.resolve('react/package.json')), 'react-dom': path.dirname(requireFrontend.resolve('react-dom/package.json')), 'react-router-dom': path.dirname(requireFrontend.resolve('react-router-dom/package.json')) } },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [directory, frontend, await fs.realpath(path.join(frontend, 'node_modules'))] } },
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

    async function open({ list = covers(3), reducedMotion = 'no-preference', broken = [] } = {}) {
      const context = await browser.newContext({ reducedMotion, viewport: { width: 900, height: 700 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
      const requested = [];
      await page.route('https://img.test/**', (route) => {
        requested.push(route.request().url());
        return broken.some((name) => route.request().url().endsWith(name)) ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      });
      await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
      await page.goto(`${origin}/?covers=${encodeURIComponent(JSON.stringify(list))}`);
      return { context, page, errors, requested };
    }
    const position = (page) => page.locator('.artist-cover-position').textContent();
    const caption = (page) => page.locator('.artist-cover-caption a').textContent();
    const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    // 1. Normal motion: advances by itself, wraps, and every stop condition holds.
    {
      const { context, page, errors, requested } = await open();
      await page.locator('.artist-cover-image').waitFor();
      assert.equal(await position(page), '1 of 3');
      assert.equal(await page.locator('.artist-cover-image').getAttribute('alt'), 'Release 1 cover');
      assert.equal(await caption(page), 'Release 1 (2000)');
      assert.equal(await page.locator('.artist-cover-caption a').getAttribute('href'), '/album/album-1');
      assert.equal(await page.getByText("Cover art from this artist’s releases").count(), 0, 'no secondary caption');
      assert.equal(await page.getByRole("region", { name: "Cover art from releases by Fixture Artist" }).count(), 1, 'accessible release-art label remains');
      assert.equal(await page.locator('.artist-cover-caption').getAttribute('aria-live'), 'off', 'no live announcements while it advances itself');
      assert.equal(await page.locator('section[aria-roledescription="carousel"]').count(), 1);

      await page.clock.runFor(6100); await settle(page);
      assert.equal(await position(page), '2 of 3', 'advances after the interval');
      assert.ok(requested.some((url) => url.endsWith('/3.png')), 'the next cover is warmed in the cache');
      // One turn at a time: the next timeout is armed by React after each render.
      await page.clock.runFor(6100); await settle(page);
      assert.equal(await position(page), '3 of 3');
      await page.clock.runFor(6100); await settle(page);
      assert.equal(await position(page), '1 of 3', 'wraps around to the first');

      // Hover (mouse) stops it; leaving resumes it.
      await page.locator('.artist-cover-frame').hover();
      await page.clock.runFor(30000); await settle(page);
      assert.equal(await position(page), '1 of 3', 'hover stops advancing');
      await page.mouse.move(0, 0);
      await page.clock.runFor(6100); await settle(page);
      assert.equal(await position(page), '2 of 3', 'leaving the cycle resumes it');

      // Keyboard focus stops it; leaving the cycle resumes it.
      await page.locator('#elsewhere').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.artist-cover-cycle'))), true, 'Tab reaches the album link inside the cycle first');
      await page.clock.runFor(30000); await settle(page);
      assert.equal(await position(page), '2 of 3', 'keyboard focus stops advancing');
      await page.locator('#elsewhere').focus();
      await page.clock.runFor(6100); await settle(page);
      assert.equal(await position(page), '3 of 3', 'moving focus away resumes it');

      // Explicit pause: stays paused, announces politely, and manual steps still work and wrap.
      await page.getByRole('button', { name: 'Pause cover cycle' }).click();
      await page.mouse.move(0, 0);
      await page.locator('#elsewhere').focus();
      assert.equal(await page.getByRole('button', { name: 'Play cover cycle' }).count(), 1, 'the control now offers Play');
      assert.equal(await page.locator('.artist-cover-caption').getAttribute('aria-live'), 'polite', 'steps are announced politely while paused');
      await page.clock.runFor(60000); await settle(page);
      assert.equal(await position(page), '3 of 3', 'a paused cycle does not advance');
      await page.getByRole('button', { name: 'Next cover' }).click();
      assert.equal(await position(page), '1 of 3', 'next wraps to the first');
      await page.getByRole('button', { name: 'Previous cover' }).click();
      assert.equal(await position(page), '3 of 3', 'previous wraps to the last');
      await page.getByRole('button', { name: 'Play cover cycle' }).click();
      await page.mouse.move(0, 0); await page.locator('#elsewhere').focus();
      await page.clock.runFor(6100); await settle(page);
      assert.equal(await position(page), '1 of 3', 'playing again resumes it');

      // Hidden tab: no advance while hidden.
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.clock.runFor(30000); await settle(page);
      assert.equal(await position(page), '1 of 3', 'a hidden tab does not advance');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 2. Reduced motion: never advances by itself, no pause control, no animation, manual steps work.
    {
      const { context, page, errors } = await open({ reducedMotion: 'reduce' });
      await page.locator('.artist-cover-image').waitFor();
      await page.clock.runFor(60000); await settle(page);
      assert.equal(await position(page), '1 of 3', 'reduced motion never advances by itself');
      assert.equal(await page.getByRole('button', { name: /cover cycle/ }).count(), 0, 'no play or pause control without autoplay');
      await page.getByRole('button', { name: 'Next cover' }).click();
      assert.equal(await position(page), '2 of 3');
      assert.equal(await page.locator('.artist-cover-image').evaluate((node) => getComputedStyle(node).animationName), 'none', 'no fade under reduced motion');
      assert.equal(await page.locator('.artist-cover-caption').getAttribute('aria-live'), 'polite');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 3. Motion allowed: the fade runs when the cover changes.
    {
      const { context, page } = await open();
      await page.locator('.artist-cover-image').waitFor();
      await page.getByRole('button', { name: 'Next cover' }).click();
      assert.equal(await page.locator('.artist-cover-image').evaluate((node) => getComputedStyle(node).animationName), 'artist-cover-in');
      await context.close();
    }

    // 4. Broken covers are dropped; one cover shows no controls; none renders nothing.
    {
      const { context, page, errors } = await open({ broken: ['/2.png'] });
      await page.locator('.artist-cover-image').waitFor();
      await page.clock.runFor(6100); await settle(page);
      await page.waitForFunction(() => document.querySelector('.artist-cover-position')?.textContent === '1 of 2' || document.querySelector('.artist-cover-position')?.textContent === '2 of 2');
      assert.match(await position(page), /of 2$/, 'the broken cover left the cycle');
      for (let i = 0; i < 4; i += 1) {
        await page.getByRole('button', { name: 'Next cover' }).click();
        assert.notEqual(await caption(page), 'Release 2 (2001)', 'the broken cover is never shown again');
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      const { context, page } = await open({ list: covers(1) });
      await page.locator('.artist-cover-image').waitFor();
      assert.equal(await page.locator('.artist-cover-controls').count(), 0, 'one cover has no controls');
      assert.equal(await page.locator('[aria-roledescription]').count(), 0, 'one cover is not announced as a carousel');
      await page.clock.runFor(60000); await settle(page);
      assert.equal(await caption(page), 'Release 1 (2000)');
      await context.close();
    }
    {
      const { context, page } = await open({ list: covers(2), broken: ['/1.png', '/2.png'] });
      await page.waitForFunction(() => document.querySelector('.artist-cover-cycle') === null);
      assert.equal(await page.locator('.artist-cover-cycle').count(), 0, 'with every cover broken nothing is rendered');
      await context.close();
    }
    {
      const { context, page } = await open({ list: [] });
      await settle(page);
      assert.equal(await page.locator('.artist-cover-cycle').count(), 0, 'no covers renders nothing');
      await context.close();
    }
  } finally {
    await browser?.close();
    await server?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
