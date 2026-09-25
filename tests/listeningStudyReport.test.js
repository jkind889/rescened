const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { hash } = require("../lib/listeningStudy/core");
const { createStudy, frozenInputs, editionsOf, report, assertStudy, validateControl, validateReferences } = require("../lib/listeningStudy/study");
const { externalPath, options } = require("../scripts/lastfmStudy");
const { tracks, album, recent } = require("./fixtures/listeningStudy/synthetic");
function completeStudy() {
  const study = createStudy(); const { sample } = frozenInputs();
  for (const edition of editionsOf(sample)) {
    const count = edition.kind === "standard" ? 10 : 18;
    study.references[edition.id] = { verified: true, reviewer: "fictional fixture", reviewedAt: "2026-09-01T00:00:00Z", source: "https://musicbrainz.org/release/fixture", releaseMbid: edition.id, releaseGroupMbid: edition.pairId, artist: edition.artist, title: edition.queryTitle, tracks: tracks(count, edition.artist) };
    study.albums[edition.id] = { name: { status: "ok", payload: album(edition.queryTitle, count, edition.artist) } };
  }
  study.controls.forEach((control, i) => {
    const spec = editionsOf(sample).find((e) => e.id === control.editionId);
    const count = spec.kind === "standard" ? 10 : 18;
    Object.assign(control, { confirmed: true, recordedAt: "2026-09-01T00:00:00Z", from: 1600000000 + i * 172800, to: 1600000000 + i * 172800 + 6000, qualifyingTrackPositions: Array.from({ length: count }, (_, j) => j + 1) });
    study.captures[control.id] = { source: "lastfm_live", complete: true, controlHash: hash(control), pages: [recent(spec.queryTitle, control.qualifyingTrackPositions, control.from, spec.artist)] };
  });
  return study;
}
const correctness = () => ({ passed: true, rulesHash: frozenInputs().rulesHash });
test("frozen sample is 20 pairs/40 editions/10 predetermined playback pairs", () => {
  const { sample } = frozenInputs(); assert.equal(editionsOf(sample).length, 40);
  assert.equal(createStudy().controls.length, 20);
});
test("empty study is incomplete, never a pass or fallback recommendation", () => {
  const result = report(createStudy(), correctness());
  assert.equal(result.recommendation, "collect_missing_evidence"); assert.equal(result.edition.incompleteSessions, 20);
});
test("all gates pass only with complete metadata, controls and deterministic evidence", () => {
  const result = report(completeStudy(), correctness());
  assert.equal(result.edition.correctTracklists, 40); assert.equal(result.edition.distinguishedPairs, 20);
  assert.equal(result.edition.correctSessions, 20); assert.equal(result.recommendation, "edition_specific_pilot");
  assert.equal(report(completeStudy()).edition.verdict, "incomplete");
});
test("a single wrong-edition listen fails edition gate even with 19 correct controls", () => {
  const study = completeStudy(); const control = study.controls.find((c) => c.id.endsWith(":deluxe"));
  const pair = frozenInputs().sample.pairs.find((p) => control.id.startsWith(`${p.id}:`));
  study.captures[control.id].pages = [recent(pair.standard, Array.from({ length: 10 }, (_, i) => i + 1), control.from, pair.artist)];
  const result = report(study, correctness());
  assert.equal(result.edition.wrongEditions, 1); assert.equal(result.edition.verdict, "fail");
  assert.equal(result.recommendation, "shared_standard_pilot");
});
test("missing metadata fails coverage while outages leave the study incomplete", () => {
  const study = completeStudy(); const ids = Object.keys(study.albums).filter((id) => id.endsWith(":deluxe")).slice(0, 3);
  for (const id of ids) study.albums[id].name = { status: "ok", payload: { error: 6 } };
  assert.equal(report(study, correctness()).edition.verdict, "fail");
  study.albums[ids[0]].name = { status: "unavailable" };
  assert.equal(report(study, correctness()).edition.verdict, "incomplete");
});
test("MBID lookup success cannot replace a failed name lookup score", () => {
  const study = completeStudy(); const id = Object.keys(study.albums)[0];
  study.albums[id].mbid = study.albums[id].name; study.albums[id].name = { status: "ok", payload: { error: 6 } };
  assert.equal(report(study, correctness()).edition.correctTracklists, 39);
});
test("reference or sample mutation is detected", () => {
  const study = createStudy(); study.referencesHash = hash(study.references); study.references.extra = {};
  assert.throws(() => assertStudy(study), /References changed/);
  const other = createStudy(); other.controls.pop(); assert.throws(() => assertStudy(other), /Controlled sample changed/);
  assert.throws(() => validateReferences(createStudy(), frozenInputs().sample), /Verified reference required/);
});
test("logbook edits after capture invalidate the corresponding evidence", () => {
  const study = completeStudy(); study.controls[0].qualifyingTrackPositions.pop();
  assert.equal(report(study, correctness()).controls[0].edition.status, "incomplete");
});
test("overlapping windows and invalid ground-truth positions cannot score", () => {
  const study = completeStudy(); study.controls[0].qualifyingTrackPositions = [999];
  assert.throws(() => validateControl(study.controls[0], study), /invalid independent/);
  const second = completeStudy(); second.controls[1].from = second.controls[0].from; second.controls[1].to = second.controls[0].to;
  assert.throws(() => validateControl(second.controls[0], second), /overlap/);
});
test("private artifacts cannot be written inside the repo, including symlink paths", async () => {
  await assert.rejects(externalPath(path.join(__dirname, "private.json")), /outside the repository/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "study-path-test-"));
  try {
    await fs.symlink(path.join(__dirname, ".."), path.join(dir, "repo"));
    await assert.rejects(externalPath(path.join(dir, "repo", "new-dir", "data.json")), /inside the repository/);
    assert.equal(await externalPath(path.join(dir, "outside.json")), path.join(dir, "outside.json"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("CLI rejects unknown and duplicate options", () => {
  assert.throws(() => options(["init", "--api-key", "secret"]), /Invalid/);
  assert.throws(() => options(["init", "--output", "/tmp/x", "--output", "/tmp/y"]), /Invalid/);
});

test("reviewed references load offline, freeze, and cannot be replaced", async () => {
  const { main } = require("../scripts/lastfmStudy");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "listening-study-reviewed-"));
  try {
    await main(["init", "--output", directory]);
    await main(["use-reviewed-references", "--output", directory]);
    await main(["freeze", "--output", directory]);
    const study = JSON.parse(await fs.readFile(path.join(directory, "study.json"), "utf8"));
    assert.equal(Object.keys(study.references).length, 40);
    assert.equal(study.referencesHash, hash(study.references));
    assertStudy(study);
    assert.equal(study.references["ultraviolence:deluxe"].tracks.length, 15);
    assert.equal(study.references["ultraviolence:deluxe"].tracks.at(-1).title, "Flipside");
    await assert.rejects(main(["use-reviewed-references", "--output", directory]), /empty, unfrozen/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("live commands refuse network work without explicit opt-in", async () => {
  const { main } = require("../scripts/lastfmStudy");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "listening-study-gate-"));
  const previous = process.env.RUN_LIVE_LASTFM_STUDY;
  delete process.env.RUN_LIVE_LASTFM_STUDY;
  try {
    await main(["init", "--output", directory]);
    await assert.rejects(main(["candidates", "--output", directory]), /Set RUN_LIVE_LASTFM_STUDY=true/);
    await assert.rejects(main(["capture-albums", "--output", directory]), /Set RUN_LIVE_LASTFM_STUDY=true/);
  } finally {
    if (previous === undefined) delete process.env.RUN_LIVE_LASTFM_STUDY; else process.env.RUN_LIVE_LASTFM_STUDY = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
