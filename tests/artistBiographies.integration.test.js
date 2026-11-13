const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const F = require("./fixtures/biographies/fixtures");
const Artist = require("../models/Artist");
const ArtistBiography = require("../models/ArtistBiography");
const { newArtistDocument } = require("../lib/artists/identity");
const { createBiographySources } = require("../lib/artists/biographySources");
const { applyBiographyPlan, createBiographyPlan, refreshBiographies } = require("../lib/artists/biographyOperations");
const { writeOutcome } = require("../lib/artists/biographies");
const { resolveBiography } = require("../lib/artists/biographyResolver");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const ENV = {
  ARTIST_PAGES_ENABLED: "true", ARTIST_BIOGRAPHIES_ENABLED: "true", COMMUNITY_MODERATION_ENABLED: "true", MODERATOR_USER_IDS: "user_mod",
};
const NOW = new Date("2026-11-12T00:00:00Z");
const saved = {};
let replSet;
let server;
let baseUrl;
let artist;

function fakeSources(overrides) {
  return createBiographySources({ fetchFn: F.fakeFetch(overrides).fetchFn, musicBrainzGate: async () => {}, wikimediaGate: async () => {}, sleepFn: async () => {} });
}

async function call(method, route, { user, body } = {}) {
  const response = await saved.fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

const record = () => ArtistBiography.findOne({ artistId: artist.artistId }).lean();

async function publish(overrides) {
  const plan = await createBiographyPlan({ sources: fakeSources(overrides), artistIds: [artist.artistId], now: NOW, databaseName: "rescened_biographies" });
  const results = await applyBiographyPlan({ plan, sources: fakeSources(overrides), now: NOW });
  return { plan, results };
}

test.before(async () => {
  if (!enabled) return;
  saved.fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1:")) return saved.fetch(url, init);
    throw new Error(`Unexpected network request to ${url}`);
  };
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_biographies" });
  await Promise.all([Artist, ArtistBiography].map((model) => model.syncIndexes()));
  for (const [key, value] of Object.entries(ENV)) { saved[key] = process.env[key]; process.env[key] = value; }
  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: { getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }) } };
  const app = express();
  app.use(express.json());
  app.use("/artists", require("../routes/artists"));
  app.use("/moderation/artist-biographies", require("../routes/artistBiographyModeration"));
  if (previous) require.cache[clerkPath] = previous; else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all([Artist.deleteMany({}), ArtistBiography.deleteMany({})]);
  artist = await Artist.create(newArtistDocument({ name: "Fixture Band", artistMbid: F.ARTIST_MBID, source: "import" }));
});

test.after(async () => {
  if (!enabled) return;
  for (const key of Object.keys(ENV)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  globalThis.fetch = saved.fetch;
  server?.close();
  await mongoose.disconnect();
  await replSet?.stop();
});

integration("a reviewed plan is applied and served from the database with attribution, never from a provider", async () => {
  const { plan, results } = await publish();
  assert.equal(plan.items[0].outcome.status, "accepted");
  assert.deepEqual(results.map((row) => row.result), ["written"]);
  const page = await call("GET", `/artists/${artist.artistId}/biography`);
  assert.equal(page.status, 200);
  const bio = page.body.biography;
  assert.match(bio.text, /^Fixture Band are an English rock band/);
  assert.deepEqual([bio.source, bio.excerpt, bio.shortened, bio.edited, bio.license.name], ["Wikipedia", true, true, false, "CC BY-SA 4.0"]);
  assert.equal(bio.article.revisionUrl, `https://en.wikipedia.org/w/index.php?oldid=${F.REVISION}`);
  assert.equal(JSON.stringify(page.body).includes("_id"), false);
  assert.deepEqual((await call("GET", `/artists/${artist.artistId}`)).body.features, { discography: false, biography: true });
  const stored = await record();
  assert.deepEqual([stored.revision, stored.identity.state, stored.history.map((event) => event.action)], [1, "verified", ["resolve:accepted"]]);
  assert.equal(stored.nextContentCheckAt.getTime() - NOW.getTime(), 7 * 24 * 3600 * 1000);
  assert.equal(stored.identity.nextCheckAt.getTime() - NOW.getTime(), 30 * 24 * 3600 * 1000);

  process.env.ARTIST_BIOGRAPHIES_ENABLED = "false";
  try {
    assert.deepEqual([(await call("GET", `/artists/${artist.artistId}/biography`)).body.code, (await call("GET", `/artists/${artist.artistId}`)).body.features.biography], ["ARTIST_BIOGRAPHIES_DISABLED", false]);
  } finally { process.env.ARTIST_BIOGRAPHIES_ENABLED = "true"; }
  const none = await Artist.create(newArtistDocument({ name: "Other", artistMbid: F.OTHER_MBID, source: "import" }));
  assert.deepEqual((await call("GET", `/artists/${none.artistId}/biography`)).body, { artistId: none.artistId, biography: null });
});

integration("apply writes nothing that changed after review", async () => {
  const plan = await createBiographyPlan({ sources: fakeSources(), artistIds: [artist.artistId], now: NOW, databaseName: "rescened_biographies" });
  // The article was edited between review and apply.
  const edited = { page: () => F.wpPage({ lastrevid: F.REVISION + 1 }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")), html: F.LEAD_HTML.replace("are an English", "were an English") }) };
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(edited), now: NOW })).map((row) => row.result), ["outcome_changed"]);
  assert.equal(await record(), null);
  // The record changed between review and apply.
  await writeOutcome({ artistId: artist.artistId, record: null, outcome: { status: "not_linked", reasons: ["NO_WIKIDATA_LINK"] }, mode: "resolve", now: NOW });
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(), now: NOW })).map((row) => row.result), ["record_changed"]);
  assert.equal((await record()).identity.state, "not_linked");
});

