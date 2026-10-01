#!/usr/bin/env node

/*
 * Fill catalog albums that do not have artwork.  This command deliberately
 * lives outside the legacy migration flow: it is safe to run repeatedly on a
 * live catalog and never replaces a cover that appeared after the scan.
 */

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const { catalogRevisionOf } = require("../lib/listening/common");
const { carryCoverRevision } = require("../lib/listening/mappingRevisions");

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REPORT_PATH = path.resolve(".migration", "cover-backfill", "report.json");
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAA_COVER_PATTERN = /^https:\/\/coverartarchive\.org\/release\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/front-500$/i;

// Keep this filter in one place so the optimistic write and the initial scan
// have exactly the same definition of "missing".
const MISSING_COVER_FILTER = {
  $or: [
    { cover: { $exists: false } },
    { cover: null },
    { cover: "" },
    { cover: /^\s*$/ },
  ],
};

function missingCoverFilter() {
  return {
    $or: [
      { cover: { $exists: false } },
      { cover: null },
      { cover: "" },
      { cover: /^\s*$/ },
    ],
  };
}

const REASON_CODES = new Set([
  "no_identity",
  "conflicting_identity",
  "barcode_ambiguity",
  "no_approved_front",
  "no_500px_image",
  "transient_provider_failure",
  "invalid_response",
  "reference_conflict",
  "concurrent_update",
]);

const USAGE = `Usage:
  npm run catalog:backfill-covers -- [--dry-run]
  npm run catalog:backfill-covers -- --apply

Options:
  --dry-run       Resolve and report missing covers without writing (default)
  --apply         Apply resolved covers using optimistic concurrency guards
  --report <path> Write the JSON report to this path
  --help          Show this help`;

class CoverBackfillError extends Error {
  constructor(message, code = "COVER_BACKFILL_FAILED", details = []) {
    super(message);
    this.name = "CoverBackfillError";
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv = []) {
  const options = { apply: false, dryRun: true, report: "", help: false };
  const seen = new Set();
  let selectedMode = "";

  function valueFor(flag, index) {
    if (seen.has(flag)) throw new CoverBackfillError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new CoverBackfillError(`${flag} requires a value`, "INVALID_ARGUMENTS");
    seen.add(flag);
    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply" || argument === "--dry-run") {
      if (selectedMode && selectedMode !== argument) {
        throw new CoverBackfillError("--apply and --dry-run cannot be used together", "INVALID_ARGUMENTS");
      }
      if (selectedMode === argument) {
        throw new CoverBackfillError(`${argument} may only be supplied once`, "INVALID_ARGUMENTS");
      }
      selectedMode = argument;
      options.apply = argument === "--apply";
      options.dryRun = !options.apply;
    } else if (argument === "--report") {
      options.report = valueFor(argument, index);
      index += 1;
    } else if (argument === "--help") {
      if (options.help) throw new CoverBackfillError("--help may only be supplied once", "INVALID_ARGUMENTS");
      options.help = true;
    } else {
      throw new CoverBackfillError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
    }
  }
  return options;
}

