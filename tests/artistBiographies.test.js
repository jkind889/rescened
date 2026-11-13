const assert = require("node:assert/strict");
const test = require("node:test");
const F = require("./fixtures/biographies/fixtures");
const { createBiographySources } = require("../lib/artists/biographySources");
const { resolveBiography, refreshArticle } = require("../lib/artists/biographyResolver");
const { leadParagraphsFromParseHtml, shortenBiography, normalizeManualText, graphemeLength, textHash } = require("../lib/artists/biographyText");
const { displayBiography, normalizeCommand, outcomeUpdate, DEFAULT_SETTINGS } = require("../lib/artists/biographies");

const NOW = new Date("2026-11-12T00:00:00Z");

function sources(overrides = {}, options = {}) {
  const fake = F.fakeFetch(overrides);
  const sleeps = [];
  const instance = createBiographySources({
    fetchFn: fake.fetchFn,
    musicBrainzGate: async () => {},
    wikimediaGate: async () => {},
    sleepFn: async (ms) => { sleeps.push(ms); },
    ...options,
  });
  return { sources: instance, calls: fake.calls, sleeps };
}

const resolve = (overrides, options) => {
  const built = sources(overrides, options);
  return resolveBiography({ artistMbid: F.ARTIST_MBID, sources: built.sources, now: NOW }).then((outcome) => ({ outcome, ...built }));
};

// --- text ---------------------------------------------------------------

