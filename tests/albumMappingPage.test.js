const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const test = require("node:test");
// Exercise real component hooks and handlers with deterministic requests, following boardDetailPage.test.js.
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Pages/AlbumMappings.jsx"), "utf8");
const body = source.slice(source.indexOf("export default function AlbumMappings()"), source.indexOf("  if (!isLoaded || displayedSession !== authSession) return <section")).replace("export default ", "");
const actions = fs.readFileSync(path.join(__dirname, "../frontend/src/features/lastfm/mappingActions.js"), "utf8").replace(/export /g, "");
const search = fs.readFileSync(path.join(__dirname, "../frontend/src/features/lastfm/mappingQueueSearch.js"), "utf8").replace(/export /g, "");
const lastfm = fs.readFileSync(path.join(__dirname, "../frontend/src/features/lastfm/lastfm.js"), "utf8");
const lastfmUrl = lastfm.slice(lastfm.indexOf("export function lastfmUrl"), lastfm.indexOf("export function formatLastfmDate")).replace("export ", "");
const community = fs.readFileSync(path.join(__dirname, "../frontend/src/features/community/community.js"), "utf8");
const communityErrorFrom = community.slice(community.indexOf("export function communityErrorFrom")).replace("export ", "");
const errorState = source.slice(source.indexOf("function errorState"), source.indexOf("function formatCount"));
const retryHandler = source.match(/onClick=\{(\(\) => [^\n]+?)\} type="button">Try again/)[1];
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function harness(initialRoute = "case-a") {
  let hook = 0; let route = initialRoute; let detailResponse; let rejectPost = false;
  let auth = { isLoaded: true, isSignedIn: true, userId: "moderator-1", sessionId: "session-1" };
  const slots = []; const effects = []; const requests = [];
  let tokenHold;
  const getToken = async () => {
    if (tokenHold) { const hold = tokenHold; tokenHold = null; return hold.promise; }
    return "offline-token";
  };
  let getHold; let failGet = false; let postHold;
  let queueResponse = { items: [] }; let queueHold;
  let now = 0; let timerId = 0;
  const timers = new Map();
  async function flush() {
    for (const fn of effects.splice(0)) fn();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  const context = vm.createContext({
    AbortController, console, URLSearchParams, API_BASE_URL: "",
    setTimeout(fn, delay) { timers.set(++timerId, { at: now + delay, fn }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    useReviewTimer: () => ({ finish() {}, commandFields: () => ({}) }),
    useAuth: () => ({ getToken, ...auth }),
    useParams: () => ({ caseId: route }),
    useNavigate: () => (url) => { route = url.split('/').at(-1); },
    useRef(current) { const i = hook++; if (!(i in slots)) slots[i] = { current }; return slots[i]; },
    useState(initial) { const i = hook++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useCallback(fn, deps) { const i = hook++; if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useMemo(fn, deps) { const i = hook++; if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = hook++; if (!slots[i] || !sameDeps(slots[i].deps, deps)) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
    ALBUM_MAPPING_PATH: '/moderation/album-mappings',
    candidateCoverageWarning: () => '',
    requestLastfmJson: async (url, options = {}) => {
      const parsed = new URL(url, "http://fixture.invalid");
      requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body), path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), signal: options.signal });
      if (options.method === 'POST') { const response = structuredClone(detailResponse); if (postHold) { const hold = postHold; postHold = null; await hold.promise; } if (rejectPost) throw Object.assign(new Error('STATE_CONFLICT'), { status: 409, code: 'STATE_CONFLICT' }); return response; }
      if (url.includes('/case-')) {
        const response = detailResponse instanceof Error ? detailResponse : structuredClone(detailResponse);
        if (getHold) { const hold = getHold; getHold = null; await hold.promise; }
        if (failGet) throw Object.assign(new Error('Offline'), { status: 503 });
        if (response instanceof Error) throw response;
        return response;
      }
      if (queueHold) { const hold = queueHold; queueHold = null; return hold.promise; }
      if (queueResponse instanceof Error) throw queueResponse;
      return structuredClone(queueResponse);
    },
  });
  const renderCode = `(() => { ${actions}\n${search}\n${lastfmUrl}\n${communityErrorFrom}\n${errorState}\n${body}\nreturn {
    action, actionOptions, setAction, reason, setReason, selectedAlbumId, setSelectedAlbumId, reviewAlbumId,
    detail, detailLoading, detailError, command, applyAction, loadQueue, handleBaselineStateChange, retry: ${retryHandler},
    searchCatalog, catalogQuery, setCatalogQuery, catalogLoading, baselineBusy, setBaselineBusy,
    queueQuery, setQueueQuery, setStatus, setPriorityOnly, setStaleOnly, queueSearchInput, handleQueueSearchSubmit,
    clearQueueSearch, items, nextCursor, queueLoading, queueLoadingMore, queueError, queueStatus, queuePending,
    loadMoreQueue, retryQueue, accessDenied,
  }; } return AlbumMappings(); })()`;
  return {
    render() { hook = 0; return vm.runInContext(renderCode, context); },
    flush,
    async advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
      await flush();
    },
    setQueueResponse(value) { queueResponse = value; },
    setAuth(value) { auth = value; },
    holdQueue() { queueHold = deferred(); return queueHold; },
    holdToken() { tokenHold = deferred(); return tokenHold; },
    queueRequests() { return requests.filter((request) => request.path === "/moderation/album-mappings"); },
    setResponse(value) { detailResponse = value; },
    rejectPost(value = true) { rejectPost = value; },
    route(value) { route = value; },
    failGet(value = true) { failGet = value; },
    holdGet() { let resolve; const promise = new Promise((done) => { resolve = done; }); getHold = { promise }; return resolve; },
    holdPost() { let resolve; const promise = new Promise((done) => { resolve = done; }); postHold = { promise }; return resolve; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
    requests,
  };
}

function view(status = "approved", mapping = {}) {
  return { case: { caseId: "case-a", status, revision: 2, candidates: [{ albumId: "album-a", catalogRevision: 7 }] },
    mapping: status === "approved" ? { albumId: "album-a", status: "active", catalogRevision: 6, currentCatalogRevision: 7, stale: true, ...mapping } : null };
}
async function loaded(response = view()) { const h = harness(); h.setResponse(response); h.render(); await h.flush(); return h; }
const event = { preventDefault() {} };

test("approved stale mappings offer and submit reconfirm against the reviewed revision", async () => {
  const h = await loaded(); const page = h.render();
  assert.equal(page.action, "reconfirm");
  assert.equal(page.actionOptions.some((option) => option.value === "approve"), false);
  await page.applyAction(event);
  const post = h.requests.find((row) => row.method === "POST");
  assert.ok(post.url.endsWith("/reconfirm"));
  assert.equal(post.body.expectedCatalogRevision, 7);
  assert.equal(post.body.expectedRevision, 2);
  assert.equal("albumId" in post.body, false);
});
for (const status of ["pending", "rejected", "no_catalog_match"]) test(`${status} cases retain approval`, async () => {
  const h = await loaded(view(status)); let page = h.render(); page.setSelectedAlbumId("album-a"); page = h.render();
  assert.equal(page.action, "approve"); await page.applyAction(event);
  assert.ok(h.requests.find((row) => row.method === "POST").url.endsWith("/approve"));
});
test("current, deleted, and inactive mappings cannot be reconfirmed", async () => {
  for (const mapping of [{ stale: false }, { currentCatalogRevision: null }, { status: "revoked" }]) {
    const h = await loaded(view("approved", mapping));
    assert.equal(h.render().actionOptions.some((option) => ["approve", "reconfirm"].includes(option.value)), false);
    assert.equal(h.render().action, "refresh", "revocation must be an explicit choice");
  }
});
test("reconfirmation reviews the mapped album even if another candidate was selected", async () => {
  const h = await loaded(); h.render().setSelectedAlbumId("album-b");
  assert.equal(h.render().reviewAlbumId, "album-a");
});

test("conflict retry fetches fresh details and requires a new decision", async () => {
  const h = await loaded(); h.rejectPost();
  await h.render().applyAction(event);
  assert.equal(h.render().detailError.code, "STATE_CONFLICT");
  const count = () => h.requests.filter((row) => row.method === "POST").length;
  await h.render().applyAction(event);
  assert.equal(count(), 1, "conflicted data cannot be submitted again");
  h.setResponse({ ...view(), case: { ...view().case, revision: 9 }, mapping: { ...view().mapping, currentCatalogRevision: 12 } });
  await h.render().retry();
  const page = h.render();
  assert.equal(page.detail.case.revision, 9);
  assert.equal(page.detail.mapping.currentCatalogRevision, 12);
  assert.equal(page.detailError, null);
  assert.equal(count(), 1, "GET recovery must not resubmit a decision");
  assert.equal(h.requests.filter((row) => row.url.endsWith('/case-a') && row.method === 'GET').length, 2);
  h.rejectPost(false); await h.render().applyAction(event);
  const post = h.requests.filter((row) => row.method === "POST").at(-1);
  assert.equal(post.body.expectedCatalogRevision, 12);
  assert.equal(post.body.expectedRevision, 9);
});

test("pending and failed reloads cannot submit the old case", async () => {
  const h = await loaded(); const release = h.holdGet();
  h.render().setBaselineBusy(true);
  const pending = h.render().retry(); await h.flush();
  assert.equal(h.render().detail, null);
  assert.equal(h.render().baselineBusy, false);
  await h.render().applyAction(event);
  assert.equal(h.requests.some((row) => row.method === "POST"), false);
  h.failGet(); release(); await pending;
  assert.equal(h.render().detail, null);
  assert.ok(h.render().detailError);
  await h.render().applyAction(event);
  assert.equal(h.requests.some((row) => row.method === "POST"), false);
});

test("out-of-order detail responses cannot replace the newest review", async () => {
  const h = await loaded(); const release = h.holdGet();
  const older = h.render().retry(); await h.flush();
  h.setResponse({ ...view(), case: { ...view().case, revision: 10 } });
  await h.render().retry(); release(); await older;
  assert.equal(h.render().detail.case.revision, 10);
});

test("switching cases clears drafts and ignores a previous case fetch", async () => {
  const h = await loaded(); h.render().setReason("Case A only"); h.render().setAction("revoke");
  const release = h.holdGet(); const older = h.render().retry(); await h.flush();
  h.setResponse({ ...view("pending"), case: { ...view("pending").case, caseId: "case-b" } });
  h.route("case-b"); const immediate = h.render();
  await immediate.applyAction(event);
  assert.equal(h.requests.some((row) => row.method === "POST"), false);
  await h.flush(); release(); await older;
  const page = h.render();
  assert.equal(page.detail.case.caseId, "case-b");
  assert.equal(page.reason, "");
  assert.equal(page.action, "approve");
});

test("a previous case mutation response cannot overwrite the newly selected case", async () => {
  const h = await loaded(); const release = h.holdPost();
  const pending = h.render().applyAction(event); await h.flush();
  h.setResponse({ ...view("pending"), case: { ...view("pending").case, caseId: "case-b" } });
  h.route("case-b"); h.render(); await h.flush(); release(); await pending;
  assert.equal(h.render().detail.case.caseId, "case-b");
  assert.equal(h.render().command.success, "");
});

test("baseline decisions refresh authoritative mapping revision and staleness", async () => {
  const h = await loaded();
  h.setResponse(view("approved", { catalogRevision: 8, currentCatalogRevision: 8, stale: false }));
  h.render().handleBaselineStateChange(); await h.flush();
  assert.equal(h.render().detail.mapping.stale, false);
  assert.equal(h.render().actionOptions.some((option) => option.value === "reconfirm"), false);
});

test("a mismatched detail response is rejected", async () => {
  const h = await loaded(); h.setResponse({ ...view(), case: { ...view().case, caseId: "case-b" } });
  await h.render().retry();
  assert.equal(h.render().detail, null);
  assert.ok(h.render().detailError);
});

test("a baseline completion from case A cannot clear the loaded case B", async () => {
  const h = await loaded();
  const completeA = h.render().handleBaselineStateChange;
  h.setResponse({ ...view("pending"), case: { ...view("pending").case, caseId: "case-b" } });
  h.route("case-b"); h.render(); await h.flush();
  assert.equal(h.render().detail.case.caseId, "case-b");
  const before = h.requests.length;
  completeA(); await h.flush();
  assert.equal(h.render().detail.case.caseId, "case-b");
  assert.equal(h.render().detailLoading, false);
  assert.equal(h.render().detailError, null);
  assert.equal(h.requests.length, before, "obsolete callbacks must not request or abort anything");
});

test("a baseline completion from a superseded review cannot interrupt its reload", async () => {
  const h = await loaded();
  const completeOldReview = h.render().handleBaselineStateChange;
  const release = h.holdGet();
  const reload = h.render().retry(); await h.flush();
  const before = h.requests.length;
  completeOldReview(); await h.flush();
  assert.equal(h.requests.length, before);
  release(); await reload;
  assert.equal(h.render().detail.case.caseId, "case-a");
  assert.equal(h.render().detailError, null);
});


test("a baseline completion after unmount cannot start another fetch", async () => {
  const h = await loaded();
  const complete = h.render().handleBaselineStateChange;
  h.unmount();
  const before = h.requests.length;
  complete(); await h.flush();
  assert.equal(h.requests.length, before);
});

const queuePage = (ids, nextCursor = null) => ({ items: ids.map((caseId) => ({ caseId })), nextCursor });
const queueIds = (h) => Array.from(h.render().items, ({ caseId }) => caseId);
async function loadQueueHarness(response = queuePage(["initial"], "initial-cursor")) {
  const h = harness("");
  h.setQueueResponse(response);
  h.render();
  await h.flush();
  return h;
}
async function editQueue(h, value) {
  h.render().setQueueQuery(value);
  h.render();
  await h.flush();
}

test("rapid album edits debounce, clear the old page immediately, and ignore normalization-only edits", async () => {
  const h = await loadQueueHarness();
  assert.equal(h.render().nextCursor, "initial-cursor");
  await editQueue(h, "ca");
  assert.deepEqual(queueIds(h), []);
  assert.equal(h.render().nextCursor, "");
  assert.equal(h.render().queueLoading, true);
  await h.advance(199);
  await editQueue(h, "  Ｃａｆｅ\u2009 (Live)  ");
  h.setQueueResponse(queuePage(["live"]));
  await h.advance(199);
  assert.equal(h.queueRequests().length, 1);
  await h.advance(1);
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "pending", q: "Cafe (Live)" });
  assert.deepEqual(queueIds(h), ["live"]);
  assert.equal(h.render().queueStatus, "1 matching case");
  await editQueue(h, "Cafe  (Live)   ");
  await h.advance(200);
  assert.equal(h.queueRequests().length, 2);
});

