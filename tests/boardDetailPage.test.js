const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Run the page's real state and async handlers, as notificationPage.test.js
// does, with deterministic requests. Browser QA covers JSX and actual inputs.
const read = (file) => fs.readFileSync(path.join(__dirname, "../frontend/src", file), "utf8");
const source = read("Pages/BoardDetail.jsx");
const client = read("features/boards/boardOrder.js").replace(/^import .*;\n/gm, "").replace(/export /g, "");
const queue = read("features/queue/queue.js");
const moveItem = queue.slice(queue.indexOf("export function moveItem"), queue.indexOf("async function failure")).replace("export ", "");
const pageSource = source.slice(source.indexOf("const MAX_DESCRIPTION_LENGTH"), source.indexOf("  function renderListeningSummary"))
  .replace("export function", "function") + `
  return { board, title, description, order, isOrderDirty, isBoardBusy, isRefreshing, needsRefresh, actionError, orderStatus,
    setTitle, setDescription, setSelectedAlbum, fetchBoard, retryRefresh, renameBoard, saveDescription,
    updateOrderSettings, removeAlbum, keepAlbumSaved, moveAlbum, saveOrder, discardOrder };
}
return BoardDetail();`;
const renderSource = `(() => { ${client}\n${moveItem}\n${pageSource}\n})()`;
const ids = (value) => Array.from(value, (album) => album.albumId || album);
const event = { preventDefault() {} };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function pageHarness() {
  const slots = [];
  let hook = 0;
  let server = {
    boardId: "11111111-1111-4111-8111-111111111111", title: "Original", description: "", revision: 1,
    orderMode: "manual", displayStyle: "ranked", orderLimit: 100,
    albums: ["A", "B", "C"].map((albumId, index) => ({ albumId, title: albumId, savedAt: new Date(index * 1000).toISOString() })),
  };
  const calls = [];
  const holds = new Map();
  let failGet = false;
  let params = { boardId: server.boardId };
  const getToken = async () => "fixture-token";
  const useMemo = (fn, deps) => {
    const index = hook++;
    const previous = slots[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) slots[index] = { deps, value: fn() };
    return slots[index].value;
  };
  const context = vm.createContext({
    console, AbortController, Response, Date, API_BASE_URL: "https://fixture.invalid",
    useParams: () => params, useNavigate: () => () => {}, useAuth: () => ({ getToken, isLoaded: true, isSignedIn: true }),
    useState: (initial) => {
      const index = hook++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef: (current) => {
      const index = hook++;
      if (!(index in slots)) slots[index] = { current };
      return slots[index];
    },
    useMemo, useCallback: (fn, deps) => useMemo(() => fn, deps), useEffect: () => {}, useDeferredValue: (value) => value,
    getApiErrorMessage: async (response, fallback) => (await response.json()).error || fallback,
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method, url, body });
      const hold = holds.get(method);
      if (hold) { holds.delete(method); hold.reached.resolve(); await hold.release.promise; }
      if (method === "GET") return failGet ? reply({ error: "Offline" }, 503) : reply(server);
      if (method === "PATCH") {
        server = { ...server, ...body, revision: server.revision + 1 };
        const { albums, ...summary } = server;
        assert.ok(albums);
        return reply(summary);
      }
      if (method === "DELETE") server.albums = server.albums.filter((album) => !url.endsWith(`/${album.albumId}`));
      if (method === "PUT") {
        if (body.revision !== server.revision) return reply({ code: "BOARD_CHANGED", error: "Changed" }, 409);
        server.albums = body.albumIds.map((id) => server.albums.find((album) => album.albumId === id));
      }
      server.revision++;
      return reply(server);
    },
  });
  const render = () => { hook = 0; return vm.runInContext(renderSource, context); };
  await render().fetchBoard();
  return {
    render, calls,
    reverseElsewhere() { server.albums.reverse(); server.revision++; },
    failReads(value = true) { failGet = value; },
    navigate() { params = { boardId: "22222222-2222-4222-8222-222222222222" }; render(); },
    hold(method) {
      const hold = { reached: deferred(), release: deferred() };
      holds.set(method, hold);
      return { reached: hold.reached.promise, release: hold.release.resolve };
    },
  };
}

for (const [setter, handler] of [["setDescription", "saveDescription"], ["setTitle", "renameBoard"]]) {
  test(`${handler} reloads revision and albums together after another tab reordered`, async () => {
    const page = await pageHarness();
    page.reverseElsewhere();
    page.render()[setter]("Updated");
    await page.render()[handler](event);
    const loaded = page.render();
    assert.equal(loaded.board.revision, 3);
    assert.deepEqual(ids(loaded.board.albums), ["C", "B", "A"]);
    loaded.moveAlbum(1, 0);
    await page.render().saveOrder();
    const reorder = page.calls.find((call) => call.method === "PUT");
    assert.deepEqual(reorder.body, { albumIds: ["B", "C", "A"], revision: 3 });
  });

  test(`${handler} cannot replace an existing dirty draft`, async () => {
    const page = await pageHarness();
    page.render()[setter]("Updated");
    page.render().moveAlbum(1, 0);
    await page.render()[handler](event);
    assert.equal(page.calls.some((call) => call.method === "PATCH"), false);
    assert.deepEqual(ids(page.render().order), ["B", "A", "C"]);
  });
}

