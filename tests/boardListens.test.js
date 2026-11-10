const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Exercise the component's real state and async handlers with fixture requests.
// Rendered UI is also checked separately in the browser.
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/BoardListens.jsx"), "utf8");
const component = source.slice(source.indexOf("export default function"), source.indexOf("  function handleKeys"))
  .replace("export default ", "") + `
  return { mode, listens, cursor, loading, busy, error, message, load, changeMode, membership };
}
BoardListens(props);`;

function harness({ readOnly = false } = {}) {
  const slots = [];
  let hook = 0;
  const calls = [];
  const rows = [
    { listenId: "linked", listenedOn: "2026-11-01", inBoard: true },
    { listenId: "same-day", listenedOn: "2026-11-01", inBoard: false },
    { listenId: "older", listenedOn: "2026-10-31", source: "automatic", inBoard: false },
  ];
  let failWrite = false;
  let failParent = false;
  let release;
  const getToken = async () => "fixture-token";
  const context = vm.createContext({
    AbortController, API_BASE_URL: "https://fixture.invalid",
    props: { album: { albumId: "album" }, boardId: "board", userId: readOnly ? "owner" : undefined,
      onChanged: async () => { if (failParent) throw new Error("Board refresh failed"); } },
    useAuth: () => ({ isSignedIn: true, getToken }),
    useState: (initial) => {
      const index = hook++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef: (initial) => {
      const index = hook++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (fn) => fn, useEffect: () => {},
    getApiErrorMessage: async (response) => (await response.json()).error,
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      calls.push({ url, method });
      if (method !== "GET") {
        if (release) await release.promise;
        if (failWrite) return { ok: false, json: async () => ({ error: "Could not add listen" }) };
        rows.find((row) => row.listenId === url.split("/").at(-1)).inBoard = method === "PUT";
        return { ok: true };
      }
      const diary = url.includes("/diary?");
      const older = url.includes("cursor=");
      const selected = diary ? (older ? rows.slice(2) : rows.slice(0, 2)) : rows.filter((row) => row.inBoard);
      return { ok: true, json: async () => ({ listens: selected.map((row) => ({ ...row })), nextCursor: diary && !older ? "older-page" : null }) };
    },
  });
  const render = () => { hook = 0; return vm.runInContext(component, context); };
  return {
    render, calls,
    failWrite() { failWrite = true; },
    failParent() { failParent = true; },
    holdWrite() {
      let done;
      release = { promise: new Promise((resolve) => { done = resolve; }) };
      return done;
    },
    async diary() { render().changeMode("diary"); await render().load(); },
  };
}

test("picker requests selected-board membership and does not add an already linked listen", async () => {
  const page = harness();
  await page.diary();
  assert.match(page.calls[0].url, /diary\?albumId=album&membershipBoardId=board/);
  await page.render().membership("linked");
  assert.equal(page.calls.filter((call) => call.method === "PUT").length, 0);
  await page.render().membership("same-day");
  assert.equal(page.calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(page.render().listens.find((row) => row.listenId === "same-day").inBoard, true);
});

test("adding an older listen marks only that row without dropping pages or retrying a duplicate", async () => {
  const page = harness();
  await page.diary();
  await page.render().load(page.render().cursor);
  const before = page.calls.length;
  await page.render().membership("older");
  const after = page.render();
  assert.equal(after.listens.length, 3);
  assert.equal(after.listens[1].inBoard, false);
  assert.equal(after.listens[2].inBoard, true);
  assert.equal(after.listens[2].source, "automatic");
  assert.equal(page.calls.length, before + 1, "does not reset to the first diary page");
  await after.membership("older");
  assert.equal(page.calls.length, before + 1);
});

test("failed adds remain available, successful adds stay marked if parent refresh fails", async () => {
  for (const failure of ["failWrite", "failParent"]) {
    const page = harness();
    await page.diary();
    page[failure]();
    await page.render().membership("same-day");
    assert.equal(page.render().listens[1].inBoard, failure === "failParent");
    assert.ok(page.render().error);
    assert.equal(page.render().busy, false);
  }
});

test("repeated add events cannot race before React renders the busy state", async () => {
  const page = harness();
  await page.diary();
  const release = page.holdWrite();
  const state = page.render();
  const first = state.membership("same-day");
  await state.membership("same-day");
  release();
  await first;
  assert.equal(page.calls.filter((call) => call.method === "PUT").length, 1);
});

test("removing a linked listen makes it available when returning to the diary picker", async () => {
  const page = harness();
  await page.render().load();
  await page.render().membership("linked");
  await page.diary();
  assert.equal(page.render().listens.find((row) => row.listenId === "linked").inBoard, false);
});

test("public board dates remain read-only and do not request owner membership annotations", async () => {
  const page = harness({ readOnly: true });
  await page.render().load();
  await page.render().membership("linked");
  assert.equal(page.calls.length, 1);
  assert.match(page.calls[0].url, /\/profile\/owner\/boards\/board/);
  assert.doesNotMatch(page.calls[0].url, /membershipBoardId/);
});

test("already-added rows have a muted state and a labelled disabled native button", () => {
  assert.match(source, /const alreadyAdded = mode === "diary" && listen.inBoard/);
  assert.match(source, /className=\{alreadyAdded \? "is-in-board" : undefined\}/);
  assert.match(source, /disabled=\{busy \|\| loading \|\| alreadyAdded\}/);
  assert.match(source, /alreadyAdded \? "Already in board"/);
  const css = fs.readFileSync(path.join(__dirname, "../frontend/src/App.css"), "utf8");
  assert.match(css, /\.board-listens-list li\.is-in-board \{[^}]*color: var\(--app-muted\);[^}]*opacity: 0\.65;/);
});
