const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ReviewObservation = require("../models/ReviewObservation");
const episodes = require("../lib/reviewObservations/episodes");
const { normalizeEffort } = require("../lib/reviewObservations/effort");
const { buildPacket, summarizeLabels } = require("../lib/reviewObservations/adjudication");
const { parseArgs } = require("../scripts/listeningMeasurement");
const clear = require("../scripts/clearReviewEpisodes");
const adjudicationScript = require("../scripts/reviewAdjudication");

const NOW = new Date("2026-11-20T12:00:00Z");
const uuid = () => crypto.randomUUID();

test("moderator identity is stored only as a stable pseudonymous hash", () => {
  const hash = episodes.moderatorHash("user_123");
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(hash, episodes.moderatorHash("user_123"));
  assert.notEqual(hash, episodes.moderatorHash("user_124"));
  assert.equal(hash.includes("user_123"), false);
});

test("episodes and recommendation runs are off unless REVIEW_EPISODES_ENABLED is true", async () => {
  assert.equal(episodes.episodesEnabled({}), false);
  assert.equal(episodes.episodesEnabled({ REVIEW_EPISODES_ENABLED: "TRUE" }), true);
  assert.equal(await episodes.captureMapping({ caseId: uuid(), action: "approve", command: {}, env: {} }), null);
  assert.equal(await episodes.captureBaseline({ kind: "albums", id: uuid(), action: "confirm", body: {}, env: {} }), null);
  assert.equal(await episodes.recordRecommendationRun({ kind: "albums", targetId: uuid(), targetRevision: 1, startedAt: NOW, result: {}, env: {} }), null);
  // Non-decision commands never capture evidence.
  assert.equal(await episodes.captureMapping({ caseId: uuid(), action: "refresh", command: {}, env: { REVIEW_EPISODES_ENABLED: "true" } }), null);
  assert.equal(await episodes.recordEpisode(null, { auditId: uuid() }), null);
});

test("an episode write that fails leaves a failure marker and never throws", async (t) => {
  const calls = [];
  t.mock.method(ReviewObservation.Episode, "updateOne", (filter, update) => {
    calls.push(update.$setOnInsert);
    if (calls.length === 1) return Promise.reject(Object.assign(new Error("boom"), { code: 13 }));
    return Promise.resolve({ upsertedCount: 1 });
  });
  const warn = t.mock.method(console, "warn", () => {});
  const capture = { evidenceVersion: 1, kind: "mapping", targetKind: "cases", targetId: uuid(), action: "approved", evidence: { capturedAt: NOW, targetRevision: 2, expectedRevision: 2, candidates: [], coverage: null, recommendationRunId: "", recommended: null, selected: null, selectedRank: null, evidenceHash: "a".repeat(64) } };
  const auditId = uuid();
  assert.equal(await episodes.recordEpisode(capture, { auditId, decidedRevision: 3, reviewer: "user_1", clock: () => NOW }), "failed");
  // The marker is written in the background, after the decision has its response.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].outcome, "failed");
  assert.equal(calls[1].failureReason, "write_failed");
  assert.equal(calls[1].auditId, auditId);
  assert.equal(calls[1].evidence, null);
  assert.ok(warn.mock.calls.some((call) => call.arguments[0].includes("write_failed")));
  assert.equal(JSON.stringify(warn.mock.calls).includes("user_1"), false, "logs never carry the moderator ID");

  // Even when the marker fails too, the caller sees a value, not an exception.
  t.mock.method(ReviewObservation.Episode, "updateOne", () => Promise.reject(new Error("down")));
  assert.equal(await episodes.recordEpisode(capture, { auditId: uuid(), decidedRevision: 3, reviewer: "user_1" }), "failed");
  // A concurrent duplicate is already recorded.
  t.mock.method(ReviewObservation.Episode, "updateOne", () => Promise.reject(Object.assign(new Error("dup"), { code: 11000 })));
  assert.equal(await episodes.recordEpisode(capture, { auditId: uuid(), decidedRevision: 3, reviewer: "user_1" }), "duplicate");
});

test("capture failures are recorded with their own reason", async (t) => {
  const written = [];
  t.mock.method(ReviewObservation.Episode, "updateOne", (filter, update) => { written.push(update.$setOnInsert); return Promise.resolve({}); });
  t.mock.method(console, "warn", () => {});
  const capture = { evidenceVersion: 1, kind: "baseline", targetKind: "albums", targetId: uuid(), action: "defer", failure: "capture_failed" };
  assert.equal(await episodes.recordEpisode(capture, { auditId: uuid(), decidedRevision: 1, reviewer: "user_1" }), "failed");
  assert.equal(written[0].outcome, "failed");
  assert.equal(written[0].failureReason, "capture_failed");
  assert.equal("failure" in written[0], false);
});

