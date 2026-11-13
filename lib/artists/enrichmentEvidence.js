const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeArtistMbid, normalizeArtistName, MAX_ARTIST_NAME_LENGTH } = require("./identity");
const { stableJson, verifySealedPlan } = require("./backfill");
const { normalizeJoinPhrase, normalizeText } = require("../catalogImport/listenBrainz");

// Sealed evidence of MusicBrainz release-group artist credits, fetched by
// exact release-group MBID for the artist identity backfill. It is not a
// catalog import dataset: it carries no ListenBrainz rankings, covers, or
// album metadata, and the catalog importer rejects it.
const EVIDENCE_KIND = "rescened-musicbrainz-release-group-credits";
const EVIDENCE_SCHEMA_VERSION = "1.0.0";
const MAX_REQUEST_IDS = 5000;
const MAX_ID_FILE_BYTES = 1024 * 1024;
const MAX_PLAN_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_CREDITS = 64;
const MAX_CREDIT_NAME_LENGTH = 300;
const MAX_JOIN_PHRASE_LENGTH = 32;
const MAX_DISPLAY_NAME_LENGTH = 500;
const MAX_TITLE_LENGTH = 1000;
const UNRESOLVED_REASONS = Object.freeze(["NOT_FOUND", "REDIRECTED", "ID_MISMATCH", "INVALID_RESPONSE", "INVALID_CREDITS", "HTTP_ERROR"]);
const DEFERRED_REASONS = Object.freeze(["TRANSIENT_FAILURE"]);
// Only the transient outcomes the fetcher retries can defer a result.
const LAST_FAILURE_PATTERN = /^(TIMEOUT|NETWORK_ERROR|HTTP_(408|425|429|500|502|503|504))$/;
const MAX_ATTEMPTS = 3;
const DATASET_ID_PATTERN = /^musicbrainz-rg-credits-\d{8}t\d{6}z-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
// A literal, not the importer's URL constant: sealed artifacts must keep
// validating even if the importer's endpoint configuration changes.
const SOURCE = Object.freeze({
  provider: "musicbrainz",
  endpoint: "https://musicbrainz.org/ws/2/release-group",
  include: "artist-credits",
  license: "CC0-1.0",
  licenseUrl: "https://musicbrainz.org/doc/About/Data_License",
});

class EnrichmentEvidenceError extends Error {
  constructor(message, code = "INVALID_ENRICHMENT_EVIDENCE", details = []) {
    super(message);
    this.name = "EnrichmentEvidenceError";
    this.code = code;
    this.details = details;
  }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Only the exact Z-suffixed millisecond form toISOString() produces.
function isIsoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function exactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

// The request set is identified by the digest of its sorted, deduplicated
// release-group MBIDs, so the same IDs always produce the same digest.
function requestDigest(ids) {
  return sha256(JSON.stringify(ids));
}

function normalizeRequestIds(values, label = "release-group IDs") {
  if (!Array.isArray(values)) throw new EnrichmentEvidenceError(`${label} must be a JSON array of MusicBrainz release-group MBIDs`, "INVALID_ID_LIST");
  const invalid = [];
  const ids = new Set();
  values.forEach((value, index) => {
    const mbid = typeof value === "string" ? normalizeArtistMbid(value) : "";
    if (!mbid) invalid.push({ index, value: typeof value === "string" ? value.slice(0, 80) : typeof value });
    else ids.add(mbid);
  });
  if (invalid.length) {
    throw new EnrichmentEvidenceError(`${label} contain ${invalid.length} invalid MusicBrainz MBID(s)`, "INVALID_ID_LIST", invalid.slice(0, 20));
  }
  if (!ids.size) throw new EnrichmentEvidenceError(`${label} are empty`, "INVALID_ID_LIST");
  if (ids.size > MAX_REQUEST_IDS) {
    throw new EnrichmentEvidenceError(`${label} contain ${ids.size} unique IDs; the limit is ${MAX_REQUEST_IDS}`, "ID_LIMIT_EXCEEDED");
  }
  return [...ids].sort();
}

function readBoundedText(filePath, maxBytes, code, label) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    throw new EnrichmentEvidenceError(`Cannot read ${label}: ${resolved} (${error.code || error.message})`, code);
  }
  if (!stat.isFile()) throw new EnrichmentEvidenceError(`${label} is not a file: ${resolved}`, code);
  if (stat.size > maxBytes) throw new EnrichmentEvidenceError(`${label} exceeds ${maxBytes} bytes: ${resolved}`, code);
  const text = fs.readFileSync(resolved, "utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new EnrichmentEvidenceError(`${label} exceeds ${maxBytes} bytes: ${resolved}`, code);
  return { resolved, text };
}

