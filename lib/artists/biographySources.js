// Provider adapter for artist biographies: MusicBrainz artist URL
// relationships, Wikidata entities, and English Wikipedia pages. Used only by
// the operator command, never on a page view. Every request is serial behind
// a per-provider gate, has a timeout that covers the body, reads at most
// MAX_RESPONSE_BYTES of decoded body, and retries only transient failures a
// bounded number of times, honoring Retry-After up to a cap. Responses are
// normalized here; raw provider shapes do not leave this module.

const { createRateGate, parseRetryAfter, DEFAULT_USER_AGENT } = require("../catalogImport/listenBrainz");
const { readBoundedJson } = require("../musicBrainzSearch");
const { normalizeArtistMbid } = require("./identity");

const MUSICBRAINZ_URL = "https://musicbrainz.org/ws/2";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const QID_PATTERN = /^Q[1-9][0-9]{0,11}$/;
const WIKIDATA_URL_PATTERN = /^https?:\/\/(?:www\.|m\.)?wikidata\.org\/(?:wiki|entity)\/(Q[1-9][0-9]{0,11})$/;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULTS = {
  timeoutMs: 8_000,
  maxRetries: 2,
  maxRetryAfterMs: 30_000,
  maxResponseBytes: 2 * 1024 * 1024,
  musicBrainzIntervalMs: 1_100,
  wikimediaIntervalMs: 1_000,
  maxlag: 5,
};

class BiographySourceError extends Error {
  constructor(message, { code = "BIOGRAPHY_PROVIDER_FAILED", provider, transient = false, status, redirectedArtistMbid } = {}) {
    super(message);
    this.name = "BiographySourceError";
    this.code = code;
    this.provider = provider;
    this.transient = transient;
    if (status !== undefined) this.status = status;
    if (redirectedArtistMbid) this.redirectedArtistMbid = redirectedArtistMbid;
  }
}

function invalid(provider, message) {
  return new BiographySourceError(message, { code: "BIOGRAPHY_INVALID_RESPONSE", provider });
}

function positiveInteger(value, name, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) throw new TypeError(`${name} must be an integer >= ${min}`);
  return value;
}

