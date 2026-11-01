const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const { MappingCase, Job, CatalogScan } = require("../models/Listening");
const { scheduleCatalogRediscoveryJobs, runWorkerOnce } = require("../lib/listening/worker");
const { normalize, mappingKey } = require("../lib/listening/common");

// Execute the real Mongoose queries/middleware against an in-memory collection boundary.
// This catches timestamps added by Mongoose, which model-method stubs would hide. Transaction
// behavior is separately covered in the Mongo integration suite; this harness does not emulate it.
function harness(t) {
  let now = new Date("2026-11-01T12:00:00.500Z");
  const albums = []; const cases = []; const jobs = []; const checkpoints = []; const reads = [];
  const value = (x) => x instanceof Date ? +x : x?._bsontype === "ObjectId" ? String(x) : x;
  const get = (row, key) => key.split(".").reduce((entry, part) => entry?.[part], row);
  const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((entry) => matches(row, entry));
    const actual = value(get(row, key));
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !expected._bsontype) {
      return Object.entries(expected).every(([operator, target]) => {
        if (operator === "$in") return target.some((item) => actual === value(item));
        if (operator === "$exists") return (actual !== undefined) === target;
        if (operator === "$lt") return actual < value(target);
        if (operator === "$lte") return actual <= value(target);
        if (operator === "$gt") return actual > value(target);
        if (operator === "$gte") return actual >= value(target);
        if (operator === "$ne") return actual !== value(target);
        throw new Error(`Unsupported test operator ${operator}`);
      });
    }
    return actual === value(expected);
  });
  const select = (rows, filter, options = {}) => {
    const selected = rows.filter((row) => matches(row, filter));
    if (options.sort) selected.sort((a, b) => {
      for (const [key, direction] of Object.entries(options.sort)) {
        const left = value(get(a, key)); const right = value(get(b, key));
        if (left !== right) return (left < right ? -1 : 1) * direction;
      }
      return 0;
    });
    return options.limit ? selected.slice(0, options.limit) : selected;
  };
  const set = (row, key, v) => {
    const parts = key.split("."); const field = parts.pop();
    const owner = parts.reduce((entry, part) => (entry[part] ||= {}), row); owner[field] = v;
  };
  const update = (row, change, insert) => {
    for (const [key, v] of Object.entries(change.$set || {})) set(row, key, v);
    for (const [key, v] of Object.entries(change.$inc || {})) set(row, key, (get(row, key) || 0) + v);
    if (insert) for (const [key, v] of Object.entries(change.$setOnInsert || {})) set(row, key, v);
  };
  const clone = (row) => {
    if (row instanceof Date) return new Date(row);
    if (row?._bsontype === "ObjectId") return new mongoose.Types.ObjectId(String(row));
    if (Array.isArray(row)) return row.map(clone);
    if (row && typeof row === "object") return Object.fromEntries(Object.entries(row).map(([key, v]) => [key, clone(v)]));
    return row;
  };
  const bind = (Model, rows) => {
    t.mock.method(Model.collection, "find", (filter, options) => {
      const selected = select(rows, filter, options);
      reads.push({ model: Model.modelName, limit: options.limit, count: selected.length });
      return { toArray: async () => selected.map((row) => ({ ...row })) };
    });
    t.mock.method(Model.collection, "findOne", async (filter, options) => { const row = select(rows, filter, options)[0]; return row ? { ...row } : null; });
    t.mock.method(Model.collection, "updateOne", async (filter, change, options = {}) => {
      let row = select(rows, filter)[0]; const inserted = !row && options.upsert;
      if (inserted) { row = { _id: new mongoose.Types.ObjectId(), ...filter }; rows.push(row); }
      if (!row) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      update(row, change, inserted);
      return { matchedCount: inserted ? 0 : 1, modifiedCount: inserted ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
    });
    t.mock.method(Model.collection, "findOneAndUpdate", async (filter, change, options = {}) => {
      const row = select(rows, filter, options)[0]; if (!row) return null;
      update(row, change, false); return clone(row);
    });
  };
  bind(AlbumCatalog, albums); bind(MappingCase, cases); bind(Job, jobs); bind(CatalogScan, checkpoints);
  t.mock.method(mongoose, "now", () => now);
  const env = { LASTFM_DISCOVERY_ENABLED: "true" };
  const state = {};
  const scan = (override = {}) => scheduleCatalogRediscoveryJobs({ env, state, clock: () => now, ...override });
  const addAlbum = (fields = {}) => {
    // Unique IDs within the same second are distinct publication observations.
    const id = new mongoose.Types.ObjectId(); const bytes = id.id;
    bytes.writeUInt32BE(Math.floor(now.getTime() / 1000), 0);
    const row = { _id: id, albumId: crypto.randomUUID(), title: "Album", artistDisplayName: "Artist", artistCredits: [], ...fields };
    albums.push(row); return row;
  };
  const addCase = (fields = {}) => {
    const album = fields.album || "Album"; const artist = fields.artist || "Artist";
    const row = { _id: new mongoose.Types.ObjectId(), caseId: crypto.randomUUID(), key: mappingKey(artist, album), artist, artistKey: normalize(artist), album, albumKey: normalize(album), status: "no_catalog_match", revision: 1, candidates: [], evidence: [], evidenceHash: "empty", ...fields };
    cases.push(row); return row;
  };
  const run = (discover, extra = {}) => runWorkerOnce({ env, provider: {}, clock: () => now, types: ["discovery"], discovery: { discover }, sessionFactory: async () => ({ withTransaction: async (fn) => fn(), endSession: async () => {} }), ...extra });
  return { albums, cases, jobs, checkpoints, reads, state, scan, run, addAlbum, addCase, now: () => now, advance: (ms) => { now = new Date(+now + ms); } };
}
const complete = (albumId) => ({ candidates: [{ albumId }], evidence: [], evidenceHash: albumId });