test("effort timings are validated before anything is stored", () => {
  const body = (fields = {}) => ({
    effortId: uuid(), kind: "mapping", targetKind: "cases", targetId: uuid(), targetRevision: 3, outcome: "decided",
    intervals: [{ startedAt: "2026-11-20T11:00:00.000Z", endedAt: "2026-11-20T11:05:00.000Z" }, { startedAt: "2026-11-20T11:10:00.000Z", endedAt: "2026-11-20T11:12:00.000Z" }],
    ...fields,
  });
  assert.equal(normalizeEffort(body(), NOW).activeMs, 7 * 60_000);
  const invalid = [
    body({ extra: true }),
    body({ kind: "mapping", targetKind: "albums" }),
    body({ kind: "baseline", targetKind: "cases" }),
    body({ targetId: "not-a-uuid" }),
    body({ outcome: "done" }),
    body({ intervals: [] }),
    body({ intervals: [{ startedAt: "2026-11-20T11:05:00.000Z", endedAt: "2026-11-20T11:00:00.000Z" }] }),
    body({ intervals: [{ startedAt: "2026-11-20T11:00:00.000Z", endedAt: "2026-11-20T11:05:00.000Z" }, { startedAt: "2026-11-20T11:04:00.000Z", endedAt: "2026-11-20T11:06:00.000Z" }] }),
    body({ intervals: [{ startedAt: "2026-11-20T06:00:00.000Z", endedAt: "2026-11-20T11:00:00.000Z" }] }),
    body({ intervals: [{ startedAt: "2026-11-20T12:30:00.000Z", endedAt: "2026-11-20T12:40:00.000Z" }] }),
    body({ intervals: [{ startedAt: "2026-02-31T11:00:00.000Z", endedAt: "2026-02-31T11:05:00.000Z" }] }),
    body({ intervals: [{ startedAt: "2026-11-20T11:00:00.000Z", endedAt: "2026-11-20T11:05:00.000Z", note: "x" }] }),
  ];
  for (const value of invalid) assert.throws(() => normalizeEffort(value, NOW), (error) => error.status === 400);
});

function packetWorld() {
  const albums = [uuid(), uuid(), uuid()];
  const releases = [uuid(), uuid()];
  const decided = new Date("2026-11-05T00:00:00Z");
  const evidence = (candidates, selected) => ({ candidates: candidates.map((id) => ({ id })), coverage: { queryCapReached: false }, selected: selected ? { id: selected } : null, recommended: null });
  const caseId = uuid();
  const rows = [
    { kind: "mapping", targetKind: "cases", targetId: caseId, action: "approved", outcome: "recorded", decidedAt: decided, evidence: evidence(albums.slice(0, 2), albums[1]) },
    // A selection found by catalog search stays an option.
    { kind: "mapping", targetKind: "cases", targetId: caseId, action: "approved", outcome: "recorded", decidedAt: decided, evidence: evidence([albums[0]], albums[2]) },
    { kind: "mapping", targetKind: "cases", targetId: caseId, action: "no_catalog_match", outcome: "recorded", decidedAt: decided, evidence: evidence(albums.slice(0, 2), null) },
    { kind: "baseline", targetKind: "albums", targetId: albums[0], action: "confirm", outcome: "recorded", decidedAt: decided, evidence: evidence(releases, releases[0]) },
    // Not adjudicable: defer, a failed episode and one decided within the last seven days.
    { kind: "baseline", targetKind: "albums", targetId: albums[0], action: "defer", outcome: "recorded", decidedAt: decided, evidence: evidence(releases, null) },
    { kind: "mapping", targetKind: "cases", targetId: caseId, action: "approved", outcome: "failed", decidedAt: decided, evidence: null },
    { kind: "mapping", targetKind: "cases", targetId: caseId, action: "approved", outcome: "recorded", decidedAt: new Date("2026-11-19T00:00:00Z"), evidence: evidence([albums[0]], albums[0]) },
  ];
  const details = {
    cases: new Map([[caseId, { artist: "Observed Artist", album: "Observed Album" }]]),
    albums: new Map(albums.map((id, index) => [id, { title: `Album ${index}`, artistDisplayName: "Artist" }])),
    targets: new Map([[albums[0], { title: "Album 0", artistDisplayName: "Artist" }]]),
    releases: new Map(releases.map((id, index) => [id, { title: `Release ${index}` }])),
  };
  return { rows, details };
}