test("overlong normalized searches cancel work locally and recover on shortening or clearing", async () => {
  const h = await loadQueueHarness();
  const previous = h.holdQueue();
  const oldPage = h.render().loadMoreQueue();
  await h.flush();
  const inFlight = h.queueRequests().at(-1);
  const invalid = "ﬃ".repeat(67);
  await editQueue(h, invalid);
  assert.equal(inFlight.signal.aborted, true);
  previous.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
  await oldPage;

  let page = h.render();
  assert.deepEqual({ ...page.queueError }, {
    message: "Album search must be 200 characters or fewer after normalization.",
    code: "INVALID_QUERY",
    status: 400,
  });
  assert.deepEqual(queueIds(h), []);
  assert.equal(page.nextCursor, "");
  assert.equal(page.queueStatus, "");
  assert.equal(page.queueLoading, false);
  assert.equal(page.queueLoadingMore, false);
  assert.equal(page.queuePending.current, false);

  page.handleQueueSearchSubmit(event);
  await page.loadQueue();
  await page.retryQueue();
  page.setPriorityOnly(true);
  h.render();
  await h.flush();
  await h.advance(200);
  assert.equal(h.queueRequests().length, 2);

  await editQueue(h, "valid but pending debounce");
  await editQueue(h, invalid);
  await h.advance(200);
  assert.equal(h.queueRequests().length, 2, "the invalid edit cancels a pending search");
  await editQueue(h, "ﬃ".repeat(66));
  h.setQueueResponse(queuePage(["shortened search"]));
  await h.advance(200);
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "pending", priority: "high", q: "ffi".repeat(66) });
  assert.deepEqual(queueIds(h), ["shortened search"]);
  assert.equal(h.render().queueError, null);

  await editQueue(h, invalid);
  h.setQueueResponse(queuePage(["initial"]));
  h.render().clearQueueSearch();
  h.render();
  await h.flush();
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "pending", priority: "high" });
  assert.deepEqual(queueIds(h), ["initial"]);
  assert.equal(h.render().queueError, null);
});