test("lead extraction keeps top-level prose and drops references, hidden, nested, and non-excerpt content", () => {
  const paragraphs = leadParagraphsFromParseHtml(F.LEAD_HTML);
  assert.equal(paragraphs.length, 2);
  assert.match(paragraphs[0], /^Fixture Band are an English rock band formed in Abingdon, Oxfordshire, in 1985\. The band's line-up has been unchanged since 1985\. They are known/);
  for (const absent of ["[1]", "listen", "For other uses", "Caption text", "searchaux"]) assert.equal(paragraphs.join(" ").includes(absent), false, absent);
  assert.throws(() => leadParagraphsFromParseHtml(null), { code: "BIOGRAPHY_INVALID_RESPONSE" });
  assert.deepEqual(leadParagraphsFromParseHtml('<div class="mw-parser-output"><table><tr><td><p>Only in a table</p></td></tr></table></div>'), []);
});

test("excerpts prefer whole sentences within about 250 graphemes", () => {
  const lead = leadParagraphsFromParseHtml(F.LEAD_HTML);
  const excerpt = shortenBiography(lead);
  assert.equal(excerpt.cut, "sentence");
  assert.equal(excerpt.shortened, true, "only part of the lead is shown");
  assert.ok(excerpt.graphemes <= 250);
  assert.match(excerpt.text, /1985\.$/);
  const whole = shortenBiography(["Fixture Band are an English rock band formed in 1985."]);
  assert.deepEqual([whole.shortened, whole.cut], [false, "sentence"]);
});

test("a first sentence longer than the cap is cut at a word boundary with an ellipsis", () => {
  const long = `Fixture Band ${"are a very long running and widely influential group ".repeat(8)}from Oxfordshire.`;
  const excerpt = shortenBiography([long]);
  assert.equal(excerpt.cut, "word");
  assert.equal(excerpt.shortened, true);
  assert.ok(excerpt.text.endsWith("…"));
  assert.ok(excerpt.graphemes <= 250);
  assert.ok(long.startsWith(excerpt.text.slice(0, -1)), "the excerpt is a prefix of the source, cut between words");
  assert.match(excerpt.text, /[a-z]…$/);
});

test("grapheme counting keeps emoji sequences and combining marks whole", () => {
  const family = "👩🏽‍🎤";
  const combining = "é";
  assert.equal(graphemeLength(family), 1);
  assert.equal(graphemeLength(combining), 1);
  const text = `${"Ä".repeat(20)} ${family.repeat(240)} end.`;
  const excerpt = shortenBiography([`Björk ${text}`]);
  assert.ok(excerpt.graphemes <= 250);
  assert.equal(excerpt.text.includes("\ud83c"), excerpt.text.includes(family), "no emoji sequence is split");
  assert.throws(() => shortenBiography([]), { code: "BIOGRAPHY_TEXT_UNSUITABLE" });
  assert.throws(() => shortenBiography(["Too short."]), { code: "BIOGRAPHY_TEXT_UNSUITABLE" });
});

test("moderator corrections are bounded plain text", () => {
  assert.equal(normalizeManualText("  Fixture Band are an English rock band.  "), "Fixture Band are an English rock band.");
  assert.throws(() => normalizeManualText("<b>bold</b> is not allowed here at all."), { code: "INVALID_BIOGRAPHY_COMMAND" });
  assert.throws(() => normalizeManualText("short"), { code: "INVALID_BIOGRAPHY_COMMAND" });
  assert.throws(() => normalizeManualText("x".repeat(251)), { code: "INVALID_BIOGRAPHY_COMMAND" });
});

// --- resolver -------------------------------------------------------------

test("a reciprocal match is accepted with exact revision provenance and attribution", async () => {
  const { outcome, calls } = await resolve();
  assert.equal(outcome.status, "accepted", JSON.stringify(outcome));
  assert.equal(outcome.qid, F.QID);
  const c = outcome.candidate;
  assert.deepEqual(c.article, {
    language: "en", title: "Fixture Band", pageId: F.PAGE_ID, revisionId: F.REVISION, revisionTimestamp: "2026-11-01T12:00:00Z",
    url: "https://en.wikipedia.org/wiki/Fixture_Band", revisionUrl: `https://en.wikipedia.org/w/index.php?oldid=${F.REVISION}`,
  });
  assert.deepEqual(c.license, { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" });
  assert.equal(c.textHash, textHash(c.text));
  assert.equal(c.extractionVersion, "en-lead-sentences-v1");
  assert.equal(outcome.evidence.wikidataRevisionId, 2300000001);
  assert.equal(outcome.evidence.p434[0].statementId, `${F.QID}$P434-a74b1b7f`);
  const parse = calls.find((call) => call.route === "parse").url;
  assert.equal(parse.searchParams.get("oldid"), String(F.REVISION), "the text comes from the validated revision");
  assert.equal(parse.searchParams.get("section"), "0");
  for (const call of calls.filter((entry) => entry.route !== "musicbrainz")) assert.equal(call.url.searchParams.get("maxlag"), "5");
  assert.ok(calls.every((call) => /RescenedCatalogImporter/.test(call.headers["User-Agent"])));
});

test("a same-named item for a different MusicBrainz artist is a conflict; names never decide", async () => {
  const { outcome } = await resolve({ wikidata: () => F.wdEntity({ claims434: [F.p434(F.OTHER_MBID)], title: "Fixture Band" }) });
  assert.deepEqual([outcome.status, outcome.reasons], ["conflict", ["P434_MISMATCH"]]);
  assert.equal(outcome.candidate, null);
});

test("P434 evidence: deprecated, multiple, missing, qualified, and unknown-rank statements", async () => {
  const cases = [
    [[F.p434(F.ARTIST_MBID, { rank: "deprecated" })], "conflict", "P434_DEPRECATED"],
    [[F.p434(F.ARTIST_MBID), F.p434(F.OTHER_MBID)], "needs_review", "MULTIPLE_P434_IDENTITIES_UNVERIFIED"],
    [[F.p434(F.ARTIST_MBID), F.p434(F.OTHER_MBID, { qualifiers: { P518: [] } })], "needs_review", "P434_UNCERTAIN"],
    [[], "needs_review", "P434_MISSING"],
    [[F.p434(F.ARTIST_MBID, { qualifiers: { P518: [] } })], "needs_review", "P434_UNCERTAIN"],
    [[{ ...F.p434(F.ARTIST_MBID), rank: "weird" }], "needs_review", "P434_UNCERTAIN"],
    [[F.p434(F.ARTIST_MBID, { rank: "preferred" }), F.p434(F.OTHER_MBID, { rank: "deprecated" })], "accepted", undefined],
  ];
  for (const [claims, status, reason] of cases) {
    const { outcome } = await resolve({ wikidata: () => F.wdEntity({ claims434: claims }) });
    assert.equal(outcome.status, status, JSON.stringify(claims));
    if (reason) assert.ok(outcome.reasons.includes(reason), `${reason} in ${outcome.reasons}`);
  }
});

test("person versus group: mismatch, ambiguity, incompatible classes, and unknown types", async () => {
  const cases = [
    [{ type: "Person" }, ["Q215380"], "conflict", "ENTITY_TYPE_MISMATCH"],
    [{ type: "Group" }, ["Q5"], "conflict", "ENTITY_TYPE_MISMATCH"],
    [{ type: "Group" }, ["Q5", "Q215380"], "conflict", "ENTITY_TYPE_AMBIGUOUS"],
    [{ type: "Group" }, ["Q215380", "Q95074"], "conflict", "ENTITY_TYPE_INCOMPATIBLE"],
    [{ type: "Person" }, ["Q5", "Q15632617"], "conflict", "ENTITY_TYPE_INCOMPATIBLE"],
    [{ type: "Group" }, ["Q123456789"], "needs_review", "ENTITY_TYPE_UNRECOGNIZED"],
    [{ type: "Character" }, ["Q5"], "needs_review", "MUSICBRAINZ_TYPE_UNRECOGNIZED"],
    [{ type: "Person" }, ["Q5"], "accepted", undefined],
  ];
  for (const [artist, classes, status, reason] of cases) {
    const { outcome } = await resolve({ musicbrainz: () => F.mbArtist(artist), wikidata: () => F.wdEntity({ classes }) });
    assert.equal(outcome.status, status, `${artist.type} ${classes}`);
    if (reason) assert.ok(outcome.reasons.includes(reason));
    if (status === "needs_review") assert.ok(outcome.candidate, "a reviewable candidate is prepared");
  }
});

test("MusicBrainz links: none, several, ended, merged artist, and unrecognized URLs", async () => {
  assert.equal((await resolve({ musicbrainz: () => F.mbArtist({ wikidata: [] }) })).outcome.status, "not_linked");
  assert.deepEqual((await resolve({ musicbrainz: () => F.mbArtist({ wikidata: [F.QID, F.OTHER_QID] }) })).outcome.reasons, ["MULTIPLE_WIKIDATA_LINKS"]);
  assert.equal((await resolve({ musicbrainz: () => F.mbArtist({ wikidata: [F.OTHER_QID, F.QID], ended: [true, false] }) })).outcome.status, "accepted", "an ended link is ignored");
  assert.deepEqual((await resolve({ musicbrainz: () => F.mbArtist({ id: F.OTHER_MBID }) })).outcome.reasons, ["MUSICBRAINZ_REDIRECT_UNVERIFIED"]);
  assert.deepEqual((await resolve({ musicbrainz: () => F.mbArtist({ wikidata: ["https://www.wikidata.org/wiki/Special:EntityPage/Q1"] }) })).outcome.reasons, ["UNRECOGNIZED_WIKIDATA_URL"]);
  // A Wikidata URL only counts through the typed "wikidata" relationship.
  const untyped = F.mbArtist({ wikidata: [], extra: [{ type: "other databases", "target-type": "url", ended: false, url: { resource: `https://www.wikidata.org/wiki/${F.QID}` } }] });
  assert.equal((await resolve({ musicbrainz: () => untyped })).outcome.status, "not_linked");
});

test("Wikidata item problems: missing and no English article", async () => {
  assert.deepEqual((await resolve({ wikidata: () => F.wdEntity({ missing: true }) })).outcome.reasons, ["WIKIDATA_ITEM_MISSING"]);
  const noArticle = await resolve({ wikidata: () => F.wdEntity({ title: null }) });
  assert.deepEqual([noArticle.outcome.status, noArticle.outcome.reasons], ["no_article", ["NO_ENGLISH_ARTICLE"]]);
});


test("verified musical trio and heavy metal band classes preserve person/group and incompatible vetoes", async () => {
  for (const id of ["Q281643", "Q56816954"]) {
    assert.equal((await resolve({ wikidata: () => F.wdEntity({ classes: [id] }) })).outcome.status, "accepted");
    assert.deepEqual((await resolve({ musicbrainz: () => F.mbArtist({ type: "Person" }), wikidata: () => F.wdEntity({ classes: [id] }) })).outcome.reasons, ["ENTITY_TYPE_MISMATCH"]);
    assert.deepEqual((await resolve({ wikidata: () => F.wdEntity({ classes: [id, "Q95074"] }) })).outcome.reasons, ["ENTITY_TYPE_INCOMPATIBLE"]);
  }
});

function redirectSources({ chain = [F.QID, F.OTHER_QID], destination = {}, page = {}, parse = {} } = {}) {
  const canonical = chain[chain.length - 1];
  return {
    wikidata: (url) => {
      const requested = url.searchParams.get("ids");
      const index = chain.indexOf(requested);
      if (index >= 0 && index < chain.length - 1) return F.wdEntity({ requested, id: chain[index + 1], redirectFrom: requested });
      return F.wdEntity({ id: canonical, ...destination });
    },
    page: () => F.wpPage({ wikibase: canonical, ...page }),
    parse: () => F.wpParse({ wikibase: canonical, ...parse }),
  };
}

test("Wikidata redirects are bounded, re-fetched and retain canonical identity and revision provenance", async () => {
  for (const chain of [[F.QID, F.OTHER_QID], [F.QID, "Q2", "Q3", F.OTHER_QID]]) {
    const { outcome, calls } = await resolve(redirectSources({ chain }));
    assert.equal(outcome.status, "accepted");
    assert.equal(outcome.qid, F.OTHER_QID);
    assert.equal(outcome.candidate.qid, F.OTHER_QID);
    assert.equal(outcome.evidence.wikidataId, F.OTHER_QID);
    assert.deepEqual(outcome.evidence.wikidataLinks, [F.QID]);
    assert.deepEqual(outcome.evidence.wikidataRedirects, chain.slice(0, -1).map((from, i) => ({ from, to: chain[i + 1], revisionId: 2300000001 })));
    assert.deepEqual(calls.filter(c => c.route === "wikidata").map(c => c.url.searchParams.get("ids")), chain);
  }
});

test("redirect destinations still require original MBID, valid type, article and revision identity", async () => {
  const cases = [
    [{ destination: { claims434: [F.p434(F.OTHER_MBID)] } }, "P434_MISMATCH"],
    [{ destination: { classes: ["Q95074"] } }, "ENTITY_TYPE_INCOMPATIBLE"],
    [{ page: { wikibase: F.QID } }, "WIKIBASE_ITEM_MISMATCH"],
    [{ parse: { wikibase: F.QID } }, "REVISION_WIKIBASE_ITEM_MISMATCH"],
    [{ destination: { missing: true } }, "WIKIDATA_ITEM_MISSING"],
    [{ destination: { title: null } }, "NO_ENGLISH_ARTICLE"],
  ];
  for (const [options, reason] of cases) {
    const { outcome } = await resolve(redirectSources(options));
    assert.notEqual(outcome.status, "accepted");
    assert.ok(outcome.reasons.includes(reason), JSON.stringify(outcome));
    assert.equal(outcome.candidate, null);
  }
});

test("cyclic, self and excessive Wikidata redirects stop without fetching a biography", async () => {
  for (const [chain, reason] of [
    [[F.QID, F.QID], "WIKIDATA_REDIRECT_LOOP"],
    [[F.QID, F.OTHER_QID, F.QID], "WIKIDATA_REDIRECT_LOOP"],
    [[F.QID, "Q2", "Q3", "Q4", "Q5"], "WIKIDATA_REDIRECT_LIMIT"],
  ]) {
    const { outcome, calls } = await resolve(redirectSources({ chain }));
    assert.deepEqual(outcome.reasons, [reason]);
    assert.equal(outcome.status, "needs_review");
    assert.ok(calls.filter(c => c.route === "wikidata").length <= 4);
    assert.equal(calls.some(c => c.route === "page"), false);
  }
});

test("malformed or unproven Wikidata redirects fail closed", async () => {
  for (const body of [
    F.wdEntity({ id: F.OTHER_QID, requested: F.QID }),
    F.wdEntity({ id: F.OTHER_QID, requested: F.QID, redirectFrom: "Q123" }),
    F.wdEntity({ id: F.OTHER_QID }),
    { entities: { [F.QID]: { id: F.OTHER_QID, lastrevid: 1, redirects: { from: F.QID, to: "https://example.invalid" } } } },
  ]) {
    const { outcome } = await resolve({ wikidata: () => body });
    assert.equal(outcome.status, "error");
    assert.equal(outcome.error.code, "BIOGRAPHY_INVALID_RESPONSE");
  }
});

test("Wikipedia page problems: wrong item, cross-entity redirect, disambiguation, list, missing, non-article", async () => {
  const cases = [
    [{ page: () => F.wpPage({ wikibase: F.OTHER_QID }) }, "conflict", "WIKIBASE_ITEM_MISMATCH"],
    [{ page: () => F.wpPage({ wikibase: F.OTHER_QID, redirectedFrom: "Fixture Band", title: "Another Topic" }) }, "conflict", "CROSS_ENTITY_REDIRECT"],
    [{ page: () => F.wpPage({ disambiguation: true }) }, "unsuitable", "DISAMBIGUATION_PAGE"],
    [{ page: () => F.wpPage({ title: "List of Fixture Band members" }) }, "unsuitable", "LIST_PAGE"],
    [{ page: () => F.wpPage({ missing: true }) }, "unsuitable", "ARTICLE_MISSING"],
    [{ page: () => F.wpPage({ ns: 4 }) }, "unsuitable", "NOT_AN_ARTICLE"],
    [{ parse: () => F.wpParse({ wikibase: F.OTHER_QID }) }, "conflict", "REVISION_WIKIBASE_ITEM_MISMATCH"],
    [{ parse: () => F.wpParse({ html: '<div class="mw-parser-output"><table><tr><td>x</td></tr></table></div>' }) }, "unsuitable", "NO_USABLE_LEAD"],
  ];
  for (const [overrides, status, reason] of cases) {
    const { outcome } = await resolve(overrides);
    assert.deepEqual([outcome.status, outcome.reasons], [status, [reason]], reason);
    assert.equal(outcome.candidate, null);
  }
  // A redirect to the same item (for example a renamed title) is fine.
  const sameItem = await resolve({ page: () => F.wpPage({ redirectedFrom: "Fixture band", title: "Fixture Band" }) });
  assert.equal(sameItem.outcome.status, "accepted");
});

test("text always comes from the validated revision, even if the page changes during retrieval", async () => {
  // The page query sees revision R; an edit to R+1 lands before the parse
  // call. The parse is pinned to R, so the stored text and revision agree.
  let parsed = null;
  const { outcome } = await resolve({
    page: () => F.wpPage({ lastrevid: F.REVISION }),
    parse: (url) => {
      parsed = Number(url.searchParams.get("oldid"));
      return F.wpParse({ revid: parsed, html: F.LEAD_HTML.replace("Fixture Band</b> are", "Fixture Band</b> were") });
    },
  });
  assert.equal(parsed, F.REVISION);
  assert.equal(outcome.candidate.article.revisionId, F.REVISION);
  assert.match(outcome.candidate.text, /^Fixture Band were/);
  // A parse that answers for another revision or page is rejected outright.
  const wrongRevision = await resolve({ parse: () => F.wpParse({ revid: F.REVISION + 1 }) });
  assert.deepEqual([wrongRevision.outcome.status, wrongRevision.outcome.error.code], ["error", "BIOGRAPHY_INVALID_RESPONSE"]);
  const wrongPage = await resolve({ parse: () => F.wpParse({ pageid: F.PAGE_ID + 1 }) });
  assert.equal(wrongPage.outcome.status, "error");
});

test("content refresh checks the stable page ID and fetches only a changed revision", async () => {
  const accepted = (await resolve()).outcome.candidate;
  const same = sources();
  assert.equal((await refreshArticle({ accepted, sources: same.sources, now: NOW })).status, "unchanged");
  assert.equal(same.calls.some((call) => call.route === "parse"), false);
  assert.equal(same.calls[0].url.searchParams.get("pageids"), String(F.PAGE_ID));
  const changed = sources({ page: () => F.wpPage({ lastrevid: F.REVISION + 5 }), parse: (url) => F.wpParse({ revid: Number(url.searchParams.get("oldid")) }) });
  const updated = await refreshArticle({ accepted, sources: changed.sources, now: NOW });
  assert.deepEqual([updated.status, updated.candidate.article.revisionId], ["accepted", F.REVISION + 5]);
  const moved = sources({ page: () => F.wpPage({ wikibase: F.OTHER_QID }) });
  assert.equal((await refreshArticle({ accepted, sources: moved.sources, now: NOW })).status, "conflict");
});

// --- adapter controls -----------------------------------------------------

test("transient failures retry with capped backoff; Retry-After beyond the cap stops without waiting", async () => {
  let attempts = 0;
  const flaky = await resolve({ musicbrainz: () => { attempts += 1; return attempts < 3 ? F.response({}, { status: 503, headers: { "retry-after": "2" } }) : F.mbArtist(); } });
  assert.equal(flaky.outcome.status, "accepted");
  assert.deepEqual(flaky.sleeps, [2000, 2000]);

  const throttled = await resolve({ wikidata: () => F.response({}, { status: 429, headers: { "retry-after": "120" } }) });
  assert.deepEqual([throttled.outcome.status, throttled.outcome.error], ["error", { code: "BIOGRAPHY_PROVIDER_THROTTLED", provider: "wikidata", transient: true }]);
  assert.deepEqual(throttled.sleeps, []);

  let lagged = 0;
  const maxlag = await resolve({ page: () => { lagged += 1; return lagged === 1 ? F.response({ error: { code: "maxlag", info: "Waiting" } }, { headers: { "retry-after": "1" } }) : F.wpPage(); } });
  assert.equal(maxlag.outcome.status, "accepted");
  assert.deepEqual(maxlag.sleeps, [1000]);

  const exhausted = await resolve({ parse: () => F.response({}, { status: 502 }) });
  assert.deepEqual([exhausted.outcome.error.code, exhausted.outcome.error.transient], ["BIOGRAPHY_PROVIDER_HTTP", true]);
  assert.deepEqual(exhausted.sleeps, [1000, 2000]);

  const notFound = await resolve({ musicbrainz: () => F.response({}, { status: 404 }) });
  assert.deepEqual([notFound.outcome.error.code, notFound.outcome.error.transient, notFound.sleeps], ["BIOGRAPHY_PROVIDER_HTTP", false, []]);
});

test("timeouts, oversized bodies, and malformed responses are operational errors", async () => {
  const network = await resolve({ musicbrainz: () => new TypeError("fetch failed") }, { maxRetries: 0 });
  assert.equal(network.outcome.error.code, "BIOGRAPHY_PROVIDER_NETWORK");
  const timed = await resolve({ musicbrainz: (url) => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50)) }, { timeoutMs: 10, maxRetries: 0 });
  assert.equal(timed.outcome.error.code, "BIOGRAPHY_PROVIDER_TIMEOUT");
  const big = await resolve({ parse: () => F.response("x".repeat(5000)) }, { maxResponseBytes: 2048 });
  assert.equal(big.outcome.error.code, "BIOGRAPHY_INVALID_RESPONSE");
  const malformed = await resolve({ wikidata: () => ({ nothing: true }) });
  assert.equal(malformed.outcome.error.code, "BIOGRAPHY_INVALID_RESPONSE");
  assert.throws(() => createBiographySources({ fetchFn: async () => {}, userAgent: "anonymous" }), /identify/);
  assert.throws(() => createBiographySources({ fetchFn: async () => {}, maxRetries: 9 }), /maxRetries/);
});

test("requests are serialized through the provider gates", async () => {
  const order = [];
  const fake = F.fakeFetch();
  const instance = createBiographySources({
    fetchFn: fake.fetchFn,
    musicBrainzGate: async () => { order.push("mb"); },
    wikimediaGate: async () => { order.push("wm"); },
    sleepFn: async () => {},
  });
  await resolveBiography({ artistMbid: F.ARTIST_MBID, sources: instance, now: NOW });
  assert.deepEqual(order, ["mb", "wm", "wm", "wm"]);
});

// --- storage rules -------------------------------------------------------

function acceptedRecord(outcome, extra = {}) {
  const { set } = outcomeUpdate(null, outcome, { mode: "resolve", now: NOW });
  return {
    artistId: "11111111-1111-4111-8111-111111111111", revision: 1, moderation: { suppressed: false, verdict: null },
    identity: { state: set["identity.state"], qid: set["identity.qid"], reasons: set["identity.reasons"] },
    accepted: set.accepted, contentCheckedAt: set.contentCheckedAt, fetch: { consecutiveFailures: 0 }, manual: null,
    ...extra,
  };
}

test("display shows accepted text with attribution and change notices; hides suppressed, rejected, and unverified", async () => {
  const { outcome } = await resolve();
  const record = acceptedRecord(outcome);
  const shown = displayBiography(record);
  assert.deepEqual(Object.keys(shown).sort(), ["article", "checkedAt", "edited", "excerpt", "language", "license", "retrievedAt", "shortened", "source", "text"]);
  assert.deepEqual([shown.source, shown.excerpt, shown.shortened, shown.edited], ["Wikipedia", true, true, false]);
  assert.equal(shown.article.revisionUrl, `https://en.wikipedia.org/w/index.php?oldid=${F.REVISION}`);
  assert.equal(shown.license.url, "https://creativecommons.org/licenses/by-sa/4.0/");
  assert.equal(displayBiography({ ...record, moderation: { suppressed: true } }), null);
  assert.equal(displayBiography({ ...record, moderation: { verdict: "match_rejected" } }), null);
  assert.equal(displayBiography({ ...record, identity: { ...record.identity, state: "conflict" } }), null);
  assert.equal(displayBiography({ ...record, identity: { ...record.identity, qid: F.OTHER_QID } }), null);
  assert.equal(displayBiography(null), null);
  const manual = { text: "Fixture Band are a rock band from Oxfordshire.", textHash: "h", basedOn: record.accepted.article, qid: F.QID, editedBy: "user_mod", editedAt: NOW };
  const edited = displayBiography({ ...record, manual });
  assert.deepEqual([edited.text, edited.edited, edited.shortened, edited.article.revisionId], [manual.text, true, true, F.REVISION]);
});

test("transient errors keep the accepted text; conflicts hide it; match changes go to review", async () => {
  const { outcome } = await resolve();
  const record = acceptedRecord(outcome);
  const error = outcomeUpdate(record, { status: "error", error: { code: "BIOGRAPHY_PROVIDER_TIMEOUT", provider: "wikipedia", transient: true } }, { mode: "content", now: NOW });
  assert.equal(Object.keys(error.set).some((key) => key.startsWith("identity") || key === "accepted"), false);
  assert.equal(error.set["fetch.consecutiveFailures"], 1);
  assert.equal(error.set["fetch.nextAttemptAt"].getTime() - NOW.getTime(), DEFAULT_SETTINGS.retryBaseMs);
  const second = outcomeUpdate({ ...record, fetch: { consecutiveFailures: 3 } }, { status: "error", error: {} }, { mode: "content", now: NOW });
  assert.equal(second.set["fetch.nextAttemptAt"].getTime() - NOW.getTime(), DEFAULT_SETTINGS.retryBaseMs * 8);
  assert.equal(second.event, null, "repeated failures do not flood the audit trail");
  assert.ok(displayBiography(record), "still shown after a transient failure");

  const conflict = outcomeUpdate(record, { status: "conflict", reasons: ["WIKIBASE_ITEM_MISMATCH"], qid: F.QID }, { mode: "content", now: NOW });
  assert.equal(conflict.set["identity.state"], "conflict");
  assert.equal(displayBiography({ ...record, identity: { ...record.identity, state: "conflict" } }), null);

  const otherPage = { ...outcome, candidate: { ...outcome.candidate, article: { ...outcome.candidate.article, pageId: 999 } } };
  const changed = outcomeUpdate(record, otherPage, { mode: "resolve", now: NOW });
  assert.deepEqual([changed.set["identity.state"], changed.set.candidate.article.pageId, "accepted" in changed.set], ["needs_review", 999, false]);
  assert.ok(changed.set["identity.reasons"].includes("MATCH_CHANGED"));

  const unchanged = outcomeUpdate(record, { status: "unchanged", qid: F.QID }, { mode: "content", now: NOW });
  assert.equal(unchanged.event, null);
  assert.equal(Object.keys(unchanged.set).some((key) => key.startsWith("manual") || key.startsWith("moderation")), false);
});

test("a moderator-confirmed item stays published when the resolver still needs review for it", async () => {
  const { outcome } = await resolve({ wikidata: () => F.wdEntity({ classes: ["Q123456789"] }) });
  assert.equal(outcome.status, "needs_review");
  const record = { revision: 3, identity: { state: "verified", qid: F.QID, reasons: ["MODERATOR_CONFIRMED"] }, accepted: outcome.candidate, moderation: { verdict: "match_confirmed", verdictQid: F.QID }, fetch: {} };
  const { set } = outcomeUpdate(record, outcome, { mode: "resolve", now: NOW });
  assert.equal(set["identity.state"], "verified");
  assert.ok(set["identity.reasons"].includes("MODERATOR_CONFIRMED"));
  const otherItem = outcomeUpdate({ ...record, moderation: { verdict: "match_confirmed", verdictQid: F.OTHER_QID } }, outcome, { mode: "resolve", now: NOW });
  assert.equal(otherItem.set["identity.state"], "needs_review");
});

test("moderator commands validate shape, reasons, and text", () => {
  assert.deepEqual(normalizeCommand("suppress", { expectedRevision: 2, reason: " Wrong person " }), { action: "suppress", expectedRevision: 2, reason: "Wrong person" });
  assert.throws(() => normalizeCommand("suppress", { expectedRevision: 2 }), { code: "INVALID_BIOGRAPHY_COMMAND" });
  assert.throws(() => normalizeCommand("unsuppress", {}), { code: "INVALID_BIOGRAPHY_COMMAND" });
  assert.throws(() => normalizeCommand("unsuppress", { expectedRevision: 1, status: "accepted" }), { code: "INVALID_BIOGRAPHY_COMMAND" });
  assert.throws(() => normalizeCommand("publish", { expectedRevision: 1 }), { code: "INVALID_BIOGRAPHY_COMMAND", status: 404 });
  assert.equal(normalizeCommand("correct_text", { expectedRevision: 1, text: "Fixture Band are an English rock band." }).text, "Fixture Band are an English rock band.");
  assert.throws(() => normalizeCommand("correct_text", { expectedRevision: 1, text: "x" }), { code: "INVALID_BIOGRAPHY_COMMAND" });
});

// --- operator command ----------------------------------------------------

test("the operator command refuses unsafe argument combinations", () => {
  const { parseArgs } = require("../scripts/artistBiographies");
  assert.deepEqual(parseArgs(["--out", "p.json", "--artist", "a", "--artist", "b"]).artistIds, ["a", "b"]);
  for (const argv of [
    [], // plan needs --out
    ["--out", "p.json", "--confirm-target", "db"],
    ["--apply", "--plan", "p.json", "--plan-sha256", "x", "--report", "r.json"],
    ["--apply", "--plan", "p.json", "--plan-sha256", "x", "--confirm-target", "db", "--report", "r.json", "--limit", "5"],
    ["--refresh", "--confirm-target", "db"],
    ["--refresh", "--apply", "--confirm-target", "db", "--report", "r.json"],
    ["--out", "a.json", "--out", "b.json"],
    ["--bogus"],
  ]) assert.throws(() => parseArgs(argv), { code: "INVALID_ARGUMENTS" }, argv.join(" "));
});

test("apply refuses an edited plan or a wrong target before writing anything", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { main } = require("../scripts/artistBiographies");
  const { sealPlan } = require("../lib/artists/backfill");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-bio-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const plan = sealPlan({ kind: "rescened-artist-biography-plan", planVersion: 1, target: { databaseName: "rescened_dev" }, generatedAt: NOW.toISOString(), settings: { language: "en", maxGraphemes: 250 }, counts: {}, items: [] });
  const planPath = path.join(directory, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  const events = [];
  const fakeDb = (name) => ({ connection: { name }, connect: async (_, options) => { events.push(["connect", options]); }, disconnect: async () => { events.push(["disconnect"]); } });
  const model = { createIndexes: async () => { events.push(["indexes"]); } };
  const run = (argv, db) => main(argv, { mongoose: db, mongoUri: "mongodb://fixture.invalid/x", BiographyModel: model, sources: {}, output: { log: () => {} } });

  await assert.rejects(run(["--apply", "--plan", planPath, "--plan-sha256", "0".repeat(64), "--confirm-target", "rescened_dev", "--report", path.join(directory, "r1.json")], fakeDb("rescened_dev")), { code: "PLAN_CHECKSUM_MISMATCH" });
  await assert.rejects(run(["--apply", "--plan", planPath, "--plan-sha256", plan.planSha256, "--confirm-target", "rescened", "--report", path.join(directory, "r2.json")], fakeDb("rescened")), { code: "TARGET_MISMATCH" });
  assert.deepEqual(events, [], "nothing connected for a bad plan or target");
  await assert.rejects(run(["--apply", "--plan", planPath, "--plan-sha256", plan.planSha256, "--confirm-target", "rescened_dev", "--report", path.join(directory, "r3.json")], fakeDb("rescened_other")), { code: "TARGET_MISMATCH" });
  assert.deepEqual(events.map(([event]) => event), ["connect", "disconnect"], "a mismatched connection builds no index");
  assert.deepEqual(events[0][1], { autoCreate: false, autoIndex: false });
  events.length = 0;
  assert.equal(await run(["--apply", "--plan", planPath, "--plan-sha256", plan.planSha256, "--confirm-target", "rescened_dev", "--report", path.join(directory, "r4.json")], fakeDb("rescened_dev")), 0);
  assert.deepEqual(events.map(([event]) => event), ["connect", "indexes", "disconnect"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "r4.json"), "utf8")).status, "completed");
  await assert.rejects(run(["--apply", "--plan", planPath, "--plan-sha256", plan.planSha256, "--confirm-target", "rescened_dev", "--report", path.join(directory, "r4.json")], fakeDb("rescened_dev")), /EEXIST/, "reports are never overwritten");

  // A recorded provider failure is written, but the report separates it from published text.
  const rows = [
    { artistId: "a", result: "written", status: "accepted" },
    { artistId: "b", result: "written", status: "error", errorCode: "BIOGRAPHY_PROVIDER_HTTP" },
  ];
  const withRows = (argv) => main(argv, { mongoose: fakeDb("rescened_dev"), mongoUri: "mongodb://fixture.invalid/x", BiographyModel: model, sources: {}, output: { log: () => {} }, operations: { applyBiographyPlan: async () => rows } });
  await withRows(["--apply", "--plan", planPath, "--plan-sha256", plan.planSha256, "--confirm-target", "rescened_dev", "--report", path.join(directory, "r5.json")]);
  const report = JSON.parse(fs.readFileSync(path.join(directory, "r5.json"), "utf8"));
  assert.deepEqual(report.counts, { written: 2 });
  assert.deepEqual(report.statusCounts, { accepted: 1, error: 1 });
  assert.equal(report.results[1].errorCode, "BIOGRAPHY_PROVIDER_HTTP");
});



