const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const enabled = process.env.RUN_FRONTEND_BROWSER_TESTS === "true";
const queuePath = "/moderation/album-mappings";
const apiOrigin = "http://fixture.invalid";
const catalogCandidate = {
  albumId: "11111111-1111-4111-8111-111111111111",
  title: "Fixture catalog album",
  artistDisplayName: "Fixture artist",
  catalogRevision: 1,
};

function row(caseId, album, fields = {}) {
  return { caseId, album, artist: "Fixture artist", status: "pending", revision: 1, listenerCount: 3, encounterCount: 3, ...fields };
}

const cases = [
  ...Array.from({ length: 23 }, (_, index) => row("popular-" + index, "Popular album " + (index + 1),
    index === 0 ? { candidates: [catalogCandidate] } : {})),
  row("buried-first", "Buried pressing"),
  row("buried-second", "Buried pressing (deluxe)"),
  row("buried-third", "Buried pressing (live)"),
  row("approved-current", "Buried pressing (current)", { status: "approved" }),
  row("approved-low", "Buried pressing (low priority)", { status: "approved", encounterCount: 1, mappingStale: true }),
  row("approved-stale", "Buried pressing (stale)", { status: "approved", mappingStale: true }),
  row("expanded-album", "ffi".repeat(66)),
];

// The fixture deliberately delivers a held response after abort, so the
// rendered component must also guard its state updates.
function installQueueApi({ cases, queuePath, apiOrigin, restricted, effortBySession, baselineBySession, holdEffortStatusFor }) {
  window.queueRequests = [];
  window.queueHolds = {};
  window.queueCompletions = {};
  window.moderationRequests = [];
  window.effortStatusHolds = {};
  const effortPath = "/moderation/review-effort";
  const baselinePath = "/moderation/album-baselines";
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const forbidden = () => json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" }, 403);
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), location.href);
    const authorization = new Headers(init.headers).get("authorization") || "";
    const switchedToRestricted = authorization === "Bearer fixture-restricted-token";
    const prefix = "Bearer fixture-token:";
    const sessionId = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : "";
    if (url.origin !== apiOrigin || (!sessionId && !switchedToRestricted)) {
      throw new Error("Unexpected fixture request: " + url);
    }
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    window.moderationRequests.push({ path: url.pathname, method, sessionId, body });
    if (url.pathname === effortPath || url.pathname === effortPath + "/opt-in") {
      const status = effortBySession[sessionId] || { enabled: false, optedIn: false };
      if (method === "GET" && holdEffortStatusFor && holdEffortStatusFor === sessionId) {
        await new Promise((resolve) => { window.effortStatusHolds[sessionId] = resolve; });
      }
      if (method === "PUT") {
        effortBySession[sessionId] = { ...status, optedIn: body.optedIn };
        return json(effortBySession[sessionId]);
      }
      return json(method === "POST" ? { recorded: true } : status);
    }
    if (url.pathname.startsWith(baselinePath + "/")) {
      const baseline = baselineBySession[sessionId];
      if (!baseline) throw new Error("Unexpected baseline fixture request: " + url);
      return json(method === "POST" ? { ...baseline, status: "deferred" } : baseline);
    }
    if (url.pathname.startsWith(queuePath + "/")) {
      if (restricted || switchedToRestricted) return forbidden();
      const [caseId, action] = url.pathname.slice(queuePath.length + 1).split("/");
      const selected = cases.find((item) => item.caseId === caseId);
      if (!selected) return json({ code: "MAPPING_CASE_NOT_FOUND" }, 404);
      if (method === "POST" && action === "reject") {
        return json({ case: { ...selected, status: "rejected", revision: selected.revision + 1 }, mapping: null, history: [] });
      }
      return json({ case: selected, mapping: null, history: [] });
    }
    if (url.pathname !== queuePath) throw new Error("Unexpected fixture route: " + url.pathname);
    const params = Object.fromEntries(url.searchParams);
    window.queueRequests.push(params);
    if (switchedToRestricted) await new Promise((resolve) => { window.queueHolds.restricted = resolve; });
    if (restricted || switchedToRestricted) return forbidden();
    if (params.q === "slow") {
      await new Promise((resolve) => { window.queueHolds.slow = resolve; });
      window.queueCompletions.slow = { aborted: init.signal?.aborted };
      return json({ items: [{ caseId: "obsolete", album: "Obsolete slow response" }], nextCursor: "obsolete-cursor" });
    }
    const matches = cases.filter((item) =>
      item.status === params.status
        && (params.priority !== "high" || item.encounterCount >= 2)
        && (params.stale !== "true" || item.mappingStale)
        && (!params.q || item.album.toLowerCase().includes(params.q.toLowerCase())));
    const start = Number(params.cursor || 0);
    const limit = params.q ? 2 : 20;
    const end = start + limit;
    return json({ items: matches.slice(start, end), nextCursor: end < matches.length ? String(end) : null });
  };
}

