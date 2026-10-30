const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Listen = require("../models/Listen");
const Review = require("../models/Reviews");
const { BOM, csvCell, toCsv } = require("../lib/dataExport/csv");
const { SCHEMA_VERSION, FIELDS, serializeExport } = require("../lib/dataExport/serializers");
const { BATCH_SIZE, MAX_EXPORT_ROWS, collectExport } = require("../lib/dataExport/collect");

const EXPORTED_AT = new Date("2026-10-30T12:00:00.000Z");
const ALBUM = { _id: new mongoose.Types.ObjectId(), albumId: "22222222-2222-4222-8222-222222222222", title: "Album, \"Live\"", artistDisplayName: "=Artist" };
const OTHER_ALBUM = { _id: new mongoose.Types.ObjectId(), albumId: "33333333-3333-4333-8333-333333333333", title: "Other", artistDisplayName: "Band" };
const INTERNAL = ["_id", "albumCatalogId", "userId", "interactionRevision", "creationKey", "followedReviewFanoutAt", "albumOrder", "key", "boardKey", "listenCount", "latestListenedOn"];

function review(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), reviewId: "11111111-1111-4111-8111-111111111111", userId: "owner", albumCatalogId: ALBUM._id,
    rating: 4.5, reviewText: "Great", date: new Date("2026-09-01T10:00:00.000Z"), editedAt: null,
    interactionRevision: 3, creationKey: "secret", followedReviewFanoutAt: new Date(), ...overrides,
  };
}

function listen(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), listenId: "44444444-4444-4444-8444-444444444444", userId: "owner", albumCatalogId: ALBUM._id,
    listenedOn: "2026-10-01", source: "manual", createdAt: new Date("2026-10-01T20:00:00.000Z"), interactionRevision: 1, ...overrides,
  };
}

function assertNoInternalKeys(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoInternalKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!INTERNAL.includes(key), `${path}.${key} is internal`);
    assertNoInternalKeys(child, `${path}.${key}`);
  }
}

function assertNoObjectIds(body, docs) {
  for (const doc of docs) assert.ok(!body.includes(String(doc._id)), `body exposes ${doc._id}`);
}

// A query chain that streams docs and records how it was built.
function streamed(docs, calls) {
  const chain = {
    sort(value) { calls.sort = value; return chain; },
    lean() { return chain; },
    cursor(options) {
      calls.batchSize = options.batchSize;
      return (async function* stream() { yield* docs; })();
    },
  };
  return chain;
}

function mockCatalog(t, albums) {
  const calls = [];
  t.mock.method(AlbumCatalog, "find", (filter, projection) => {
    calls.push({ filter, projection });
    const wanted = new Set(filter._id.$in.map(String));
    return { lean: async () => albums.filter((album) => wanted.has(String(album._id))) };
  });
  return calls;
}

test("CSV cells are always quoted, double embedded quotes, and keep numbers plain", () => {
  assert.equal(csvCell("plain"), "\"plain\"");
  assert.equal(csvCell("say \"hi\", ok"), "\"say \"\"hi\"\", ok\"");
  assert.equal(csvCell("line one\nline two"), "\"line one\nline two\"");
  assert.equal(csvCell(null), "\"\"");
  assert.equal(csvCell(undefined), "\"\"");
  assert.equal(csvCell(4.5), "\"4.5\"");
  assert.equal(csvCell(-1), "\"-1\"", "numbers are never formula-prefixed");
  assert.equal(csvCell(true), "\"true\"");
  assert.equal(csvCell(false), "\"false\"");
});

test("CSV text cells that a spreadsheet would run as a formula get a ' prefix", () => {
  for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(csvCell(`${start}SUM(A1)`), `"'${start}SUM(A1)"`, JSON.stringify(start));
  }
  assert.equal(csvCell(" =not-leading"), "\" =not-leading\"");
  assert.equal(csvCell("a=b"), "\"a=b\"");
});

