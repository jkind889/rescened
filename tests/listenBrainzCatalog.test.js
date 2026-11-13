const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Ajv = require("ajv");

const schema = require("../data/catalog-import/catalog-import.schema.json");
const {
  CatalogFetchError,
  artifactPathsFor,
  buildCover,
  collectCandidates,
  createMusicBrainzClient,
  createRateGate,
  fetchCatalogDataset,
  mapArtistCredits,
  mapReleaseType,
  parsePartialDate,
  parseRetryAfter,
  requestJson,
  selectCatalogAlbums,
  writeCatalogArtifacts,
} = require("../lib/catalogImport/listenBrainz");
const { parseArguments } = require("../scripts/fetchListenBrainzCatalog");

const IDS = {
  releaseGroups: [
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "33333333-3333-3333-3333-333333333333",
    "44444444-4444-4444-4444-444444444444",
    "55555555-5555-5555-5555-555555555555",
  ],
  releases: [
    "aaaaaaaa-1111-1111-1111-111111111111",
    "aaaaaaaa-2222-2222-2222-222222222222",
    "aaaaaaaa-3333-3333-3333-333333333333",
  ],
  artists: [
    "bbbbbbbb-1111-1111-1111-111111111111",
    "bbbbbbbb-2222-2222-2222-222222222222",
    "bbbbbbbb-3333-3333-3333-333333333333",
  ],
};

function makeRangeResult(range, quota, entries, options = {}) {
  return {
    config: { range, quota, candidateLimit: options.candidateLimit || Math.max(entries.length, quota, 1) },
    fetchedAt: options.fetchedAt || "2026-08-14T12:00:00.000Z",
    payload: {
      range,
      from_ts: options.fromTs ?? 1_704_067_200,
      to_ts: options.toTs ?? 1_735_689_600,
      release_groups: entries,
    },
  };
}

function rankingEntry(releaseGroupMbid, listenCount, options = {}) {
  return {
    release_group_mbid: releaseGroupMbid,
    release_group_name: options.title || `ListenBrainz ${releaseGroupMbid.slice(0, 4)}`,
    artist_name: options.artistName || "ListenBrainz Artist",
    listen_count: listenCount,
    ...(options.releaseMbid ? { caa_release_mbid: options.releaseMbid } : {}),
    ...(options.imageId ? { caa_id: options.imageId } : {}),
  };
}

function musicBrainzReleaseGroup(releaseGroupMbid, artistMbid, options = {}) {
  return {
    id: releaseGroupMbid,
    title: options.title || `Album ${releaseGroupMbid.slice(0, 4)}`,
    "first-release-date": options.releaseDate ?? "2024-02-29",
    "primary-type": options.primaryType || "Album",
    "secondary-types": options.secondaryTypes || [],
    "artist-credit": options.artistCredits || [
      {
        name: options.artistName || `Artist ${artistMbid.slice(-4)}`,
        joinphrase: "",
        artist: { id: artistMbid, name: options.artistName || `Artist ${artistMbid.slice(-4)}` },
      },
    ],
  };
}

test("release type mapping obeys secondary precedence before primary type", () => {
  assert.equal(mapReleaseType("EP", ["Compilation", "Remix", "Soundtrack"]), "soundtrack");
  assert.equal(mapReleaseType("Single", ["Compilation", "Live", "Mixtape/Street"]), "mixtape");
  assert.equal(mapReleaseType("Album", ["Compilation", "Remix"]), "remix");
  assert.equal(mapReleaseType("EP", []), "ep");
  assert.equal(mapReleaseType("Broadcast", []), "other");
});

test("strict partial dates preserve precision, including proleptic year zero", () => {
  assert.deepEqual(parsePartialDate("1997"), {
    releaseDate: "1997",
    releaseDatePrecision: "year",
    releaseYear: 1997,
  });
  assert.deepEqual(parsePartialDate("2000-02"), {
    releaseDate: "2000-02",
    releaseDatePrecision: "month",
    releaseYear: 2000,
  });
  assert.deepEqual(parsePartialDate("0000-02-29"), {
    releaseDate: "0000-02-29",
    releaseDatePrecision: "day",
    releaseYear: 0,
  });
  assert.deepEqual(parsePartialDate("1900-02-29"), {
    releaseDate: "",
    releaseDatePrecision: "",
    releaseYear: null,
  });
  assert.deepEqual(parsePartialDate("2024-13"), {
    releaseDate: "",
    releaseDatePrecision: "",
    releaseYear: null,
  });
});