test("late queue success and failure leave the current results and loading state alone", async () => {
  const h = await loadQueueHarness();
  const oldSuccess = h.holdQueue();
  await editQueue(h, "old success");
  await h.advance(200);
  const oldRequest = h.queueRequests().at(-1);
  const oldError = h.holdQueue();
  await editQueue(h, "old error");
  await h.advance(200);
  const errorRequest = h.queueRequests().at(-1);
  const latest = h.holdQueue();
  await editQueue(h, "latest");
  await h.advance(200);
  assert.equal(oldRequest.signal.aborted, true);
  assert.equal(errorRequest.signal.aborted, true);
  oldError.reject(Object.assign(new Error("Forbidden"), { status: 403, code: "MODERATOR_REQUIRED" }));
  await h.flush();
  assert.equal(h.render().queueLoading, true);
  assert.equal(h.render().queueError, null);
  assert.equal(h.render().accessDenied, false);
  latest.resolve(queuePage(["newest"], "latest-cursor"));
  await h.flush();
  oldSuccess.resolve(queuePage(["outdated"], "obsolete-cursor"));
  await h.flush();
  assert.deepEqual(queueIds(h), ["newest"]);
  assert.equal(h.render().nextCursor, "latest-cursor");
  assert.equal(h.render().queueLoading, false);
});

