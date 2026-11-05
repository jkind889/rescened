const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const test = require("node:test");
// Exercise real component hooks and handlers with deterministic requests, following boardDetailPage.test.js.
const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Pages/AlbumMappings.jsx"), "utf8");
const body = source.slice(source.indexOf("export default function AlbumMappings()"), source.indexOf("  if (!isLoaded) return <section")).replace("export default ", "");
const actions = fs.readFileSync(path.join(__dirname, "../frontend/src/features/lastfm/mappingActions.js"), "utf8").replace(/export /g, "");
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
      if (options.method === 'POST') { if (postHold) { const hold = postHold; postHold = null; await hold.promise; } if (rejectPost) throw Object.assign(new Error('STATE_CONFLICT'), { status: 409, code: 'STATE_CONFLICT' }); return structuredClone(detailResponse); }
      if (url.includes('/case-')) { const response = structuredClone(detailResponse); if (getHold) { const hold = getHold; getHold = null; await hold.promise; } if (failGet) throw Object.assign(new Error('Offline'), { status: 503 }); return response; }
      return { items: [] };
    },
  });
  const renderCode = `(() => { ${actions}\n${body}\nreturn { action, actionOptions, setAction, reason, setReason, selectedAlbumId, setSelectedAlbumId, reviewAlbumId, detail, detailLoading, detailError, command, applyAction, loadQueue, handleBaselineStateChange, retry: typeof loadDetail === "function" ? loadDetail : () => navigate(ALBUM_MAPPING_PATH + "/" + caseId) }; } return AlbumMappings(); })()`;
  return {
    render() { hook = 0; return vm.runInContext(renderCode, context); },
    async flush() { for (const fn of effects.splice(0)) fn(); for (let i = 0; i < 8; i++) await Promise.resolve(); },
    setResponse(value) { detailResponse = value; },
    rejectPost() { rejectPost = true; },
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
  }
});
test("reconfirmation reviews the mapped album even if another candidate was selected", async () => {
  const h = await loaded(); h.render().setSelectedAlbumId("album-b");
  assert.equal(h.render().reviewAlbumId, "album-a");
});
