#!/usr/bin/env node
// MusicBrainz result-size experiment. Operator-only and explicit: without
// --live it prints the planned requests and exits without network access.
//
//   node benchmarks/musicbrainz/run.cjs            # plan only
//   node benchmarks/musicbrainz/run.cjs --live     # run the default sample
//   node benchmarks/musicbrainz/run.cjs --live --queries "air,bts" --limits 25,50,100 --artists <mbid>,<mbid>
//
// Requests are serial behind a 1.1 s rate gate with the application's
// identifying user agent and no retries. Reports go to .benchmarks/musicbrainz/.
// A small sample shows tradeoffs; it is not a statistical benchmark.

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_USER_AGENT,
  buildArtistDiscographyUrl,
  buildSearchUrl,
  creditsArtist,
  matchesDiscographyFilter,
  mapReleaseGroupToCandidate,
  rankedCandidates,
  validateSearchResponse,
} = require("../../lib/musicBrainzSearch");
const { createRateGate } = require("../../lib/catalogImport/listenBrainz");

const DEFAULT_QUERIES = ["radiohead", "ok computer", "taylor swift", "kid a", "bts", "air", "discovery", "tyler the creator"];
// MusicBrainz artist MBIDs present in the checked-in seed dataset.
const DEFAULT_ARTISTS = [
  { name: "Radiohead", mbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711" },
  { name: "Kanye West", mbid: "164f0d73-1234-4e2c-8743-d77bf2191051" },
  { name: "BTS", mbid: "0d79fe8e-ba27-4859-bb8c-2f255f346853" },
  { name: "Björk", mbid: "87c5dedd-371d-4a53-9f7f-80522fb7f3cb" },
  { name: "V", mbid: "83096042-3785-481e-8843-dee69f1aad12" },
];
const DEFAULT_LIMITS = [25, 50, 100];
const WINDOWS = [[0, 12], [12, 24], [24, 50], [50, 100]];
const MAX_REQUESTS = 80;

function parseArgs(argv) {
  const options = { live: false, queries: DEFAULT_QUERIES, limits: DEFAULT_LIMITS, artists: DEFAULT_ARTISTS, out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--live") options.live = true;
    else if (flag === "--queries") options.queries = value().split(",").map((query) => query.trim()).filter(Boolean);
    else if (flag === "--limits") options.limits = value().split(",").map(Number);
    else if (flag === "--artists") options.artists = value().split(",").map((mbid) => ({ name: mbid, mbid: mbid.trim() }));
    else if (flag === "--out") options.out = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  if (options.limits.some((limit) => !Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error("--limits must be integers 1-100");
  return options;
}

function plan(options) {
  const requests = [];
  for (const query of options.queries) {
    for (const limit of options.limits) requests.push({ kind: "search", query, limit, offset: 0, url: buildSearchUrl(query, undefined, { limit }) });
    requests.push({ kind: "search", query, limit: 50, offset: 50, url: buildSearchUrl(query, undefined, { limit: 50, offset: 50 }) });
  }
  for (const artist of options.artists) {
    for (const filter of ["album", "all"]) requests.push({ kind: "discography", artist: artist.name, mbid: artist.mbid, filter, url: buildArtistDiscographyUrl(artist.mbid, filter) });
  }
  if (requests.length > MAX_REQUESTS) throw new Error(`Refusing to plan more than ${MAX_REQUESTS} requests`);
  return requests;
}

function normalizedPair(candidate) {
  const text = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `${text(candidate.title)}|${text(candidate.artistDisplayName)}`;
}

// Pure summary of one search response, used by the tests with fixtures.
function summarizeSearch(data, query) {
  validateSearchResponse(data);
  const ranked = rankedCandidates(data, query);
  const ids = data["release-groups"].map((group) => group?.id);
  const duplicateIds = ids.length - new Set(ids).size;
  const unique = [];
  const seen = new Set();
  for (const row of ranked) if (!seen.has(row.candidate.externalId)) { seen.add(row.candidate.externalId); unique.push(row); }
  const pairs = unique.map((row) => normalizedPair(row.candidate));
  const nearDuplicates = pairs.length - new Set(pairs).size;
  const tiers = Object.fromEntries(WINDOWS.map(([from, to]) => {
    const slice = unique.slice(from, to);
    return [`${from + 1}-${to}`, { shown: slice.length, strong: slice.filter((row) => row.tier >= 2).length, matched: slice.filter((row) => row.tier >= 1).length }];
  }));
  return {
    providerCount: Number.isInteger(data.count) ? data.count : null,
    returned: data["release-groups"].length,
    validCandidates: unique.length,
    duplicateIds,
    nearDuplicates,
    tiers,
    top12: unique.slice(0, 12).map((row) => row.candidate.externalId),
    ids: unique.map((row) => row.candidate.externalId),
  };
}

function summarizeDiscography(data, filter, artistMbid) {
  validateSearchResponse(data);
  const groups = data["release-groups"];
  const kept = groups.filter((group) => creditsArtist(group, artistMbid) && matchesDiscographyFilter(group, filter) && mapReleaseGroupToCandidate(group));
  const count = Number(data.count ?? data["release-group-count"]);
  return {
    providerCount: Number.isInteger(count) ? count : null,
    returned: groups.length,
    kept: kept.length,
    filteredOut: groups.length - kept.length,
    pagesAt100: Number.isInteger(count) ? Math.ceil(count / 100) : null,
  };
}

function compare(results) {
  const byQuery = new Map();
  for (const result of results.filter((row) => row.kind === "search" && row.summary)) {
    if (!byQuery.has(result.query)) byQuery.set(result.query, {});
    byQuery.get(result.query)[`${result.limit}@${result.offset}`] = result.summary;
  }
  return [...byQuery].map(([query, runs]) => {
    const fifty = runs["50@0"];
    const hundred = runs["100@0"];
    const page2 = runs["50@50"];
    return {
      query,
      providerCount: fifty?.providerCount ?? hundred?.providerCount ?? null,
      top12ChangedBy100: fifty && hundred ? hundred.top12.filter((id) => !fifty.top12.includes(id)).length : null,
      page2OverlapWithPage1: fifty && page2 ? page2.ids.filter((id) => fifty.ids.includes(id)).length : null,
      strongBeyond50: hundred ? hundred.tiers["51-100"].strong : null,
      matchedBeyond50: hundred ? hundred.tiers["51-100"].matched : null,
    };
  });
}

async function run(options) {
  const requests = plan(options);
  if (!options.live) {
    console.log(`Plan only (${requests.length} requests, about ${Math.ceil(requests.length * 1.1)} s). Add --live to run.`);
    for (const request of requests) console.log(`${request.kind}\t${request.query || request.artist}\t${request.limit || request.filter}\t${request.offset ?? ""}`);
    return null;
  }
  const gate = createRateGate({ intervalMs: 1_100 });
  const results = [];
  for (const request of requests) {
    await gate();
    const started = Date.now();
    const row = { ...request };
    delete row.url;
    try {
      const response = await fetch(request.url, { headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      row.status = response.status;
      row.latencyMs = Date.now() - started;
      row.bytes = Buffer.byteLength(text);
      if (response.ok) {
        const data = JSON.parse(text);
        row.summary = request.kind === "search" ? summarizeSearch(data, request.query) : summarizeDiscography(data, request.filter, request.mbid);
      }
    } catch (error) {
      row.error = error.name === "TimeoutError" ? "timeout" : "network";
      row.latencyMs = Date.now() - started;
    }
    results.push(row);
    process.stdout.write(`${row.kind} ${row.query || row.artist} ${row.limit || row.filter}${row.offset ? `@${row.offset}` : ""}: ${row.status || row.error} ${row.latencyMs} ms ${row.bytes || 0} B\n`);
  }
  const report = { generatedAt: new Date().toISOString(), userAgent: DEFAULT_USER_AGENT, sampleNote: "Small public sample; not statistically representative.", results, comparison: compare(results) };
  const out = options.out || path.join(process.cwd(), ".benchmarks", "musicbrainz", `${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(`Report: ${out}`);
  return report;
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { DEFAULT_ARTISTS, DEFAULT_QUERIES, compare, parseArgs, plan, summarizeDiscography, summarizeSearch };
