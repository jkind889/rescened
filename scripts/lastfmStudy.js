#!/usr/bin/env node
// Read-only provider study. This module deliberately imports no database or application models.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parse } = require("dotenv");
const { hash } = require("../lib/listeningStudy/core");
const { createClient, referenceFromRelease } = require("../lib/listeningStudy/provider");
const { ROOT, frozenInputs, editionsOf, createStudy, assertStudy, validateReferences, validateControl, report, markdown } = require("../lib/listeningStudy/study");

function options(argv) {
  const [command, ...rest] = argv;
  const allowed = new Set(["output", "edition", "release", "release-group", "reference-file", "reviewer", "credentials", "username", "session", "supplemental"]);
  const result = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, "");
    if (!rest[i]?.startsWith("--") || !allowed.has(key) || !rest[i + 1] || rest[i + 1].startsWith("--") || result[key]) throw new Error("Invalid or duplicate command option");
    result[key] = rest[i + 1];
  }
  if (!result.output) throw new Error("--output must name a private directory outside the repository");
  return result;
}
const inside = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
async function externalPath(input) {
  const target = path.resolve(input);
  const root = await fs.realpath(ROOT);
  if (inside(target, ROOT)) throw new Error("Evidence and credentials must stay outside the repository");
  let ancestor = target;
  while (true) {
    try {
      const resolved = await fs.realpath(ancestor);
      if (inside(resolved, root)) throw new Error("Evidence path resolves inside the repository");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return target;
}
async function write(directory, filename, value) {
  const destination = path.join(directory, filename);
  await externalPath(destination);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, destination);
}
async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (!["init", "use-reviewed-references", "candidates", "browse-releases", "reference", "reference-file", "freeze", "capture-albums", "capture-sessions", "evaluate", "diagnose", "evaluate-mappings"].includes(args.command)) throw new Error("Unknown study command");
  const directory = await externalPath(args.output);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (args.command === "init") {
    await fs.writeFile(path.join(directory, "study.json"), `${JSON.stringify(createStudy(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log("Created frozen study and 20-session logbook. References and playback evidence remain pending."); return;
  }
  await externalPath(path.join(directory, "study.json"));
  const study = JSON.parse(await fs.readFile(path.join(directory, "study.json"), "utf8"));
  const { sample } = assertStudy(study);
  const editions = editionsOf(sample);
  const edition = editions.find((e) => e.id === args.edition);
  const save = () => write(directory, "study.json", study);
  if (args.command === "evaluate-mappings") {
    const { mappingReport, mappingMarkdown } = require("../lib/listeningStudy/albumNameMappings");
    const supplemental = args.supplemental ? JSON.parse(await fs.readFile(await externalPath(args.supplemental), "utf8")) : [];
    const result = mappingReport(study, supplemental);
    await write(directory, "album-name-mapping-report.json", result);
    await write(directory, "album-name-mapping-report.md", mappingMarkdown(result));
    console.log(JSON.stringify({ evaluatedControls: result.controls.filter((r) => r.status === "evaluated").length,
      combinedProposedListens: result.combined.proposedListens, postHoc: true }));
    return;
  }
  if (args.command === "diagnose") {
    const { buildDiagnostics, matchingMarkdown, identityMarkdown } = require("../lib/listeningStudy/diagnostics");
    const { matching, identity } = buildDiagnostics(study);
    await write(directory, "track-matching-report.json", matching);
    await write(directory, "track-matching-report.md", matchingMarkdown(matching));
    await write(directory, "edition-evidence-report.json", identity);
    await write(directory, "edition-evidence-report.md", identityMarkdown(identity));
    console.log(JSON.stringify({ name: matching.name, mbid: matching.mbid, playback: identity.conclusion }));
    return;
  }
  if (args.command === "use-reviewed-references") {
    if (study.referencesHash || Object.keys(study.references).length || Object.keys(study.albums).length) throw new Error("Reviewed references require an empty, unfrozen study");
    const filename = path.join(ROOT, "data/listening-study/references.json");
    const bytes = await fs.readFile(filename, "utf8");
    if (hash(bytes) !== (await fs.readFile(`${filename}.sha256`, "utf8")).trim()) throw new Error("Reviewed reference checksum mismatch");
    study.references = JSON.parse(bytes);
    validateReferences(study, sample);
    await save(); console.log("Loaded 40 reviewed references. Run freeze before Last.fm capture."); return;
  }
  if (args.command === "reference-file") {
    if (study.referencesHash || Object.keys(study.albums).length) throw new Error("References cannot change after freeze or Last.fm capture");
    if (!edition || !args["reference-file"] || !args.reviewer) throw new Error("reference-file requires --edition, --reference-file, and --reviewer");
    const reference = JSON.parse(await fs.readFile(await externalPath(args["reference-file"]), "utf8"));
    if (!reference.source?.startsWith("https://") || !reference.title || reference.artist !== edition.artist
      || !reference.tracks?.length || reference.tracks.length > 1000
      || reference.tracks.some((t) => typeof t.title !== "string" || !t.title.trim() || typeof t.artist !== "string" || !t.artist.trim())) throw new Error("Invalid official-source reference");
    study.references[edition.id] = { ...reference, verified: true, queryTitle: edition.queryTitle, reviewer: args.reviewer, reviewedAt: new Date().toISOString() };
    await save(); console.log(`Recorded reviewed official-source reference: ${edition.id}`); return;
  }
  if (args.command === "freeze") {
    if (study.referencesHash) throw new Error("References already frozen");
    validateReferences(study, sample);
    study.referencesHash = hash(study.references); study.referencesFrozenAt = new Date().toISOString();
    await save(); console.log("Reference tracklists frozen. Last.fm album capture is now permitted."); return;
  }
  if (args.command === "evaluate") {
    const check = spawnSync(process.execPath, ["--test", "tests/listeningStudy.test.js", "tests/listeningStudyProvider.test.js", "tests/listeningStudyReport.test.js"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    const correctness = { passed: check.status === 0, rulesHash: frozenInputs().rulesHash, checkedAt: new Date().toISOString() };
    await write(directory, "deterministic-tests.txt", `${check.stdout || ""}${check.stderr || ""}`);
    await write(directory, "correctness.json", correctness);
    const result = report(study, correctness);
    await write(directory, "report.json", result); await write(directory, "report.md", markdown(result));
    console.log(JSON.stringify({ recommendation: result.recommendation, edition: result.edition, standard: result.standard }));
    if (!correctness.passed) process.exitCode = 1;
    else if (result.recommendation.startsWith("collect")) process.exitCode = 2;
    return;
  }
  if (process.env.RUN_LIVE_LASTFM_STUDY !== "true") throw new Error("Set RUN_LIVE_LASTFM_STUDY=true to enable provider requests");
  const secrets = args.credentials ? parse(await fs.readFile(await externalPath(args.credentials))) : {};
  const apiKey = process.env.LASTFM_API_KEY || secrets.LASTFM_API_KEY || "";
  const client = createClient({ apiKey });
  if (args.command === "browse-releases") {
    if (!args["release-group"]) throw new Error("browse-releases requires --release-group");
    const result = await client.browseReleases(args["release-group"]);
    study.releaseGroups ||= {};
    study.releaseGroups[args["release-group"]] = { ...result, fetchedAt: new Date().toISOString(), verified: false };
    await save(); console.log(`Stored ${result.releases.length} release candidates; complete=${result.complete}`); return;
  }
  if (args.command === "candidates") {
    if (args.edition && !edition) throw new Error("Unknown edition");
    study.candidates ||= {};
    for (const item of edition ? [edition] : editions) {
      try {
        const payload = await client.candidates(item.artist, item.queryTitle);
        study.candidates[item.id] = { fetchedAt: new Date().toISOString(), total: payload.count, candidates: payload.releases || [], verified: false };
      } catch (error) { study.candidates[item.id] = { status: "unavailable", code: error.code || "request_failed" }; }
      await save();
    }
    console.log("Saved bounded MusicBrainz candidates. They require human reference review and are not ground truth."); return;
  }
  if (args.command === "reference") {
    if (study.referencesHash || Object.keys(study.albums).length) throw new Error("References cannot change after freeze or Last.fm capture");
    if (!edition || !args.release || !args.reviewer) throw new Error("reference requires --edition, --release, and --reviewer");
    const payload = await client.release(args.release);
    const reference = referenceFromRelease(payload, edition, args.reviewer, new Date().toISOString());
    study.references[edition.id] = reference;
    await write(directory, `reference-${edition.id.replace(":", "-")}.json`, payload);
    await save(); console.log(`Recorded reviewed reference: ${edition.id} (${reference.tracks.length} tracks)`); return;
  }
  if (!apiKey) throw new Error("LASTFM_API_KEY_required");
  if (!study.referencesHash) throw new Error("Freeze all 40 verified references before querying Last.fm");
  validateReferences(study, sample);
  if (args.command === "capture-albums") {
    if (args.edition && !edition) throw new Error("Unknown edition");
    for (const item of edition ? [edition] : editions) {
      study.albums[item.id] ||= {};
      for (const lookup of ["name", "mbid"]) {
        if (lookup === "mbid" && !study.references[item.id].releaseMbid) {
          study.albums[item.id].mbid = { status: "not_applicable", reason: "reference_has_no_verified_mbid" }; await save(); continue;
        }
        // Preserve completed failures and successes; only transient outages are retried.
        if (study.albums[item.id][lookup]?.status === "ok") continue;
        let record;
        try {
          const payload = await client.album(item.artist, item.queryTitle, lookup === "mbid" ? study.references[item.id].releaseMbid : "");
          record = { status: "ok", fetchedAt: new Date().toISOString(), payload };
        } catch (error) { record = { status: "unavailable", fetchedAt: new Date().toISOString(), code: error.code || "request_failed" }; }
        study.albums[item.id][lookup] = record; await save();
        if (record.code === "provider_authentication_failed") throw new Error(record.code);
      }
    }
    console.log("Album responses captured; name and MBID lookup scores remain separate."); return;
  }
  const user = args.username || process.env.LASTFM_USERNAME || secrets.LASTFM_USERNAME;
  if (!user) throw new Error("An explicitly supplied Last.fm username is required");
  const controls = args.session ? study.controls.filter((c) => c.id === args.session) : study.controls.filter((c) => c.confirmed);
  if (!controls.length) throw new Error("No independently recorded controlled sessions are ready");
  // Validate the entire requested batch before making any request.
  for (const control of controls) validateControl(control, study);
  for (const control of controls) {
    const previous = study.captures[control.id];
    try {
      const capture = await client.recent(user, control.from, control.to);
      study.captures[control.id] = { ...capture, source: "lastfm_live", capturedAt: new Date().toISOString(), controlHash: hash(control) };
    } catch (error) { study.captures[control.id] = { complete: false, code: error.code || "request_failed" }; }
    if (previous) {
      study.captureHistory ||= {};
      (study.captureHistory[control.id] ||= []).push(previous);
    }
    await save();
  }
  console.log("Captured controlled windows. Private source responses remain only in the external study directory.");
}
if (require.main === module) main().catch((error) => { console.error(`Study stopped: ${error.message}`); process.exitCode = 1; });
module.exports = { options, externalPath, main };
