// Shared contracts for read-only mapping measurement: the versioned exposure manifest, cohort
// windows, aggregate metric shapes, collection budgets and an output privacy guard. See
// docs/DETERMINISTIC_MAPPING_METRICS_PLAN.md for the definitions these implement.
const crypto = require("node:crypto");

const MEASUREMENT_SCHEMA_VERSION = 2;
const COLLECTOR_VERSION = 2;
const DAY_MS = 86_400_000;
// Conservative starting bounds from the plan; validate them against each target before relying on them.
const COLLECTION_LIMITS = Object.freeze({ pageSize: 500, maxRecords: 10_000, maxTimeMS: 5_000, wallMs: 60_000 });

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/u;
const LABEL = /^[\w.-]{1,80}$/u;
const REVISION = /^[0-9a-f]{7,40}$/iu;
const CHECKSUM = /^[0-9a-f]{64}$/iu;
const SNAPSHOT_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
// Values that must never be copied into a manifest or report.
const CREDENTIAL = /mongodb(?:\+srv)?:\/\/|\/\/[^\s/:@]+:[^\s/@]+@|[?&](?:password|token|key|secret)=/iu;
// observations: when a worker that writes discovery attempts and pair observations began running.
const EXPOSURES = ["pr32", "pr33", "observations"];
// Confirmed November 1, 2026 and frozen for the study: 14-day intake, 7-day follow-up, daily 06:00 UTC snapshot.
const CONFIRMED_WINDOWS = Object.freeze({ intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "06:00" });
const DEPLOYMENTS = ["backend", "worker", "frontend"];

class ManifestError extends Error {
  constructor(problems) { super(`Invalid measurement manifest: ${problems.join("; ")}`); this.name = "ManifestError"; this.problems = problems; }
}

function manifestTemplate() {
  return {
    schemaVersion: MEASUREMENT_SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
    environment: "ENVIRONMENT_LABEL",
    study: "deterministic-mapping",
    sourceCommit: null,
    deployments: { backend: null, worker: null, frontend: null },
    exposures: {
      pr32: { activatedAt: null, rollbackAt: null, verification: "" },
      pr33: { activatedAt: null, rollbackAt: null, verification: "" },
      observations: { activatedAt: null, rollbackAt: null, verification: "" },
    },
    flags: {},
    allowlistScopeVersion: "",
    targetVerification: "",
    windows: { ...CONFIRMED_WINDOWS },
    collection: { startAt: null, endAt: null },
    evidence: { location: "", checksum: null },
  };
}

