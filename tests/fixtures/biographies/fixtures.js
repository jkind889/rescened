// Synthetic provider responses for artist-biography tests. Shapes follow the
// documented MusicBrainz web service (artist lookup with inc=url-rels), the
// Wikibase API (wbgetentities), and the MediaWiki Action API (query with
// info/pageprops/revisions, and parse with oldid). Values are invented; no
// response was captured from a live service. See README.md.

const ARTIST_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const OTHER_MBID = "11111111-2222-4333-8444-555555555555";
const QID = "Q44190";
const OTHER_QID = "Q99999";
const PAGE_ID = 52780;
const REVISION = 1200000001;

const LEAD_HTML = `<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">
<div class="shortdescription nomobile noexcerpt noprint searchaux" style="display:none">English rock band</div>
<div role="note" class="hatnote navigation-not-searchable">For other uses, see <a href="/wiki/X">X</a>.</div>
<table class="infobox vcard"><tbody><tr><th>Fixture Band</th></tr></tbody></table>
<p class="mw-empty-elt"></p>
<p><b>Fixture Band</b> are an English <a href="/wiki/Rock_music">rock</a> band formed in Abingdon, Oxfordshire, in 1985.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup> The band&#39;s line-up has been unchanged since&nbsp;1985. <span class="noexcerpt nowrap">(<a href="/wiki/File:x.ogg">listen</a>)</span>They are known for experimental albums that changed alternative music in the late 1990s and 2000s, reaching a very wide audience across several decades.</p>
<p>A second paragraph that is not needed for the excerpt.</p>
<figure><figcaption><p>Caption text</p></figcaption></figure>
</div>`;

function mbArtist({ id = ARTIST_MBID, type = "Group", wikidata = [QID], ended = [], extra = [] } = {}) {
  return {
    id,
    name: "Fixture Band",
    type,
    relations: [
      ...wikidata.map((qid, index) => ({ type: "wikidata", "target-type": "url", direction: "forward", ended: ended[index] === true, url: { resource: qid.startsWith("http") ? qid : `https://www.wikidata.org/wiki/${qid}` } })),
      { type: "official homepage", "target-type": "url", ended: false, url: { resource: "https://example.invalid/" } },
      ...extra,
    ],
  };
}

function p434(value, { rank = "normal", id = `${QID}$P434-${value.slice(0, 8)}`, qualifiers } = {}) {
  return { id, rank, mainsnak: { snaktype: "value", property: "P434", datavalue: { type: "string", value } }, ...(qualifiers ? { qualifiers } : {}) };
}

function p31(value, rank = "normal") {
  return { rank, mainsnak: { snaktype: "value", property: "P31", datavalue: { type: "wikibase-entityid", value: { "entity-type": "item", id: value } } } };
}

function wdEntity({ id = QID, requested = id, claims434 = [p434(ARTIST_MBID)], classes = ["Q215380"], title = "Fixture Band", missing = false, redirectFrom = null, lastrevid = 2300000001, extraClaims = {} } = {}) {
  if (missing) return { entities: { [requested]: { id: requested, missing: "" } } };
  const entity = {
    type: "item",
    id,
    ...(lastrevid === null ? {} : { lastrevid }),
    claims: { P434: claims434, P31: classes.map((value) => p31(value)), ...extraClaims },
    sitelinks: title ? { enwiki: { site: "enwiki", title, badges: [] } } : {},
  };
  if (redirectFrom) entity.redirects = { from: redirectFrom, to: id };
  return { entities: { [requested]: entity } };
}

function wpPage({ pageid = PAGE_ID, title = "Fixture Band", ns = 0, lastrevid = REVISION, wikibase = QID, disambiguation = false, redirectedFrom = null, missing = false, timestamp = "2026-11-01T12:00:00Z" } = {}) {
  const query = { pages: [missing ? { ns, title, missing: true } : {
    pageid, ns, title, lastrevid,
    pageprops: { ...(wikibase ? { wikibase_item: wikibase } : {}), ...(disambiguation ? { disambiguation: "" } : {}) },
    revisions: [{ revid: lastrevid, parentid: lastrevid - 1, timestamp }],
  }] };
  if (redirectedFrom) query.redirects = [{ from: redirectedFrom, to: title }];
  return { batchcomplete: true, query };
}

function wpParse({ revid = REVISION, pageid = PAGE_ID, title = "Fixture Band", html = LEAD_HTML, wikibase = QID, disambiguation = false } = {}) {
  return { parse: { title, pageid, revid, text: html, properties: { ...(wikibase ? { wikibase_item: wikibase } : {}), ...(disambiguation ? { disambiguation: "" } : {}) } } };
}

function response(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: (async function* chunks() { yield Buffer.from(text); })(),
  };
}

// A fake fetch that routes by provider and request type. Overrides replace
// a route with a body, a response, an Error, or a function of the URL.
function fakeFetch(overrides = {}) {
  const calls = [];
  const routes = {
    musicbrainz: () => mbArtist(),
    wikidata: () => wdEntity(),
    page: () => wpPage(),
    parse: () => wpParse(),
    ...overrides,
  };
  async function fetchFn(input, init = {}) {
    const url = new URL(String(input));
    let route;
    if (url.hostname === "musicbrainz.org") route = "musicbrainz";
    else if (url.hostname === "www.wikidata.org") route = "wikidata";
    else if (url.hostname === "en.wikipedia.org") route = url.searchParams.get("action") === "parse" ? "parse" : "page";
    else throw new Error(`Unexpected host ${url.hostname}`);
    calls.push({ route, url, headers: init.headers || {} });
    const handler = routes[route];
    const value = typeof handler === "function" ? await handler(url, calls.filter((call) => call.route === route).length) : handler;
    if (value instanceof Error) throw value;
    if (value && typeof value === "object" && "status" in value && "headers" in value) return value;
    return response(value);
  }
  return { fetchFn, calls };
}

module.exports = { ARTIST_MBID, LEAD_HTML, OTHER_MBID, OTHER_QID, PAGE_ID, QID, REVISION, fakeFetch, mbArtist, p31, p434, response, wdEntity, wpPage, wpParse };
