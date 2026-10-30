const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);

// Opt-in, offline regression using an installed Chromium-compatible browser.
// BROWSER_EXECUTABLE=/path/to/chrome node --test tests/pageMeta.browser.test.js
test("page metadata restores defaults across detail navigation and StrictMode", {
  skip: !process.env.BROWSER_EXECUTABLE && "set BROWSER_EXECUTABLE to run rendered metadata checks",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-page-meta-"));
  try {
    const frontend = path.resolve(__dirname, "../frontend");
    const { build } = await import(pathToFileURL(require.resolve("vite", { paths: [frontend] })).href);
    const entry = path.join(directory, "entry.jsx");
    await fs.writeFile(entry, `
      import React, { StrictMode, act } from "react";
      import { createRoot } from "react-dom/client";
      import PageMeta from ${JSON.stringify(path.join(frontend, "src/Components/PageMeta.jsx"))};
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      const root = createRoot(document.getElementById("root"));
      const snapshots = [];
      function snapshot(step) {
        snapshots.push({ step, title: document.title,
          titleCount: document.querySelectorAll("head title").length,
          description: document.querySelector('meta[name="description"]').content,
          canonicals: [...document.querySelectorAll('link[rel="canonical"]')].map(tag => tag.href) });
      }
      async function run() {
        snapshot("initial");
        for (const strict of [false, true]) {
          const render = async (metadata) => {
            const page = metadata ? React.createElement(PageMeta, metadata) : React.createElement("h1", null, "Home");
            await act(async () => root.render(strict ? React.createElement(StrictMode, null, page) : page));
          };
          await render({ title: "Album title", description: "Album description", canonical: "https://rescened.com/album/example" });
          snapshot(strict + ":album");
          await render({ title: "Review title", description: "Review description", canonical: "https://rescened.com/review/example" });
          snapshot(strict + ":review");
          await render(null);
          snapshot(strict + ":home");
          await render({ title: "Album title", description: "Album description", canonical: "https://rescened.com/album/example" });
          snapshot(strict + ":revisit");
          await render(null);
          snapshot(strict + ":home-again");
        }
        document.getElementById("result").textContent = JSON.stringify(snapshots);
      }
      run().catch(error => { document.getElementById("result").textContent = JSON.stringify({ error: String(error) }); });
    `);
    const bundle = await build({
      configFile: false,
      root: directory,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      resolve: { alias: {
        react: path.join(frontend, "node_modules/react"),
        "react-dom": path.join(frontend, "node_modules/react-dom"),
      } },
      build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "MetadataCheck" } },
    });
    const code = bundle[0].output.find(item => item.type === "chunk").code;
    const html = path.join(directory, "index.html");
    await fs.writeFile(html, '<!doctype html><html><head><title>rescened</title><meta name="description" content="Default description"></head><body><div id="root"></div><pre id="result"></pre><script>' + code.replace(/<\/script/gi, "<\\/script") + '</script></body></html>');
    const { stdout } = await execFile(process.env.BROWSER_EXECUTABLE, [
      "--headless", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--no-default-browser-check",
      "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${path.join(directory, "profile")}`,
      "--virtual-time-budget=5000", "--dump-dom", pathToFileURL(html).href,
    ], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const raw = stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
    assert.ok(raw, "browser completed the metadata navigation sequence");
    const snapshots = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    assert.equal(snapshots.error, undefined);
    assert.equal(snapshots.length, 11);
    console.log(JSON.stringify(snapshots));
    for (const state of snapshots) {
      const isAlbum = /:(album|revisit)$/.test(state.step);
      const isReview = /:review$/.test(state.step);
      assert.equal(state.title, isAlbum ? "Album title" : isReview ? "Review title" : "rescened", state.step);
      assert.equal(state.titleCount, 1, state.step);
      assert.equal(state.description, isAlbum ? "Album description" : isReview ? "Review description" : "Default description", state.step);
      assert.deepEqual(state.canonicals, isAlbum ? ["https://rescened.com/album/example"] : isReview ? ["https://rescened.com/review/example"] : [], state.step);
    }
    console.log("Rendered 11 metadata states: initial, album, review, home, revisit, home again; normal and StrictMode.");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