function isBlankCover(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function plain(value) {
  if (value && typeof value.toObject === "function") return value.toObject({ depopulate: true, versionKey: false });
  return value || {};
}

function idString(value) {
  if (value === null || value === undefined) return "";
  return typeof value.toHexString === "function" ? value.toHexString() : String(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}

function normalizeMbid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MBID_PATTERN.test(normalized) ? normalized : "";
}

function canonicalReleaseReference(releaseMbid) {
  const normalized = normalizeMbid(releaseMbid);
  if (!normalized) return null;
  return {
    provider: "musicbrainz",
    entityType: "release",
    externalId: normalized,
    url: `https://musicbrainz.org/release/${normalized}`,
  };
}

function normalizedReference(reference) {
  const provider = String(reference?.provider || "").trim().toLowerCase();
  const entityType = String(reference?.entityType || "").trim().toLowerCase();
  const externalId = String(reference?.externalId || "").trim().toLowerCase();
  if (!provider || !entityType || !externalId) return null;
  return { provider, entityType, externalId, key: `${provider}|${entityType}|${externalId}` };
}

function exactCaseInsensitiveRegex(value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`, "i");
}

function sameDocument(left, right) {
  return idString(plain(left)._id) !== "" && idString(plain(left)._id) === idString(plain(right)._id);
}

function resolverModule() {
  try {
    // Resolve lazily so `--help` and injected test resolvers work while the
    // shared module is being developed or is unavailable in a partial deploy.
    return require("../lib/coverArtArchive"); // eslint-disable-line global-require
  } catch (error) {
    const unavailable = new CoverBackfillError(`Cover Art Archive resolver is unavailable: ${error.message}`, "RESOLVER_UNAVAILABLE");
    unavailable.cause = error;
    throw unavailable;
  }
}

function selectResolver(dependencies = {}) {
  if (dependencies.resolveCoverArt) return dependencies.resolveCoverArt;
  if (dependencies.resolver) return dependencies.resolver;
  const module = resolverModule();
  // Construct one resolver for the entire run.  In addition to avoiding
  // repeated setup, this preserves the resolver's shared MusicBrainz rate
  // gate across all four backfill workers.
  if (typeof module.createCoverArtResolver === "function") {
    const clock = typeof dependencies.clock === "function"
      ? dependencies.clock
      : typeof dependencies.now === "function"
        ? dependencies.now
        : () => (dependencies.now || new Date());
    return module.createCoverArtResolver({
      fetchFn: dependencies.fetchFn,
      sleepFn: dependencies.sleepFn,
      clock,
      userAgent: dependencies.userAgent,
    });
  }
  return module;
}

async function resolveQuery(query) {
  let resolved = query;
  if (resolved && typeof resolved.lean === "function") resolved = resolved.lean();
  if (resolved && typeof resolved.exec === "function") resolved = resolved.exec();
  return resolved;
}

async function invokeResolver(resolver, album, context) {
  if (typeof resolver === "function") return resolver(album, context);
  if (resolver && typeof resolver.resolveCoverArt === "function") return resolver.resolveCoverArt(album, context);
  if (resolver && typeof resolver.resolve === "function") return resolver.resolve(album, context);
  if (resolver && typeof resolver.resolveAlbumCover === "function") return resolver.resolveAlbumCover(album, context);
  throw new CoverBackfillError("Cover Art Archive resolver does not expose a resolver function", "RESOLVER_UNAVAILABLE");
}

function reasonCode(value, fallback = "invalid_response") {
  const normalized = String(value || "").trim().toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (REASON_CODES.has(normalized)) return normalized;
  if (normalized === "metadata_mismatch") return "conflicting_identity";
  if (["timeout", "network_error", "provider_failure", "retry_exhausted", "unavailable"].includes(normalized)) {
    return "transient_provider_failure";
  }
  if (["provider_http_error", "bad_response", "malformed_response"].includes(normalized)) {
    return "invalid_response";
  }
  return fallback;
}

function coverFromResolution(raw) {
  return String(
    raw?.cover
    || raw?.coverUrl
    || raw?.url500
    || raw?.canonicalUrl
    || raw?.url
    || raw?.image?.url500
    || raw?.image?.thumbnails?.["500"]
    || "",
  ).trim();
}

function normalizedResolution(raw, now) {
  const value = raw && typeof raw === "object" ? raw : {};
  const suppliedCover = coverFromResolution(value);
  const match = CAA_COVER_PATTERN.exec(suppliedCover);
  if (!match) {
    return {
      resolved: false,
      reason: reasonCode(
        value.reason || value.code,
        suppliedCover || value.resolved === true || value.status === "resolved" ? "invalid_response" : "no_identity",
      ),
      details: value.details || value.message || null,
    };
  }

  // Never persist a provider redirect, release-group alias, or a URL with a
  // non-canonical MBID spelling, even when an injected resolver supplied one.
  const coverMbid = normalizeMbid(match[1]);
  if (!coverMbid) {
    return { resolved: false, reason: "invalid_response", details: "Cover URL did not contain a valid release MBID" };
  }
  const cover = `https://coverartarchive.org/release/${coverMbid}/front-500`;

  const provenance = value.provenance && typeof value.provenance === "object" ? clone(value.provenance) : {};
  const claimedRelease = (
    value.sourceReleaseMbid
    || value.releaseMbid
    || value.sourceReleaseId
    || provenance.releaseMbid
    || (Array.isArray(value.derivedReferences)
      ? value.derivedReferences.find((reference) => (
        String(reference?.provider || "").toLowerCase() === "musicbrainz"
        && String(reference?.entityType || "").toLowerCase() === "release"
      ))?.externalId
      : "")
    || match[1]
  );
  const claimedReleaseMbid = normalizeMbid(claimedRelease);
  if (!claimedReleaseMbid || claimedReleaseMbid !== coverMbid) {
    return { resolved: false, reason: "invalid_response", details: "Cover URL and source release identity do not match" };
  }
  const releaseMbid = coverMbid;
  const groupMbid = normalizeMbid(value.releaseGroupMbid || value.groupMbid || provenance.releaseGroupMbid);
  const verifiedAt = value.verifiedAt || value.verifiedAtUtc || provenance.verifiedAt || isoDate(now);
  const coverProvenance = {
    ...provenance,
    source: "cover-art-archive",
    method: value.method || value.resolutionMethod || provenance.method || undefined,
    releaseGroupMbid: groupMbid || provenance.releaseGroupMbid || null,
    releaseMbid: releaseMbid || null,
    imageId: value.imageId ?? value.image?.id ?? provenance.imageId ?? null,
    size: 500,
    canonicalUrl: cover,
    verifiedAt,
  };
  Object.keys(coverProvenance).forEach((key) => {
    if (coverProvenance[key] === undefined) delete coverProvenance[key];
  });
  return {
    resolved: true,
    cover,
    releaseMbid,
    releaseGroupMbid: groupMbid,
    provenance: coverProvenance,
    raw: value,
    derivedReferences: Array.isArray(value.derivedReferences) ? clone(value.derivedReferences) : [],
  };
}

function sourceReleaseMbid(resolution) {
  return normalizeMbid(
    resolution?.releaseMbid
    || resolution?.raw?.sourceReleaseMbid
    || resolution?.raw?.releaseMbid
    || resolution?.provenance?.releaseMbid
    || resolution?.derivedReferences?.find((reference) => (
      String(reference?.provider || "").toLowerCase() === "musicbrainz"
      && String(reference?.entityType || "").toLowerCase() === "release"
    ))?.externalId,
  );
}

function buildReport({ mode, generatedAt, entries, scanned }) {
  const counts = {
    scanned,
    resolved: entries.filter((entry) => ["resolved", "updated"].includes(entry.status)).length,
    updated: entries.filter((entry) => entry.status === "updated").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    unresolved: entries.filter((entry) => entry.status === "unresolved").length,
    conflicts: entries.filter((entry) => entry.status === "conflict" || entry.reason === "reference_conflict").length,
    failures: entries.filter((entry) => entry.status === "failed").length,
    referenceConflicts: entries.filter((entry) => entry.reason === "reference_conflict").length,
    concurrentUpdates: entries.filter((entry) => entry.reason === "concurrent_update").length,
    revisionCarryFailures: entries.filter((entry) => entry.revisionCarryFailed).length,
  };
  return {
    reportVersion: "1.0.0",
    generatedAt,
    mode,
    applied: mode === "apply",
    fatal: false,
    counts,
    entries,
    // `outcomes` is a readable alias for consumers that do not know the
    // report's historical naming; both arrays intentionally have the same
    // object identity before serialization.
    outcomes: entries,
  };
}

function rowSummary(album) {
  const source = plain(album);
  return {
    _id: idString(source._id) || null,
    albumId: source.albumId || null,
    title: source.title || "",
    artistDisplayName: source.artistDisplayName || "",
    originalUpdatedAt: isoDate(source.updatedAt),
  };
}

function guardedFilter(album) {
  const source = plain(album);
  const filter = { _id: source._id, ...missingCoverFilter() };
  if (source.updatedAt === undefined) filter.updatedAt = { $exists: false };
  else filter.updatedAt = source.updatedAt;
  filter.catalogRevision = source.catalogRevision === undefined ? { $in: [null, 1] } : source.catalogRevision;
  return filter;
}

function resolutionContext(options, dependencies) {
  const clock = typeof dependencies.clock === "function"
    ? dependencies.clock
    : typeof dependencies.now === "function"
      ? dependencies.now
      : () => (dependencies.now || new Date());
  return {
    mode: options.apply ? "backfill" : "backfill-dry-run",
    profile: "backfill",
    timeoutMs: dependencies.timeoutMs || DEFAULT_TIMEOUT_MS,
    retries: dependencies.retries,
    now: clock,
    userAgent: dependencies.userAgent || process.env.MUSICBRAINZ_USER_AGENT,
  };
}

async function findReferenceOwner(Model, reference, dependencies = {}) {
  if (dependencies.findReferenceOwner) return dependencies.findReferenceOwner(reference);
  const normalized = normalizedReference(reference);
  if (!normalized) return null;
  const query = {
    externalReferences: {
      $elemMatch: {
        provider: "musicbrainz",
        entityType: "release",
        // MusicBrainz IDs are case-insensitive, while the historical catalog
        // schema did not lowercase externalId. Do not miss an uppercase owner.
        externalId: exactCaseInsensitiveRegex(normalized.externalId),
      },
    },
  };
  return resolveQuery(Model.findOne(query));
}

function isSuccessfulWrite(result) {
  if (!result || result.acknowledged === false) return false;
  const matched = result.matchedCount ?? result.n ?? result.result?.n;
  return matched === undefined || Number(matched) > 0;
}

function providerFailureEntry(base, error) {
  const message = String(error?.message || error || "").toLowerCase();
  const fallback = /invalid|malformed|response|json/.test(message)
    ? "invalid_response"
    : "transient_provider_failure";
  return {
    ...base,
    status: "failed",
    reason: reasonCode(error?.reason || error?.code, fallback),
    error: error?.message || String(error),
  };
}

async function processAlbum(album, { options, dependencies, Model, resolver, context }) {
  const base = rowSummary(album);
  let resolution;
  try {
    const raw = await invokeResolver(resolver, plain(album), context);
    resolution = normalizedResolution(raw, context.now());
  } catch (error) {
    // Resolver/provider failures are row-scoped. Database failures below are
    // deliberately rethrown because a partial database failure is fatal.
    return providerFailureEntry(base, error);
  }

  if (!resolution.resolved) {
    return {
      ...base,
      status: "unresolved",
      reason: resolution.reason,
      details: resolution.details,
    };
  }

  const reference = canonicalReleaseReference(sourceReleaseMbid(resolution));
  let referenceConflict = false;
  let appendReference = false;
  if (reference) {
    const existingReferences = Array.isArray(plain(album).externalReferences) ? plain(album).externalReferences : [];
    const existing = existingReferences.some((candidate) => {
      const normalized = normalizedReference(candidate);
      return normalized?.key === normalizedReference(reference).key;
    });
    if (!existing) {
      const owner = await findReferenceOwner(Model, reference, dependencies);
      if (owner && !sameDocument(owner, album)) referenceConflict = true;
      else appendReference = true;
    }
  }

  const result = {
    ...base,
    status: options.apply ? "updated" : "resolved",
    cover: resolution.cover,
    provenance: resolution.provenance,
    releaseGroupMbid: resolution.releaseGroupMbid || null,
    releaseMbid: resolution.releaseMbid || null,
  };
  if (referenceConflict) {
    // A release identity already owned by another catalog album is not safe
    // to publish on this row. Leave the cover untouched for a moderator to
    // resolve the identity collision manually.
    result.reason = "reference_conflict";
    result.referenceConflict = true;
    result.status = "conflict";
  }

  if (!options.apply || referenceConflict) return result;

  // Albums written before revisions were tracked have no stored field and
  // count as revision 1, so set the next revision explicitly; $inc on a
  // missing field would leave it at 1 and the carry below would find nothing.
  const fromRevision = catalogRevisionOf(plain(album));
  const update = {
    $set: {
      cover: resolution.cover,
      "fieldProvenance.cover": resolution.provenance,
      catalogRevision: fromRevision + 1,
    },
  };
  if (appendReference) update.$addToSet = { externalReferences: reference };
  let writeResult;
  try {
    writeResult = await Model.updateOne(guardedFilter(album), update, { runValidators: true });
  } catch (error) {
    if (appendReference && error?.code === 11000) {
      return {
        ...result,
        status: "conflict",
        reason: "reference_conflict",
        cover: undefined,
        provenance: undefined,
      };
    }
    throw error;
  }
  if (writeResult?.acknowledged === false) {
    throw new CoverBackfillError(`Database did not acknowledge the cover update for ${base._id}`, "DATABASE_WRITE_FAILED");
  }
  if (!isSuccessfulWrite(writeResult)) {
    return {
      ...result,
      status: "conflict",
      reason: "concurrent_update",
      cover: undefined,
      provenance: undefined,
    };
  }
  // A cover cannot change album identity or the reviewed tracklist, so the
  // reviewed baseline and active album mappings follow the album to its new
  // revision in one transaction. If that fails, the cover stays committed and
  // both stay stale (fail closed) until they are re-reviewed.
  const carry = dependencies.carryCoverRevision || (Model === AlbumCatalog ? carryCoverRevision : null);
  if (carry && base.albumId) {
    try {
      const carried = await carry({ albumId: base.albumId, fromRevision, toRevision: fromRevision + 1, now: context.now() });
      result.baselineCarried = Boolean(carried?.baselineCarried);
      result.mappingsCarried = Number(carried?.mappingsCarried || 0);
    } catch {
      result.revisionCarryFailed = true;
    }
  }
  return result;
}

async function listMissingAlbums(Model) {
  let query = Model.find(MISSING_COVER_FILTER);
  if (query && typeof query.sort === "function") query = query.sort({ _id: 1 });
  if (query && typeof query.lean === "function") query = query.lean();
  const rows = await resolveQuery(query);
  return [...(rows || [])].sort((left, right) => idString(plain(left)._id).localeCompare(idString(plain(right)._id)));
}

async function mapBounded(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, consume));
  return results;
}