function parseJson(text, code, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new EnrichmentEvidenceError(`${label} is not valid JSON`, code);
  }
}

function readIdsFile(filePath) {
  const { text } = readBoundedText(filePath, MAX_ID_FILE_BYTES, "INVALID_ID_LIST", "The ID file");
  return { ids: normalizeRequestIds(parseJson(text, "INVALID_ID_LIST", "The ID file"), "The ID file's release-group IDs"), originPlanSha256: null };
}

// Extracts the release groups an existing sealed backfill plan could not find
// in any input dataset. The plan's own seal and the operator-supplied digest
// must both match before any ID is trusted.
function readPlanNoSourceIds(filePath, expectedSha256) {
  const { text } = readBoundedText(filePath, MAX_PLAN_BYTES, "INVALID_PLAN", "The plan file");
  const plan = parseJson(text, "INVALID_PLAN", "The plan file");
  const planSha256 = verifySealedPlan(plan, expectedSha256);
  if (!Array.isArray(plan.noSource)) throw new EnrichmentEvidenceError("The plan has no noSource list", "INVALID_PLAN");
  const ids = normalizeRequestIds(plan.noSource.map((entry) => entry?.releaseGroupMbid), "The plan's noSource release-group IDs");
  return { ids, originPlanSha256: planSha256 };
}

function evidenceDigest(evidence) {
  const { evidenceSha256: _ignored, ...body } = evidence;
  return sha256(stableJson(body));
}

function datasetIdFor(generatedAt, digest) {
  const compact = generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase();
  return `musicbrainz-rg-credits-${compact}-${digest.slice(0, 12)}`;
}

// Credits must already be in the catalog importer's normalized form, so the
// backfill's exact name/join-phrase matching behaves exactly as it does for
// import datasets. Every credit must carry a valid canonical artist name.
function creditProblems(credits) {
  if (!Array.isArray(credits) || credits.length === 0 || credits.length > MAX_CREDITS) return [`credits must contain 1 to ${MAX_CREDITS} entries`];
  const problems = [];
  credits.forEach((credit, index) => {
    if (!exactKeys(credit, ["name", "joinPhrase", "artistMbid", "artistName"])) {
      problems.push(`credit ${index} must have exactly name, joinPhrase, artistMbid, and artistName`);
      return;
    }
    const { name, joinPhrase, artistMbid, artistName } = credit;
    if (typeof name !== "string" || !name || name.length > MAX_CREDIT_NAME_LENGTH || normalizeText(name) !== name) problems.push(`credit ${index} name is not a normalized credited name`);
    if (typeof joinPhrase !== "string" || joinPhrase.length > MAX_JOIN_PHRASE_LENGTH || normalizeJoinPhrase(joinPhrase) !== joinPhrase) problems.push(`credit ${index} joinPhrase is not normalized`);
    if (typeof artistMbid !== "string" || normalizeArtistMbid(artistMbid) !== artistMbid) problems.push(`credit ${index} artistMbid is not a lowercase MusicBrainz MBID`);
    let canonical = "";
    try { canonical = normalizeArtistName(artistName); } catch { /* reported below */ }
    if (!canonical || canonical !== artistName || normalizeText(artistName) !== artistName || artistName.length > MAX_ARTIST_NAME_LENGTH) {
      problems.push(`credit ${index} artistName is not a valid canonical artist name`);
    }
  });
  if (!problems.length) {
    const display = credits.map((credit) => `${credit.name}${credit.joinPhrase}`).join("");
    if (display.length > MAX_DISPLAY_NAME_LENGTH) problems.push(`combined credit display name exceeds ${MAX_DISPLAY_NAME_LENGTH} characters`);
  }
  return problems;
}