test("artist credits use MusicBrainz credited names and join phrases", () => {
  const mapped = mapArtistCredits([
    {
      name: "Alpha Alias",
      joinphrase: " feat. ",
      artist: { id: IDS.artists[0], name: "Alpha" },
    },
    {
      name: "Beta",
      joinphrase: " & ",
      artist: { id: IDS.artists[1], name: "Beta" },
    },
    {
      name: "Gamma",
      joinphrase: "",
      artist: { id: IDS.artists[2], name: "Gamma" },
    },
  ]);

  assert.equal(mapped.artistDisplayName, "Alpha Alias feat. Beta & Gamma");
  assert.deepEqual(mapped.artistCredits.map((credit) => credit.artistName), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(mapped.artistCredits.map(({ name, joinPhrase }) => ({ name, joinPhrase })), [
    { name: "Alpha Alias", joinPhrase: " feat. " },
    { name: "Beta", joinPhrase: " & " },
    { name: "Gamma", joinPhrase: "" },
  ]);
});

test("CAA cover mapping requires a release MBID and safe positive image ID", () => {
  assert.deepEqual(buildCover(IDS.releases[0], 43_287_476_628), {
    releaseMbid: IDS.releases[0],
    imageId: 43_287_476_628,
    url500: `https://coverartarchive.org/release/${IDS.releases[0]}/front-500`,
  });
  assert.equal(buildCover("not-an-mbid", 123), null);
  assert.equal(buildCover(IDS.releases[0], 0), null);
});

test("ListenBrainz candidates deduplicate MBIDs while preserving every ranking signal", () => {
  const repeated = IDS.releaseGroups[0];
  const collected = collectCandidates([
    makeRangeResult("all_time", 1, [
      rankingEntry(repeated, 100, { releaseMbid: IDS.releases[0], imageId: 1001 }),
      rankingEntry(repeated, 90, { releaseMbid: IDS.releases[1], imageId: 1002 }),
    ]),
    makeRangeResult("year", 1, [rankingEntry(repeated, 40)]),
    makeRangeResult("month", 1, [rankingEntry(IDS.releaseGroups[1], 20)]),
  ]);

  assert.equal(collected.candidates.size, 2);
  assert.deepEqual(collected.rangeOrders.get("all_time"), [repeated]);
  assert.deepEqual(collected.candidates.get(repeated).selectionSignals, [
    { range: "all_time", rank: 1, listenCount: 100 },
    { range: "all_time", rank: 2, listenCount: 90 },
    { range: "year", rank: 1, listenCount: 40 },
  ]);
  assert.equal(collected.candidates.get(repeated).coverCandidates.length, 2);
  assert.equal(collected.stats.duplicateRows, 2);
});

test("selection fills each quota with lower-ranked candidates after artist-cap and duplicate skips", async () => {
  const configs = [
    { range: "all_time", quota: 1, candidateLimit: 3 },
    { range: "year", quota: 1, candidateLimit: 3 },
    { range: "month", quota: 1, candidateLimit: 3 },
  ];
  const collected = collectCandidates([
    makeRangeResult("all_time", 1, [rankingEntry(IDS.releaseGroups[0], 100)], { candidateLimit: 3 }),
    makeRangeResult("year", 1, [
      rankingEntry(IDS.releaseGroups[0], 90),
      rankingEntry(IDS.releaseGroups[1], 80),
      rankingEntry(IDS.releaseGroups[2], 70),
    ], { candidateLimit: 3 }),
    makeRangeResult("month", 1, [
      rankingEntry(IDS.releaseGroups[0], 60),
      rankingEntry(IDS.releaseGroups[3], 50),
    ], { candidateLimit: 3 }),
  ]);
  const artistsByReleaseGroup = new Map([
    [IDS.releaseGroups[0], IDS.artists[0]],
    [IDS.releaseGroups[1], IDS.artists[0]],
    [IDS.releaseGroups[2], IDS.artists[1]],
    [IDS.releaseGroups[3], IDS.artists[2]],
  ]);
  const hydratedMbids = [];
  const result = await selectCatalogAlbums({
    collected,
    rangeConfigs: configs,
    maxPerPrimaryArtist: 1,
    hydrateReleaseGroup: async (releaseGroupMbid) => {
      hydratedMbids.push(releaseGroupMbid);
      return {
        data: musicBrainzReleaseGroup(releaseGroupMbid, artistsByReleaseGroup.get(releaseGroupMbid)),
        fetchedAt: "2026-08-14T12:00:01.000Z",
      };
    },
  });

  assert.deepEqual(result.selectedByRange, { all_time: 1, year: 1, month: 1 });
  assert.deepEqual(result.albums.map((album) => album.releaseGroupMbid), [
    IDS.releaseGroups[0],
    IDS.releaseGroups[2],
    IDS.releaseGroups[3],
  ]);
  assert.deepEqual(hydratedMbids, [
    IDS.releaseGroups[0],
    IDS.releaseGroups[1],
    IDS.releaseGroups[2],
    IDS.releaseGroups[3],
  ]);
  assert.equal(result.rejections.filter((entry) => entry.code === "primary_artist_cap").length, 1);
});

test("selection rejects a contract-invalid mapped row before quota and backfills from a lower rank", async () => {
  const configs = [{ range: "all_time", quota: 1, candidateLimit: 2 }];
  const collected = collectCandidates([
    makeRangeResult("all_time", 1, [
      rankingEntry(IDS.releaseGroups[0], 100),
      rankingEntry(IDS.releaseGroups[1], 90),
    ], { candidateLimit: 2 }),
  ]);
  const hydrated = [];
  const result = await selectCatalogAlbums({
    collected,
    rangeConfigs: configs,
    hydrateReleaseGroup: async (releaseGroupMbid) => {
      hydrated.push(releaseGroupMbid);
      return {
        data: musicBrainzReleaseGroup(releaseGroupMbid, IDS.artists[0]),
        fetchedAt: releaseGroupMbid === IDS.releaseGroups[0]
          ? "2026-08-14"
          : "2026-08-14T12:00:01.000Z",
      };
    },
  });

  assert.deepEqual(hydrated, [IDS.releaseGroups[0], IDS.releaseGroups[1]]);
  assert.deepEqual(result.albums.map((album) => album.releaseGroupMbid), [IDS.releaseGroups[1]]);
  assert.equal(result.selectedByRange.all_time, 1);
  assert.ok(result.rejections.some((entry) => (
    entry.releaseGroupMbid === IDS.releaseGroups[0]
    && entry.code === "invalid_mapped_album"
  )));
});

test("rate gate keeps every MusicBrainz request start at least 1.1 seconds apart", async () => {
  let now = 10_000;
  const waits = [];
  const gate = createRateGate({
    intervalMs: 1_100,
    nowMs: () => now,
    sleepFn: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });

  await Promise.all([gate(), gate(), gate()]);
  assert.deepEqual(waits, [1_100, 1_100]);
});

test("JSON requester honors Retry-After beyond the backoff cap and bounds retry attempts", async () => {
  let requests = 0;
  const waits = [];
  const result = await requestJson("https://example.test/data", {
    fetchFn: async () => {
      requests += 1;
      if (requests === 1) {
        return new Response("busy", { status: 503, headers: { "Retry-After": "120" } });
      }
      return Response.json({ ok: true });
    },
    retries: 3,
    sleepFn: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(result.data, { ok: true });
  assert.equal(requests, 2);
  assert.deepEqual(waits, [120_000]);
  assert.equal(parseRetryAfter("120", 0, 30_000), 120_000);

  let failedRequests = 0;
  await assert.rejects(
    () => requestJson("https://example.test/unavailable", {
      fetchFn: async () => {
        failedRequests += 1;
        return new Response("busy", { status: 503 });
      },
      retries: 3,
      sleepFn: async () => {},
    }),
    (error) => error instanceof CatalogFetchError && error.status === 503,
  );
  assert.equal(failedRequests, 4);
});

test("MusicBrainz client caches successful hydration for resumable runs", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-mb-cache-"));
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  let requests = 0;
  let now = Date.parse("2026-08-14T12:00:00.000Z");
  const releaseGroup = musicBrainzReleaseGroup(IDS.releaseGroups[0], IDS.artists[0]);
  const client = createMusicBrainzClient({
    cacheDir: temporaryDirectory,
    fetchFn: async (url, options) => {
      requests += 1;
      assert.match(url, /inc=artist-credits/);
      assert.match(options.headers["User-Agent"], /^RescenedCatalogImporter\//);
      return Response.json(releaseGroup);
    },
    clock: () => new Date(now),
    nowMs: () => now,
    sleepFn: async (milliseconds) => { now += milliseconds; },
  });

  const first = await client.hydrateReleaseGroup(IDS.releaseGroups[0]);
  const second = await client.hydrateReleaseGroup(IDS.releaseGroups[0]);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(requests, 1);
  assert.deepEqual(client.stats, { cacheHits: 1, cacheMisses: 1, networkRequests: 1 });
  assert.deepEqual(second.data, releaseGroup);
});

test("MusicBrainz client ignores a cache entry whose fetchedAt is not contract-compatible ISO", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-mb-invalid-cache-"));
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const releaseGroup = musicBrainzReleaseGroup(IDS.releaseGroups[0], IDS.artists[0]);
  const cachePath = path.join(temporaryDirectory, `${IDS.releaseGroups[0]}.json`);
  await fs.writeFile(cachePath, JSON.stringify({ fetchedAt: "2026-08-14", data: releaseGroup }));
  let requests = 0;
  const fetchedAt = "2026-08-14T12:00:00.000Z";
  const client = createMusicBrainzClient({
    cacheDir: temporaryDirectory,
    fetchFn: async () => {
      requests += 1;
      return Response.json(releaseGroup);
    },
    clock: () => new Date(fetchedAt),
    sleepFn: async () => {},
  });

  const result = await client.hydrateReleaseGroup(IDS.releaseGroups[0]);
  assert.equal(result.cacheHit, false);
  assert.equal(result.fetchedAt, fetchedAt);
  assert.equal(requests, 1);
  assert.deepEqual(client.stats, { cacheHits: 0, cacheMisses: 1, networkRequests: 1 });
  assert.equal(JSON.parse(await fs.readFile(cachePath, "utf8")).fetchedAt, fetchedAt);
});

test("small end-to-end fetch produces a strict v1 dataset and exact quotas", async () => {
  const configs = [
    { range: "all_time", quota: 1, candidateLimit: 2 },
    { range: "year", quota: 1, candidateLimit: 2 },
    { range: "month", quota: 1, candidateLimit: 2 },
  ];
  const releaseGroupsByRange = {
    all_time: [rankingEntry(IDS.releaseGroups[0], 300, { releaseMbid: IDS.releases[0], imageId: 1001 })],
    year: [rankingEntry(IDS.releaseGroups[1], 200)],
    month: [rankingEntry(IDS.releaseGroups[2], 100)],
  };
  const artistByReleaseGroup = new Map([
    [IDS.releaseGroups[0], IDS.artists[0]],
    [IDS.releaseGroups[1], IDS.artists[1]],
    [IDS.releaseGroups[2], IDS.artists[2]],
  ]);
  const fixedTime = "2026-08-14T12:00:00.000Z";
  const { dataset, report } = await fetchCatalogDataset({
    rangeConfigs: configs,
    datasetId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    clock: () => new Date(fixedTime),
    listenBrainzFetchFn: async (url) => {
      const range = new URL(url).searchParams.get("range");
      return Response.json({
        payload: {
          range,
          from_ts: 1_704_067_200,
          to_ts: 1_735_689_600,
          release_groups: releaseGroupsByRange[range],
        },
      });
    },
    hydrateReleaseGroup: async (releaseGroupMbid) => ({
      data: musicBrainzReleaseGroup(releaseGroupMbid, artistByReleaseGroup.get(releaseGroupMbid)),
      fetchedAt: fixedTime,
    }),
  });

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(dataset), true, JSON.stringify(validate.errors));
  assert.equal(dataset.albums.length, 3);
  assert.deepEqual(dataset.albums.map((album) => album.selectedRange), ["all_time", "year", "month"]);
  assert.equal(dataset.selection.targetAlbumCount, 3);
  assert.equal(dataset.selection.maxPerPrimaryArtist, 5);
  assert.equal(dataset.albums[0].cover.url500, `https://coverartarchive.org/release/${IDS.releases[0]}/front-500`);
  assert.equal(report.status, "complete");
});

test("artifact writer publishes a matching checksum and fetch report", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-catalog-artifacts-"));
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "catalog.json");
  const dataset = { schemaVersion: "1.0.0", albums: [{ title: "Test" }] };
  const report = { status: "complete" };
  const artifacts = await writeCatalogArtifacts(outputPath, dataset, report);
  const datasetContents = await fs.readFile(outputPath, "utf8");
  const expectedHash = crypto.createHash("sha256").update(datasetContents).digest("hex");

  assert.equal(artifacts.checksum, expectedHash);
  assert.equal(
    await fs.readFile(artifactPathsFor(outputPath).checksumPath, "utf8"),
    `${expectedHash}  catalog.json\n`,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(artifacts.reportPath, "utf8")), report);
  assert.equal((await fs.readdir(temporaryDirectory)).some((name) => name.endsWith(".tmp")), false);
});