test("album mapping queue search renders matching pages and keeps moderator filters", { skip: enabled ? false : "Set RUN_FRONTEND_BROWSER_TESTS=true with pinned Chromium", timeout: 60000 }, async (t) => {
  const { chromium } = require("./browser-support/chromium");
  const { createFixtureServer } = require("./browser-support/server");
  const frontend = path.resolve(__dirname, "../frontend");
  const requireFrontend = createRequire(path.join(frontend, "package.json"));
  const { default: react } = await import(pathToFileURL(requireFrontend.resolve("@vitejs/plugin-react")).href);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-mapping-queue-"));
  let server; let browser;
  try {
    await fs.writeFile(path.join(directory, "index.html"), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mapping queue fixture</title><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await fs.writeFile(path.join(directory, "auth.js"), `
import { useSyncExternalStore } from "react";
let holdNextToken = false;
window.holdNextFixtureToken = () => { holdNextToken = true; };
const getToken = async () => {
  const held = holdNextToken;
  if (held) {
    holdNextToken = false;
    await new Promise((resolve) => { window.releaseFixtureToken = resolve; });
  }
  const token = auth.userId === "fixture-regular" ? "fixture-restricted-token" : "fixture-token:" + auth.sessionId;
  if (held) window.releasedFixtureToken = token;
  return token;
};
let auth = { isLoaded: true, isSignedIn: true, userId: "fixture-moderator", sessionId: "initial-session", getToken };
const listeners = new Set();
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const getSnapshot = () => auth;
window.setFixtureSession = (userId, sessionId) => {
  auth = { ...auth, userId, sessionId };
  for (const listener of listeners) listener();
};
export function useAuth() { return useSyncExternalStore(subscribe, getSnapshot); }
`);
    await fs.writeFile(path.join(directory, "entry.jsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ${JSON.stringify(path.join(frontend, "src/reset.css"))};
import ${JSON.stringify(path.join(frontend, "src/index.css"))};
import ${JSON.stringify(path.join(frontend, "src/App.css"))};
import AlbumMappings from ${JSON.stringify(path.join(frontend, "src/Pages/AlbumMappings.jsx"))};
createRoot(document.getElementById("root")).render(
  <MemoryRouter initialEntries={[${JSON.stringify(queuePath)}]}>
    <Routes>
      <Route path=${JSON.stringify(queuePath)} element={<AlbumMappings />} />
      <Route path=${JSON.stringify(queuePath + "/:caseId")} element={<AlbumMappings />} />
      <Route path="/moderation/album-suggestions" element={<h1>Album submissions</h1>} />
    </Routes>
  </MemoryRouter>
);
`);
    server = await createFixtureServer({
      configFile: false, root: directory, envDir: false, plugins: [react()],
      define: { "import.meta.env.VITE_API_URL": JSON.stringify(apiOrigin) },
      resolve: { alias: {
        "@clerk/react": path.join(directory, "auth.js"),
        ...Object.fromEntries(["react", "react-dom", "react-router-dom"].map((name) => [name, path.dirname(requireFrontend.resolve(name + "/package.json"))])),
      } },
      server: { watch: null, fs: { allow: [directory, frontend, await fs.realpath(path.join(frontend, "node_modules"))] } },
    });
    await server.listen();
    const url = "http://127.0.0.1:" + server.httpServer.address().port;
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    });

    async function fixture(restricted, run, { effortBySession = {}, baselineBySession = {}, holdEffortStatusFor = "" } = {}) {
      const context = await browser.newContext({ viewport: { width: 390, height: 840 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      try {
        await page.addInitScript(installQueueApi, { cases, queuePath, apiOrigin, restricted, effortBySession, baselineBySession, holdEffortStatusFor });
        await page.goto(url);
        await run(page);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }

    async function openMappingCase(page, title) {
      await page.locator("#mapping-queue-results").getByRole("button", { name: new RegExp(`\\b${title}\\b`) }).click();
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
    }

    async function releaseTokenForModeratorB(page) {
      await page.evaluate(() => window.releaseFixtureToken());
      await page.waitForFunction(() => window.releasedFixtureToken === "fixture-token:moderator-b-session");
    }

    await t.test("search beyond page one, paginate, preserve selection, and combine filters on mobile", async () => {
      await fixture(false, async (page) => {
        const input = page.getByRole("searchbox", { name: "Search album name" });
        const results = page.locator("#mapping-queue-results");
        const card = (title) => results.getByRole("button", { name: title });
        const status = (label) => results.getByRole("status").filter({ hasText: label });
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        await status("20+ cases").waitFor();
        assert.equal(await card(/Buried pressing/).count(), 0);
        await input.fill("buried");
        await status("2+ matching cases").waitFor();
        await card(/Buried pressing \(deluxe\)/).waitFor();
        await results.getByRole("button", { name: "Load more" }).click();
        await status("3 matching cases").waitFor();
        assert.equal(await results.getByRole("button", { name: "Load more" }).count(), 0);
        assert.equal(await overflow(), 0);

        const beforeSelection = await page.evaluate(() => window.queueRequests.length);
        await card(/Buried pressing \(live\)/).click();
        await page.getByRole("heading", { name: "Buried pressing (live)", exact: true }).waitFor();
        assert.equal(await input.inputValue(), "buried");
        assert.equal(await status("3 matching cases").isVisible(), true);
        assert.equal(await page.evaluate(() => window.queueRequests.length), beforeSelection);

        await page.getByLabel("Review status").selectOption("approved");
        await card(/Buried pressing \(current\)/).waitFor();
        await page.getByLabel("High encounter priority").check();
        await card(/Buried pressing \(stale\)/).waitFor();
        assert.equal(await card(/low priority/).count(), 0);
        await page.getByLabel("Album changed since review").check();
        await status("1 matching case").waitFor();
        assert.equal(await card(/Buried pressing \(current\)/).count(), 0);
        assert.deepEqual(await page.evaluate(() => window.queueRequests.at(-1)), { status: "approved", priority: "high", stale: "true", q: "buried" });

        await input.fill("盤".repeat(200));
        await input.press("Enter");
        await results.getByRole("heading", { name: "No matching cases in this view." }).waitFor();
        assert.equal(await overflow(), 0);
        await results.getByRole("button", { name: "Clear search" }).click();
        await status("1 case").waitFor();
        assert.equal(await input.inputValue(), "");
        assert.equal(await input.evaluate((element) => element === document.activeElement), true);
        assert.equal(await card(/Buried pressing \(stale\)/).isVisible(), true);
      });
    });

    await t.test("late search results cannot overwrite a more recent edit", async () => {
      await fixture(false, async (page) => {
        const input = page.getByRole("searchbox", { name: "Search album name" });
        await input.fill("slow");
        await page.waitForFunction(() => Boolean(window.queueHolds.slow));
        await input.fill("buried");
        await page.getByText("2+ matching cases", { exact: true }).waitFor();
        await page.evaluate(async () => {
          window.queueHolds.slow();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        assert.deepEqual(await page.evaluate(() => window.queueCompletions.slow), { aborted: true });
        assert.equal(await page.getByText("Obsolete slow response", { exact: true }).count(), 0);
        assert.equal(await page.getByText("2+ matching cases", { exact: true }).isVisible(), true);
      });
    });

    await t.test("a signed-in account switch aborts the old search and renders the restricted desk", async () => {
      await fixture(false, async (page) => {
        const input = page.getByRole("searchbox", { name: "Search album name" });
        const results = page.locator("#mapping-queue-results");
        await results.getByText("20+ cases", { exact: true }).waitFor();
        await input.fill("slow");
        await page.waitForFunction(() => Boolean(window.queueHolds.slow));
        const beforeSwitch = await page.evaluate(() => window.queueRequests.length);

        await page.evaluate(() => window.setFixtureSession("fixture-regular", "restricted-session"));
        await page.waitForFunction(() => Boolean(window.queueHolds.restricted));
        assert.equal(await input.inputValue(), "");
        assert.deepEqual(await page.evaluate((count) => window.queueRequests.slice(count), beforeSwitch), [{ status: "pending" }]);
        await page.evaluate(async () => {
          window.queueHolds.slow();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        assert.deepEqual(await page.evaluate(() => window.queueCompletions.slow), { aborted: true });
        assert.equal(await results.getByRole("button", { name: /Popular album|Obsolete slow response|Load more/ }).count(), 0);

        await page.evaluate(() => window.queueHolds.restricted());
        await page.getByRole("heading", { name: "Moderator access required." }).waitFor();
        assert.equal(await input.count(), 0);
        assert.equal(await page.getByRole("alert").getByText("Restricted desk · 403").isVisible(), true);

        await page.evaluate(() => window.setFixtureSession("fixture-moderator", "new-moderator-session"));
        await results.getByText("20+ cases", { exact: true }).waitFor();
        assert.equal(await input.inputValue(), "");
      });
    });

    await t.test("a pending baseline decision cannot dispatch with the replacement moderator's token", async () => {
      const baseline = { target: catalogCandidate, status: "queued", revision: 1, flags: { discovery: false, moderation: true } };
      await fixture(false, async (page) => {
        const candidate = page.getByRole("radio", { name: /Fixture catalog album/ });
        const panel = page.locator(".baseline-review-panel");
        const reason = panel.getByRole("textbox", { name: "Reason optional" });
        const defer = panel.getByRole("button", { name: "Defer", exact: true });
        await openMappingCase(page, "Popular album 1");
        await candidate.check();
        await panel.getByText("Review revision 1", { exact: true }).waitFor();
        await reason.fill("Moderator A's private draft");
        await page.evaluate(() => window.holdNextFixtureToken());
        await defer.click();
        await page.waitForFunction(() => Boolean(window.releaseFixtureToken));
        assert.equal(await defer.isDisabled(), true);

        await page.evaluate(() => window.setFixtureSession("fixture-moderator-b", "moderator-b-session"));
        await page.waitForFunction(() => window.moderationRequests.some((request) =>
          request.path === "/moderation/album-mappings/popular-0" && request.sessionId === "moderator-b-session"));
        await candidate.check();
        await panel.getByText("Review revision 2", { exact: true }).waitFor();
        await releaseTokenForModeratorB(page);
        assert.equal(await reason.inputValue(), "");
        assert.equal(await defer.isEnabled(), true);
        assert.equal(await panel.getByText("Baseline defer recorded.").count(), 0);
        assert.deepEqual(await page.evaluate(() => window.moderationRequests.filter((request) =>
          request.method === "POST" && request.path.startsWith("/moderation/album-baselines/") && request.path.endsWith("/defer"))), []);
      }, { baselineBySession: { "initial-session": baseline, "moderator-b-session": { ...baseline, revision: 2 } } });
    });

    await t.test("review timing and a pending opt-in update belong to the active Clerk session", async () => {
      for (const moderatorBOptedIn of [false, true]) {
        await fixture(false, async (page) => {
          const timer = page.getByLabel("Review timer");
          const start = timer.getByRole("button", { name: "Start timing", exact: true });
          const elapsed = timer.locator(".review-timer-elapsed");
          const mutations = () => page.evaluate(() => window.moderationRequests.filter((request) =>
            request.path.startsWith("/moderation/review-effort") && request.method !== "GET"));

          await page.clock.install();
          await openMappingCase(page, "Popular album 1");
          await start.click();
          await page.clock.runFor(3_000);
          await timer.getByText("0:03", { exact: true }).waitFor();
          await page.evaluate(() => window.holdNextFixtureToken());
          await timer.getByRole("button", { name: "Stop timing my reviews" }).click();
          await page.waitForFunction(() => Boolean(window.releaseFixtureToken));

          await page.evaluate(() => window.setFixtureSession("fixture-moderator-b", "moderator-b-session"));
          await page.waitForFunction(() => Boolean(window.effortStatusHolds["moderator-b-session"]));
          await page.getByRole("heading", { name: "Popular album 1", exact: true }).waitFor();
          assert.equal(await timer.count(), 0);
          await releaseTokenForModeratorB(page);
          await page.evaluate(() => window.effortStatusHolds["moderator-b-session"]());
          if (moderatorBOptedIn) {
            await start.waitFor();
            assert.equal(await elapsed.textContent(), "0:00");
          } else {
            await timer.getByRole("button", { name: "Opt in", exact: true }).waitFor();
            assert.equal(await elapsed.count(), 0);
          }
          await page.getByRole("combobox", { name: "Decision", exact: true }).selectOption("reject");
          await page.getByRole("button", { name: "Reject case", exact: true }).click();
          await page.getByText("Reject case recorded.", { exact: true }).waitFor();
          assert.deepEqual(await mutations(), []);

          if (moderatorBOptedIn) {
            await openMappingCase(page, "Popular album 2");
            await start.click();
            await page.clock.runFor(1_000);
            await openMappingCase(page, "Popular album 3");
            const [unfinished] = await mutations();
            assert.equal(unfinished.sessionId, "moderator-b-session");
            assert.equal(unfinished.method, "POST");
            assert.equal(unfinished.body.targetId, "popular-1");
            assert.equal(unfinished.body.outcome, "abandoned");
            assert.equal(unfinished.body.intervals.length, 1);
            assert.equal((await mutations()).length, 1);
          }
        }, {
          effortBySession: {
            "initial-session": { enabled: true, optedIn: true },
            "moderator-b-session": { enabled: true, optedIn: moderatorBOptedIn },
          },
          holdEffortStatusFor: "moderator-b-session",
        });
      }
    });

    await t.test("leaving the mapping desk saves unfinished timing and cancels a pending opt-in update", async () => {
      await fixture(false, async (page) => {
        const timer = page.getByLabel("Review timer");
        await page.clock.install();
        await openMappingCase(page, "Popular album 1");
        await timer.getByRole("button", { name: "Start timing", exact: true }).click();
        await page.clock.runFor(3_000);
        await timer.getByText("0:03", { exact: true }).waitFor();

        await page.evaluate(() => window.holdNextFixtureToken());
        await timer.getByRole("button", { name: "Stop timing my reviews" }).click();
        await page.waitForFunction(() => Boolean(window.releaseFixtureToken));
        await page.getByRole("link", { name: "Album submissions", exact: true }).click();
        await page.getByRole("heading", { name: "Album submissions", exact: true }).waitFor();
        await page.waitForFunction(() => window.moderationRequests.some((request) =>
          request.path === "/moderation/review-effort" && request.method === "POST"));

        await page.evaluate(() => window.releaseFixtureToken());
        await page.waitForFunction(() => window.releasedFixtureToken === "fixture-token:initial-session");
        const writes = await page.evaluate(() => window.moderationRequests.filter((request) =>
          request.path.startsWith("/moderation/review-effort") && request.method !== "GET"));
        assert.equal(writes.length, 1);
        const [unfinished] = writes;
        assert.equal(unfinished.method, "POST");
        assert.equal(unfinished.sessionId, "initial-session");
        assert.equal(unfinished.body.targetId, "popular-0");
        assert.equal(unfinished.body.outcome, "abandoned");
        assert.equal(unfinished.body.intervals.length, 1);
      }, { effortBySession: { "initial-session": { enabled: true, optedIn: true } } });
    });

    await t.test("switching Clerk sessions after leaving the mapping desk keeps unfinished timing on the originating session", async () => {
      await fixture(false, async (page) => {
        const timer = page.getByLabel("Review timer");
        await page.clock.install();
        await openMappingCase(page, "Popular album 1");
        await timer.getByRole("button", { name: "Start timing", exact: true }).click();
        await page.clock.runFor(3_000);
        await timer.getByText("0:03", { exact: true }).waitFor();

        await page.evaluate(() => window.holdNextFixtureToken());
        await page.getByRole("link", { name: "Album submissions", exact: true }).click();
        await page.getByRole("heading", { name: "Album submissions", exact: true }).waitFor();
        await page.evaluate(() => window.setFixtureSession("fixture-moderator-b", "moderator-b-session"));
        await page.waitForFunction(() => window.moderationRequests.some((request) =>
          request.path === "/moderation/review-effort" && request.method === "POST"));

        const writes = await page.evaluate(() => window.moderationRequests.filter((request) =>
          request.path.startsWith("/moderation/review-effort") && request.method !== "GET"));
        assert.equal(writes.length, 1);
        assert.equal(writes[0].sessionId, "initial-session");
        assert.equal(writes[0].body.targetId, "popular-0");
        assert.equal(writes[0].body.outcome, "abandoned");
        assert.equal(await page.evaluate(() => window.moderationRequests.some((request) =>
          request.sessionId === "moderator-b-session")), false);
        assert.equal(await page.evaluate(() => Boolean(window.releaseFixtureToken)), false);
      }, { effortBySession: {
        "initial-session": { enabled: true, optedIn: true },
        "moderator-b-session": { enabled: true, optedIn: true },
      } });
    });

    await t.test("a normalized query over 200 characters stays local and recovers on edit or clear", async () => {
      await fixture(false, async (page) => {
        const input = page.getByRole("searchbox", { name: "Search album name" });
        const results = page.locator("#mapping-queue-results");
        const invalid = "ﬃ".repeat(67);
        await results.getByText("20+ cases", { exact: true }).waitFor();
        await page.clock.install();
        const initial = await page.evaluate(() => window.queueRequests.length);
        await input.fill(invalid);
        const alert = results.getByRole("alert");
        await alert.getByText("Album search must be 200 characters or fewer after normalization.").waitFor();
        assert.equal(await alert.getByText("INVALID_QUERY", { exact: true }).isVisible(), true);
        assert.equal(await input.getAttribute("aria-invalid"), "true");
        assert.equal(await results.getAttribute("aria-busy"), "false");
        assert.equal(await results.getByRole("status").count(), 0);
        assert.equal(await results.getByRole("heading", { name: /No matching cases/ }).count(), 0);
        assert.equal(await results.getByRole("button", { name: "Load more" }).count(), 0);
        assert.equal(await alert.getByRole("button", { name: "Retry queue" }).count(), 0);

        await input.press("Enter");
        await page.getByRole("button", { name: "Refresh queue" }).click();
        await page.getByLabel("High encounter priority").check();
        await page.clock.runFor(200);
        assert.equal(await page.evaluate(() => window.queueRequests.length), initial);

        await input.fill("ﬃ".repeat(66));
        await page.clock.runFor(200);
        await results.getByText("1 matching case", { exact: true }).waitFor();
        assert.equal(await alert.count(), 0);
        assert.equal(await page.evaluate(() => window.queueRequests.at(-1).q), "ffi".repeat(66));
        await input.fill(invalid);
        await alert.waitFor();
        await page.getByRole("button", { name: "Clear", exact: true }).click();
        await results.getByText("20+ cases", { exact: true }).waitFor();
        assert.equal(await input.inputValue(), "");
        assert.deepEqual(await page.evaluate(() => window.queueRequests.at(-1)), { status: "pending", priority: "high" });
      });
    });

    await t.test("403 displays the restricted mapping desk", async () => {
      await fixture(true, async (page) => {
        await page.getByRole("heading", { name: "Moderator access required." }).waitFor();
        assert.equal(await page.getByRole("searchbox").count(), 0);
        assert.equal(await page.getByRole("alert").getByText("Restricted desk · 403").isVisible(), true);
      });
    });
  } finally {
    await browser?.close();
    await server?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