function resolvedRowProblems(row) {
  if (!exactKeys(row, ["releaseGroupMbid", "status", "observedAt", "title", "credits"])) return ["resolved result has missing or unknown fields"];
  const problems = [];
  if (!isIsoTimestamp(row.observedAt)) problems.push("observedAt is not an ISO timestamp");
  if (typeof row.title !== "string" || !row.title || row.title.length > MAX_TITLE_LENGTH || normalizeText(row.title) !== row.title) problems.push("title is not normalized text");
  return problems.concat(creditProblems(row.credits));
}

function unresolvedRowProblems(row) {
  if (!exactKeys(row, ["releaseGroupMbid", "status", "observedAt", "reason"], ["httpStatus", "destinationReleaseGroupMbid"])) return ["unresolved result has missing or unknown fields"];
  const problems = [];
  if (!isIsoTimestamp(row.observedAt)) problems.push("observedAt is not an ISO timestamp");
  if (!UNRESOLVED_REASONS.includes(row.reason)) problems.push(`unknown unresolved reason ${String(row.reason)}`);
  // An HTTP outcome records its status; other outcomes have none.
  const status = row.httpStatus;
  const statusValid = {
    NOT_FOUND: status === 404,
    REDIRECTED: Number.isInteger(status) && status >= 300 && status <= 399,
    HTTP_ERROR: Number.isInteger(status) && status >= 400 && status <= 599 && status !== 404,
  };
  if (Object.prototype.hasOwnProperty.call(statusValid, row.reason) ? !statusValid[row.reason] : status !== undefined) {
    problems.push(`httpStatus is invalid for ${String(row.reason)}`);
  }
  // An identity mismatch always names the returned release group; a redirect
  // names its destination only when the Location header identified one.
  if (row.reason === "ID_MISMATCH" && row.destinationReleaseGroupMbid === undefined) problems.push("an identity mismatch must name the returned release group");
  if (row.destinationReleaseGroupMbid !== undefined) {
    if (!["REDIRECTED", "ID_MISMATCH"].includes(row.reason)) problems.push("only a redirect or identity mismatch may name a destination");
    else if (normalizeArtistMbid(row.destinationReleaseGroupMbid) !== row.destinationReleaseGroupMbid || row.destinationReleaseGroupMbid === row.releaseGroupMbid) {
      problems.push("destinationReleaseGroupMbid is invalid");
    }
  }
  return problems;
}

function deferredRowProblems(row) {
  if (!exactKeys(row, ["releaseGroupMbid", "status", "observedAt", "reason", "attempts", "lastFailure"])) return ["deferred result has missing or unknown fields"];
  const problems = [];
  if (!isIsoTimestamp(row.observedAt)) problems.push("observedAt is not an ISO timestamp");
  if (!DEFERRED_REASONS.includes(row.reason)) problems.push(`unknown deferred reason ${String(row.reason)}`);
  if (!Number.isInteger(row.attempts) || row.attempts < 1 || row.attempts > MAX_ATTEMPTS) problems.push(`attempts must be 1 to ${MAX_ATTEMPTS}`);
  if (typeof row.lastFailure !== "string" || !LAST_FAILURE_PATTERN.test(row.lastFailure)) problems.push("lastFailure is invalid");
  return problems;
}

function resultProblems(row) {
  if (!isPlainObject(row)) return ["result must be an object"];
  if (normalizeArtistMbid(row.releaseGroupMbid) !== row.releaseGroupMbid) return ["releaseGroupMbid is not a lowercase MusicBrainz MBID"];
  if (row.status === "resolved") return resolvedRowProblems(row);
  if (row.status === "unresolved") return unresolvedRowProblems(row);
  if (row.status === "deferred") return deferredRowProblems(row);
  return [`unknown status ${String(row.status)}`];
}