test("changing a filter fetches immediately with the current search and resets pagination", async () => {
  const h = await loadQueueHarness();
  await editQueue(h, "album");
  h.setQueueResponse(queuePage(["pending match"], "searched-cursor"));
  await h.advance(200);
  const request = h.holdQueue();
  h.render().setStatus("approved");
  h.render().setPriorityOnly(true);
  h.render().setStaleOnly(true);
  h.render();
  await h.flush();
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "approved", priority: "high", stale: "true", q: "album" });
  assert.deepEqual(queueIds(h), []);
  assert.equal(h.render().nextCursor, "");
  request.resolve(queuePage(["approved match"]));
  await h.flush();
  assert.deepEqual(queueIds(h), ["approved match"]);

  await editQueue(h, "new album");
  h.render().setPriorityOnly(false);
  h.render();
  await h.flush();
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "approved", stale: "true", q: "new album" });
  const count = h.queueRequests().length;
  await h.advance(200);
  assert.equal(h.queueRequests().length, count);
});

test("Load more deduplicates cases and is cancelled when a query changes", async () => {
  const h = await loadQueueHarness();
  await editQueue(h, "live");
  h.setQueueResponse(queuePage(["one", "two"], "page-two"));
  await h.advance(200);
  const pageTwo = h.holdQueue();
  const load = h.render().loadMoreQueue;
  const more = load();
  void load();
  await h.flush();
  assert.equal(h.queueRequests().length, 3);
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "pending", cursor: "page-two", q: "live" });
  assert.equal(h.render().queueStatus, "2+ matching cases · Loading more…");
  pageTwo.resolve(queuePage(["two", "three", "three"], "page-three"));
  await more;
  assert.deepEqual(queueIds(h), ["one", "two", "three"]);
  const pageThree = h.holdQueue();
  const obsolete = h.render().loadMoreQueue();
  await h.flush();
  const appendRequest = h.queueRequests().at(-1);
  await editQueue(h, "studio");
  assert.equal(appendRequest.signal.aborted, true);
  assert.equal(h.render().queueLoadingMore, false);
  h.setQueueResponse(queuePage(["studio"]));
  await h.advance(200);
  pageThree.resolve(queuePage(["obsolete"], "obsolete-cursor"));
  await obsolete;
  assert.deepEqual(queueIds(h), ["studio"]);
  assert.equal(h.render().nextCursor, "");
});