async function runBackfill(options = {}, dependencies = {}) {
  const Model = dependencies.AlbumCatalog || AlbumCatalog;
  const rows = dependencies.albums || await listMissingAlbums(Model);
  // A clean rerun should succeed without loading provider code at all.
  const resolver = rows.length > 0 ? selectResolver(dependencies) : null;
  const now = typeof dependencies.now === "function"
    ? dependencies.now
    : () => (dependencies.now || new Date());
  const entries = await mapBounded(
    rows,
    Number(dependencies.concurrency) > 0 ? Number(dependencies.concurrency) : DEFAULT_CONCURRENCY,
    (album) => processAlbum(album, {
      options: { apply: Boolean(options.apply) },
      dependencies,
      Model,
      resolver,
      context: resolutionContext(options, dependencies),
    }),
  );
  return buildReport({
    mode: options.apply ? "apply" : "dry-run",
    generatedAt: isoDate(now()) || new Date().toISOString(),
    entries,
    scanned: rows.length,
  });
}

function jsonContents(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(target, value) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, jsonContents(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  return resolved;
}

function reportTarget(options) {
  return path.resolve(options.report || DEFAULT_REPORT_PATH);
}

function reportForError(error, mode) {
  return {
    reportVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    mode,
    applied: mode === "apply",
    fatal: true,
    counts: null,
    entries: [],
    error: {
      code: error.code || "COVER_BACKFILL_FAILED",
      message: error.message,
      details: error.details || [],
    },
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  let options;
  let target;
  let connectedHere = false;
  const db = dependencies.mongoose || mongoose;
  try {
    options = parseArgs(argv);
    if (options.help) {
      output.log(USAGE);
      return 0;
    }
    target = reportTarget(options);
    if (db.connection?.readyState !== 1 && !dependencies.skipConnect) {
      const mongoUri = dependencies.mongoUri || process.env.MONGO_URI;
      if (!mongoUri) throw new CoverBackfillError("MONGO_URI is required", "MISSING_MONGO_URI");
      await db.connect(mongoUri);
      connectedHere = true;
    }
    const report = await runBackfill(options, dependencies);
    const written = writeJsonAtomic(target, report);
    output.log(JSON.stringify({ mode: report.mode, counts: report.counts, report: written }, null, 2));
    const hasIssues = report.counts.unresolved > 0 || report.counts.conflicts > 0 || report.counts.failures > 0 || report.counts.revisionCarryFailures > 0;
    return hasIssues ? 2 : 0;
  } catch (error) {
    if (target) {
      try {
        writeJsonAtomic(target, reportForError(error, options?.apply ? "apply" : "dry-run"));
      } catch (reportError) {
        output.error(`Could not write fatal cover backfill report: ${reportError.message}`);
      }
    }
    output.error(`${error.code || "COVER_BACKFILL_FAILED"}: ${error.message}`);
    return 1;
  } finally {
    if (connectedHere && typeof db.disconnect === "function") await db.disconnect();
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  CAA_COVER_PATTERN,
  CoverBackfillError,
  DEFAULT_CONCURRENCY,
  DEFAULT_REPORT_PATH,
  MISSING_COVER_FILTER,
  USAGE,
  buildReport,
  canonicalReleaseReference,
  guardedFilter,
  isBlankCover,
  main,
  mapBounded,
  normalizedResolution,
  parseArgs,
  parseBackfillArgs: parseArgs,
  runBackfill,
  runCoverBackfill: runBackfill,
  writeJsonAtomic,
};
