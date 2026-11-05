const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const test = require("node:test");
// Exercise real component hooks and handlers with deterministic requests, following boardDetailPage.test.js.
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Pages/AlbumMappings.jsx"), "utf8");
const body = source.slice(source.indexOf("export default function AlbumMappings()"), source.indexOf("  if (!isLoaded) return <section")).replace("export default ", "");
const actions = fs.readFileSync(path.join(__dirname, "../frontend/src/features/lastfm/mappingActions.js"), "utf8").replace(/export /g, "");
const retryHandler = source.match(/onClick=\{(\(\) => [^\n]+?)\} type="button">Try again/)[1];
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
function harness() {
  let hook = 0; let route = 'case-a'; let detailResponse; let rejectPost = false;
  const slots = []; const effects = []; const requests = [];
  const getToken = async () => 'offline-token';
  let getHold; let failGet = false; let postHold;
  const context = vm.createContext({
    AbortController, console,
    useReviewTimer: () => ({ finish() {}, commandFields: () => ({}) }),
    useAuth: () => ({ getToken, isLoaded: true, isSignedIn: true }),
    useParams: () => ({ caseId: route }),
    useNavigate: () => (url) => { route = url.split('/').at(-1); },
    useRef(current) { const i = hook++; if (!(i in slots)) slots[i] = { current }; return slots[i]; },
    useState(initial) { const i = hook++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useCallback(fn, deps) { const i = hook++; if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useMemo(fn, deps) { const i = hook++; if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = hook++; if (!slots[i] || !sameDeps(slots[i].deps, deps)) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
    ALBUM_MAPPING_PATH: '/moderation/album-mappings',
    lastfmUrl: (url) => url,
    candidateCoverageWarning: () => '',
    errorState: (error) => ({ message: error.message, status: error.status, code: error.code }),
    requestLastfmJson: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
      if (options.method === 'POST') { const response = structuredClone(detailResponse); if (postHold) { const hold = postHold; postHold = null; await hold.promise; } if (rejectPost) throw Object.assign(new Error('STATE_CONFLICT'), { status: 409, code: 'STATE_CONFLICT' }); return response; }
      if (url.includes('/case-')) { const response = structuredClone(detailResponse); if (getHold) { const hold = getHold; getHold = null; await hold.promise; } if (failGet) throw Object.assign(new Error('Offline'), { status: 503 }); return response; }
      return { items: [] };
    },
  });
  const renderCode = `(() => { ${actions}\n${body}\nreturn { action, actionOptions, setAction, reason, setReason, selectedAlbumId, setSelectedAlbumId, reviewAlbumId, detail, detailLoading, detailError, command, applyAction, loadQueue, handleBaselineStateChange, retry: ${retryHandler} }; } return AlbumMappings(); })()`;
  return {
    render() { hook = 0; return vm.runInContext(renderCode, context); },
    async flush() { for (const fn of effects.splice(0)) fn(); for (let i = 0; i < 8; i++) await Promise.resolve(); },
    setResponse(value) { detailResponse = value; },
    rejectPost(value = true) { rejectPost = value; },
    route(value) { route = value; },
    failGet(value = true) { failGet = value; },
    holdGet() { let resolve; const promise = new Promise((done) => { resolve = done; }); getHold = { promise }; return resolve; },
    holdPost() { let resolve; const promise = new Promise((done) => { resolve = done; }); postHold = { promise }; return resolve; },
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
  const pending = h.render().retry(); await h.flush();
  assert.equal(h.render().detail, null);
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