test("CSV files start with a byte order mark and end every line with CRLF", () => {
  const body = toCsv(["a", "b"], [{ a: "x", b: 1 }, { a: "y" }]);
  assert.ok(body.startsWith(BOM));
  assert.equal(body, `${BOM}"a","b"\r\n"x","1"\r\n"y",""\r\n`);
});

test("review exports carry public IDs, ISO times, and editedAt only when edited", () => {
  const collected = { items: [
    { review: review(), album: ALBUM },
    { review: review({ reviewId: "55555555-5555-4555-8555-555555555555", editedAt: new Date("2026-10-02T08:30:00.000Z"), reviewText: "-meh" }), album: OTHER_ALBUM },
  ] };
  const json = JSON.parse(serializeExport("reviews", "json", collected, EXPORTED_AT).body);
  assert.equal(json.schemaVersion, SCHEMA_VERSION);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.dataset, "reviews");
  assert.equal(json.exportedAt, "2026-10-30T12:00:00.000Z");
  assert.ok(!("omitted" in json), "only listens report omitted rows");
  assert.deepEqual(json.items[0], {
    reviewId: "11111111-1111-4111-8111-111111111111", albumId: ALBUM.albumId, albumTitle: ALBUM.title, albumArtist: "=Artist",
    rating: 4.5, reviewText: "Great", reviewedAt: "2026-09-01T10:00:00.000Z", editedAt: null,
  });
  assert.equal(json.items[1].editedAt, "2026-10-02T08:30:00.000Z");
  assert.equal(json.items[1].reviewText, "-meh", "JSON keeps text exactly");
  assertNoInternalKeys(json);

  const csv = serializeExport("reviews", "csv", collected, EXPORTED_AT);
  assert.equal(csv.contentType, "text/csv; charset=utf-8");
  const lines = csv.body.slice(1).split("\r\n");
  assert.equal(lines[0], FIELDS.reviews.map((field) => `"${field}"`).join(","));
  assert.equal(lines[1], `"11111111-1111-4111-8111-111111111111","${ALBUM.albumId}","Album, ""Live""","'=Artist","4.5","Great","2026-09-01T10:00:00.000Z",""`);
  assert.ok(lines[2].includes("\"'-meh\""));
  assert.ok(lines[2].endsWith("\"2026-10-02T08:30:00.000Z\""));
  assertNoObjectIds(csv.body, [ALBUM, OTHER_ALBUM, ...collected.items.map((item) => item.review)]);
});

test("a review whose album is gone keeps its text with blank album fields", () => {
  const json = JSON.parse(serializeExport("reviews", "json", { items: [{ review: review(), album: null }] }, EXPORTED_AT).body);
  assert.deepEqual(
    { albumId: json.items[0].albumId, albumTitle: json.items[0].albumTitle, albumArtist: json.items[0].albumArtist, reviewText: json.items[0].reviewText },
    { albumId: null, albumTitle: "", albumArtist: "", reviewText: "Great" },
  );
});

test("listen exports keep listenedOn as a date and report omitted, including zero", () => {
  const none = JSON.parse(serializeExport("listens", "json", { items: [], omitted: 0 }, EXPORTED_AT).body);
  assert.deepEqual(none, { schemaVersion: 1, dataset: "listens", exportedAt: "2026-10-30T12:00:00.000Z", omitted: 0, items: [] });

  const some = JSON.parse(serializeExport("listens", "json", { items: [{ listen: listen({ source: "automatic" }), album: ALBUM }], omitted: 2 }, EXPORTED_AT).body);
  assert.equal(some.omitted, 2);
  assert.deepEqual(some.items, [{
    listenId: "44444444-4444-4444-8444-444444444444", albumId: ALBUM.albumId, albumTitle: ALBUM.title, albumArtist: "=Artist",
    listenedOn: "2026-10-01", source: "automatic", loggedAt: "2026-10-01T20:00:00.000Z",
  }]);
  assertNoInternalKeys(some);

  const csv = serializeExport("listens", "csv", { items: [{ listen: listen(), album: ALBUM }], omitted: 2 }, EXPORTED_AT).body;
  assert.equal(csv.slice(1).split("\r\n")[1], `"44444444-4444-4444-8444-444444444444","${ALBUM.albumId}","Album, ""Live""","'=Artist","2026-10-01","manual","2026-10-01T20:00:00.000Z"`);
});