function summarize(results) {
  const counts = { requested: results.length, resolved: 0, unresolved: 0, deferred: 0 };
  const failureReasons = { unresolved: {}, deferred: {} };
  for (const row of results) {
    counts[row.status] += 1;
    if (row.status !== "resolved") failureReasons[row.status][row.reason] = (failureReasons[row.status][row.reason] || 0) + 1;
  }
  return { counts, failureReasons };
}

function sealEvidence(evidence) {
  const body = JSON.parse(JSON.stringify(evidence));
  delete body.evidenceSha256;
  return { ...body, evidenceSha256: evidenceDigest(body) };
}

// Builds and seals evidence with exactly one result for each requested ID.
function buildEvidence({ ids, results, originPlanSha256 = null, generatedAt }) {
  const requested = normalizeRequestIds(ids);
  if (!isIsoTimestamp(generatedAt)) throw new EnrichmentEvidenceError("generatedAt must be an ISO timestamp", "INVALID_ENRICHMENT_EVIDENCE");
  if (!Array.isArray(results)) throw new EnrichmentEvidenceError("results must be an array", "INVALID_ENRICHMENT_EVIDENCE");
  const byId = new Map();
  for (const row of results) {
    if (!isPlainObject(row)) throw new EnrichmentEvidenceError("Every result must be an object", "INVALID_ENRICHMENT_EVIDENCE");
    if (byId.has(row.releaseGroupMbid)) throw new EnrichmentEvidenceError(`Duplicate result for ${row.releaseGroupMbid}`, "INVALID_ENRICHMENT_EVIDENCE");
    byId.set(row.releaseGroupMbid, row);
  }
  const ordered = requested.map((id) => {
    if (!byId.has(id)) throw new EnrichmentEvidenceError(`Missing result for ${id}`, "INVALID_ENRICHMENT_EVIDENCE");
    return byId.get(id);
  });
  if (byId.size !== requested.length) throw new EnrichmentEvidenceError("Results include IDs that were not requested", "INVALID_ENRICHMENT_EVIDENCE");
  const problems = ordered.flatMap((row) => resultProblems(row).map((problem) => `${row.releaseGroupMbid}: ${problem}`));
  if (problems.length) throw new EnrichmentEvidenceError(`Invalid enrichment result: ${problems[0]}`, "INVALID_ENRICHMENT_EVIDENCE", problems.slice(0, 50));
  const digest = requestDigest(requested);
  const { counts, failureReasons } = summarize(ordered);
  const evidence = sealEvidence({
    kind: EVIDENCE_KIND,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    datasetId: datasetIdFor(generatedAt, digest),
    generatedAt,
    request: { releaseGroupMbidsSha256: digest, count: requested.length, originPlanSha256 },
    source: { ...SOURCE },
    counts,
    failureReasons,
    results: ordered,
  });
  return validateEvidence(evidence);
}

