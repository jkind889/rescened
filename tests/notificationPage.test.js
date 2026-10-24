const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Exercise the page's actual async handlers without adding a second React/DOM
// test runtime. Browser QA separately covers rendering and enabled controls.
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Pages/Notifications.jsx"), "utf8");
const handlersSource = source.slice(source.indexOf("export function Notifications() {"), source.indexOf("  const hasNotifications ="))
  .replace("export function", "function") + "\nreturn { loadMore, clearAll }; }\nNotifications();";

function pageHarness({ clearFails = false } = {}) {
  const state = [[{ notificationId: "first-page", readAt: null }], "older-page", false, false, false, false, "", ""];
  let hook = 0;
  let resolvePage;
  let rejectPage;
  let pageRequested;
  const reached = new Promise((resolve) => { pageRequested = resolve; });
  const handlers = vm.runInNewContext(handlersSource, {
    console, URLSearchParams, Date, API_BASE_URL: "https://fixture.invalid", window: { confirm: () => true },
    useAuth: () => ({ getToken: async () => "fixture-token", isLoaded: true, isSignedIn: true }),
    useState: () => {
      const index = hook++;
      return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
    useRef: (current) => ({ current }), useCallback: (fn) => fn, useEffect: () => {},
    getApiErrorMessage: async () => "Clear failed",
    fetch: async (url, options) => {
      if (options.method === "GET") {
        pageRequested();
        return new Promise((resolve, reject) => { resolvePage = resolve; rejectPage = reject; });
      }
      return { ok: !clearFails, json: async () => ({ cleared: 35 }) };
    },
  });
  return { state, handlers, reached,
    completePage() { resolvePage({ ok: true, json: async () => ({ notifications: [{ notificationId: "older-row", readAt: null }], nextCursor: "stale-cursor" }) }); },
    failPage() { rejectPage(new Error("Stale load failed")); },
  };
}

test("a delayed older page cannot restore cleared notifications or their cursor", async () => {
  const page = pageHarness();
  const load = page.handlers.loadMore();
  await page.reached;
  await page.handlers.clearAll();
  page.completePage();
  await load;
  assert.equal(page.state[0].length, 0);
  assert.equal(page.state[1], null);
  assert.equal(page.state[3], false);
});

test("a discarded page error cannot replace the clear result", async () => {
  const page = pageHarness();
  const load = page.handlers.loadMore();
  await page.reached;
  await page.handlers.clearAll();
  page.failPage();
  await load;
  assert.equal(page.state[7], "");
});

test("failed clearing keeps existing rows and permits loading again", async () => {
  const page = pageHarness({ clearFails: true });
  const load = page.handlers.loadMore();
  await page.reached;
  await page.handlers.clearAll();
  page.completePage();
  await load;
  assert.equal(page.state[0].length, 1);
  assert.equal(page.state[0][0].notificationId, "first-page");
  assert.equal(page.state[1], "older-page");
  assert.equal(page.state[3], false);
  assert.equal(page.state[4], false);
  assert.equal(page.state[7], "Clear failed");
});