// --- review regressions ---------------------------------------------------

test("Wikidata is asked for info and an entity without its revision is rejected", async () => {
  const { calls } = await resolve();
  assert.equal(calls.find((call) => call.route === "wikidata").url.searchParams.get("props"), "info|claims|sitelinks");
  const missingRevision = await resolve({ wikidata: () => F.wdEntity({ lastrevid: null }) });
  assert.deepEqual([missingRevision.outcome.status, missingRevision.outcome.error.code], ["error", "BIOGRAPHY_INVALID_RESPONSE"]);
});

test("a moderator-based publication is hidden once its confirmation no longer stands", () => {
  const record = {
    identity: { state: "verified", qid: F.QID, basis: "moderator" },
    accepted: { text: "Fixture Band are an English rock band.", qid: F.QID, shortened: false, article: { title: "Fixture Band", url: "u", revisionId: 1, revisionUrl: "r" }, license: {} },
    moderation: { verdict: "match_confirmed", verdictQid: F.QID },
  };
  assert.ok(displayBiography(record));
  assert.equal(displayBiography({ ...record, moderation: { verdict: null } }), null);
  assert.equal(displayBiography({ ...record, moderation: { verdict: "match_confirmed", verdictQid: F.OTHER_QID } }), null);
  assert.ok(displayBiography({ ...record, identity: { ...record.identity, basis: "automatic" }, moderation: { verdict: null } }), "automatic proof does not need a verdict");
});