function createBiographySources(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new TypeError("A fetch implementation is required");
  const userAgent = String(options.userAgent || process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT).trim();
  if (!/[(/@]/.test(userAgent)) throw new TypeError("The user agent must identify the application and a contact");
  const nowMs = options.nowMs || Date.now;
  const sleepFn = options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const settings = { ...DEFAULTS, ...options };
  positiveInteger(settings.timeoutMs, "timeoutMs", { min: 1 });
  positiveInteger(settings.maxRetries, "maxRetries");
  if (settings.maxRetries > 5) throw new TypeError("maxRetries must be at most 5");
  positiveInteger(settings.maxRetryAfterMs, "maxRetryAfterMs");
  positiveInteger(settings.maxResponseBytes, "maxResponseBytes", { min: 1024 });
  const gates = {
    musicbrainz: options.musicBrainzGate || createRateGate({ intervalMs: settings.musicBrainzIntervalMs, nowMs, sleepFn }),
    wikidata: options.wikimediaGate || createRateGate({ intervalMs: settings.wikimediaIntervalMs, nowMs, sleepFn }),
  };
  gates.wikipedia = gates.wikidata; // one serial Wikimedia queue
  const stats = { requests: 0, retries: 0 };

  async function getJson(provider, url) {
    for (let attempt = 0; ; attempt += 1) {
      await gates[provider]();
      stats.requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      let retryDelay = null;
      try {
        const response = await fetchFn(url, {
          method: "GET",
          redirect: "manual", // observe redirects without following them
          signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": userAgent },
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          if (response.status >= 300 && response.status < 400) {
            // Never follow HTTP redirects. Only a permanent redirect to a
            // different valid MB artist endpoint proves an artist merge;
            // temporary/challenge/canonical-host redirects are operational.
            let redirectedArtistMbid = null;
            if (provider === "musicbrainz" && [301, 308].includes(response.status)) {
              try {
                const location = response.headers?.get?.("location");
                const target = new URL(location, url);
                const match = /^\/ws\/2\/artist\/([^/]+)$/.exec(target.pathname);
                const requested = normalizeArtistMbid(new URL(url).pathname.split("/").pop());
                const candidate = match && normalizeArtistMbid(match[1]);
                if (location && target.protocol === "https:" && target.hostname === "musicbrainz.org" && !target.port && !target.username && !target.password && !target.hash && candidate && requested && candidate !== requested) redirectedArtistMbid = candidate;
              } catch { /* an invalid Location never establishes identity */ }
            }
            throw new BiographySourceError(`${provider} returned an HTTP redirect`, { code: redirectedArtistMbid ? "BIOGRAPHY_MUSICBRAINZ_MERGED" : "BIOGRAPHY_PROVIDER_REDIRECT", provider, status: response.status, redirectedArtistMbid });
          }
          const transient = RETRYABLE.has(response.status);
          if (!transient) throw new BiographySourceError(`${provider} returned HTTP ${response.status}`, { code: "BIOGRAPHY_PROVIDER_HTTP", provider, status: response.status });
          retryDelay = parseRetryAfter(response.headers?.get?.("retry-after"), nowMs());
          if (retryDelay !== null && retryDelay > settings.maxRetryAfterMs) {
            throw new BiographySourceError(`${provider} asked to wait longer than allowed`, { code: "BIOGRAPHY_PROVIDER_THROTTLED", provider, transient: true, status: response.status });
          }
          if (attempt >= settings.maxRetries) throw new BiographySourceError(`${provider} returned HTTP ${response.status}`, { code: "BIOGRAPHY_PROVIDER_HTTP", provider, transient: true, status: response.status });
        } else {
          let data;
          try {
            data = await readBoundedJson(response, settings.maxResponseBytes);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            throw new BiographySourceError(`${provider} returned an unreadable or oversized response`, { code: "BIOGRAPHY_INVALID_RESPONSE", provider });
          }
          // MediaWiki reports replication lag as an API error with HTTP 200.
          if (data?.error?.code === "maxlag") {
            retryDelay = parseRetryAfter(response.headers?.get?.("retry-after"), nowMs()) ?? 5_000;
            if (retryDelay > settings.maxRetryAfterMs) throw new BiographySourceError(`${provider} is lagged`, { code: "BIOGRAPHY_PROVIDER_THROTTLED", provider, transient: true });
            if (attempt >= settings.maxRetries) throw new BiographySourceError(`${provider} is lagged`, { code: "BIOGRAPHY_PROVIDER_THROTTLED", provider, transient: true });
          } else {
            return data;
          }
        }
      } catch (error) {
        if (error instanceof BiographySourceError) throw error;
        const timedOut = controller.signal.aborted;
        if (attempt >= settings.maxRetries) {
          throw new BiographySourceError(`${provider} request ${timedOut ? "timed out" : "failed"}`, { code: timedOut ? "BIOGRAPHY_PROVIDER_TIMEOUT" : "BIOGRAPHY_PROVIDER_NETWORK", provider, transient: true });
        }
      } finally {
        clearTimeout(timer);
      }
      stats.retries += 1;
      await sleepFn(retryDelay ?? Math.min(1_000 * (2 ** attempt), 8_000));
    }
  }

  async function musicBrainzArtist(artistMbid) {
    const mbid = normalizeArtistMbid(artistMbid);
    if (!mbid) throw new BiographySourceError("Invalid artist MBID", { code: "INVALID_ARTIST_MBID", provider: "musicbrainz" });
    const data = await getJson("musicbrainz", `${MUSICBRAINZ_URL}/artist/${mbid}?${new URLSearchParams({ inc: "url-rels+artist-rels", fmt: "json" })}`);
    const id = normalizeArtistMbid(data?.id);
    if (!id || !Array.isArray(data?.relations ?? [])) throw invalid("musicbrainz", "MusicBrainz returned an invalid artist");
    const wikidata = [];
    const performanceNames = [];
    for (const relation of data.relations || []) {
      if (relation?.["type-id"] === "dd9886f2-1dfe-4270-97db-283f6839a666" && relation?.["target-type"] === "artist") {
        performanceNames.push({
          artistMbid: normalizeArtistMbid(relation.artist?.id),
          direction: relation.direction,
          ended: relation.ended,
          begin: relation.begin ?? null,
          end: relation.end ?? null,
          // Unexpected relationship attributes are not plain identity proof.
          plain: Array.isArray(relation.attributes) && relation.attributes.length === 0 && Object.keys(relation["attribute-values"] || {}).length === 0,
        });
      }
      // Only the explicitly typed artist -> URL "wikidata" relationship counts.
      if (relation?.type !== "wikidata" || relation?.["target-type"] !== "url") continue;
      const match = WIKIDATA_URL_PATTERN.exec(String(relation?.url?.resource || ""));
      wikidata.push({ qid: match ? match[1] : null, ended: relation.ended === true, resource: String(relation?.url?.resource || "").slice(0, 200) });
    }
    return { id, requestedId: mbid, type: typeof data.type === "string" ? data.type : null, wikidata, performanceNames };
  }

  // A qualifier snak as short, comparable text: item IDs, strings, times,
  // monolingual text, or the snak type when it has no value.
  function qualifierValue(snak) {
    if (snak?.snaktype !== "value") return `(${["somevalue", "novalue"].includes(snak?.snaktype) ? snak.snaktype : "unknown"})`;
    const value = snak?.datavalue?.value;
    if (typeof value === "string") return value.slice(0, 200);
    if (value && typeof value === "object") {
      if (QID_PATTERN.test(value.id || "")) return value.id;
      if (typeof value.time === "string") return value.time.slice(0, 40);
      if (typeof value.text === "string") return value.text.slice(0, 200);
      if (value.amount !== undefined) return String(value.amount).slice(0, 40);
    }
    return `(${String(snak?.datatype || "value").slice(0, 40)})`;
  }

  // Qualifiers as [{ property, values }] sorted by property, at most 10
  // properties and 5 values each, so evidence stays bounded and comparable.
  function qualifiersOf(claim) {
    if (!claim?.qualifiers || typeof claim.qualifiers !== "object") return [];
    return Object.keys(claim.qualifiers).filter((key) => /^P[1-9][0-9]*$/.test(key)).sort().slice(0, 10).map((property) => ({
      property,
      values: (Array.isArray(claim.qualifiers[property]) ? claim.qualifiers[property] : []).slice(0, 5).map(qualifierValue).sort(),
    }));
  }

  function qualifierPolicy(claim) {
    if (claim.qualifiers === undefined) return "plain";
    const qualifiers = claim.qualifiers;
    if (!qualifiers || typeof qualifiers !== "object" || Array.isArray(qualifiers)) return "unsafe";
    const properties = Object.keys(qualifiers);
    if (!properties.length) return "plain";
    if (properties.some(property => !["P1810", "P742"].includes(property))) return "unsafe";
    return properties.every(property => Array.isArray(qualifiers[property]) && qualifiers[property].length > 0 && qualifiers[property].length <= 5 && qualifiers[property].every(snak =>
      snak?.snaktype === "value" && snak.datavalue?.type === "string" && typeof snak.datavalue.value === "string" && snak.datavalue.value.trim().length > 0 && snak.datavalue.value.length <= 200
    )) ? "name" : "unsafe";
  }

  // Statement facts kept as evidence. A missing or unexpected rank is
  // "unknown", never silently "normal"; qualifiers are kept so a qualified
  // statement is not mistaken for plain identity proof.
  function claimValues(entity, property) {
    return (Array.isArray(entity?.claims?.[property]) ? entity.claims[property] : []).map((claim) => ({
      statementId: typeof claim?.id === "string" ? claim.id.slice(0, 120) : null,
      rank: ["preferred", "normal", "deprecated"].includes(claim?.rank) ? claim.rank : "unknown",
      snaktype: ["value", "somevalue", "novalue"].includes(claim?.mainsnak?.snaktype) ? claim.mainsnak.snaktype : "unknown",
      value: claim?.mainsnak?.datavalue?.value,
      qualifiers: qualifiersOf(claim),
      qualifierPolicy: qualifierPolicy(claim),
    }));
  }

  async function wikidataEntity(qid) {
    if (!QID_PATTERN.test(qid || "")) throw new BiographySourceError("Invalid Wikidata item ID", { code: "INVALID_WIKIDATA_ID", provider: "wikidata" });
    const params = new URLSearchParams({ action: "wbgetentities", ids: qid, props: "info|claims|sitelinks", sitefilter: "enwiki", format: "json", maxlag: String(settings.maxlag) });
    const data = await getJson("wikidata", `${WIKIDATA_API}?${params}`);
    const entities = data?.entities;
    if (!entities || typeof entities !== "object") throw invalid("wikidata", "Wikidata returned no entities");
    const entity = entities[qid];
    if (!entity) throw invalid("wikidata", "Wikidata returned no entity");
    if (Object.prototype.hasOwnProperty.call(entity, "missing")) return { requestedId: qid, id: null, missing: true, p434: [], p31: [], sitelinkTitle: null };
    if (!QID_PATTERN.test(entity.id || "")) throw invalid("wikidata", "Wikidata returned an invalid entity");
    // props=info supplies lastrevid, kept as provenance for the evidence.
    if (!Number.isInteger(entity.lastrevid) || entity.lastrevid < 1) throw invalid("wikidata", "Wikidata returned an entity without its revision");
    // wbgetentities returns a redirect under the requested key, with the
    // canonical entity ID and an explicit from/to pair. Never infer a
    // redirect from an unrelated entity in the response.
    let redirectTo = null;
    if (entity.redirects || entity.id !== qid) {
      if (!entity.redirects || entity.redirects.from !== qid || entity.redirects.to !== entity.id || !QID_PATTERN.test(entity.redirects.to)) {
        throw invalid("wikidata", "Wikidata returned inconsistent redirect evidence");
      }
      redirectTo = entity.redirects.to;
    }
    const p434 = claimValues(entity, "P434").map((claim) => ({
      statementId: claim.statementId,
      rank: claim.rank,
      snaktype: claim.snaktype,
      value: claim.snaktype === "value" ? normalizeArtistMbid(claim.value) || "invalid" : null,
      qualifiers: claim.qualifiers,
      qualifierPolicy: claim.qualifierPolicy,
    }));
    const p31 = claimValues(entity, "P31").filter((claim) => claim.rank !== "deprecated" && claim.snaktype === "value")
      .map((claim) => claim.value?.id).filter((id) => QID_PATTERN.test(id || ""));
    const title = entity.sitelinks?.enwiki?.title;
    return {
      requestedId: qid,
      id: entity.id,
      revisionId: entity.lastrevid,
      missing: false,
      redirected: redirectTo !== null,
      redirectTo,
      p434,
      p31: [...new Set(p31)],
      p527: claimValues(entity, "P527").map(claim => ({ ...claim, value: QID_PATTERN.test(claim.value?.id || "") ? claim.value.id : null })),
      p463: claimValues(entity, "P463").map(claim => ({ ...claim, value: QID_PATTERN.test(claim.value?.id || "") ? claim.value.id : null })),
      sitelinkTitle: typeof title === "string" && title.trim() && title.length <= 255 ? title : null,
    };
  }

  function normalizePage(data, { requestedTitle = null } = {}) {
    const query = data?.query;
    const page = Array.isArray(query?.pages) ? query.pages[0] : null;
    if (!page) throw invalid("wikipedia", "Wikipedia returned no page");
    if (page.missing || page.invalid) return { missing: true, title: page.title || requestedTitle };
    const props = page.pageprops || {};
    if (!Number.isInteger(page.pageid) || !Number.isInteger(page.lastrevid) || !Number.isInteger(page.ns) || typeof page.title !== "string") {
      throw invalid("wikipedia", "Wikipedia returned an incomplete page");
    }
    // The latest revision's timestamp, kept only when it is that revision.
    const latest = Array.isArray(page.revisions) ? page.revisions[0] : null;
    const timestamp = latest?.revid === page.lastrevid && typeof latest.timestamp === "string" && !Number.isNaN(Date.parse(latest.timestamp)) ? latest.timestamp : null;
    return {
      missing: false,
      pageId: page.pageid,
      ns: page.ns,
      title: page.title,
      lastRevisionId: page.lastrevid,
      lastRevisionTimestamp: timestamp,
      wikibaseItem: QID_PATTERN.test(props.wikibase_item || "") ? props.wikibase_item : null,
      disambiguation: Object.prototype.hasOwnProperty.call(props, "disambiguation"),
      redirected: Array.isArray(query.redirects) && query.redirects.length > 0,
      normalized: Array.isArray(query.normalized) && query.normalized.length > 0,
    };
  }

  function pageParams(extra) {
    return new URLSearchParams({ action: "query", prop: "info|pageprops|revisions", ppprop: "wikibase_item|disambiguation", rvprop: "ids|timestamp", redirects: "1", format: "json", formatversion: "2", maxlag: String(settings.maxlag), ...extra });
  }

  async function wikipediaPage(title) {
    if (typeof title !== "string" || !title.trim() || title.length > 255) throw new BiographySourceError("Invalid article title", { code: "INVALID_ARTICLE_TITLE", provider: "wikipedia" });
    return normalizePage(await getJson("wikipedia", `${WIKIPEDIA_API}?${pageParams({ titles: title })}`), { requestedTitle: title });
  }

  async function wikipediaPageById(pageId) {
    positiveInteger(pageId, "pageId", { min: 1 });
    return normalizePage(await getJson("wikipedia", `${WIKIPEDIA_API}?${pageParams({ pageids: String(pageId) })}`));
  }

  // The lead section HTML of one exact revision. The response must echo the
  // requested revision, so the text always belongs to the stored revision.
  // Its page properties (wikibase_item, disambiguation) describe the page's
  // current linkage, rechecked as evidence; they are not a historical
  // guarantee about that revision.
  async function wikipediaLead(revisionId) {
    positiveInteger(revisionId, "revisionId", { min: 1 });
    const params = new URLSearchParams({
      action: "parse", oldid: String(revisionId), prop: "text|properties|revid", section: "0",
      disableeditsection: "1", disablelimitreport: "1", disabletoc: "1", format: "json", formatversion: "2", maxlag: String(settings.maxlag),
    });
    const data = await getJson("wikipedia", `${WIKIPEDIA_API}?${params}`);
    const parse = data?.parse;
    if (data?.error) throw new BiographySourceError("Wikipedia could not parse the revision", { code: "BIOGRAPHY_REVISION_UNAVAILABLE", provider: "wikipedia" });
    if (!parse || !Number.isInteger(parse.revid) || !Number.isInteger(parse.pageid) || typeof parse.text !== "string") throw invalid("wikipedia", "Wikipedia returned an invalid parse");
    let props = parse.properties || {};
    if (Array.isArray(props)) props = Object.fromEntries(props.map((entry) => [entry?.name, entry?.["*"] ?? entry?.value ?? ""]));
    return {
      revisionId: parse.revid,
      pageId: parse.pageid,
      title: typeof parse.title === "string" ? parse.title : null,
      html: parse.text,
      wikibaseItem: QID_PATTERN.test(props.wikibase_item || "") ? props.wikibase_item : null,
      disambiguation: Object.prototype.hasOwnProperty.call(props, "disambiguation"),
    };
  }

  return { musicBrainzArtist, wikidataEntity, wikipediaPage, wikipediaPageById, wikipediaLead, stats };
}

module.exports = { BiographySourceError, DEFAULTS, QID_PATTERN, createBiographySources };