test("Enter and Refresh flush the debounce and Clear immediately restores the filtered queue", async () => {
  const h = await loadQueueHarness();
  let focused = false;
  h.render().queueSearchInput.current = { focus() { focused = true; } };
  await editQueue(h, "studio");
  h.render().handleQueueSearchSubmit(event);
  await h.flush();
  assert.equal(h.queueRequests().at(-1).params.q, "studio");
  await h.advance(200);
  assert.equal(h.queueRequests().length, 2);
  await editQueue(h, "demo");
  await h.render().loadQueue();
  assert.equal(h.queueRequests().at(-1).params.q, "demo");
  await h.advance(200);
  assert.equal(h.queueRequests().length, 3);
  h.render().clearQueueSearch();
  h.render();
  await h.flush();
  assert.equal(focused, true);
  assert.equal(h.render().queueQuery, "");
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "pending" });
});

test("unmount cancels queued timers and requests and token lookup cannot start obsolete fetches", async () => {
  const h = await loadQueueHarness();
  await editQueue(h, "timer");
  h.unmount();
  await h.advance(200);
  assert.equal(h.queueRequests().length, 1);

  const active = await loadQueueHarness();
  const token = active.holdToken();
  const pendingToken = active.render().loadQueue();
  await active.flush();
  const response = active.holdQueue();
  await editQueue(active, "new query");
  await active.advance(200);
  token.resolve("obsolete-token");
  await pendingToken;
  assert.equal(active.queueRequests().length, 2);
  const inFlight = active.queueRequests().at(-1);
  active.unmount();
  assert.equal(inFlight.signal.aborted, true);
  response.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await active.flush();
  assert.equal(active.render().queueError, null);
  assert.deepEqual(queueIds(active), []);
});