test("the sealed apply signature covers decision evidence, not just status and text", async () => {
  const { signature } = require("../lib/artists/biographyOperations");
  const base = (await resolve()).outcome;
  const otherClass = (await resolve({ wikidata: () => F.wdEntity({ classes: ["Q5741069"] }) })).outcome;
  const otherStatement = (await resolve({ wikidata: () => F.wdEntity({ claims434: [F.p434(F.ARTIST_MBID, { id: "Q44190$other" })] }) })).outcome;
  const unrelatedEdit = (await resolve({ wikidata: () => F.wdEntity({ lastrevid: 2300000999 }) })).outcome;
  for (const changed of [otherClass, otherStatement]) {
    assert.deepEqual([changed.status, changed.candidate.textHash, changed.candidate.article.revisionId], [base.status, base.candidate.textHash, base.candidate.article.revisionId]);
    assert.notEqual(signature(changed), signature(base), "same status and text, different evidence");
  }
  assert.equal(signature(unrelatedEdit), signature(base), "an unrelated item revision alone does not invalidate review");
});

test("apply and refresh reports are checkpointed per row and finish honestly on failure", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { main } = require("../scripts/artistBiographies");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-bio-report-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = { connection: { name: "rescened_dev" }, connect: async () => {}, disconnect: async () => {} };
  const model = { createIndexes: async () => {} };
  const logs = [];
  const failing = (stage) => ({
    refreshBiographies: async ({ onResult }) => {
      const rows = [{ artistId: "a1", result: "written", status: "accepted" }];
      await onResult(rows[0], rows);
      const saved = JSON.parse(fs.readFileSync(path.join(directory, `${stage}.json`), "utf8"));
      assert.deepEqual([saved.status, saved.databaseCommitted, saved.results.length], ["running", true, 1], "the committed row is on disk before the next row runs");
      throw Object.assign(new Error("connection lost"), { code: "MONGO_NETWORK", biographyRow: { artistId: "a2", stage } });
    },
  });
  const run = (name, operations, extra = {}) => main(["--refresh", "--confirm-target", "rescened_dev", "--report", path.join(directory, `${name}.json`)], { mongoose: db, mongoUri: "mongodb://x.invalid/y", BiographyModel: model, sources: {}, output: { log: (line) => logs.push(line) }, operations, ...extra });

  await assert.rejects(run("writing", failing("writing")), { code: "MONGO_NETWORK" });
  const partial = JSON.parse(fs.readFileSync(path.join(directory, "writing.json"), "utf8"));
  assert.deepEqual([partial.status, partial.databaseCommitted, partial.uncertainWrites, partial.results.map((row) => row.result)], ["partial", true, 1, ["written", "uncertain"]]);
  assert.equal(partial.error.code, "MONGO_NETWORK");

  await assert.rejects(run("resolving", failing("resolving")), { code: "MONGO_NETWORK" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "resolving.json"), "utf8")).results.map((row) => row.result), ["written", "not_written"]);

  const nothing = { refreshBiographies: async () => { throw Object.assign(new Error("boom"), { biographyRow: { artistId: "a1", stage: "resolving" } }); } };
  await assert.rejects(run("failed", nothing));
  const failed = JSON.parse(fs.readFileSync(path.join(directory, "failed.json"), "utf8"));
  assert.deepEqual([failed.status, failed.databaseCommitted, failed.uncertainWrites], ["failed", false, 0]);

  // Report finalization fails after writes: the report is printed instead.
  const ok = { refreshBiographies: async ({ onResult }) => { const rows = [{ artistId: "a1", result: "written" }]; await onResult(rows[0], rows); return rows; } };
  let writes = 0;
  const flakyWriter = (target, text) => { writes += 1; if (writes > 1) throw new Error("disk full"); fs.writeFileSync(target, text); };
  await assert.rejects(run("final", ok, { writeReport: flakyWriter }), (error) => error.code === "REPORT_WRITE_FAILED" && error.databaseCommitted === true);
  assert.ok(logs.some((line) => line.includes('"reportWriteFailed": true') && line.includes('"databaseCommitted": true')));
});

