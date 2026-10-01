const fs = require("node:fs");
const path = require("node:path");
const { RULES, hash, text, normalizeAlbum, normalizeRecent, compareAlbum, evaluateSessions } = require("./core");
const ROOT = path.resolve(__dirname, "../..");
const sampleFile = path.join(ROOT, "data/listening-study/sample.json");

function frozenInputs() {
  const sampleBytes = fs.readFileSync(sampleFile, "utf8");
  const expected = fs.readFileSync(`${sampleFile}.sha256`, "utf8").trim();
  if (hash(sampleBytes) !== expected) throw new Error("Frozen sample checksum mismatch");
  const sample = JSON.parse(sampleBytes);
  if (sample.pairs.length !== 20 || sample.pairs.filter((p) => p.controlled).length !== 10
    || new Set(sample.pairs.map((p) => p.id)).size !== 20) throw new Error("Invalid frozen sample");
  const rulesHash = hash(["core.js", "study.js"].map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n"));
  const expectedRules = fs.readFileSync(path.join(ROOT, "data/listening-study/rules.sha256"), "utf8").trim();
  if (rulesHash !== expectedRules) throw new Error("Matching rules changed: use a separately versioned study rather than overwriting the baseline");
  return { sample, sampleHash: expected, rulesHash };
}
function editionsOf(sample) {
  return sample.pairs.flatMap((pair) => ["standard", "deluxe"].map((kind) => ({ id: `${pair.id}:${kind}`, pairId: pair.id, artist: pair.artist, queryTitle: pair[kind], kind })));
}
function createStudy() {
  const input = frozenInputs();
  return { schemaVersion: 1, ruleVersion: RULES.version, sampleHash: input.sampleHash, rulesHash: input.rulesHash,
    createdAt: new Date().toISOString(), references: {}, albums: {}, captures: {},
    controls: editionsOf(input.sample).filter((e) => input.sample.pairs.find((p) => p.id === e.pairId).controlled)
      .map((e) => ({ id: e.id, editionId: e.id, recordedAt: null, from: null, to: null, qualifyingTrackPositions: [], confirmed: false })) };
}
function assertStudy(study) {
  const inputs = frozenInputs();
  if (study.schemaVersion !== 1 || study.sampleHash !== inputs.sampleHash || study.rulesHash !== inputs.rulesHash) throw new Error("Study does not match frozen sample/rules");
  const required = editionsOf(inputs.sample).filter((e) => inputs.sample.pairs.find((p) => p.id === e.pairId).controlled).map((e) => e.id).sort();
  if (JSON.stringify(study.controls?.map((c) => c.id).sort()) !== JSON.stringify(required)
    || study.controls.some((c) => c.id !== c.editionId)) throw new Error("Controlled sample changed");
  if (study.referencesHash && hash(study.references) !== study.referencesHash) throw new Error("References changed after freeze");
  return inputs;
}
function validateReferences(study, sample) {
  for (const edition of editionsOf(sample)) {
    const ref = study.references[edition.id];
    if (!ref?.verified || !ref.reviewer || !ref.reviewedAt || !ref.source?.startsWith("https://")
      || !ref.tracks?.length || ref.tracks.some((t) => !text(t.title) || !text(t.artist))) {
      throw new Error(`Verified reference required: ${edition.id}`);
    }
  }
  for (const pair of sample.pairs) {
    const a = study.references[`${pair.id}:standard`]; const b = study.references[`${pair.id}:deluxe`];
    if ((a.releaseMbid && a.releaseMbid === b.releaseMbid)
      || (a.releaseGroupMbid && b.releaseGroupMbid && a.releaseGroupMbid !== b.releaseGroupMbid)) throw new Error(`Review edition pairing: ${pair.id}`);
  }
}
function buildEditions(study, sample, mode) {
  const specs = editionsOf(sample); const definitions = [];
  for (const spec of specs) {
    if (mode === "standard" && spec.kind !== "standard") continue;
    const record = study.albums[spec.id]?.name;
    if (!record || record.status !== "ok") continue;
    const album = normalizeAlbum(record.payload);
    if (album.status !== "ok") continue;
    const ref = study.references[spec.id];
    const aliases = mode === "standard"
      ? specs.filter((e) => e.pairId === spec.pairId).flatMap((e) => [e.queryTitle, study.references[e.id]?.title])
      : [spec.queryTitle, ref?.title, album.title];
    // Fallback accepts edition labels but uses only the standard provider tracklist.
    definitions.push({ ...spec, aliases: [...new Set(aliases.filter(Boolean))], tracks: album.tracks,
      mbid: mode === "standard" ? "" : album.mbid });
  }
  return definitions;
}
function controlVerdict(study, control, definitions, mode) {
  const capture = study.captures[control.id]; const ref = study.references[control.editionId];
  if (!control.confirmed || !capture?.complete || capture.source !== "lastfm_live" || !ref?.verified) return { status: "incomplete" };
  if (capture.controlHash !== hash(control)) return { status: "incomplete", reason: "logbook_changed_after_capture" };
  const parsed = normalizeRecent(capture.pages);
  const events = parsed.events.filter((e) => e.timestamp >= control.from && e.timestamp <= control.to);
  const pairId = control.editionId.split(":")[0];
  const baseline = mode === "standard" ? study.references[`${pairId}:standard`] : ref;
  if (!baseline) return { status: "incomplete" };
  // Independent oracle: positions recorded by the listener, never inferred from Last.fm scrobbles.
  const heard = new Set(control.qualifyingTrackPositions.map((position) => {
    const t = ref.tracks[position - 1]; return `${text(t.artist)}|${text(t.title)}`;
  }));
  const covered = mode === "edition" ? new Set(control.qualifyingTrackPositions).size
    : baseline.tracks.filter((track) => {
      const key = `${text(track.artist)}|${text(track.title)}`;
      return heard.has(key) && baseline.tracks.filter((t) => `${text(t.artist)}|${text(t.title)}` === key).length === 1;
    }).length;
  const expectedLog = covered >= Math.ceil(baseline.tracks.length * RULES.threshold);
  const evaluation = evaluateSessions(events, definitions, mode);
  const logs = evaluation.sessions.filter((s) => s.status === "would_log");
  const wrongEdition = logs.some((s) => s.pairId !== pairId || (mode === "edition" && s.editionId !== control.editionId));
  const falsePositive = logs.length > (expectedLog ? 1 : 0) || wrongEdition;
  const resolved = evaluation.sessions.some((s) => mode === "standard" ? s.pairId === pairId : s.editionId === control.editionId);
  const correct = !falsePositive && logs.length === (expectedLog ? 1 : 0) && resolved && parsed.rejected.length === 0;
  return { status: "scored", expectedLog, correct, wrongEdition, falsePositive, proposedListens: logs.length,
    rejectedRows: parsed.rejected.length, outcomes: evaluation.sessions.map(({ status, reason, distinctTracks, totalTracks, editionId }) => ({ status, reason, distinctTracks, totalTracks, editionId })),
    unmatchedRows: evaluation.unresolved.length };
}
function validateControl(control, study) {
  const ref = study.references[control.editionId];
  if (!control.confirmed || !ref?.verified || !Number.isSafeInteger(control.from) || !Number.isSafeInteger(control.to)
    || control.from <= 0 || control.to <= control.from || control.to > Math.floor(Date.now() / 1000) || control.to - control.from > RULES.maxSessionSeconds
    || !Number.isFinite(Date.parse(control.recordedAt)) || Date.parse(control.recordedAt) > Date.now()
    || !Array.isArray(control.qualifyingTrackPositions) || !control.qualifyingTrackPositions.length
    || control.qualifyingTrackPositions.some((p) => !Number.isInteger(p) || p < 1 || p > ref.tracks.length)) throw new Error(`Incomplete or invalid independent logbook: ${control.id}`);
  for (const other of study.controls) {
    if (other.id !== control.id && other.confirmed && other.from <= control.to && other.to >= control.from) throw new Error("Controlled capture windows must not overlap");
  }
}
function report(study, correctness = null) {
  const { sample, rulesHash } = assertStudy(study);
  const rows = editionsOf(sample).map((edition) => ({ id: edition.id, kind: edition.kind,
    name: compareAlbum(study.references[edition.id], study.albums[edition.id]?.name),
    mbid: compareAlbum(study.references[edition.id], study.albums[edition.id]?.mbid) }));
  const pairs = sample.pairs.map((pair) => {
    const a = study.albums[`${pair.id}:standard`]?.name; const b = study.albums[`${pair.id}:deluxe`]?.name;
    const parsedA = normalizeAlbum(a?.payload); const parsedB = normalizeAlbum(b?.payload);
    const accurate = rows.filter((r) => r.id.startsWith(`${pair.id}:`)).every((r) => r.name.correct);
    const distinctIdentity = parsedA.status === "ok" && parsedB.status === "ok"
      && text(parsedA.title) !== text(parsedB.title) && !(parsedA.mbid && parsedA.mbid === parsedB.mbid);
    return { id: pair.id, distinguished: accurate && distinctIdentity };
  });
  const controls = study.controls.map((control) => {
    if (control.confirmed) validateControl(control, study);
    return { id: control.id, edition: controlVerdict(study, control, buildEditions(study, sample, "edition"), "edition"),
      standard: controlVerdict(study, control, buildEditions(study, sample, "standard"), "standard") };
  });
  const correctnessPassed = correctness?.passed === true && correctness.rulesHash === rulesHash;
  const metric = (mode) => ({ correctSessions: controls.filter((c) => c[mode].correct).length,
    incompleteSessions: controls.filter((c) => c[mode].status === "incomplete").length,
    falsePositives: controls.filter((c) => c[mode].falsePositive).length,
    wrongEditions: controls.filter((c) => c[mode].wrongEdition).length });
  const edition = { correctTracklists: rows.filter((r) => r.name.correct).length, distinguishedPairs: pairs.filter((p) => p.distinguished).length, ...metric("edition") };
  const standard = { correctBaselines: rows.filter((r) => r.kind === "standard" && r.name.correct).length, ...metric("standard") };
  const metadataIncomplete = rows.some((r) => ["incomplete", "reference_missing"].includes(r.name.status));
  const baselineIncomplete = rows.filter((r) => r.kind === "standard").some((r) => ["incomplete", "reference_missing"].includes(r.name.status));
  const editionPass = correctnessPassed && edition.correctTracklists >= 38 && edition.distinguishedPairs >= 18
    && edition.correctSessions >= 18 && edition.falsePositives === 0 && edition.wrongEditions === 0;
  const standardPass = correctnessPassed && standard.correctBaselines >= 19 && standard.correctSessions >= 18 && standard.falsePositives === 0;
  edition.verdict = metadataIncomplete || edition.incompleteSessions || !correctnessPassed ? "incomplete" : editionPass ? "pass" : "fail";
  standard.verdict = baselineIncomplete || standard.incompleteSessions || !correctnessPassed ? "incomplete" : standardPass ? "pass" : "fail";
  const recommendation = edition.verdict === "pass" ? "edition_specific_pilot"
    : edition.verdict === "incomplete" ? "collect_missing_evidence"
      : standard.verdict === "pass" ? "shared_standard_pilot"
        : standard.verdict === "incomplete" ? "collect_fallback_evidence" : "neither_approach_ready";
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), sampleHash: study.sampleHash, rulesHash,
    correctnessPassed, edition, standard, recommendation, albums: rows, pairs, controls };
}
function markdown(result) {
  const lines = ["# Last.fm listening study", "", `Recommendation: **${result.recommendation}**`, "",
    `Edition gate: ${result.edition.verdict}. Tracklists ${result.edition.correctTracklists}/40; distinct pairs ${result.edition.distinguishedPairs}/20; correct sessions ${result.edition.correctSessions}/20; false positives ${result.edition.falsePositives}.`, "",
    `Shared-standard gate: ${result.standard.verdict}. Baselines ${result.standard.correctBaselines}/20; correct sessions ${result.standard.correctSessions}/20; false positives ${result.standard.falsePositives}.`, "",
    `Deterministic checks: ${result.correctnessPassed ? "passed" : "not established"}. Missing evidence is not a successful result.`, "",
    "| Edition | Name lookup | MBID lookup |", "| --- | --- | --- |",
    ...result.albums.map((row) => `| ${row.id} | ${row.name.correct ? "correct" : row.name.status + (row.name.status === "scored" ? " / mismatch" : "")} | ${row.mbid.correct ? "correct" : row.mbid.status} |`), "",
    "| Controlled session | Edition result | Standard result |", "| --- | --- | --- |",
    ...result.controls.map((row) => `| ${row.id} | ${row.edition.correct ? "correct" : row.edition.status} | ${row.standard.correct ? "correct" : row.standard.status} |`), "",
    "See report.json for count/membership/order/identity comparisons and individual session failure details.", "",
    "This small, preselected pilot does not establish catalog-wide reliability.", ""];
  return lines.join("\n");
}
module.exports = { ROOT, frozenInputs, editionsOf, createStudy, assertStudy, validateReferences, validateControl, buildEditions, report, markdown };