for (const [label, method, start] of [
  ["description", "PATCH", (page) => { page.render().setDescription("Changed"); return page.render().saveDescription(event); }],
  ["rename", "PATCH", (page) => { page.render().setTitle("Changed"); return page.render().renameBoard(event); }],
  ["settings", "PATCH", (page) => page.render().updateOrderSettings({ displayStyle: "grid" })],
  ["removal", "DELETE", (page) => page.render().removeAlbum("A")],
  ["explicit save", "POST", (page) => page.render().keepAlbumSaved("A")],
]) {
  test(`${label} prevents arranging during both the write and its refresh`, async () => {
    const page = await pageHarness();
    const write = page.hold(method);
    const operation = start(page);
    await write.reached;
    const pending = page.render();
    assert.equal(pending.isBoardBusy, true);
    pending.moveAlbum(2, 1);
    assert.equal(page.render().isOrderDirty, false);
    const refresh = page.hold("GET");
    write.release();
    await refresh.reached;
    const refreshing = page.render();
    assert.equal(refreshing.isRefreshing, true);
    refreshing.moveAlbum(2, 1);
    assert.equal(page.render().isOrderDirty, false);
    refresh.release();
    await operation;
    assert.equal(page.render().isBoardBusy, false);
    page.render().moveAlbum(1, 0);
    assert.equal(page.render().isOrderDirty, true);
  });
}

test("listen modal and its pending refresh prevent arranging after close", async () => {
  const page = await pageHarness();
  page.render().setSelectedAlbum({ albumId: "A" });
  page.render().moveAlbum(1, 0);
  assert.equal(page.render().isOrderDirty, false);
  const read = page.hold("GET");
  const refresh = page.render().fetchBoard(true);
  await read.reached;
  page.render().setSelectedAlbum(null);
  page.render().moveAlbum(1, 0);
  assert.equal(page.render().isOrderDirty, false);
  read.release();
  await refresh;
  assert.equal(page.render().isBoardBusy, false);
});

test("metadata refresh failure retains the old paired snapshot and blocks writes until retry", async () => {
  const page = await pageHarness();
  page.reverseElsewhere();
  page.failReads();
  page.render().setDescription("Changed");
  await page.render().saveDescription(event);
  const stale = page.render();
  assert.equal(stale.board.revision, 1);
  assert.deepEqual(ids(stale.board.albums), ["A", "B", "C"]);
  assert.equal(stale.needsRefresh, true);
  stale.moveAlbum(1, 0);
  assert.equal(page.render().isOrderDirty, false);
  page.failReads(false);
  await page.render().retryRefresh();
  assert.equal(page.render().board.revision, 3);
  assert.deepEqual(ids(page.render().order), ["C", "B", "A"]);
  assert.equal(page.render().isBoardBusy, false);
});

test("failed conflict refresh preserves the draft and reports failure, then explicit retry recovers", async () => {
  const page = await pageHarness();
  page.render().moveAlbum(1, 0);
  page.reverseElsewhere();
  page.failReads();
  await page.render().saveOrder();
  const failed = page.render();
  assert.deepEqual(ids(failed.order), ["B", "A", "C"]);
  assert.equal(failed.board.revision, 1);
  assert.equal(failed.isOrderDirty, true);
  assert.equal(failed.needsRefresh, true);
  assert.match(failed.actionError, /could not load/);
  assert.match(failed.actionError, /unsaved order is still shown/);
  assert.doesNotMatch(failed.actionError, /was discarded/);
  await failed.saveOrder();
  assert.equal(page.calls.filter((call) => call.method === "PUT").length, 1, "no stale retry");
  page.failReads(false);
  await page.render().retryRefresh();
  const recovered = page.render();
  assert.deepEqual(ids(recovered.order), ["C", "B", "A"]);
  assert.equal(recovered.board.revision, 2);
  assert.equal(recovered.isOrderDirty, false);
  assert.equal(recovered.actionError, "");
  assert.match(recovered.orderStatus, /unsaved order was discarded/);
});

test("successful conflict refresh reports recovery only after installing the latest snapshot", async () => {
  const page = await pageHarness();
  page.render().moveAlbum(1, 0);
  page.reverseElsewhere();
  await page.render().saveOrder();
  assert.deepEqual(ids(page.render().order), ["C", "B", "A"]);
  assert.equal(page.render().isOrderDirty, false);
  assert.match(page.render().actionError, /latest order is shown/);
});

test("repeated save and arrow events before a render cannot race an in-flight reorder", async () => {
  const page = await pageHarness();
  page.render().moveAlbum(1, 0);
  const dirty = page.render();
  const write = page.hold("PUT");
  const saving = dirty.saveOrder();
  await dirty.saveOrder();
  dirty.moveAlbum(2, 0);
  await write.reached;
  assert.deepEqual(ids(page.render().order), ["B", "A", "C"]);
  write.release();
  await saving;
  assert.equal(page.calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(page.render().isOrderDirty, false);
});

test("metadata completion after navigating does not install the previous board", async () => {
  const page = await pageHarness();
  page.render().setTitle("Changed");
  const write = page.hold("PATCH");
  const saving = page.render().renameBoard(event);
  await write.reached;
  page.navigate();
  write.release();
  await saving;
  assert.equal(page.calls.filter((call) => call.method === "GET").length, 1, "no previous-board refresh");
  assert.equal(page.render().board.title, "Original");
});

for (const [setter, otherSetter, handler, field, otherField] of [
  ["setDescription", "setTitle", "saveDescription", "description", "title"],
  ["setTitle", "setDescription", "renameBoard", "title", "description"],
]) {
  test(`${handler} preserves independently edited metadata and typing during the request`, async () => {
    const page = await pageHarness();
    page.render()[setter]("Submitted");
    page.render()[otherSetter]("Unsubmitted other field");
    const write = page.hold("PATCH");
    const saving = page.render()[handler](event);
    await write.reached;
    page.render()[setter]("Typed during request");
    write.release();
    await saving;
    const after = page.render();
    assert.equal(after[field], "Typed during request");
    assert.equal(after[otherField], "Unsubmitted other field");
    assert.equal(after.board[field], "Submitted");
    assert.equal(after.board.revision, 2);
  });
}