test("overlapping catalog scans leave completed job timestamps and terminal results untouched", async (t) => {
  const h = harness(t); const album = h.addAlbum(); h.addCase();
  assert.equal(await h.scan(), 1);
  await h.run(async () => complete(album.albumId));
  const completedAt = h.jobs[0].updatedAt;
  h.advance(60_000);
  assert.equal(await h.scan({ state: {} }), 0);
  assert.equal(h.jobs[0].status, "done");
  assert.deepEqual(h.jobs[0].updatedAt, completedAt);
  assert.equal(h.jobs.length, 1);
});

test("catalog failures retry hourly exactly three times despite continuous scans", async (t) => {
  const h = harness(t); h.addAlbum(); h.addCase(); await h.scan();
  const incomplete = async () => ({ incomplete: true, candidates: [], evidence: [], evidenceHash: "partial" });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const before = h.now();
    assert.equal((await h.run(incomplete)).error, "discovery_incomplete");
    const job = h.jobs[0];
    assert.equal(job.attempts, attempt);
    assert.equal(job.status, attempt === 4 ? "done" : "pending");
    assert.equal(+job.runAt, +before + 3_600_000);
    for (let minute = 0; minute < 60; minute += 1) {
      h.advance(60_000); await h.scan({ state: {} });
      if (minute < 59) assert.equal((await h.run(incomplete)).processed, false);
    }
  }
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].error, "discovery_incomplete");
});

test("a queued catalog job respects rejection before execution and revision changes during discovery", async (t) => {
  const h = harness(t); h.addAlbum(); const row = h.addCase(); await h.scan();
  row.status = "rejected"; row.revision += 1;
  let calls = 0;
  await h.run(async () => { calls += 1; return complete("new"); });
  assert.equal(calls, 0); assert.equal(row.status, "rejected");
  row.status = "pending"; h.advance(1_000); h.addAlbum(); await h.scan({ state: {} });
  const outcome = await h.run(async () => { row.status = "rejected"; row.revision += 1; return complete("new"); });
  assert.equal(outcome.error, "mapping_case_revision_changed");
  assert.equal(row.status, "rejected"); assert.deepEqual(row.candidates, []);
});

test("a publication during another discovery and same-second albums receive independent jobs", async (t) => {
  const h = harness(t); const first = h.addAlbum(); const row = h.addCase(); await h.scan();
  let second;
  await h.run(async () => { second = h.addAlbum(); return complete(first.albumId); });
  assert.equal(+first._id.getTimestamp(), +second._id.getTimestamp());
  assert.equal(await h.scan({ state: {} }), 1);
  h.advance(15_000); await h.run(async () => complete(second.albumId));
  assert.equal(row.candidates[0].albumId, second.albumId);
  assert.equal(h.jobs.length, 2); assert.ok(h.jobs.every((job) => job.status === "done"));
});

test("bounded pages and queue horizon eventually reach more than 25 matching cases", async (t) => {
  const h = harness(t); h.addAlbum();
  for (let i = 0; i < 60; i += 1) h.addCase({ album: `Album (${i + 1}th Anniversary Edition)` });
  assert.equal(await h.scan(), 21); // now through +5 minutes, inclusive
  assert.equal(h.jobs.length, 21);
  assert.equal(await h.scan(), 0);
  for (let pass = 0; pass < 20 && h.jobs.length < 60; pass += 1) { h.advance(360_000); await h.scan(); }
  assert.equal(h.jobs.length, 60);
  assert.equal(new Set(h.jobs.map((job) => job.payload.caseId)).size, 60);
  assert.ok(h.reads.every((read) => read.limit && read.count <= read.limit));
  assert.ok(h.reads.filter((read) => read.model === MappingCase.modelName).every((read) => read.limit <= 25));
});

test("daily bounded full sweep catches an old-ID album committed after the recent scan", async (t) => {
  const h = harness(t); h.addCase(); await h.scan();
  const old = mongoose.Types.ObjectId.createFromTime(Math.floor(+h.now() / 1000) - 30 * 86_400);
  h.addAlbum({ _id: old });
  assert.equal(await h.scan(), 1);
  assert.equal(h.jobs[0].payload.catalogAlbumId, String(old));
});

