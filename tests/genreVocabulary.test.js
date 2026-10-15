const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { normalizeVocabularyCommand } = require("../lib/genres/vocabularyCommands");
const { parseArgs } = require("../scripts/mergeGenres");

function rejects(action, body, pattern) {
  assert.throws(() => normalizeVocabularyCommand(action, body), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "INVALID_GENRE_COMMAND");
    assert.match(error.message, pattern);
    return true;
  });
}

test("vocabulary commands require the expected revision and allow only their own fields", () => {
  rejects("rename", { name: "Hip-hop" }, /expectedRevision/);
  rejects("rename", { name: "Hip-hop", expectedRevision: -1 }, /expectedRevision/);
  rejects("rename", { name: "Hip-hop", expectedRevision: 0, parentGenreId: null }, /parentGenreId is not allowed/);
  rejects("retire", { expectedRevision: 0, name: "x" }, /name is not allowed/);
  rejects("delete", { expectedRevision: 0 }, /Unknown genre command/);
  rejects("rename", [], /must be an object/);
  rejects("restore", { expectedRevision: 0, reason: "x".repeat(1001) }, /1000 characters/);
});

test("names are validated, reasons default, and retiring needs a reason", () => {
  rejects("rename", { name: "<b>", expectedRevision: 1 }, /may contain/);
  rejects("alias_add", { expectedRevision: 1 }, /name must be a string/);
  rejects("retire", { expectedRevision: 1, reason: "   " }, /reason is required/);
  assert.deepEqual(normalizeVocabularyCommand("rename", { name: " Hip  Hop ", expectedRevision: 2 }), {
    action: "rename",
    expectedRevision: 2,
    reason: "Genre renamed by a moderator.",
    identity: { name: "Hip Hop", normalizedName: "hip hop", slug: "hip-hop" },
  });
  assert.equal(normalizeVocabularyCommand("retire", { expectedRevision: 0, reason: " Duplicate of Lo-fi " }).reason, "Duplicate of Lo-fi");
});

test("reparent takes a genre UUID or an explicit null", () => {
  rejects("reparent", { expectedRevision: 0 }, /parentGenreId is required/);
  rejects("reparent", { expectedRevision: 0, parentGenreId: "rock" }, /UUID or null/);
  assert.equal(normalizeVocabularyCommand("reparent", { expectedRevision: 0, parentGenreId: null }).parentGenreId, null);
  const id = crypto.randomUUID();
  assert.equal(normalizeVocabularyCommand("reparent", { expectedRevision: 0, parentGenreId: id.toUpperCase() }).parentGenreId, id);
});

test("the merge CLI needs both genres and the reviewed plan checksum to apply", () => {
  assert.throws(() => parseArgs(["--from", "lofi"]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArgs(["--from", "a", "--into", "b", "--apply"]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArgs(["--from", "a", "--into", "b", "--expect-plan-sha256", "a".repeat(64)]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArgs(["--from", "a", "--from", "b", "--into", "c"]), { code: "INVALID_ARGUMENTS" });
  assert.deepEqual(parseArgs(["--from", "Lo-Fi", "--into", "lo-fi-hip-hop", "--apply", "--expect-plan-sha256", "F".repeat(64)]), {
    from: "lo-fi", into: "lo-fi-hip-hop", report: "", apply: true, expectPlanSha256: "f".repeat(64), help: false,
  });
});