test("a checkpoint failure after a committed row keeps that row recorded as written", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { main } = require("../scripts/artistBiographies");
  const { refreshBiographies } = require("../lib/artists/biographyOperations");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-bio-checkpoint-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logs = [];
  let writes = 0;
  // Real operation with stub models: one due record that refreshes as unchanged.
  const due = [{ artistId: "11111111-1111-4111-8111-111111111111", revision: 2, identity: { state: "verified", qid: F.QID, nextCheckAt: new Date("2027-01-01") }, accepted: { qid: F.QID, article: { pageId: F.PAGE_ID, revisionId: F.REVISION } }, fetch: {} }];
  const BiographyModel = { find: () => ({ sort: () => ({ limit: () => ({ lean: async () => due }) }) }), updateOne: async () => ({ modifiedCount: 1 }), createIndexes: async () => {} };
  const operations = { refreshBiographies: (args) => refreshBiographies({ ...args, BiographyModel }) };
  // The checkpoint after the committed row fails; the failure report then saves.
  const writer = (target, text) => { writes += 1; if (writes === 1) throw new Error("disk full"); fs.writeFileSync(target, text); };
  await assert.rejects(main(["--refresh", "--confirm-target", "rescened_dev", "--report", path.join(directory, "r.json")], {
    mongoose: { connection: { name: "rescened_dev" }, connect: async () => {}, disconnect: async () => {} }, mongoUri: "mongodb://x.invalid/y",
    BiographyModel, sources: sources().sources, now: NOW, output: { log: (line) => logs.push(line) }, operations, writeReport: writer,
  }), /disk full/);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "r.json"), "utf8"));
  assert.deepEqual([saved.status, saved.databaseCommitted, saved.uncertainWrites, saved.results.map((row) => row.result)], ["partial", true, 0, ["written"]]);
});