test("failed enqueue does not advance past its case and overlapping scanners create one pair", async (t) => {
  const h = harness(t); h.addAlbum(); const row = h.addCase();
  const original = Job.collection.updateOne;
  t.mock.method(Job.collection, "updateOne", async () => { throw new Error("temporary database failure"); });
  await assert.rejects(h.scan(), /temporary database failure/);
  assert.equal(h.state.recent.caseCursor, null);
  t.mock.method(Job.collection, "updateOne", original);
  await Promise.all([h.scan(), h.scan({ state: {} })]);
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].payload.caseId, row.caseId);
});

test("catalog scans filter artist, title, status and feature flag", async (t) => {
  const h = harness(t); h.addAlbum();
  const eligible = h.addCase(); h.addCase({ status: "approved" }); h.addCase({ status: "rejected" });
  h.addCase({ artist: "Someone else" }); h.addCase({ album: "Album (Live)" });
  assert.equal(await h.scan({ env: {} }), 0); assert.equal(h.reads.length, 0);
  assert.equal(await h.scan(), 1); assert.equal(h.jobs[0].payload.caseId, eligible.caseId);
});


test("nonmatching case backlogs are bounded and resume beyond the first 200 rows", async (t) => {
  const h = harness(t); h.addAlbum();
  for (let i = 0; i < 210; i += 1) h.addCase({ album: `Different ${i}` });
  const eligible = h.addCase();
  assert.equal(await h.scan(), 0);
  assert.equal(h.reads.filter((read) => read.model === MappingCase.modelName).reduce((sum, read) => sum + read.count, 0), 200);
  for (let pass = 0; pass < 4 && !h.jobs.length; pass += 1) await h.scan();
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].payload.caseId, eligible.caseId);
});

test("case revision conflicts retry the catalog observation instead of consuming it", async (t) => {
  const h = harness(t); const album = h.addAlbum(); const row = h.addCase({ evidenceHash: "" }); await h.scan();
  await h.run(async () => { row.revision += 1; return complete(album.albumId); });
  assert.equal(h.jobs[0].status, "pending");
  h.advance(3_600_000);
  await h.run(async () => complete(album.albumId));
  assert.equal(h.jobs[0].status, "done");
  assert.equal(row.status, "pending"); assert.equal(row.candidates[0].albumId, album.albumId);
});


test("outstanding catalog work stays capped when the worker is not consuming jobs", async (t) => {
  const h = harness(t); h.addAlbum();
  for (let i = 0; i < 150; i += 1) h.addCase();
  for (let pass = 0; pass < 20; pass += 1) { await h.scan(); h.advance(360_000); }
  assert.equal(h.jobs.length, 100);
  h.jobs[0].status = "done";
  for (let pass = 0; pass < 4; pass += 1) await h.scan();
  assert.equal(h.jobs.length, 101);
  assert.equal(h.jobs.filter((job) => job.status !== "done").length, 100);
});

test("production scan checkpoints survive restarts and serialize overlapping scanners", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 30; i += 1) h.addAlbum();
  await Promise.all([h.scan({ state: undefined }), h.scan({ state: undefined })]);
  assert.equal(h.checkpoints.length, 1);
  assert.equal(h.checkpoints[0].leaseToken, "");
  const cursor = String(h.checkpoints[0].state.recent.cursor);
  assert.equal(cursor, String(h.albums[9]._id));
  await h.scan({ state: undefined }); // full scan turn
  await h.scan({ state: undefined }); // recent scan resumes after restoring persisted state
  assert.equal(String(h.checkpoints[0].state.recent.cursor), String(h.albums[19]._id));
});

test("credited artists resume independently through bounded indexed case pages", async (t) => {
  const h = harness(t); h.addAlbum({ artistCredits: [{ name: "Second" }] });
  for (let i = 0; i < 205; i += 1) h.addCase({ album: `Unrelated ${i}` });
  const row = h.addCase({ artist: "Second" });
  for (let pass = 0; pass < 6 && !h.jobs.length; pass += 1) await h.scan();
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].payload.caseId, row.caseId);
});

test("a scanner that loses its lease stops enqueueing and cannot overwrite its successor checkpoint", async (t) => {
  const h = harness(t); h.addAlbum(); h.addCase(); h.addCase();
  const original = Job.collection.updateOne;
  t.mock.method(Job.collection, "updateOne", async (...args) => {
    const result = await original(...args);
    h.checkpoints[0].leaseToken = "successor";
    h.checkpoints[0].state = { marker: "successor-state" };
    return result;
  });
  await assert.rejects(h.scan({ state: undefined }), /catalog_scan_lease_lost/);
  assert.equal(h.jobs.length, 1);
  assert.deepEqual(h.checkpoints[0].state, { marker: "successor-state" });
  assert.equal(h.checkpoints[0].leaseToken, "successor");
});
