const assert = require("node:assert/strict");
const test = require("node:test");
const { detectionEnabledFor, normalizeTimeZone } = require("../lib/listening/detectionView");

test("time zones are canonical IANA names", () => {
  assert.equal(normalizeTimeZone("america/new_york"), "America/New_York");
  assert.equal(normalizeTimeZone(" Europe/London "), "Europe/London");
  assert.equal(normalizeTimeZone("UTC"), "UTC");
  for (const value of ["Mars/Olympus", "+05:00", "", "   ", 5, null, "x".repeat(101)]) {
    assert.throws(() => normalizeTimeZone(value), { code: "INVALID_TIME_ZONE" });
  }
});

test("detection reads follow the detection flag and pilot allowlist", () => {
  assert.deepEqual(detectionEnabledFor("user", {}), { enabled: false, pilotAllowed: false });
  assert.deepEqual(detectionEnabledFor("user", { LISTENING_DETECTION_ENABLED: "true" }), { enabled: true, pilotAllowed: false });
  assert.deepEqual(detectionEnabledFor("user", { LISTENING_DETECTION_ENABLED: "true", LASTFM_PILOT_USER_IDS: "user" }), { enabled: true, pilotAllowed: true });
});