test("queue errors can retry the first page or a failed append and a current 403 restricts the desk", async () => {
  const h = await loadQueueHarness(new Error("Queue offline"));
  assert.equal(h.render().queueError.message, "Queue offline");
  h.setQueueResponse(queuePage(["one"], "second"));
  await h.render().retryQueue();
  assert.deepEqual(queueIds(h), ["one"]);
  h.setQueueResponse(new Error("Page offline"));
  await h.render().loadMoreQueue();
  assert.deepEqual(queueIds(h), ["one"]);
  assert.equal(h.render().nextCursor, "second");
  assert.equal(h.render().queueError.message, "Page offline");
  h.setQueueResponse(queuePage(["two"]));
  await h.render().retryQueue();
  assert.equal(h.queueRequests().at(-1).params.cursor, "second");
  assert.deepEqual(queueIds(h), ["one", "two"]);
  assert.equal(h.render().queueError, null);
  h.setQueueResponse(Object.assign(new Error("Forbidden"), { status: 403, code: "MODERATOR_REQUIRED" }));
  await h.render().loadQueue();
  assert.equal(h.render().accessDenied, true);
  assert.deepEqual(queueIds(h), []);
});

test("an unexpected abort of the current request releases the queue and supports retry on either page", async () => {
  const abort = Object.assign(new Error("Unexpected external abort"), { name: "AbortError" });
  const h = await loadQueueHarness(abort);
  const assertReleased = () => {
    const page = h.render();
    assert.equal(page.queueLoading, false);
    assert.equal(page.queueLoadingMore, false);
    assert.equal(page.queuePending.current, false);
    assert.equal(page.queueError.code, "REQUEST_FAILED");
    assert.equal(h.queueRequests().at(-1).signal.aborted, false);
  };
  assertReleased();
  h.setQueueResponse(queuePage(["first"], "second"));
  await h.render().retryQueue();
  assert.deepEqual(queueIds(h), ["first"]);
  assert.equal(h.render().queueError, null);

  h.setQueueResponse(abort);
  await h.render().loadMoreQueue();
  assertReleased();
  assert.deepEqual(queueIds(h), ["first"]);
  assert.equal(h.render().nextCursor, "second");
  h.setQueueResponse(queuePage(["next"]));
  await h.render().retryQueue();
  assert.equal(h.queueRequests().at(-1).params.cursor, "second");
  assert.deepEqual(queueIds(h), ["first", "next"]);
  assert.equal(h.render().queueError, null);
});