// Full structural and semantic validation. Any problem rejects the whole
// artifact: partial evidence must never reach a plan.
function validateEvidence(evidence) {
  if (!isPlainObject(evidence) || evidence.kind !== EVIDENCE_KIND) {
    throw new EnrichmentEvidenceError(`The file is not ${EVIDENCE_KIND} evidence`, "INVALID_ENRICHMENT_EVIDENCE");
  }
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new EnrichmentEvidenceError(`Unsupported evidence schemaVersion ${String(evidence.schemaVersion)}`, "UNSUPPORTED_ENRICHMENT_VERSION");
  }
  const problems = [];
  if (!exactKeys(evidence, ["kind", "schemaVersion", "datasetId", "generatedAt", "request", "source", "counts", "failureReasons", "results", "evidenceSha256"])) {
    problems.push("evidence has missing or unknown top-level fields");
  }
  if (typeof evidence.evidenceSha256 !== "string" || !SHA256_PATTERN.test(evidence.evidenceSha256)) problems.push("evidenceSha256 is missing");
  else if (evidenceDigest(evidence) !== evidence.evidenceSha256) {
    throw new EnrichmentEvidenceError("The evidence was modified after it was sealed", "ENRICHMENT_CHECKSUM_MISMATCH");
  }
  if (!isIsoTimestamp(evidence.generatedAt)) problems.push("generatedAt is not an ISO timestamp");
  if (stableJson(evidence.source) !== stableJson(SOURCE)) problems.push("source does not describe the MusicBrainz release-group endpoint and CC0 license");
  const request = evidence.request;
  if (!exactKeys(request, ["releaseGroupMbidsSha256", "count", "originPlanSha256"])) problems.push("request has missing or unknown fields");
  else if (request.originPlanSha256 !== null && !(typeof request.originPlanSha256 === "string" && SHA256_PATTERN.test(request.originPlanSha256))) problems.push("request.originPlanSha256 is invalid");

  const results = Array.isArray(evidence.results) ? evidence.results : null;
  if (!results) problems.push("results must be an array");
  else {
    if (!results.length || results.length > MAX_REQUEST_IDS) problems.push(`results must contain 1 to ${MAX_REQUEST_IDS} entries`);
    results.forEach((row, index) => {
      for (const problem of resultProblems(row)) problems.push(`results[${index}]: ${problem}`);
      if (index > 0 && !(String(results[index - 1]?.releaseGroupMbid) < String(row?.releaseGroupMbid))) {
        problems.push(`results[${index}]: results must be sorted by releaseGroupMbid with no duplicates`);
      }
      // Nothing can be observed after the artifact was generated.
      if (isIsoTimestamp(evidence.generatedAt) && isIsoTimestamp(row?.observedAt) && row.observedAt > evidence.generatedAt) {
        problems.push(`results[${index}]: observedAt is later than generatedAt`);
      }
    });
    if (!problems.length) {
      const ids = results.map((row) => row.releaseGroupMbid);
      const digest = requestDigest(ids);
      if (request.releaseGroupMbidsSha256 !== digest || request.count !== ids.length) problems.push("results do not account for exactly the requested IDs");
      if (evidence.datasetId !== datasetIdFor(evidence.generatedAt, digest) || !DATASET_ID_PATTERN.test(evidence.datasetId)) problems.push("datasetId does not match the generation time and request");
      const { counts, failureReasons } = summarize(results);
      if (stableJson(evidence.counts) !== stableJson(counts)) problems.push("counts do not match the results");
      if (stableJson(evidence.failureReasons) !== stableJson(failureReasons)) problems.push("failureReasons do not match the results");
    }
  }
  if (problems.length) {
    throw new EnrichmentEvidenceError(`Invalid enrichment evidence: ${problems[0]}`, "INVALID_ENRICHMENT_EVIDENCE", problems.slice(0, 50));
  }
  return evidence;
}

// The seal is an integrity check, not a signature: anyone can reseal an edited
// or narrower artifact. Callers that act on reviewed evidence pin the exact
// evidenceSha256 that was reviewed, as backfill plans pin planSha256.
function readEvidenceFile(filePath, expectedEvidenceSha256) {
  const { resolved, text } = readBoundedText(filePath, MAX_EVIDENCE_BYTES, "INVALID_ENRICHMENT_EVIDENCE", "The evidence file");
  const evidence = validateEvidence(parseJson(text, "INVALID_ENRICHMENT_EVIDENCE", "The evidence file"));
  if (expectedEvidenceSha256 !== undefined && String(expectedEvidenceSha256).toLowerCase() !== evidence.evidenceSha256) {
    throw new EnrichmentEvidenceError("The evidence does not match the reviewed evidenceSha256", "ENRICHMENT_CHECKSUM_MISMATCH");
  }
  return { evidence, sourcePath: resolved, sha256: sha256(text) };
}

// Confirms that evidence was generated for exactly the noSource release
// groups of a given sealed plan, rather than merely labelled with it.
function assertEvidenceMatchesPlanIds(evidence, planIds, planSha256) {
  validateEvidence(evidence);
  const ids = normalizeRequestIds(planIds, "The plan's noSource release-group IDs");
  if (evidence.request.originPlanSha256 !== planSha256 || evidence.request.releaseGroupMbidsSha256 !== requestDigest(ids)) {
    throw new EnrichmentEvidenceError("The evidence was not generated from exactly this plan's noSource release groups", "ENRICHMENT_PLAN_MISMATCH");
  }
  return true;
}

