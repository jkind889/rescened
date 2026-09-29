const assert = require("node:assert/strict");
const test = require("node:test");
const { mappingKey } = require("../lib/listening/common");
const { detectSessions } = require("../lib/listening/detection");
const { planReconciliation, playEvidenceExpiry } = require("../lib/listening/reconciliation");

const ALBUM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T0 = Date.parse("2026-09-25T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const baseline = {
  albumId: ALBUM, baselineId: uuid(800), version: 1, tracklistHash: "a".repeat(64),
  tracks: Array.from({ length: 10 }, (_, index) => ({ trackId: uuid(index + 1), discNumber: 1, trackNumber: index + 1, title: `Track ${index + 1}`, durationMs: 200_000, artistDisplayName: "Artist" })),
};
const mapping = { key: mappingKey("Artist", "Album"), mappingId: uuid(900), revision: 1, albumId: ALBUM, status: "active" };

let sequence = 0;
function play(numbers, start, expiresIn = 30 * DAY) {
  return numbers.map((number, index) => {
    sequence += 1;
    const playedAt = new Date(T0 + (start + index * 4) * MINUTE);
    return { eventId: uuid(10_000 + sequence), identityKey: `key-${sequence}`, artist: "Artist", album: "Album", track: `Track ${number}`, playedAt, expiresAt: new Date(playedAt.getTime() + expiresIn) };
  });
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

function compute(events, overrides = {}) {
  return detectSessions({ events, windows: [{ start: new Date(T0 - HOUR), end: null }], mappings: [mapping], baselines: [overrides.baseline || baseline], evaluatedAt: new Date(overrides.evaluatedAt || T0 + 3 * DAY) }).sessions;
}
// A stored detection shaped like the persisted document.
function stored(session, sessionId, extra = {}) {
  return {
    sessionId, albumId: session.albumId, baseline: session.baseline, ruleVersion: session.ruleVersion, matchingVersion: session.matchingVersion,
    mappings: session.mappings, holds: [], processingRevision: 1, eventIds: [...new Set(session.evidence.map((item) => item.eventId))],
    plays: session.plays.map((item) => ({ ...item, playId: uuid(700 + item.ordinal), publishedAt: null })), predecessorSessionIds: [], ...extra,
  };
}
function context(events) {
  return {
    retained: new Map(events.map((event) => [event.eventId, event])),
    currentMappings: new Map([[mapping.mappingId, mapping]]),
    currentBaselines: new Map([[ALBUM, baseline]]),
  };
}

test("new sessions are inserted without lineage and unchanged ones update in place", () => {
  const events = play(range(1, 10), 0);
  const [session] = compute(events);
  const first = planReconciliation({ existing: [], fresh: [session], ...context(events) });
  assert.equal(first.inserts.length, 1);
  assert.deepEqual(first.inserts[0].predecessorSessionIds, []);
  const later = [...events, ...play([1, 2], 60)];
  const second = planReconciliation({ existing: [stored(session, "s1")], fresh: compute(later), ...context(later) });
  assert.equal(second.updates.length, 1);
  assert.equal(second.updates[0].stored.sessionId, "s1");
  assert.equal(second.inserts.length, 0);
});

test("unpublished splits and merges are replaced with explicit lineage", () => {
  const early = play(range(1, 5), 0);
  const late = play(range(6, 10), 60);
  const filler = play([1], 30);
  const [merged] = compute([...early, ...filler, ...late]);
  const [a, b] = compute([...early, ...late].map((event) => (late.includes(event) ? { ...event, playedAt: new Date(event.playedAt.getTime() + 3 * HOUR), expiresAt: event.expiresAt } : event)));
  // Two stored sessions become one after a late event fills the gap.
  const storedA = stored(a, "a");
  const storedB = stored(b, "b");
  const all = [...early, ...filler, ...late];
  const plan = planReconciliation({ existing: [storedA, storedB], fresh: [merged], ...context(all) });
  assert.deepEqual(plan.removals, ["a", "b"]);
  assert.deepEqual(plan.inserts[0].predecessorSessionIds, ["a", "b"]);
  // And the reverse: one stored session split in two.
  const split = planReconciliation({ existing: [stored(merged, "m")], fresh: [a, b], ...context(all) });
  assert.deepEqual(split.removals, ["m"]);
  assert.equal(split.inserts.length, 2);
});

test("published plays are fixed boundaries", () => {
  const first = play(range(1, 10), 0);
  const [single] = compute(first);
  const published = stored(single, "p", { plays: stored(single, "p").plays.map((item) => ({ ...item, publishedAt: new Date(T0 + HOUR) })) });
  const replay = [...first, ...play(range(1, 10), 45)];
  const extended = planReconciliation({ existing: [published], fresh: compute(replay), ...context(replay) });
  assert.equal(extended.updates.length, 1, "later plays may join a published session");
  // A late event before the published play changes which event starts it.
  const earlier = [...play([3], -20), ...first];
  const moved = planReconciliation({ existing: [published], fresh: compute(earlier), ...context(earlier) });
  assert.deepEqual(moved.holds.map((item) => item.holds), [["reconciliation_required"]]);
  // Merging a published session with another is held, never applied.
  const second = play(range(1, 10), 300);
  const [other] = compute(second);
  const bridge = [...first, ...play([5], 120), ...play([6], 200), ...second];
  const merge = planReconciliation({ existing: [published, stored(other, "q")], fresh: compute(bridge), ...context(bridge) });
  assert.equal(merge.inserts.length, 0);
  assert.equal(merge.removals.length, 0);
  assert.deepEqual(merge.holds.map((item) => item.holds[0]), ["reconciliation_required", "reconciliation_required"]);
});

test("stored sessions keep their frozen baseline and rule", () => {
  const events = play(range(1, 10), 0);
  const [session] = compute(events);
  const replaced = { ...baseline, baselineId: uuid(801), version: 2 };
  const baselinePlan = planReconciliation({ existing: [stored(session, "s")], fresh: compute(events, { baseline: replaced }), ...context(events) });
  assert.deepEqual(baselinePlan.holds.map((item) => item.holds), [["stale_baseline"]]);
  assert.equal(baselinePlan.updates.length + baselinePlan.inserts.length, 0);
  const rulePlan = planReconciliation({ existing: [stored(session, "s", { ruleVersion: 0 })], fresh: [session], ...context(events) });
  assert.deepEqual(rulePlan.holds.map((item) => item.holds), [["stale_rule"]]);
});

test("sessions that disappear from a fresh computation are held with a reason", () => {
  const events = play(range(1, 10), 0);
  const [session] = compute(events);
  const base = context(events);
  const expired = planReconciliation({ existing: [stored(session, "s")], fresh: [], ...base, retained: new Map() });
  assert.deepEqual(expired.holds[0].holds, ["evidence_expired"]);
  const revoked = planReconciliation({ existing: [stored(session, "s")], fresh: [], ...base, currentMappings: new Map() });
  assert.deepEqual(revoked.holds[0].holds, ["stale_mapping"]);
  const noBaseline = planReconciliation({ existing: [stored(session, "s")], fresh: [], ...base, currentBaselines: new Map() });
  assert.deepEqual(noBaseline.holds[0].holds, ["stale_baseline"]);
});

test("a qualified play losing coverage to expiry stays visible as expired", () => {
  const events = [...play([1, 2, 3], 0, 2 * DAY), ...play(range(4, 10), 12)];
  const [session] = compute(events, { evaluatedAt: T0 + HOUR });
  const remaining = events.slice(3);
  const plan = planReconciliation({ existing: [stored(session, "s")], fresh: compute(remaining), ...context(remaining) });
  assert.deepEqual(plan.holds.map((item) => item.holds), [["evidence_expired"]]);
  assert.equal(plan.updates.length, 0);
});

test("a held session whose qualified evidence lapsed is also marked expired", () => {
  const events = play(range(1, 10), 0);
  const [session] = compute(events);
  const lapsed = stored(session, "s", { plays: stored(session, "s").plays.map((item) => ({ ...item, evidenceExpiresAt: new Date(T0 + DAY) })) });
  const plan = planReconciliation({ existing: [lapsed], fresh: [], ...context(events), currentMappings: new Map(), now: new Date(T0 + 2 * DAY) });
  assert.deepEqual(plan.holds[0].holds, ["evidence_expired", "stale_mapping"]);
});

test("sessions next to a retention gap are held as incomplete", () => {
  const events = play(range(1, 10), 0);
  const plan = planReconciliation({ existing: [], fresh: compute(events), ...context(events), retentionGap: { from: new Date(T0 - 5 * DAY), to: new Date(T0 - HOUR) } });
  assert.deepEqual(plan.inserts[0].holds, ["sync_incomplete"]);
});

test("evidence expiry is when coverage would fall below the threshold", () => {
  const events = play(range(1, 10), 0).map((event, index) => ({ ...event, expiresAt: new Date(T0 + (index + 10) * DAY) }));
  const [session] = compute(events);
  const retained = new Map(events.map((event) => [event.eventId, event]));
  // Ten credited, eight required: losing the third-earliest drops coverage to seven.
  assert.equal(playEvidenceExpiry(session, session.plays[0], retained).getTime(), T0 + 12 * DAY);
  const [partial] = compute(events.slice(0, 5));
  assert.equal(playEvidenceExpiry(partial, partial.plays[0], retained), null);
});