test("signing out or losing auth readiness clears pending queue state", async () => {
  for (const auth of [{ isLoaded: true, isSignedIn: false }, { isLoaded: false, isSignedIn: true }]) {
    const h = await loadQueueHarness();
    const pending = h.holdQueue();
    const loading = h.render().loadMoreQueue();
    await h.flush();
    const request = h.queueRequests().at(-1);
    h.setAuth(auth);
    h.render();
    await h.flush();
    assert.equal(request.signal.aborted, true);
    pending.reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    await loading;
    const page = h.render();
    assert.equal(page.queuePending.current, false);
    assert.equal(page.queueLoading, false);
    assert.equal(page.queueLoadingMore, false);
    assert.equal(page.queueError, null);
    assert.deepEqual(queueIds(h), []);
  }
});

const signedIn = (userId, sessionId) => ({ isLoaded: true, isSignedIn: true, userId, sessionId });

test("switching signed-in sessions clears private review state and ignores late responses", async () => {
  for (const reloadDetail of [false, true]) {
    const h = await loaded();
    await editQueue(h, "private search");
    const oldQueue = h.holdQueue();
    await h.advance(200);
    const queueRequest = h.queueRequests().at(-1);
    assert.equal(queueRequest.params.q, "private search");

    h.render().setReason("Private reason");
    const releasePost = h.holdPost();
    const pendingPost = h.render().applyAction(event);
    await h.flush();
    const commandRequest = h.requests.at(-1);
    assert.equal(commandRequest.method, "POST");
    assert.equal(commandRequest.signal.aborted, false);

    let releaseDetail;
    let pendingDetail;
    if (reloadDetail) {
      releaseDetail = h.holdGet();
      pendingDetail = h.render().retry();
      await h.flush();
    }
    const detailRequest = h.requests.findLast((request) => request.path.endsWith("/case-a"));
    assert.equal(detailRequest.signal.aborted, false);
    h.render().setBaselineBusy(true);
    h.render().setCatalogQuery("Private catalog query");
    const catalogToken = h.holdToken();
    const pendingCatalog = h.render().searchCatalog(event);

    const forbidden = Object.assign(new Error("Forbidden"), { status: 403, code: "MODERATOR_REQUIRED" });
    const queueCount = h.queueRequests().length;
    h.setQueueResponse(forbidden);
    h.setResponse(forbidden);
    h.setAuth(signedIn("regular-user", "session-2"));
    h.render();
    await h.flush();
    assert.equal(h.queueRequests().length, queueCount, "the old search must never run with the new session");
    h.render();
    await h.flush();
    assert.equal(h.queueRequests().length, queueCount + 1);
    assert.deepEqual(h.queueRequests().at(-1).params, { status: "pending" });
    assert.equal(queueRequest.signal.aborted, true);
    assert.equal(detailRequest.signal.aborted, true);
    assert.equal(commandRequest.signal.aborted, true);

    oldQueue.resolve(queuePage(["private row"], "private cursor"));
    releaseDetail?.();
    releasePost();
    catalogToken.resolve("old-token");
    await Promise.all([pendingDetail, pendingPost, pendingCatalog]);
    await h.flush();
    const restricted = h.render();
    assert.equal(restricted.accessDenied, true);
    assert.equal(restricted.queueError.code, "MODERATOR_REQUIRED");
    assert.equal(restricted.queueQuery, "");
    assert.deepEqual(queueIds(h), []);
    assert.equal(restricted.nextCursor, "");
    assert.equal(restricted.detail, null);
    assert.equal(restricted.baselineBusy, false);
    assert.equal(restricted.reason, "");
    assert.equal(restricted.catalogQuery, "");
    assert.equal(restricted.catalogLoading, false);
    assert.equal(restricted.command.pending, false);
    assert.equal(restricted.command.success, "");
    assert.equal(h.requests.some((request) => request.path.endsWith("/catalog-search")), false);
    assert.equal(h.queueRequests().length, queueCount + 1);

    h.setAuth(signedIn("moderator-2", "session-3"));
    h.setQueueResponse(queuePage(["fresh row"], "fresh cursor"));
    const fresh = view();
    fresh.case.revision = 5;
    h.setResponse(fresh);
    h.render();
    await h.flush();
    const authorized = h.render();
    assert.equal(authorized.accessDenied, false);
    assert.equal(authorized.queueError, null);
    assert.equal(authorized.queueQuery, "");
    assert.deepEqual(queueIds(h), ["fresh row"]);
    assert.equal(authorized.nextCursor, "fresh cursor");
    assert.equal(authorized.detail.case.revision, 5);
    assert.equal(h.queueRequests().length, queueCount + 2);
  }
});