test("artifact writer rejects non-file destinations before publishing any sidecar", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-catalog-preflight-"));
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "catalog.json");
  await fs.mkdir(outputPath);

  await assert.rejects(
    writeCatalogArtifacts(outputPath, { albums: [] }, { status: "complete" }),
    (error) => error instanceof CatalogFetchError && error.code === "artifact_destination_not_file",
  );
  assert.deepEqual(await fs.readdir(temporaryDirectory), ["catalog.json"]);
});

test("artifact writer restores the prior bundle when dataset-last publication fails", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-catalog-rollback-"));
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const outputPath = path.join(temporaryDirectory, "catalog.json");
  const paths = artifactPathsFor(outputPath);
  const prior = {
    [paths.outputPath]: "prior dataset\n",
    [paths.checksumPath]: "prior checksum\n",
    [paths.reportPath]: "prior report\n",
  };
  await Promise.all(Object.entries(prior).map(([destination, contents]) => fs.writeFile(destination, contents)));

  const attemptedNewDestinations = [];
  const failingFileSystem = Object.create(fs);
  failingFileSystem.rename = async (source, destination) => {
    if (source.endsWith(".tmp")) attemptedNewDestinations.push(destination);
    if (source.endsWith(".tmp") && destination === paths.outputPath) {
      const error = new Error("forced dataset publication failure");
      error.code = "EIO";
      throw error;
    }
    return fs.rename(source, destination);
  };

  await assert.rejects(
    writeCatalogArtifacts(
      outputPath,
      { albums: [{ title: "replacement" }] },
      { status: "complete" },
      { fileSystem: failingFileSystem },
    ),
    (error) => error.code === "EIO",
  );
  assert.deepEqual(attemptedNewDestinations, [paths.reportPath, paths.checksumPath, paths.outputPath]);
  for (const [destination, contents] of Object.entries(prior)) {
    assert.equal(await fs.readFile(destination, "utf8"), contents);
  }
  const leftovers = (await fs.readdir(temporaryDirectory)).filter((name) => name.endsWith(".tmp") || name.endsWith(".bak"));
  assert.deepEqual(leftovers, []);
});

test("fetch CLI requires one output path and rejects unknown arguments", () => {
  assert.deepEqual(parseArguments(["--output", "data/seed.json"]), {
    outputPath: path.resolve("data/seed.json"),
  });
  assert.throws(() => parseArguments([]), /Usage/);
  assert.throws(() => parseArguments(["--input", "seed.json"]), /Unknown argument/);
  assert.throws(
    () => parseArguments(["--output", "one.json", "--output", "two.json"]),
    /only be provided once/,
  );
});