test("content refresh routes a changed page ID to review instead of replacing the article", async () => {
  const accepted = (await resolve()).outcome.candidate;
  // The stored page ID now redirects to another page with the same item.
  const redirected = sources({ page: () => F.wpPage({ pageid: 777, title: "Fixture Band (merged)", lastrevid: F.REVISION + 2, redirectedFrom: "Fixture Band" }), parse: (url) => F.wpParse({ pageid: 777, revid: Number(url.searchParams.get("oldid")), title: "Fixture Band (merged)" }) });
  const outcome = await refreshArticle({ accepted, sources: redirected.sources, now: NOW });
  assert.deepEqual([outcome.status, outcome.reasons, outcome.candidate.article.pageId], ["needs_review", ["MATCH_CHANGED", "PAGE_CHANGED"], 777]);
  const record = { revision: 4, identity: { state: "verified", qid: F.QID, basis: "automatic" }, accepted: { ...accepted, acceptedAt: NOW }, moderation: {}, fetch: {} };
  const { set } = outcomeUpdate(record, outcome, { mode: "content", now: NOW });
  assert.deepEqual([set["identity.state"], "accepted" in set, set.candidate.article.pageId], ["needs_review", false, 777]);
  assert.ok(set["identity.reasons"].includes("MATCH_CHANGED"));
  assert.equal(displayBiography({ ...record, identity: { ...record.identity, state: set["identity.state"] } }), null, "the old article stops showing");
  // Same page, new revision still updates in place.
  const sameRecord = outcomeUpdate(record, { status: "accepted", qid: F.QID, candidate: { ...accepted, article: { ...accepted.article, revisionId: F.REVISION + 9 } } }, { mode: "content", now: NOW });
  assert.equal(sameRecord.set.accepted.article.revisionId, F.REVISION + 9);
});

test("P434 qualifier values are kept, bounded, and part of the reviewed evidence", async () => {
  const { signature } = require("../lib/artists/biographyOperations");
  const qualifier = (value) => ({ snaktype: "value", property: "P518", datavalue: { type: "wikibase-entityid", value: { id: value } } });
  const claims = (value) => [F.p434(F.ARTIST_MBID), F.p434(F.OTHER_MBID, { qualifiers: { P518: [qualifier(value)], P1810: [{ snaktype: "value", datavalue: { type: "string", value: "x".repeat(500) } }] } })];
  const first = (await resolve({ wikidata: () => F.wdEntity({ claims434: claims("Q1") }) })).outcome;
  const second = (await resolve({ wikidata: () => F.wdEntity({ claims434: claims("Q2") }) })).outcome;
  assert.equal(first.status, "needs_review");
  const stored = first.evidence.p434.find((claim) => claim.value === F.OTHER_MBID).qualifiers;
  assert.deepEqual(stored.map((entry) => entry.property), ["P1810", "P518"]);
  assert.deepEqual(stored.find((entry) => entry.property === "P518").values, ["Q1"]);
  assert.equal(stored.find((entry) => entry.property === "P1810").values[0].length, 200, "long values are truncated");
  assert.notEqual(signature(first), signature(second), "a different qualifier value invalidates the review");
});




const { nameQualifier, performance, itemClaim, soloFixture, aliasFixture } = require('./fixtures/biographies/identityFixtures');

test('plain and descriptive P1810/P742 name qualifiers allow exact single-ID identity', async () => {
  for (const qualifiers of [nameQualifier(), nameQualifier('P742'), { ...nameQualifier(), ...nameQualifier('P742') }]) {
    const { outcome } = await resolve({ wikidata: () => F.wdEntity({ claims434: [F.p434(F.ARTIST_MBID, { qualifiers })] }) });
    assert.equal(outcome.status, 'accepted');
    assert.equal(outcome.evidence.p434[0].qualifierPolicy, 'name');
  }
});

test('malformed, unknown, truncated and non-value name qualifiers cannot become proof', async () => {
  const cases = [
    { P1810: [] }, { P1810: [{ snaktype: 'novalue' }] }, { P1810: [{ snaktype: 'value', datavalue: { type: 'wikibase-entityid', value: { id: 'Q5' } } }] },
    nameQualifier('P1810', ''), nameQualifier('P1810', 'a'.repeat(201)), { P1810: Array(6).fill(nameQualifier().P1810[0]) },
    { ...nameQualifier(), P518: [] }, { ...nameQualifier(), bad: [] }, null, [],
  ];
  for (const qualifiers of cases) {
    const claim = { ...F.p434(F.ARTIST_MBID), qualifiers };
    const { outcome } = await resolve({ wikidata: () => F.wdEntity({ claims434: [claim] }) });
    assert.equal(outcome.status, 'needs_review', JSON.stringify(qualifiers));
    assert.ok(outcome.reasons.includes('P434_UNCERTAIN'));
  }
  const unknown = F.p434(F.OTHER_MBID, { rank: 'unexpected' });
  assert.equal((await resolve({ wikidata: () => F.wdEntity({ claims434: [F.p434(F.ARTIST_MBID), unknown] }) })).outcome.status, 'needs_review');
});

test('multiple IDs require reciprocal active real-name/performance-name identity proof', async () => {
  const { outcome } = await resolve(aliasFixture());
  assert.equal(outcome.status, 'accepted', JSON.stringify(outcome));
  assert.equal(outcome.evidence.personAliases.artists.length, 2);
  for (const options of [
    { relation: { ended: true } }, { relation: { direction: 'forward' } }, { reverse: { direction: 'backward' } },
    { relation: { begin: '2099' } }, { relation: { begin: '2026' } }, { relation: { end: '2008' } },
    { person: { type: 'Group' } }, { person: { id: '22222222-2222-4222-8222-222222222222' } },
    { person: { extra: [] } }, { person: { wikidata: [] } }, { group: true },
  ]) {
    const result = (await resolve(aliasFixture(options))).outcome;
    assert.equal(result.status, 'needs_review', JSON.stringify(options));
    assert.ok(result.reasons.includes('MULTIPLE_P434_IDENTITIES_UNVERIFIED'));
  }
});