test("adjudication packets are blinded, seeded and keyed separately", () => {
  const { rows, details } = packetWorld();
  const built = buildPacket({ episodes: rows, details, environment: "fixture", now: NOW, seed: "seed-1", sampleSize: 30 });
  assert.equal(built.eligible, 4);
  assert.equal(built.sampled, 4);
  const packet = JSON.parse(built.packetBytes);
  const key = JSON.parse(built.keyBytes);
  const labels = JSON.parse(built.labelsBytes);
  const serialized = built.packetBytes;
  for (const word of ["approved", "no_catalog_match", "confirm", "selected", "recommended", "reason", "moderator"]) assert.equal(serialized.includes(`"${word}"`), false, `packet reveals ${word}`);
  const baselineItem = packet.items.find((item) => item.kind === "baseline");
  assert.ok(baselineItem.options.every((option) => Object.keys(option).join() === "letter,musicBrainzUrl"), "every release option looks the same, so the choice does not stand out");
  assert.equal(key.packetChecksum, built.packetChecksum);
  assert.equal(labels.packetChecksum, built.packetChecksum);
  assert.deepEqual(Object.values(labels.labels), [null, null, null, null]);
  const searched = key.items.find((item) => packet.items.find((entry) => entry.itemId === item.itemId).options.length === 2 && item.action === "approved" && item.moderatorChoice !== "no_match");
  assert.ok(searched, "the searched selection is a lettered option");
  assert.ok(key.items.some((item) => item.action === "no_catalog_match" && item.moderatorChoice === "no_match"));
  const again = buildPacket({ episodes: rows, details, environment: "fixture", now: NOW, seed: "seed-1", sampleSize: 30 });
  assert.deepEqual(JSON.parse(again.keyBytes).items.map((item) => item.moderatorChoice), key.items.map((item) => item.moderatorChoice), "the same seed reproduces the sample and option order");
  assert.equal(buildPacket({ episodes: rows, details, environment: "fixture", now: NOW, seed: "seed-1", sampleSize: 2 }).sampled, 2);
});

test("labels join with the key as supported, unsupported, insufficient or unreviewed", () => {
  const { rows, details } = packetWorld();
  const built = buildPacket({ episodes: rows, details, environment: "fixture", now: NOW, seed: "seed-2" });
  const key = JSON.parse(built.keyBytes);
  const packet = JSON.parse(built.packetBytes);
  const [first, second, third] = key.items;
  const other = (item) => packet.items.find((entry) => entry.itemId === item.itemId).options.map((option) => option.letter).find((letter) => letter !== item.moderatorChoice) || "no_match";
  const answers = { [first.itemId]: first.moderatorChoice, [second.itemId]: other(second), [third.itemId]: "insufficient" };
  const labels = (adjudicator, values = answers) => JSON.stringify({ ...JSON.parse(built.labelsBytes), adjudicator, labels: { ...JSON.parse(built.labelsBytes).labels, ...values } });
  const summary = summarizeLabels({ packetBytes: built.packetBytes, keyBytes: built.keyBytes, labelsBytes: labels("same_moderator") });
  assert.equal(summary.adjudication, "delayed_self_review");
  assert.deepEqual(summary.outcome, { supported: 1, unsupported: 1, insufficient: 1, unreviewed: 1, total: 4, reconciles: true });
  assert.deepEqual(summary.unsupportedRate, { unit: "adjudicable sampled decision", numerator: 1, denominator: 2, value: 0.5 });
  assert.equal(summarizeLabels({ packetBytes: built.packetBytes, keyBytes: built.keyBytes, labelsBytes: labels("independent") }).adjudication, "independent");
  assert.throws(() => summarizeLabels({ packetBytes: built.packetBytes, keyBytes: built.keyBytes, labelsBytes: labels("") }), /ADJUDICATION_ADJUDICATOR_REQUIRED/u);
  assert.throws(() => summarizeLabels({ packetBytes: `${built.packetBytes} `, keyBytes: built.keyBytes, labelsBytes: labels("independent") }), /ADJUDICATION_CHECKSUM_MISMATCH/u);
  assert.throws(() => summarizeLabels({ packetBytes: built.packetBytes, keyBytes: built.keyBytes, labelsBytes: labels("independent", { [first.itemId]: "Z" }) }), /ADJUDICATION_LABEL_INVALID/u);
  assert.throws(() => summarizeLabels({ packetBytes: built.packetBytes, keyBytes: built.keyBytes, labelsBytes: labels("independent", { [uuid()]: "A" }) }), /ADJUDICATION_LABEL_INVALID/u);
});