function fsyncDirectory(fileSystem, directory) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, "r");
    fileSystem.fsyncSync(descriptor);
  } catch {
    // Some platforms cannot fsync a directory; the file itself is synced.
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

// Publishes atomically without ever replacing an existing file: the content
// is fully written and synced to a private temporary file, then hard-linked
// into place. link() fails if the destination exists, so a reviewed artifact
// is never overwritten, and the target never holds a partial write.
function publishEvidence(outPath, evidence, { fileSystem = fs } = {}) {
  validateEvidence(evidence);
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new EnrichmentEvidenceError(`Evidence exceeds ${MAX_EVIDENCE_BYTES} bytes and could not be read back`, "INVALID_ENRICHMENT_EVIDENCE");
  }
  const target = path.resolve(outPath);
  const directory = path.dirname(target);
  fileSystem.mkdirSync(directory, { recursive: true });
  if (fileSystem.existsSync(target)) throw new EnrichmentEvidenceError(`Evidence file already exists: ${target}`, "ARTIFACT_EXISTS");
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, text, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    try {
      fileSystem.linkSync(temporary, target);
    } catch (error) {
      if (error.code === "EEXIST") throw new EnrichmentEvidenceError(`Evidence file already exists: ${target}`, "ARTIFACT_EXISTS");
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes(error.code)) {
        throw new EnrichmentEvidenceError(`The --out filesystem does not support safe no-overwrite publication (hard links); choose a local directory (${error.code})`, "PUBLISH_UNSUPPORTED");
      }
      throw error;
    }
    fsyncDirectory(fileSystem, directory);
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch { /* ignore */ }
    }
    try { fileSystem.unlinkSync(temporary); } catch { /* already gone */ }
  }
  return target;
}

// Adapts validated evidence to the backfill's dataset-validation shape, and
// returns the unsuccessful lookups the plan reports as ENRICHMENT_UNRESOLVED.
function evidenceBackfillSource({ evidence, sourcePath = null, sha256: fileSha256 = null }) {
  validateEvidence(evidence);
  const validAlbums = [];
  const unresolved = new Map();
  evidence.results.forEach((row, index) => {
    if (row.status === "resolved") {
      validAlbums.push({
        index,
        observedAt: row.observedAt,
        row: { releaseGroupMbid: row.releaseGroupMbid, artistCredits: row.credits.map((credit) => ({ ...credit })) },
      });
    } else {
      const { releaseGroupMbid: _id, ...outcome } = row;
      unresolved.set(row.releaseGroupMbid, outcome);
    }
  });
  return {
    validation: {
      kind: EVIDENCE_KIND,
      evidenceSha256: evidence.evidenceSha256,
      dataset: { datasetId: evidence.datasetId, schemaVersion: evidence.schemaVersion },
      sourcePath,
      sha256: fileSha256,
      validAlbums,
      quarantined: [],
      unresolvedRows: evidence.counts.unresolved,
      deferredRows: evidence.counts.deferred,
    },
    unresolved,
  };
}

function evidenceExitCode(evidence) {
  return evidence.counts.resolved === evidence.counts.requested ? 0 : 2;
}

module.exports = {
  DEFERRED_REASONS,
  MAX_EVIDENCE_BYTES,
  EVIDENCE_KIND,
  EVIDENCE_SCHEMA_VERSION,
  EnrichmentEvidenceError,
  MAX_ATTEMPTS,
  MAX_CREDITS,
  MAX_REQUEST_IDS,
  SOURCE,
  UNRESOLVED_REASONS,
  assertEvidenceMatchesPlanIds,
  buildEvidence,
  creditProblems,
  evidenceBackfillSource,
  evidenceDigest,
  evidenceExitCode,
  isIsoTimestamp,
  normalizeRequestIds,
  publishEvidence,
  readEvidenceFile,
  readIdsFile,
  readPlanNoSourceIds,
  requestDigest,
  resolvedRowProblems,
  sealEvidence,
  validateEvidence,
};