// Problems may be printed, so unexpected key text is echoed only when it is a plain short name.
const keyLabel = (key) => /^[\w.-]{1,40}$/u.test(key) && !CREDENTIAL.test(key) ? key : "<unrecognized key>";
function checkKeys(value, allowed, path, problems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { problems.push(`${path} must be an object`); return false; }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${path}.${keyLabel(key)} is not a manifest field`);
  return true;
}
function instant(value, path, problems, { nullable = true } = {}) {
  if (value === null && nullable) return null;
  const parsed = typeof value === "string" && ISO_INSTANT.test(value) ? new Date(value) : null;
  // Date accepts impossible calendar dates such as February 31 and rolls them over; reject them.
  const calendar = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 16) === value.slice(0, 16);
  if (!calendar) { problems.push(`${path} must be a UTC ISO instant${nullable ? " or null" : ""}`); return null; }
  return parsed;
}
function text(value, path, problems, max = 500) {
  if (typeof value !== "string" || value.length > max) problems.push(`${path} must be text of at most ${max} characters`);
}
function revision(value, path, problems) {
  if (value !== null && !(typeof value === "string" && REVISION.test(value))) problems.push(`${path} must be a Git revision or null`);
}

// Validates a manifest without connecting to anything. Unverified facts stay null; they limit the
// claims a report can make rather than blocking collection.
function validateManifest(manifest) {
  const problems = [];
  if (!checkKeys(manifest, Object.keys(manifestTemplate()), "manifest", problems)) throw new ManifestError(problems);
  if (manifest.schemaVersion !== MEASUREMENT_SCHEMA_VERSION) problems.push(`schemaVersion must be ${MEASUREMENT_SCHEMA_VERSION}`);
  if (manifest.collectorVersion !== COLLECTOR_VERSION) problems.push(`collectorVersion must be ${COLLECTOR_VERSION}`);
  if (typeof manifest.environment !== "string" || !LABEL.test(manifest.environment) || manifest.environment === "ENVIRONMENT_LABEL") problems.push("environment must be a label naming the verified target");
  if (typeof manifest.study !== "string" || !LABEL.test(manifest.study)) problems.push("study must be a label");
  revision(manifest.sourceCommit, "sourceCommit", problems);
  if (checkKeys(manifest.deployments, DEPLOYMENTS, "deployments", problems)) for (const name of DEPLOYMENTS) revision(manifest.deployments[name] ?? null, `deployments.${name}`, problems);
  const exposures = {};
  if (checkKeys(manifest.exposures, EXPOSURES, "exposures", problems)) {
    for (const name of EXPOSURES) {
      const entry = manifest.exposures[name];
      if (!checkKeys(entry, ["activatedAt", "rollbackAt", "verification"], `exposures.${name}`, problems)) continue;
      const activatedAt = instant(entry.activatedAt ?? null, `exposures.${name}.activatedAt`, problems);
      const rollbackAt = instant(entry.rollbackAt ?? null, `exposures.${name}.rollbackAt`, problems);
      text(entry.verification ?? "", `exposures.${name}.verification`, problems);
      if (rollbackAt && !activatedAt) problems.push(`exposures.${name}.rollbackAt needs activatedAt`);
      if (activatedAt && rollbackAt && rollbackAt <= activatedAt) problems.push(`exposures.${name}.rollbackAt must follow activatedAt`);
      if (activatedAt && !String(entry.verification || "").trim()) problems.push(`exposures.${name}.verification must say how activation was verified`);
      exposures[name] = { activatedAt, rollbackAt };
    }
  }
  if (manifest.flags && typeof manifest.flags === "object" && !Array.isArray(manifest.flags)) {
    for (const [name, value] of Object.entries(manifest.flags)) {
      if (!/^[A-Z][A-Z0-9_]{1,80}$/u.test(name) || typeof value !== "boolean") problems.push(`flags.${keyLabel(name)} must be an upper-case flag name with a boolean value`);
    }
  } else problems.push("flags must be an object");
  text(manifest.allowlistScopeVersion, "allowlistScopeVersion", problems, 80);
  text(manifest.targetVerification, "targetVerification", problems);
  // The study's windows are frozen; a different value needs an explicit revised observation plan.
  if (checkKeys(manifest.windows, ["intakeDays", "followUpDays", "snapshotTimeUtc"], "windows", problems)) {
    const { intakeDays, followUpDays, snapshotTimeUtc } = manifest.windows;
    if (!Number.isInteger(intakeDays) || intakeDays < 1 || intakeDays > 90) problems.push("windows.intakeDays must be an integer from 1 to 90");
    if (!Number.isInteger(followUpDays) || followUpDays < 1 || followUpDays > 90) problems.push("windows.followUpDays must be an integer from 1 to 90");
    if (typeof snapshotTimeUtc !== "string" || !SNAPSHOT_TIME.test(snapshotTimeUtc)) problems.push("windows.snapshotTimeUtc must be HH:MM in UTC");
    if (Object.entries(CONFIRMED_WINDOWS).some(([key, value]) => manifest.windows[key] !== value)) problems.push("windows must match the confirmed study windows (14-day intake, 7-day follow-up, 06:00 UTC)");
  }
  let collection = { startAt: null, endAt: null };
  if (checkKeys(manifest.collection, ["startAt", "endAt"], "collection", problems)) {
    collection = { startAt: instant(manifest.collection.startAt ?? null, "collection.startAt", problems), endAt: instant(manifest.collection.endAt ?? null, "collection.endAt", problems) };
    if (collection.startAt && collection.endAt && collection.endAt <= collection.startAt) problems.push("collection.endAt must follow collection.startAt");
  }
  if (checkKeys(manifest.evidence, ["location", "checksum"], "evidence", problems)) {
    text(manifest.evidence.location ?? "", "evidence.location", problems);
    if (manifest.evidence.checksum !== null && !(typeof manifest.evidence.checksum === "string" && CHECKSUM.test(manifest.evidence.checksum))) problems.push("evidence.checksum must be a SHA-256 hex digest or null");
  }
  if (CREDENTIAL.test(JSON.stringify(manifest))) problems.push("manifest must not contain connection strings or credentials");
  if (problems.length) throw new ManifestError(problems);
  return { ...manifest, parsed: { exposures, collection } };
}

function manifestChecksum(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const iso = (value) => value ? value.toISOString() : null;

// Half-open intake intervals around a verified activation, from the frozen manifest windows.
// A baseline intake whose follow-up crosses activation is mixed exposure; the shifted baseline
// ends one follow-up period earlier so its follow-up finishes before activation.
function cohortWindows(exposure, windows, cutoff) {
  if (!windows) return { status: "windows_unconfirmed" };
  if (!exposure?.activatedAt) return { status: "exposure_unverified", claim: "prospective_only" };
  const at = exposure.activatedAt.getTime();
  const intake = windows.intakeDays * DAY_MS; const followUp = windows.followUpDays * DAY_MS;
  const postFollowUpEnd = at + intake + followUp;
  const rollbackInside = Boolean(exposure.rollbackAt && exposure.rollbackAt.getTime() < postFollowUpEnd);
  return {
    status: "defined",
    activatedAt: iso(exposure.activatedAt),
    baselineIntake: { from: iso(new Date(at - intake)), to: iso(new Date(at)), followUpCrossesActivation: true },
    shiftedBaselineIntake: { from: iso(new Date(at - intake - followUp)), to: iso(new Date(at - followUp)) },
    postIntake: { from: iso(new Date(at)), to: iso(new Date(at + intake)) },
    postFollowUpEnd: iso(new Date(postFollowUpEnd)),
    followUpComplete: Boolean(cutoff && cutoff.getTime() >= postFollowUpEnd),
    rollbackInsidePostWindow: rollbackInside,
  };
}

// The intake for prospective observation records. Records exist only after the observation worker
// started, so a PR33 activation before then yields a prospective intake from the records' start.
// No catalog jobs exist before PR33, so there is no PR33 baseline intake for these records.
function observationIntake(exposures, windows) {
  if (!windows) return { status: "windows_unconfirmed" };
  const records = exposures.observations?.activatedAt;
  if (!records) return { status: "observation_records_unverified" };
  const pr33 = exposures.pr33?.activatedAt;
  const post = Boolean(pr33 && pr33 >= records);
  const from = post ? pr33 : records;
  const to = new Date(from.getTime() + windows.intakeDays * DAY_MS);
  const followUpEnd = to.getTime() + windows.followUpDays * DAY_MS;
  // Records stop when the observation worker rolls back, which would turn missing runs into "not executed".
  if (exposures.observations.rollbackAt && exposures.observations.rollbackAt.getTime() < followUpEnd) return { status: "observation_records_rolled_back" };
  return {
    status: "defined", basis: post ? "post_pr33_activation" : "prospective_after_observation_records",
    from, to, followUpMs: windows.followUpDays * DAY_MS,
    baseline: "not_applicable_no_catalog_jobs_before_pr33",
    pr33RollbackInsideFollowUp: Boolean(exposures.pr33?.rollbackAt && exposures.pr33.rollbackAt.getTime() < followUpEnd),
  };
}

// Whether an entry has its full follow-up by the cutoff. Exits stay in the cohort as competing
// outcomes; entries without full follow-up are censored, never failures.
function followUpStatus(entryAt, cutoff, followUpMs) {
  if (!entryAt) return "unknown_entry";
  return cutoff.getTime() - entryAt.getTime() >= followUpMs ? "mature" : "censored";
}

// A proportion always carries its numerator, denominator and unit; 0/0 is null, not zero.
function ratio(numerator, denominator, unit) {
  return { unit, numerator, denominator, value: denominator ? numerator / denominator : null };
}

// Categories must partition the total; the check is printed rather than assumed.
function partition(counts, total) {
  const sum = Object.values(counts).reduce((acc, value) => acc + value, 0);
  return { ...counts, total, reconciles: sum === total };
}

function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (share) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]) : null;
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.length ? Math.round(sorted[sorted.length - 1]) : null };
}

class BudgetExceeded extends Error {
  constructor(reason) { super(reason); this.name = "BudgetExceeded"; this.reason = reason; }
}

// Counts materialized records and wall time for one collection run. Exceeding either stops the
// run; the caller reports the affected section as not collected instead of a partial cohort.
function createBudget({ maxRecords = COLLECTION_LIMITS.maxRecords, wallMs = COLLECTION_LIMITS.wallMs, clock = () => Date.now() } = {}) {
  const startedAt = clock();
  let records = 0;
  const check = () => { if (clock() - startedAt > wallMs) throw new BudgetExceeded("wall_time_budget_exhausted"); };
  return {
    take(count) {
      records += count;
      if (records > maxRecords) throw new BudgetExceeded("record_budget_exhausted");
      check();
    },
    check,
    elapsed: () => clock() - startedAt,
    get records() { return records; },
    limits: { maxRecords, wallMs },
  };
}

const OBJECT_ID = /\b[0-9a-f]{24}\b/iu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
// Revision and checksum fields legitimately hold hex digests.
const HEX_FIELDS = new Set(["sourceCommit", "backend", "worker", "frontend", "checksum", "manifestChecksum"]);

// Defense in depth for aggregate-only output: rejects any string that looks like an internal or
// public record identifier, and any value equal to a known private identifier.
function assertAggregateOnly(report, privateValues = []) {
  const forbidden = new Set(privateValues.filter(Boolean).map(String));
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (forbidden.has(value) || (!HEX_FIELDS.has(key) && (OBJECT_ID.test(value) || UUID.test(value)))) throw new Error("MEASUREMENT_OUTPUT_CONTAINS_IDENTIFIER");
      if (CREDENTIAL.test(value)) throw new Error("MEASUREMENT_OUTPUT_CONTAINS_CREDENTIAL");
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === "object") for (const [child, item] of Object.entries(value)) walk(item, child);
  };
  walk(report, "");
  return report;
}

module.exports = {
  COLLECTION_LIMITS, COLLECTOR_VERSION, CONFIRMED_WINDOWS, DAY_MS, MEASUREMENT_SCHEMA_VERSION,
  BudgetExceeded, ManifestError,
  assertAggregateOnly, cohortWindows, createBudget, followUpStatus, observationIntake, manifestChecksum, manifestTemplate, partition, percentiles, ratio, validateManifest,
};