test("operator commands validate arguments and keep packets out of the repository", () => {
  assert.deepEqual(parseArgs(["--manifest", "m.json", "--adjudication", "dir"]), { manifest: "m.json", adjudication: "dir" });
  assert.throws(() => parseArgs(["--manifest", "m.json", "--validate-only", "--adjudication", "dir"]), /Usage/u);
  assert.deepEqual(clear.parseArgs([]), { apply: false, cutoff: null, database: "", count: null });
  assert.equal(+clear.parseArgs(["--cutoff", "2026-11-20T00:00:00Z"]).cutoff, Date.parse("2026-11-20T00:00:00Z"), "a dry run can repeat a cutoff");
  assert.deepEqual(clear.parseArgs(["--apply", "--cutoff", "2026-11-20T00:00:00Z", "--confirm-count", "4", "--confirm-database", "rescened_dev"]).count, 4);
  for (const args of [["--apply"], ["--apply", "--cutoff", "2026-11-20T00:00:00Z", "--confirm-database", "x"], ["--apply", "--cutoff", "2026-11-20T00:00:00Z", "--confirm-count", "4"], ["--confirm-database", "x"], ["--confirm-count", "4"], ["--apply", "--cutoff", "2026-11-20T00:00:00Z", "--confirm-count", "-1", "--confirm-database", "x"], ["--apply", "--cutoff", "2026-02-31T00:00:00Z", "--confirm-count", "1", "--confirm-database", "x"], ["--force"]]) {
    assert.throws(() => clear.parseArgs(args), /Usage/u);
  }
  assert.throws(() => adjudicationScript.parseArgs(["--manifest", "m.json", "--out", "dir"]), /Usage/u);
  assert.equal(adjudicationScript.parseArgs(["--manifest", "m.json", "--out", "dir", "--seed", "s", "--sample", "10"]).sample, 10);
  assert.throws(() => adjudicationScript.outputDirectory(path.join(__dirname, "..", "tmp-adjudication")), /ADJUDICATION_OUTPUT_INSIDE_REPOSITORY/u);
  const occupied = fs.mkdtempSync(path.join(os.tmpdir(), "adjudication-"));
  fs.writeFileSync(path.join(occupied, "packet.json"), "{}");
  assert.throws(() => adjudicationScript.outputDirectory(occupied), /ADJUDICATION_OUTPUT_NOT_EMPTY/u);
  fs.rmSync(occupied, { recursive: true });
});

test("a dry-run clear changes nothing and an apply needs the connected database name", async () => {
  const calls = [];
  const Episode = { countDocuments: async (filter) => { calls.push(["count", filter]); return 4; }, deleteMany: async (filter) => { calls.push(["delete", filter]); return { deletedCount: 4 }; } };
  const audits = [{ countDocuments: async () => 10 }];
  const connection = { db: { databaseName: "rescened_test" } };
  const dry = await clear.clearReviewEpisodes({ now: NOW, connection, Episode, audits });
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.episodes, 4);
  assert.equal(calls.some(([name]) => name === "delete"), false);
  await assert.rejects(clear.clearReviewEpisodes({ apply: true, cutoff: NOW, count: 4, database: "rescened_prod", now: NOW, connection, Episode, audits }), /CLEAR_DATABASE_MISMATCH/u);
  await assert.rejects(clear.clearReviewEpisodes({ apply: true, cutoff: NOW, count: 3, database: "rescened_test", now: NOW, connection, Episode, audits }), /CLEAR_COUNT_CHANGED/u);
  await assert.rejects(clear.clearReviewEpisodes({ cutoff: new Date(NOW.getTime() + 1000), now: NOW, connection, Episode, audits }), /CLEAR_CUTOFF_IN_FUTURE/u);
  assert.equal(calls.some(([name]) => name === "delete"), false);
  const applied = await clear.clearReviewEpisodes({ apply: true, cutoff: NOW, count: 4, database: "rescened_test", now: NOW, connection, Episode, audits });
  assert.deepEqual([applied.deleted, applied.auditEntriesNotReduced], [4, true]);
  assert.deepEqual(calls.at(-1), ["delete", { recordedAt: { $lte: NOW } }]);
});