test("a replacement Clerk session clears an overlong search before the next queue request", async () => {
  const h = await loadQueueHarness();
  await editQueue(h, "ﬃ".repeat(67));
  assert.equal(h.render().queueError.code, "INVALID_QUERY");
  const count = h.queueRequests().length;

  h.setAuth(signedIn("moderator-1", "replacement-session"));
  h.render();
  await h.flush();
  const cleared = h.render();
  assert.equal(cleared.queueQuery, "");
  assert.equal(cleared.queueError, null);
  assert.equal(h.queueRequests().length, count);
  await h.flush();
  assert.equal(h.queueRequests().length, count + 1);
  assert.deepEqual(h.queueRequests().at(-1).params, { status: "pending" });
  assert.deepEqual(queueIds(h), ["initial"]);
});

test("selecting a case preserves loaded pages and a pending decision refreshes the latest search", async () => {
  const h = await loadQueueHarness();
  await editQueue(h, "old search");
  await h.advance(200);
  h.setQueueResponse(queuePage(["next"]));
  await h.render().loadMoreQueue();
  const listCount = h.queueRequests().length;
  h.setResponse(view());
  h.route("case-a");
  h.render();
  await h.flush();
  assert.deepEqual(queueIds(h), ["initial", "next"]);
  assert.equal(h.queueRequests().length, listCount);
  assert.equal(h.render().queueQuery, "old search");
  const release = h.holdPost();
  const decision = h.render().applyAction(event);
  await h.flush();
  await editQueue(h, "new search");
  h.setQueueResponse(queuePage(["current"]));
  release();
  await decision;
  assert.equal(h.queueRequests().at(-1).params.q, "new search");
  await h.advance(200);
  assert.deepEqual(queueIds(h), ["current"]);
  assert.equal(h.queueRequests().length, listCount + 1);
});