const BOARDS = [
  {
    boardId: "66666666-6666-4666-8666-666666666666", userId: "owner", title: "Saved albums", description: "", isDefault: true,
    orderMode: "manual", displayStyle: "ranked", albums: [
      { ...ALBUM, userId: "owner", savedAt: new Date("2026-08-01T00:00:00.000Z"), explicitlySaved: true, listenCount: 2, latestListenedOn: "2026-10-01" },
      { ...OTHER_ALBUM, userId: "owner", savedAt: new Date("2026-07-01T00:00:00.000Z"), explicitlySaved: false, listenCount: 1, latestListenedOn: "2026-07-01" },
    ],
  },
  { boardId: "77777777-7777-4777-8777-777777777777", userId: "owner", title: "@Empty", description: "Nothing yet", isDefault: false, orderMode: "added", displayStyle: "grid", albums: [] },
];

test("board JSON nests albums in display order with 1-based positions", () => {
  const json = JSON.parse(serializeExport("boards", "json", { items: BOARDS }, EXPORTED_AT).body);
  assert.equal(json.schemaVersion, 1);
  assert.deepEqual(json.items[0], {
    boardId: "66666666-6666-4666-8666-666666666666", boardTitle: "Saved albums", boardDescription: "", isDefault: true, orderMode: "manual", displayStyle: "ranked",
    albums: [
      { position: 1, albumId: ALBUM.albumId, albumTitle: ALBUM.title, albumArtist: "=Artist", savedAt: "2026-08-01T00:00:00.000Z", explicitlySaved: true },
      { position: 2, albumId: OTHER_ALBUM.albumId, albumTitle: "Other", albumArtist: "Band", savedAt: "2026-07-01T00:00:00.000Z", explicitlySaved: false },
    ],
  });
  assert.deepEqual(json.items[1].albums, []);
  assertNoInternalKeys(json);
});

test("board CSV has one row per membership and one blank-album row for an empty board", () => {
  const body = serializeExport("boards", "csv", { items: BOARDS }, EXPORTED_AT).body;
  assertNoObjectIds(body, [ALBUM, OTHER_ALBUM]);
  const lines = body.slice(1).split("\r\n");
  assert.equal(lines.length, 5, "header, two memberships, the empty board, and the trailing CRLF");
  assert.equal(lines[1], `"66666666-6666-4666-8666-666666666666","Saved albums","","true","manual","ranked","1","${ALBUM.albumId}","Album, ""Live""","'=Artist","2026-08-01T00:00:00.000Z","true"`);
  assert.ok(lines[2].startsWith("\"66666666-6666-4666-8666-666666666666\"") && lines[2].includes("\"2\",\"33333333-"));
  assert.equal(lines[3], "\"77777777-7777-4777-8777-777777777777\",\"'@Empty\",\"Nothing yet\",\"false\",\"added\",\"grid\",\"\",\"\",\"\",\"\",\"\",\"\"");
  assert.equal(lines[4], "");
});

test("reviews are read in index order in batches, with one catalog read per batch", async (t) => {
  const docs = Array.from({ length: BATCH_SIZE + 1 }, (_, index) => review({ reviewId: `review-${index}`, albumCatalogId: index % 2 ? OTHER_ALBUM._id : ALBUM._id }));
  docs.push(review({ reviewId: "orphan", albumCatalogId: new mongoose.Types.ObjectId() }));
  const calls = {};
  t.mock.method(Review, "find", (filter, projection) => {
    calls.filter = filter;
    calls.projection = projection;
    return streamed(docs, calls);
  });
  const catalogCalls = mockCatalog(t, [ALBUM, OTHER_ALBUM]);

  const { items } = await collectExport("reviews", "owner");

  assert.deepEqual(calls.filter, { userId: "owner" });
  assert.deepEqual(calls.sort, { date: -1, _id: -1 });
  assert.equal(calls.batchSize, BATCH_SIZE);
  assert.ok(!calls.projection.includes("interactionRevision") && !calls.projection.includes("creationKey"));
  assert.equal(catalogCalls.length, 2);
  assert.equal(catalogCalls[0].projection, "albumId title artistDisplayName");
  assert.equal(items.length, BATCH_SIZE + 2);
  assert.equal(items[1].album.albumId, OTHER_ALBUM.albumId);
  assert.equal(items.at(-1).album, null, "an orphaned review stays in the export");
});