test('a general reciprocal solo-project bridge accepts a group item for its performance identity', async () => {
  const { outcome } = await resolve(soloFixture());
  assert.equal(outcome.status, 'accepted', JSON.stringify(outcome));
  assert.equal(outcome.qid, F.QID, 'keep the project article, not the underlying human article');
  assert.equal(outcome.candidate.qid, F.QID);
  assert.equal(outcome.evidence.soloProject.verified, true);
  assert.equal(outcome.evidence.soloProject.person.artistMbid, F.OTHER_MBID);
  assert.deepEqual(outcome.evidence.soloProject.person.p31, ['Q5']);
});

test('solo-project bridge fails closed for unsupported, ambiguous or contradictory identity evidence', async () => {
  const cases = [
    { relation: { direction: 'forward' } }, { relation: { ended: true } }, { relation: { end: '2020' } },
    { relation: { begin: '2099' } }, { relation: { begin: '2026-11' } }, { relation: { begin: '2020-02-31' } },
    { relation: { attributes: ['guest'] } }, { reverse: { direction: 'backward' } }, { reverse: { ended: true } },
    { person: { extra: [] } }, { person: { type: 'Group' } }, { person: { wikidata: [] } },
    { human: { classes: ['Q215380'] } }, { human: { claims434: [F.p434(F.ARTIST_MBID)] } },
    { human: { extraClaims: {} } }, { human: { extraClaims: { P463: [itemClaim('P463', 'Q777')] } } },
    { human: { extraClaims: { P463: [itemClaim('P463', F.QID, { qualifiers: { P580: [] } })] } } },
    { project: { extraClaims: {} } },
    { project: { extraClaims: { P527: [itemClaim('P527', F.OTHER_QID), itemClaim('P527', 'Q777')] } } },
    { project: { extraClaims: { P527: [itemClaim('P527', F.OTHER_QID, { rank: 'deprecated' })] } } },
    { project: { extraClaims: { P527: [itemClaim('P527', F.OTHER_QID, { qualifiers: { P582: [] } })] } } },
  ];
  for (const options of cases) {
    const { outcome } = await resolve(soloFixture(options));
    assert.notEqual(outcome.status, 'accepted', JSON.stringify(options));
    assert.equal(outcome.candidate, null);
  }
});

test('a solo-project bridge never relaxes project MBID, type veto or article identity checks', async () => {
  for (const [overrides, reason] of [
    [soloFixture({ project: { claims434: [F.p434(F.OTHER_MBID)] } }), 'P434_MISMATCH'],
    [soloFixture({ project: { classes: ['Q215380', 'Q95074'] } }), 'ENTITY_TYPE_INCOMPATIBLE'],
    [{ ...soloFixture(), page: () => F.wpPage({ wikibase: F.OTHER_QID }) }, 'WIKIBASE_ITEM_MISMATCH'],
  ]) assert.ok((await resolve(overrides)).outcome.reasons.includes(reason));
});

test('official merged aliases collapse to the verified canonical person with provenance', async () => {
  const aliases = aliasFixture();
  const result = await resolve({ ...aliases, musicbrainz: url => url.pathname.endsWith(F.OTHER_MBID)
    ? F.response({}, { status: 301, headers: { location: `/ws/2/artist/${F.ARTIST_MBID}?fmt=json` } }) : aliases.musicbrainz(url) });
  assert.equal(result.outcome.status, 'accepted');
  const row = result.outcome.evidence.personAliases.artists.find(x => x.requestedArtistMbid === F.OTHER_MBID);
  assert.deepEqual(row.musicBrainzRedirects, [{ from: F.OTHER_MBID, to: F.ARTIST_MBID }]);
  assert.equal(row.artistMbid, F.ARTIST_MBID);
  assert.deepEqual(result.sleeps, []);
});

test('primary merges retain original identity and require canonical reciprocal claims and article', async () => {
  const fixture = { musicbrainz: url => url.pathname.endsWith(F.ARTIST_MBID)
    ? F.response({}, { status: 308, headers: { location: `/ws/2/artist/${F.OTHER_MBID}` } }) : F.mbArtist({ id: F.OTHER_MBID }),
    wikidata: () => F.wdEntity({ claims434: [F.p434(F.OTHER_MBID)] }) };
  const result = (await resolve(fixture)).outcome;
  assert.equal(result.status, 'accepted');
  assert.equal(result.evidence.artistMbid, F.ARTIST_MBID);
  assert.equal(result.evidence.musicBrainzId, F.OTHER_MBID);
  assert.deepEqual(result.evidence.musicBrainzRedirects, [{ from: F.ARTIST_MBID, to: F.OTHER_MBID }]);
  assert.equal((await resolve({ ...fixture, wikidata: () => F.wdEntity() })).outcome.status, 'conflict');
  assert.equal((await resolve({ ...fixture, page: () => F.wpPage({ wikibase: F.OTHER_QID }) })).outcome.status, 'conflict');
});