integration("an applied provider failure records backoff so the next plan moves on to other artists", async () => {
  const failing = { musicbrainz: () => F.response({}, { status: 404 }) };
  const first = await createBiographyPlan({ sources: fakeSources(failing), limit: 5, now: NOW, databaseName: "rescened_biographies" });
  assert.deepEqual(first.items.map((item) => [item.artistId, item.outcome.status]), [[artist.artistId, "error"]]);
  const applied = await applyBiographyPlan({ plan: first, sources: fakeSources(failing), now: NOW });
  assert.deepEqual(applied.map((row) => [row.result, row.status, row.errorCode]), [["written", "error", "BIOGRAPHY_PROVIDER_HTTP"]]);
  const stored = await record();
  assert.deepEqual([stored.identity.state, stored.accepted, stored.fetch.consecutiveFailures, stored.fetch.lastErrorCode], ["unchecked", null, 1, "BIOGRAPHY_PROVIDER_HTTP"]);
  assert.ok(stored.fetch.nextAttemptAt > NOW);
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null, "a failure publishes nothing");
  // While in backoff the failing artist is not selected again.
  const second = await createBiographyPlan({ sources: fakeSources(), limit: 5, now: NOW, databaseName: "rescened_biographies" });
  assert.deepEqual(second.items, []);
  // A planned failure that has since recovered is a new answer and needs a new plan.
  await ArtistBiography.deleteMany({});
  const recovered = await applyBiographyPlan({ plan: first, sources: fakeSources(), now: NOW });
  assert.deepEqual(recovered.map((row) => row.result), ["outcome_changed"]);
  assert.equal(await record(), null);
});

integration("conflicts and needs-review outcomes are stored but never shown", async () => {
  await publish({ wikidata: () => F.wdEntity({ claims434: [F.p434(F.OTHER_MBID)] }) });
  assert.equal((await record()).identity.state, "conflict");
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null);
});