test("listens whose album is gone are counted in omitted, not exported", async (t) => {
  const calls = {};
  t.mock.method(Listen, "find", (filter) => {
    calls.filter = filter;
    return streamed([listen(), listen({ listenId: "gone", albumCatalogId: new mongoose.Types.ObjectId() })], calls);
  });
  mockCatalog(t, [ALBUM]);

  const result = await collectExport("listens", "owner");

  assert.deepEqual(calls.sort, { listenedOn: -1, createdAt: -1, _id: -1 });
  assert.equal(result.omitted, 1);
  assert.deepEqual(result.items.map((item) => item.listen.listenId), ["44444444-4444-4444-8444-444444444444"]);
});

test("a listen export with every album present reports omitted as zero", async (t) => {
  t.mock.method(Listen, "find", () => streamed([listen()], {}));
  mockCatalog(t, [ALBUM]);
  assert.equal((await collectExport("listens", "owner")).omitted, 0);
});

test("exports above the row cap fail with EXPORT_TOO_LARGE, and the cap itself passes", async (t) => {
  const many = (count) => Array.from({ length: count }, () => review());
  mockCatalog(t, [ALBUM]);
  const find = t.mock.method(Review, "find", () => streamed(many(MAX_EXPORT_ROWS), {}));
  assert.equal((await collectExport("reviews", "owner")).items.length, MAX_EXPORT_ROWS);

  find.mock.mockImplementation(() => streamed(many(MAX_EXPORT_ROWS + 1), {}));
  await assert.rejects(collectExport("reviews", "owner"), { status: 413, code: "EXPORT_TOO_LARGE" });
});

test("board exports use the board library's ordering and keep empty boards", async (t) => {
  const manualBoard = { _id: new mongoose.Types.ObjectId(), boardId: "66666666-6666-4666-8666-666666666666", userId: "owner", title: "Ranked", description: "", isDefault: false, orderMode: "manual", displayStyle: "ranked", albumOrder: [OTHER_ALBUM._id, ALBUM._id] };
  const emptyBoard = { _id: new mongoose.Types.ObjectId(), boardId: "77777777-7777-4777-8777-777777777777", userId: "owner", title: "Empty", description: "", isDefault: true };
  t.mock.method(Board, "find", (filter) => {
    assert.deepEqual(filter, { userId: "owner" });
    return { sort: async (sort) => { assert.deepEqual(sort, { isDefault: -1, updatedAt: -1 }); return [emptyBoard, manualBoard]; } };
  });
  const saves = [ALBUM, OTHER_ALBUM].map((album, index) => ({ boardId: manualBoard._id, userId: "owner", albumCatalogId: album, savedAt: new Date(Date.UTC(2026, 0, index + 1)) }));
  t.mock.method(BoardItem, "find", () => ({ populate() { return { sort: async () => saves }; } }));
  t.mock.method(BoardListen, "aggregate", async () => []);

  const { items } = await collectExport("boards", "owner");
  const json = JSON.parse(serializeExport("boards", "json", { items }, EXPORTED_AT).body);

  assert.deepEqual(json.items.map((board) => board.boardId), [emptyBoard.boardId, manualBoard.boardId]);
  assert.deepEqual(json.items[1].albums.map((album) => [album.position, album.albumId]), [[1, OTHER_ALBUM.albumId], [2, ALBUM.albumId]]);
  assert.deepEqual(json.items[0].albums, []);
  assertNoInternalKeys(json);
  assertNoObjectIds(JSON.stringify(json), [manualBoard, emptyBoard, ALBUM, OTHER_ALBUM]);
});