test('merge loops and overlong chains are held without following arbitrary destinations', async () => {
  const ids = [F.ARTIST_MBID, F.OTHER_MBID, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  for (const chain of [ids.slice(0, 2), ids]) {
    const { outcome, calls } = await resolve({ musicbrainz: url => {
      const i = chain.indexOf(url.pathname.split('/').pop());
      return F.response({}, { status: 301, headers: { location: `/ws/2/artist/${chain[(i + 1) % chain.length]}` } });
    } });
    assert.equal(outcome.status, 'needs_review');
    assert.ok(calls.length <= 4);
  }
});

test('historical person-name links prove identity but never current solo membership', async () => {
  for (const dates of [{ begin: '2012', end: '2018-09-07' }, { begin: '2010', end: null }, { begin: null, end: null }]) {
    const historical = { ended: true, ...dates };
    assert.equal((await resolve(aliasFixture({ relation: historical, reverse: historical }))).outcome.status, 'accepted');
    assert.notEqual((await resolve(soloFixture({ relation: historical, reverse: historical }))).outcome.status, 'accepted');
  }
  for (const dates of [{ begin: '2020-02-31', end: null }, { begin: '2020', end: '2019' }, { begin: '2099', end: null }, { begin: null, end: '2026' }, { begin: '2010', end: 'nonsense' }]) {
    const historical = { ended: true, ...dates };
    assert.equal((await resolve(aliasFixture({ relation: historical, reverse: historical }))).outcome.status, 'needs_review');
  }
  assert.equal((await resolve(aliasFixture({ relation: { ended: true }, reverse: { ended: false } }))).outcome.status, 'needs_review');
});

test('temporary, same-ID, unrelated, malformed and insecure redirects are provider errors, not identity conflicts', async () => {
  for (const [status, location] of [
    [302, `https://musicbrainz.org/ws/2/artist/${F.OTHER_MBID}`],
    [307, `https://musicbrainz.org/ws/2/artist/${F.OTHER_MBID}`],
    [301, `https://musicbrainz.org/ws/2/artist/${F.ARTIST_MBID}`],
    [301, `https://musicbrainz.org/artist/${F.OTHER_MBID}`],
    [301, 'https://example.invalid/untrusted'], [301, '/challenge'], [301, 'http://['],
    [301, `http://musicbrainz.org/ws/2/artist/${F.OTHER_MBID}`],
    [301, `https://user@musicbrainz.org/ws/2/artist/${F.OTHER_MBID}`],
    [301, `https://musicbrainz.org:4430/ws/2/artist/${F.OTHER_MBID}`],
  ]) {
    const { outcome, calls, sleeps } = await resolve({ musicbrainz: () => F.response({}, { status, headers: { location } }) });
    assert.equal(outcome.status, 'error', `${status} ${location}`);
    assert.equal(outcome.error.code, 'BIOGRAPHY_PROVIDER_REDIRECT');
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

// --- refresh guard: changed text is staged, never auto-published ------------

function revisionOf(accepted, { revisionId, text }) {
  return {
    ...accepted,
    ...(text ? { text, textHash: textHash(text) } : {}),
    article: { ...accepted.article, revisionId, revisionUrl: `https://en.wikipedia.org/w/index.php?oldid=${revisionId}` },
    retrievedAt: NOW,
  };
}

test("refresh stages changed text from a newer revision and keeps showing the accepted excerpt", async () => {
  const { outcome } = await resolve();
  const record = { ...acceptedRecord(outcome), identity: { ...acceptedRecord(outcome).identity, state: "verified", basis: "automatic" } };
  const vandalised = revisionOf(record.accepted, { revisionId: F.REVISION + 1, text: "Fixture Band are the worst band in the world, says nobody." });

  for (const mode of ["content", "resolve"]) {
    const { set, event } = outcomeUpdate(record, { status: "accepted", qid: F.QID, candidate: vandalised, evidence: outcome.evidence, reasons: [] }, { mode, now: NOW });
    assert.equal("accepted" in set, false, `${mode}: published text is not replaced`);
    assert.equal(set.pendingRevision.textHash, vandalised.textHash);
    assert.equal(event.action, `${mode}:revision_staged`);
    assert.deepEqual([event.details.revisionId, event.details.previousRevisionId], [F.REVISION + 1, F.REVISION]);
    const shown = displayBiography({ ...record, pendingRevision: set.pendingRevision });
    assert.deepEqual([shown.text, shown.article.revisionId], [record.accepted.text, F.REVISION], `${mode}: readers still see the reviewed text and its source`);
  }

  // A plan apply uses the same path: it cannot replace published text either,
  // even text a moderator dismissed.
  const dismissedRecord = { ...record, dismissedRevision: { revisionId: F.REVISION + 1, textHash: vandalised.textHash, dismissedBy: "user_mod", dismissedAt: NOW } };
  const overDismissal = outcomeUpdate(dismissedRecord, { status: "accepted", qid: F.QID, candidate: vandalised, evidence: outcome.evidence, reasons: [] }, { mode: "resolve", now: NOW });
  assert.deepEqual(["accepted" in overDismissal.set, "pendingRevision" in overDismissal.set, overDismissal.set["identity.state"]], [false, false, "verified"]);

  // A record that is not published yet (here back in review) can still be published by a plan.
  const unpublished = { ...record, identity: { ...record.identity, state: "needs_review" }, accepted: null, pendingRevision: vandalised };
  const first = outcomeUpdate(unpublished, { status: "accepted", qid: F.QID, candidate: vandalised, evidence: outcome.evidence, reasons: [] }, { mode: "resolve", now: NOW });
  assert.deepEqual([first.set.accepted.textHash, first.set.pendingRevision, first.set.dismissedRevision], [vandalised.textHash, null, null]);
});

test("returning to dismissed text clears an older staged text; identical text refreshes extraction metadata", async () => {
  const { outcome } = await resolve();
  const base = acceptedRecord(outcome);
  const record = { ...base, identity: { ...base.identity, state: "verified", basis: "automatic" } };
  const x = revisionOf(record.accepted, { revisionId: F.REVISION + 1, text: "Fixture Band are a band a moderator declined this wording for." });
  const y = revisionOf(record.accepted, { revisionId: F.REVISION + 2, text: "Fixture Band are a band with a later wording that was staged." });
  const backToX = outcomeUpdate({ ...record, pendingRevision: y, dismissedRevision: { revisionId: F.REVISION + 1, textHash: x.textHash, dismissedBy: "user_mod", dismissedAt: NOW } }, { status: "accepted", qid: F.QID, candidate: revisionOf(x, { revisionId: F.REVISION + 3 }) }, { mode: "content", now: NOW });
  assert.equal(backToX.set.pendingRevision, null, "the staged text is no longer what Wikipedia says");
  assert.equal("accepted" in backToX.set, false);

  const sameTextLongerLead = { ...revisionOf(record.accepted, { revisionId: F.REVISION + 4 }), shortened: true, cut: "sentence", extractionVersion: "en-lead-sentences-v2" };
  const moved = outcomeUpdate({ ...record, accepted: { ...record.accepted, shortened: false } }, { status: "accepted", qid: F.QID, candidate: sameTextLongerLead }, { mode: "content", now: NOW });
  assert.deepEqual([moved.set.accepted.text, moved.set.accepted.shortened, moved.set.accepted.extractionVersion, moved.set.accepted.article.revisionId], [record.accepted.text, true, "en-lead-sentences-v2", F.REVISION + 4]);
});

test("identical text only moves the source revision; reverts clear, and dismissed or already staged text is not restaged", async () => {
  const { outcome } = await resolve();
  const base = acceptedRecord(outcome);
  const record = { ...base, identity: { ...base.identity, state: "verified", basis: "automatic" } };
  const sameText = revisionOf(record.accepted, { revisionId: F.REVISION + 2 });
  const edit = revisionOf(record.accepted, { revisionId: F.REVISION + 3, text: "Fixture Band are an English rock band, edited lead." });
  const accept = (candidate) => ({ status: "accepted", qid: F.QID, candidate });

  const pointer = outcomeUpdate(record, accept(sameText), { mode: "content", now: NOW });
  assert.deepEqual([pointer.set.accepted.text, pointer.set.accepted.article.revisionId, pointer.set.accepted.acceptedAt], [record.accepted.text, F.REVISION + 2, record.accepted.acceptedAt]);
  assert.equal(pointer.event.action, "content:revision_unchanged_text");

  const reverted = outcomeUpdate({ ...record, pendingRevision: edit }, accept(sameText), { mode: "content", now: NOW });
  assert.equal(reverted.set.pendingRevision, null, "an edit that was reverted on Wikipedia is no longer pending");

  const dismissed = outcomeUpdate({ ...record, dismissedRevision: { revisionId: F.REVISION + 3, textHash: edit.textHash, dismissedBy: "user_mod", dismissedAt: NOW } }, accept(revisionOf(edit, { revisionId: F.REVISION + 4 })), { mode: "content", now: NOW });
  assert.deepEqual(["pendingRevision" in dismissed.set, "accepted" in dismissed.set, dismissed.event], [false, false, null], "dismissed text is not staged again under a later revision");

  const alreadyStaged = outcomeUpdate({ ...record, pendingRevision: edit }, accept(revisionOf(edit, { revisionId: F.REVISION + 5 })), { mode: "content", now: NOW });
  assert.deepEqual(["pendingRevision" in alreadyStaged.set, alreadyStaged.event], [false, null]);

  const newer = revisionOf(record.accepted, { revisionId: F.REVISION + 6, text: "Fixture Band are an English rock band, edited again." });
  const replaced = outcomeUpdate({ ...record, pendingRevision: edit }, accept(newer), { mode: "content", now: NOW });
  assert.deepEqual([replaced.set.pendingRevision.textHash, replaced.event.details.replacedPendingRevisionId], [newer.textHash, F.REVISION + 3]);

  // Leaving the published page clears a staged revision of it.
  const conflict = outcomeUpdate({ ...record, pendingRevision: edit }, { status: "conflict", reasons: ["WIKIBASE_ITEM_MISMATCH"], qid: F.QID }, { mode: "content", now: NOW });
  assert.equal(conflict.set.pendingRevision, null);
});

test("revision commands need the right fields: dismiss needs a reason, accept takes none", () => {
  assert.deepEqual(normalizeCommand("dismiss_revision", { expectedRevision: 3, reason: " Vandalism " }), { action: "dismiss_revision", expectedRevision: 3, reason: "Vandalism" });
  assert.throws(() => normalizeCommand("dismiss_revision", { expectedRevision: 3 }), /reason is required/);
  assert.deepEqual(normalizeCommand("accept_revision", { expectedRevision: 3 }), { action: "accept_revision", expectedRevision: 3 });
  assert.throws(() => normalizeCommand("accept_revision", { expectedRevision: 3, text: "x" }), /Unsupported field text/);
});

test("identity revalidation of a moderator-confirmed biography stages changed text too", async () => {
  const { outcome } = await resolve();
  const base = acceptedRecord(outcome);
  const record = { ...base, identity: { ...base.identity, state: "verified", basis: "moderator" }, moderation: { suppressed: false, verdict: "match_confirmed", verdictQid: F.QID } };
  const changed = revisionOf(record.accepted, { revisionId: F.REVISION + 7, text: "Fixture Band are an English rock band, newly worded lead." });
  const { set, event } = outcomeUpdate(record, { status: "needs_review", qid: F.QID, reasons: ["P31_UNFAMILIAR"], candidate: changed, evidence: outcome.evidence }, { mode: "resolve", now: NOW });
  assert.deepEqual([set["identity.state"], set["identity.basis"], "accepted" in set, set.pendingRevision.textHash, event.action], ["verified", "moderator", false, changed.textHash, "resolve:revision_staged"]);
});