integration("refresh keeps text on transient errors, follows new revisions, and hides on conflict", async () => {
  await publish();
  const later = new Date(NOW.getTime() + 8 * 24 * 3600 * 1000);
  const failed = await refreshBiographies({ sources: fakeSources({ page: () => F.response({}, { status: 503 }) }), now: later });
  assert.deepEqual(failed.map((row) => [row.mode, row.status, row.result, row.errorCode]), [["content", "error", "written", "BIOGRAPHY_PROVIDER_HTTP"]]);
  let stored = await record();
  assert.deepEqual([stored.fetch.consecutiveFailures, stored.identity.state, stored.accepted.article.revisionId], [1, "verified", F.REVISION]);
  assert.ok((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, "still shown after a transient failure");
  assert.deepEqual(await refreshBiographies({ sources: fakeSources(), now: later }), [], "backoff defers the next attempt");

  const afterBackoff = new Date(later.getTime() + 2 * 3600 * 1000);
  const changed = { page: () => F.wpPage({ lastrevid: F.REVISION + 7 }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")) }) };
  assert.deepEqual((await refreshBiographies({ sources: fakeSources(changed), now: afterBackoff })).map((row) => row.status), ["accepted"]);
  stored = await record();
  assert.deepEqual([stored.accepted.article.revisionId, stored.fetch.consecutiveFailures], [F.REVISION + 7, 0]);

  const muchLater = new Date(afterBackoff.getTime() + 8 * 24 * 3600 * 1000);
  await refreshBiographies({ sources: fakeSources({ page: () => F.wpPage({ wikibase: F.OTHER_QID }) }), now: muchLater });
  assert.equal((await record()).identity.state, "conflict");
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null);
});

integration("refresh stages changed Wikipedia text for review; readers keep the reviewed excerpt until a moderator decides", async () => {
  await publish();
  const path = `/moderation/artist-biographies/${artist.artistId}`;
  const original = (await call("GET", `/artists/${artist.artistId}/biography`)).body.biography;
  const at = (days) => new Date(NOW.getTime() + days * 24 * 3600 * 1000);
  const revision = (revid, html) => ({ page: () => F.wpPage({ lastrevid: revid }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")), html }) });
  const vandal = F.LEAD_HTML.replace("are an English", "are a terrible");

  // A moderator correction and a suppression are both in place before refresh.
  let detail = (await call("GET", path, { user: "user_mod" })).body.biography;
  const corrected = await call("POST", `${path}/correct-text`, { user: "user_mod", body: { expectedRevision: detail.revision, text: "Fixture Band are an English rock band from Abingdon.", note: "Shorter" } });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));

  const staged = await refreshBiographies({ sources: fakeSources(revision(F.REVISION + 1, vandal)), now: at(8) });
  assert.deepEqual(staged.map((row) => [row.mode, row.status, row.result, row.action]), [["content", "accepted", "written", "content:revision_staged"]]);
  let stored = await record();
  assert.equal(stored.accepted.article.revisionId, F.REVISION, "the reviewed excerpt stays published");
  assert.equal(stored.pendingRevision.article.revisionId, F.REVISION + 1);
  assert.match(stored.pendingRevision.text, /terrible/);
  let shown = (await call("GET", `/artists/${artist.artistId}/biography`)).body.biography;
  assert.deepEqual([shown.text, shown.edited, shown.article.revisionId], ["Fixture Band are an English rock band from Abingdon.", true, F.REVISION], "readers never see unreviewed text");
  assert.equal(JSON.stringify(shown).includes("terrible"), false);

  // Moderators find it in the queue and see both texts.
  const queue = (await call("GET", "/moderation/artist-biographies?state=revision_pending", { user: "user_mod" })).body.biographies;
  assert.deepEqual(queue.map((row) => [row.artistId, row.pendingRevision, row.shown]), [[artist.artistId, true, true]]);
  detail = (await call("GET", path, { user: "user_mod" })).body.biography;
  assert.equal(detail.pendingRevision.article.revisionId, F.REVISION + 1);

  // Dismissing needs a reason; the same text is not staged again later.
  assert.equal((await call("POST", `${path}/dismiss-revision`, { user: "user_mod", body: { expectedRevision: detail.revision } })).status, 400);
  const dismissed = await call("POST", `${path}/dismiss-revision`, { user: "user_mod", body: { expectedRevision: detail.revision, reason: "Vandalism" } });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  assert.deepEqual([dismissed.body.biography.pendingRevision, dismissed.body.biography.dismissedRevision.reason], [null, "Vandalism"]);
  const again = await refreshBiographies({ sources: fakeSources(revision(F.REVISION + 2, vandal)), now: at(16) });
  assert.deepEqual(again.map((row) => row.action), [null]);
  assert.equal((await record()).pendingRevision, null, "dismissed text stays dismissed under a newer revision");

  // A genuinely new lead is staged; a stale accept is refused; a current accept publishes it.
  const better = F.LEAD_HTML.replace("are an English", "are a celebrated English");
  await refreshBiographies({ sources: fakeSources(revision(F.REVISION + 3, better)), now: at(24) });
  detail = (await call("GET", path, { user: "user_mod" })).body.biography;
  assert.equal(detail.pendingRevision.article.revisionId, F.REVISION + 3);
  const stale = await call("POST", `${path}/accept-revision`, { user: "user_mod", body: { expectedRevision: detail.revision - 1 } });
  assert.deepEqual([stale.status, stale.body.code], [409, "BIOGRAPHY_REVISION_CONFLICT"]);
  const suppressed = await call("POST", `${path}/suppress`, { user: "user_mod", body: { expectedRevision: detail.revision, reason: "Checking" } });
  assert.equal(suppressed.status, 200);
  const accepted = await call("POST", `${path}/accept-revision`, { user: "user_mod", body: { expectedRevision: suppressed.body.biography.revision } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  stored = await record();
  assert.deepEqual([stored.accepted.article.revisionId, stored.accepted.acceptedBy, stored.pendingRevision, stored.moderation.suppressed, Boolean(stored.manual)], [F.REVISION + 3, "user_mod", null, true, true], "accepting keeps suppression and the correction");
  assert.match(stored.accepted.text, /celebrated/);
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null, "still suppressed");
  const cleared = await call("POST", `${path}/clear-correction`, { user: "user_mod", body: { expectedRevision: stored.revision } });
  await call("POST", `${path}/unsuppress`, { user: "user_mod", body: { expectedRevision: cleared.body.biography.revision } });
  shown = (await call("GET", `/artists/${artist.artistId}/biography`)).body.biography;
  assert.deepEqual([shown.article.revisionId, shown.edited], [F.REVISION + 3, false]);
  assert.match(shown.text, /celebrated/);
  assert.notEqual(shown.text, original.text);
  assert.deepEqual(stored.history.slice(-2).map((event) => [event.actorType, event.action]), [["moderator", "suppress"], ["moderator", "accept_revision"]]);
  assert.equal((await call("POST", `${path}/accept-revision`, { user: "user_mod", body: { expectedRevision: (await record()).revision } })).status, 409, "nothing left to accept");
});

integration("monthly identity revalidation also stages changed text instead of publishing it", async () => {
  await publish();
  const stored = await record();
  await ArtistBiography.updateOne({ artistId: artist.artistId }, { $set: { "identity.nextCheckAt": new Date(NOW.getTime() - 1000) } });
  const changed = { page: () => F.wpPage({ lastrevid: F.REVISION + 4 }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")), html: F.LEAD_HTML.replace("are an English", "are a disputed") }) };
  const rows = await refreshBiographies({ sources: fakeSources(changed), now: NOW });
  assert.deepEqual(rows.map((row) => [row.mode, row.action]), [["resolve", "resolve:revision_staged"]]);
  const after = await record();
  assert.deepEqual([after.accepted.textHash, after.accepted.article.revisionId, after.identity.state], [stored.accepted.textHash, F.REVISION, "verified"]);
  assert.match(after.pendingRevision.text, /disputed/);
});

integration("a plan apply cannot replace published text or override a dismissal, and a refresh after loading makes an accept conflict", async () => {
  await publish();
  const path = `/moderation/artist-biographies/${artist.artistId}`;
  const at = (days) => new Date(NOW.getTime() + days * 24 * 3600 * 1000);
  const revision = (revid, html) => ({ page: () => F.wpPage({ lastrevid: revid }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")), html }) });
  const vandal = revision(F.REVISION + 1, F.LEAD_HTML.replace("are an English", "are a terrible"));

  // A routine plan includes this artist; applying it stages the changed text instead of publishing it.
  const plan = await createBiographyPlan({ sources: fakeSources(vandal), artistIds: [artist.artistId], now: at(1), databaseName: "rescened_biographies" });
  assert.deepEqual([plan.items[0].outcome.status, plan.items[0].published.revisionId, plan.items[0].stagesChangedText, plan.items[0].matchesDismissedText], ["accepted", F.REVISION, true, false]);
  const applied = await applyBiographyPlan({ plan, sources: fakeSources(vandal), now: at(1) });
  assert.deepEqual(applied.map((row) => [row.result, row.action]), [["written", "resolve:revision_staged"]]);
  let stored = await record();
  assert.equal(stored.accepted.article.revisionId, F.REVISION);
  assert.match(stored.pendingRevision.text, /terrible/);

  // Dismissed text stays out even when a later plan resolves to it.
  const dismissed = await call("POST", `${path}/dismiss-revision`, { user: "user_mod", body: { expectedRevision: stored.revision, reason: "Vandalism" } });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  const later = await createBiographyPlan({ sources: fakeSources(vandal), artistIds: [artist.artistId], now: at(2), databaseName: "rescened_biographies" });
  assert.deepEqual([later.items[0].stagesChangedText, later.items[0].matchesDismissedText], [false, true]);
  await applyBiographyPlan({ plan: later, sources: fakeSources(vandal), now: at(2) });
  stored = await record();
  assert.deepEqual([stored.accepted.article.revisionId, stored.pendingRevision, stored.dismissedRevision.reason], [F.REVISION, null, "Vandalism"]);
  assert.equal(JSON.stringify((await call("GET", `/artists/${artist.artistId}/biography`)).body).includes("terrible"), false);

  // A moderator loads staged text A; refresh then stages text B; accepting with the loaded revision conflicts.
  await refreshBiographies({ sources: fakeSources(revision(F.REVISION + 2, F.LEAD_HTML.replace("are an English", "are a first"))), now: at(9) });
  const loaded = (await call("GET", path, { user: "user_mod" })).body.biography;
  assert.match(loaded.pendingRevision.text, /a first/);
  await refreshBiographies({ sources: fakeSources(revision(F.REVISION + 3, F.LEAD_HTML.replace("are an English", "are a second"))), now: at(17) });
  const conflict = await call("POST", `${path}/accept-revision`, { user: "user_mod", body: { expectedRevision: loaded.revision } });
  assert.deepEqual([conflict.status, conflict.body.code], [409, "BIOGRAPHY_REVISION_CONFLICT"]);
  stored = await record();
  assert.deepEqual([stored.accepted.article.revisionId, stored.pendingRevision.article.revisionId], [F.REVISION, F.REVISION + 3], "nothing the moderator did not see was published");

  // Hidden after a conflict, then verified again by a plan: the last accepted text returns and the new text is staged.
  await ArtistBiography.updateOne({ artistId: artist.artistId }, { $set: { "identity.state": "conflict", pendingRevision: null } });
  const hiddenPlan = await createBiographyPlan({ sources: fakeSources(vandal), artistIds: [artist.artistId], now: at(30), databaseName: "rescened_biographies" });
  assert.deepEqual([hiddenPlan.items[0].published.shown, hiddenPlan.items[0].stagesChangedText, hiddenPlan.items[0].matchesDismissedText], [false, false, true], "the dismissed text is reported, not staged");
  const better = revision(F.REVISION + 4, F.LEAD_HTML.replace("are an English", "are a renowned"));
  const betterPlan = await createBiographyPlan({ sources: fakeSources(better), artistIds: [artist.artistId], now: at(30), databaseName: "rescened_biographies" });
  assert.equal(betterPlan.items[0].stagesChangedText, true);
  const reapplied = await applyBiographyPlan({ plan: betterPlan, sources: fakeSources(better), now: at(30) });
  assert.deepEqual(reapplied.map((row) => row.action), ["resolve:revision_staged"]);
  stored = await record();
  assert.deepEqual([stored.identity.state, stored.accepted.article.revisionId, stored.dismissedRevision.reason], ["verified", F.REVISION, "Vandalism"]);
  assert.match(stored.pendingRevision.text, /renowned/);
  const shownAgain = (await call("GET", `/artists/${artist.artistId}/biography`)).body.biography;
  assert.equal(shownAgain.article.revisionId, F.REVISION, "readers get the last accepted text back");
});

integration("a refresh that raced a moderator command is discarded and the command survives", async () => {
  await publish();
  const stale = await record();
  const suppressed = await call("POST", `/moderation/artist-biographies/${artist.artistId}/suppress`, { user: "user_mod", body: { expectedRevision: stale.revision, reason: "Wrong person" } });
  assert.equal(suppressed.status, 200, JSON.stringify(suppressed.body));
  const outcome = await resolveBiography({ artistMbid: F.ARTIST_MBID, sources: fakeSources({ page: () => F.wpPage({ lastrevid: F.REVISION + 3 }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")) }) }), now: NOW });
  assert.equal(await writeOutcome({ artistId: artist.artistId, record: stale, outcome, mode: "resolve", now: NOW }), "stale");
  const stored = await record();
  assert.deepEqual([stored.moderation.suppressed, stored.accepted.article.revisionId], [true, F.REVISION]);
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null);
  // A refresh that re-reads the record after the command applies and still
  // leaves the suppression in place.
  assert.equal(await writeOutcome({ artistId: artist.artistId, record: stored, outcome, mode: "resolve", now: NOW }), "written");
  const refreshed = await record();
  assert.deepEqual([refreshed.moderation.suppressed, refreshed.accepted.article.revisionId], [true, F.REVISION + 3]);
});

integration("moderator corrections, rejection, and their audit trail survive refresh", async () => {
  await publish();
  const path = `/moderation/artist-biographies/${artist.artistId}`;
  assert.equal((await call("GET", path)).status, 401);
  assert.equal((await call("GET", path, { user: "user_other" })).status, 403);
  let detail = (await call("GET", path, { user: "user_mod" })).body.biography;
  assert.equal(detail.artistName, "Fixture Band");
  assert.equal("_id" in detail, false);

  const corrected = await call("POST", `${path}/correct-text`, { user: "user_mod", body: { expectedRevision: detail.revision, text: "Fixture Band are an English rock band from Abingdon.", note: "Shorter" } });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  let shown = (await call("GET", `/artists/${artist.artistId}/biography`)).body.biography;
  assert.deepEqual([shown.text, shown.edited, shown.article.revisionId], ["Fixture Band are an English rock band from Abingdon.", true, F.REVISION]);

  const stale = await call("POST", `${path}/unsuppress`, { user: "user_mod", body: { expectedRevision: detail.revision } });
  assert.deepEqual([stale.status, stale.body.code], [409, "BIOGRAPHY_REVISION_CONFLICT"]);

  // A later content refresh updates the source revision but keeps the correction.
  const later = new Date(NOW.getTime() + 8 * 24 * 3600 * 1000);
  await refreshBiographies({ sources: fakeSources({ page: () => F.wpPage({ lastrevid: F.REVISION + 9 }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")) }) }), now: later });
  shown = (await call("GET", `/artists/${artist.artistId}/biography`)).body.biography;
  assert.deepEqual([shown.text, shown.edited, shown.article.revisionId], ["Fixture Band are an English rock band from Abingdon.", true, F.REVISION], "the correction keeps its own source revision");
  assert.equal((await record()).accepted.article.revisionId, F.REVISION + 9);

  detail = (await call("GET", path, { user: "user_mod" })).body.biography;
  const rejected = await call("POST", `${path}/reject-match`, { user: "user_mod", body: { expectedRevision: detail.revision, reason: "Different band" } });
  assert.equal(rejected.status, 200);
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null);
  // Re-resolution later finds the same match; the rejection still holds.
  const evenLater = new Date(later.getTime() + 31 * 24 * 3600 * 1000);
  await refreshBiographies({ sources: fakeSources(), now: evenLater });
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null);
  const history = (await record()).history;
  assert.deepEqual(history.filter((event) => event.actorType === "moderator").map((event) => [event.action, event.actorId]), [["correct_text", "user_mod"], ["reject_match", "user_mod"]]);

  process.env.COMMUNITY_MODERATION_ENABLED = "false";
  try {
    assert.equal((await call("POST", `${path}/clear-verdict`, { user: "user_mod", body: { expectedRevision: 1 } })).body.code, "MODERATION_DISABLED");
    assert.equal((await call("GET", path, { user: "user_mod" })).status, 200, "reads stay available");
  } finally { process.env.COMMUNITY_MODERATION_ENABLED = "true"; }
});

integration("confirming a reviewable candidate publishes it, and clearing the verdict revokes it at once", async () => {
  await publish({ wikidata: () => F.wdEntity({ classes: ["Q123456789"] }) });
  const path = `/moderation/artist-biographies/${artist.artistId}`;
  const queue = (await call("GET", "/moderation/artist-biographies?state=needs_review", { user: "user_mod" })).body.biographies;
  assert.deepEqual(queue.map((row) => [row.artistId, row.candidateTitle, row.shown]), [[artist.artistId, "Fixture Band", false]]);
  let detail = (await call("GET", path, { user: "user_mod" })).body.biography;
  const confirmed = await call("POST", `${path}/confirm-match`, { user: "user_mod", body: { expectedRevision: detail.revision } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.ok((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography);
  detail = confirmed.body.biography;
  const cleared = await call("POST", `${path}/clear-verdict`, { user: "user_mod", body: { expectedRevision: detail.revision } });
  assert.equal(cleared.status, 200);
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null, "revoking the approval hides it immediately");
  const stored = await record();
  assert.deepEqual([stored.identity.state, stored.accepted, Boolean(stored.candidate)], ["needs_review", null, true]);
  const again = await call("POST", `${path}/confirm-match`, { user: "user_mod", body: { expectedRevision: stored.revision } });
  assert.equal(again.status, 200, "it can be reviewed and confirmed again");
});

integration("clearing a rejection cannot resurrect a publication that rested on a moderator confirmation", async () => {
  await publish({ wikidata: () => F.wdEntity({ classes: ["Q123456789"] }) });
  const path = `/moderation/artist-biographies/${artist.artistId}`;
  let revision = (await record()).revision;
  const step = async (command, body = {}) => {
    const result = await call("POST", `${path}/${command}`, { user: "user_mod", body: { expectedRevision: revision, ...body } });
    assert.equal(result.status, 200, `${command}: ${JSON.stringify(result.body)}`);
    revision = result.body.biography.revision;
  };
  await step("confirm-match");
  assert.ok((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography);
  await step("reject-match", { reason: "Changed my mind" });
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null);
  await step("clear-verdict");
  assert.equal((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography, null, "no approval stands, so nothing is shown");
  const stored = await record();
  assert.deepEqual([stored.identity.state, stored.identity.basis, stored.accepted, Boolean(stored.candidate)], ["needs_review", null, null, true]);
});

integration("apply refuses a plan whose decision evidence changed even with the same text and revision", async () => {
  const plan = await createBiographyPlan({ sources: fakeSources(), artistIds: [artist.artistId], now: NOW, databaseName: "rescened_biographies" });
  const changedEvidence = { wikidata: () => F.wdEntity({ classes: ["Q5741069"], claims434: [F.p434(F.ARTIST_MBID, { id: "Q44190$replaced" })] }) };
  const results = await applyBiographyPlan({ plan, sources: fakeSources(changedEvidence), now: NOW });
  assert.deepEqual(results.map((row) => [row.result, row.status]), [["outcome_changed", "accepted"]]);
  assert.equal(await record(), null);
});

integration("redirect provenance is persisted and changed paths invalidate a reviewed plan", async () => {
  const redirected = (intermediate = false) => ({
    wikidata: (url) => {
      const id = url.searchParams.get("ids");
      if (id === F.OTHER_QID) return F.wdEntity({ id });
      return F.wdEntity({ requested: id, id: id === F.QID && intermediate ? "Q123" : F.OTHER_QID, redirectFrom: id });
    },
    page: () => F.wpPage({ wikibase: F.OTHER_QID }),
    parse: () => F.wpParse({ wikibase: F.OTHER_QID }),
  });
  const plan = await createBiographyPlan({ sources: fakeSources(redirected()), artistIds: [artist.artistId], now: NOW, databaseName: "rescened_biographies" });
  assert.equal(plan.items[0].outcome.status, "accepted");
  const changed = await applyBiographyPlan({ plan, sources: fakeSources(redirected(true)), now: NOW });
  assert.deepEqual(changed.map(row => row.result), ["outcome_changed"]);
  assert.equal(await record(), null);
  const applied = await applyBiographyPlan({ plan, sources: fakeSources(redirected()), now: NOW });
  assert.deepEqual(applied.map(row => row.result), ["written"]);
  const stored = await record();
  assert.equal(stored.identity.qid, F.OTHER_QID);
  assert.deepEqual(stored.identity.evidence.wikidataLinks, [F.QID]);
  assert.deepEqual(stored.identity.evidence.wikidataRedirects, [{ from: F.QID, to: F.OTHER_QID, revisionId: 2300000001 }]);
  assert.ok((await call("GET", `/artists/${artist.artistId}/biography`)).body.biography);
});


integration("solo-project evidence is persisted and changed member proof invalidates a plan", async () => {
  const { soloFixture, itemClaim } = require("./fixtures/biographies/identityFixtures");
  const plan = await createBiographyPlan({ sources: fakeSources(soloFixture()), artistIds: [artist.artistId], now: NOW, databaseName: "rescened_biographies" });
  assert.equal(plan.items[0].outcome.status, "accepted");
  const changed = soloFixture({ project: { extraClaims: { P527: [itemClaim('P527', F.OTHER_QID, { id: 'replacement-claim' })] } } });
  const drifted = await applyBiographyPlan({ plan, sources: fakeSources(changed), now: NOW });
  assert.deepEqual(drifted.map(row => row.result), ["outcome_changed"]);
  assert.equal(await record(), null);
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(soloFixture()), now: NOW })).map(row => row.result), ["written"]);
  const stored = await record();
  assert.equal(stored.identity.evidence.soloProject.verified, true);
  assert.equal(stored.accepted.qid, F.QID);
});

integration("real/stage identity proof is rechecked and persisted rather than merging artists", async () => {
  const { aliasFixture } = require("./fixtures/biographies/identityFixtures");
  const plan = await createBiographyPlan({ sources: fakeSources(aliasFixture()), artistIds: [artist.artistId], now: NOW, databaseName: "rescened_biographies" });
  assert.equal(plan.items[0].outcome.status, "accepted");
  const drifted = await applyBiographyPlan({ plan, sources: fakeSources(aliasFixture({ reverse: { ended: true } })), now: NOW });
  assert.deepEqual(drifted.map(row => row.result), ["outcome_changed"]);
  assert.equal(await record(), null);
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(aliasFixture()), now: NOW })).map(row => row.result), ["written"]);
  assert.equal((await record()).identity.evidence.personAliases.artists.length, 2);
  assert.equal(await Artist.countDocuments(), 1);
});

integration("merged MBID paths are sealed and persisted without changing catalog identity", async () => {
  const intermediate = '22222222-2222-4222-8222-222222222222';
  const fixtures = (extraHop = false) => ({
    musicbrainz: url => {
      const id = url.pathname.split('/').pop();
      if (id === F.OTHER_MBID) return F.mbArtist({ id });
      return F.response({}, { status: 301, headers: { location: `/ws/2/artist/${id === F.ARTIST_MBID && extraHop ? intermediate : F.OTHER_MBID}` } });
    },
    wikidata: () => F.wdEntity({ claims434: [F.p434(F.OTHER_MBID)] }),
  });
  const plan = await createBiographyPlan({ sources: fakeSources(fixtures()), artistIds: [artist.artistId], now: NOW, databaseName: 'rescened_biographies' });
  assert.equal(plan.items[0].outcome.status, 'accepted');
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(fixtures(true)), now: NOW })).map(r => r.result), ['outcome_changed']);
  assert.equal(await record(), null);
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(fixtures()), now: NOW })).map(r => r.result), ['written']);
  assert.deepEqual((await record()).identity.evidence.musicBrainzRedirects, [{ from: F.ARTIST_MBID, to: F.OTHER_MBID }]);
  assert.equal(require('../lib/artists/identity').artistMbidOf(await Artist.findOne({ artistId: artist.artistId })), F.ARTIST_MBID);
});

integration("historical name proof date changes invalidate a plan", async () => {
  const { aliasFixture } = require('./fixtures/biographies/identityFixtures');
  const fixtures = end => aliasFixture({ relation: { ended: true, end }, reverse: { ended: true, end } });
  const plan = await createBiographyPlan({ sources: fakeSources(fixtures('2018')), artistIds: [artist.artistId], now: NOW, databaseName: 'rescened_biographies' });
  assert.equal(plan.items[0].outcome.status, 'accepted');
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(fixtures('2019')), now: NOW })).map(r => r.result), ['outcome_changed']);
  assert.equal(await record(), null);
  assert.deepEqual((await applyBiographyPlan({ plan, sources: fakeSources(fixtures('2018')), now: NOW })).map(r => r.result), ['written']);
});
