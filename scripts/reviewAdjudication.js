#!/usr/bin/env node
// Exports a blinded adjudication packet for sampled review episodes (docs/LASTFM_SYNC.md,
// "Monitoring"). Read-only against the database. Writes packet.json, key.json and labels.json into a
// new private directory outside the repository, such as ~/rescened-ops/adjudication/<date>, and
// prints only counts and checksums. The adjudicator fills in labels.json; listening:measurement
// --adjudication <directory> joins it with the key.
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { prospectiveIntake, validateManifest } = require("../lib/listening/measurement");
const { DEFAULT_SAMPLE_SIZE, buildPacket } = require("../lib/reviewObservations/adjudication");
const { readManifest } = require("./listeningMeasurement");

const USAGE = "Usage: reviewAdjudication.js --manifest PATH --out DIR --seed TEXT [--sample N]";
const REPOSITORY = path.resolve(__dirname, "..");
const MAX_EPISODES = 5_000;

class ExportError extends Error {
  constructor(code) { super(code); this.name = "ExportError"; this.code = code; }
}

function parseArgs(argv) {
  const args = { sample: DEFAULT_SAMPLE_SIZE }; const rest = [...argv]; const seen = new Set();
  while (rest.length) {
    const flag = rest.shift();
    if (!["--manifest", "--out", "--seed", "--sample"].includes(flag) || seen.has(flag) || !rest.length || rest[0].startsWith("--")) throw new ExportError(USAGE);
    seen.add(flag);
    const value = rest.shift();
    if (flag === "--sample") { args.sample = Number(value); if (!Number.isInteger(args.sample) || args.sample < 1 || args.sample > 200) throw new ExportError(USAGE); }
    else args[flag.slice(2)] = value;
  }
  if (!args.manifest || !args.out || !args.seed) throw new ExportError(USAGE);
  return args;
}

// The packet holds names and catalog details, so it must never land inside the working tree.
function outputDirectory(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(REPOSITORY, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new ExportError("ADJUDICATION_OUTPUT_INSIDE_REPOSITORY");
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length) throw new ExportError("ADJUDICATION_OUTPUT_NOT_EMPTY");
  return resolved;
}

async function loadDetails(episodes, { Listening, AlbumCatalog, AlbumSubmission }) {
  const ids = (kind) => [...new Set(episodes.filter((episode) => episode.kind === kind).flatMap((episode) => [...(episode.evidence?.candidates || []).map((item) => item.id), episode.evidence?.selected?.id].filter(Boolean)))];
  const caseIds = [...new Set(episodes.filter((episode) => episode.kind === "mapping").map((episode) => episode.targetId))];
  const cases = await Listening.MappingCase.find({ caseId: { $in: caseIds } }).select("caseId artist album").lean();
  const albums = await AlbumCatalog.find({ albumId: { $in: ids("mapping") } }).select("albumId title artistDisplayName releaseType tracks").lean();
  const baseline = episodes.filter((episode) => episode.kind === "baseline");
  const albumTargets = await AlbumCatalog.find({ albumId: { $in: baseline.filter((episode) => episode.targetKind === "albums").map((episode) => episode.targetId) } }).select("albumId title artistDisplayName").lean();
  const submissionTargets = await AlbumSubmission.find({ submissionId: { $in: baseline.filter((episode) => episode.targetKind === "submissions").map((episode) => episode.targetId) } }).select("submissionId proposedMetadata.title proposedMetadata.artistDisplayName").lean();
  return {
    cases: new Map(cases.map((row) => [row.caseId, { artist: row.artist, album: row.album }])),
    albums: new Map(albums.map((row) => [row.albumId, { title: row.title, artistDisplayName: row.artistDisplayName, releaseType: row.releaseType || "", trackCount: (row.tracks || []).length }])),
    targets: new Map([
      ...albumTargets.map((row) => [row.albumId, { title: row.title, artistDisplayName: row.artistDisplayName }]),
      ...submissionTargets.map((row) => [row.submissionId, { title: row.proposedMetadata?.title || "", artistDisplayName: row.proposedMetadata?.artistDisplayName || "" }]),
    ]),
  };
}

async function exportPacket({
  manifest, out, seed, sample = DEFAULT_SAMPLE_SIZE, now = new Date(),
  Listening = require("../models/Listening"), AlbumCatalog = require("../models/AlbumCatalog"), AlbumSubmission = require("../models/AlbumSubmission"),
  ReviewObservation = require("../models/ReviewObservation"),
}) {
  const validated = validateManifest(manifest);
  const directory = outputDirectory(out);
  const intake = prospectiveIntake(validated.parsed.exposures.reviewEpisodes, validated.windows, now, { followUp: false });
  if (intake.status !== "defined") throw new ExportError(`ADJUDICATION_INTAKE_${intake.status.toUpperCase()}`);
  const episodes = await ReviewObservation.Episode.find({ decidedAt: { $gte: intake.from, $lt: intake.to }, outcome: "recorded" }).select("kind targetKind targetId action outcome decidedAt evidence").limit(MAX_EPISODES + 1).maxTimeMS(5_000).lean();
  if (episodes.length > MAX_EPISODES) throw new ExportError("ADJUDICATION_TOO_MANY_EPISODES");
  const details = await loadDetails(episodes, { Listening, AlbumCatalog, AlbumSubmission });
  const built = buildPacket({ episodes, details, environment: validated.environment, now, seed, sampleSize: sample });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of [["packet.json", built.packetBytes], ["key.json", built.keyBytes], ["labels.json", built.labelsBytes]]) fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600, flag: "wx" });
  return { environment: validated.environment, intake: { from: intake.from.toISOString(), to: intake.to.toISOString() }, episodesInIntake: episodes.length, eligible: built.eligible, sampled: built.sampled, packetChecksum: built.packetChecksum, files: ["packet.json", "key.json", "labels.json"] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { manifest } = readManifest(args.manifest);
  if (!process.env.MONGO_URI) throw new ExportError("MONGO_URI_REQUIRED");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
  try { console.log(JSON.stringify(await exportPacket({ manifest, out: args.out, seed: args.seed, sample: args.sample }), null, 2)); }
  finally { await mongoose.disconnect(); }
}

const PRINTABLE = /^(?:Usage:|Invalid measurement manifest:|MONGO_URI_REQUIRED$|MANIFEST_NOT_JSON$|ADJUDICATION_\w+$)/u;
if (require.main === module) main().catch((error) => { console.error(PRINTABLE.test(error?.message || "") ? error.message : "REVIEW_ADJUDICATION_FAILED"); process.exitCode = 1; });
module.exports = { exportPacket, outputDirectory, parseArgs };
