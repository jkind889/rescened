const crypto = require("node:crypto");
const path = require("node:path");
const {
  artistMbidOf,
  creditIdentity,
  loadArtistsById,
  loadArtistsByMbid,
  newArtistDocument,
  normalizeArtistId,
  normalizeArtistMbid,
} = require("./identity");

// Dry-run-first backfill that links existing catalog credits to Rescened
// artist IDs using the MusicBrainz artist MBIDs recorded in reviewed catalog
// import datasets. Albums are matched only by MusicBrainz release-group ID,
// and credits only by exact position and name. Anything else is flagged.
const PLAN_KIND = "rescened-artist-identity-backfill";
const PLAN_VERSION = "1.0.0";
const ACTOR = "system:artist-identity-backfill";
const USER_OWNED_SOURCES = new Set(["community", "manual"]);

class ArtistBackfillError extends Error {
  constructor(message, code = "ARTIST_BACKFILL_FAILED", details = []) {
    super(message);
    this.name = "ArtistBackfillError";
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function planDigest(plan) {
  const { planSha256: _ignored, ...body } = plan;
  return crypto.createHash("sha256").update(stableJson(body), "utf8").digest("hex");
}

function sealPlan(plan) {
  const body = clone(plan);
  delete body.planSha256;
  return { ...body, planSha256: planDigest(body) };
}

function verifySealedPlan(plan, expectedSha256) {
  if (!plan || plan.kind !== PLAN_KIND || plan.planVersion !== PLAN_VERSION) {
    throw new ArtistBackfillError("The file is not a supported artist identity backfill plan", "INVALID_PLAN");
  }
  const actual = planDigest(plan);
  if (plan.planSha256 !== actual) {
    throw new ArtistBackfillError("The plan was modified after it was sealed", "PLAN_CHECKSUM_MISMATCH");
  }
  if (String(expectedSha256 || "").toLowerCase() !== actual) {
    throw new ArtistBackfillError("--plan-sha256 does not match the reviewed plan", "PLAN_CHECKSUM_MISMATCH");
  }
  return actual;
}

function parseBackfillArgs(argv = []) {
  const options = { mode: "plan", inputs: [], out: "", plan: "", planSha256: "", confirmTarget: "", report: "", help: false };
  const seen = new Set();
  let explicitMode = "";
  const takeValue = (flag, index, repeatable = false) => {
    if (!repeatable && seen.has(flag)) throw new ArtistBackfillError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ArtistBackfillError(`${flag} requires a value`, "INVALID_ARGUMENTS");
    seen.add(flag);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan-only" || argument === "--dry-run" || argument === "--apply") {
      const mode = argument === "--apply" ? "apply" : "plan";
      if (explicitMode && explicitMode !== mode) throw new ArtistBackfillError("--apply cannot be combined with --dry-run", "INVALID_ARGUMENTS");
      explicitMode = mode;
      options.mode = mode;
    } else if (argument === "--input") {
      options.inputs.push(takeValue(argument, index, true));
      index += 1;
    } else if (argument === "--out") {
      options.out = takeValue(argument, index);
      index += 1;
    } else if (argument === "--plan") {
      options.plan = takeValue(argument, index);
      index += 1;
    } else if (argument === "--plan-sha256") {
      options.planSha256 = takeValue(argument, index).toLowerCase();
      index += 1;
    } else if (argument === "--confirm-target") {
      options.confirmTarget = takeValue(argument, index);
      index += 1;
    } else if (argument === "--report") {
      options.report = takeValue(argument, index);
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new ArtistBackfillError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
    }
  }
  if (options.help) return options;
  if (options.mode === "plan") {
    if (!options.inputs.length) throw new ArtistBackfillError("At least one --input dataset is required", "INVALID_ARGUMENTS");
    if (!options.out) throw new ArtistBackfillError("--out <plan.json> is required", "INVALID_ARGUMENTS");
    if (options.plan || options.planSha256 || options.confirmTarget || options.report) {
      throw new ArtistBackfillError("--plan, --plan-sha256, --confirm-target, and --report are apply-only options", "INVALID_ARGUMENTS");
    }
  } else {
    if (options.inputs.length || options.out) {
      throw new ArtistBackfillError("--apply reads only the sealed plan; do not pass --input or --out", "INVALID_ARGUMENTS");
    }
    for (const [flag, value] of [["--plan", options.plan], ["--plan-sha256", options.planSha256], ["--confirm-target", options.confirmTarget], ["--report", options.report]]) {
      if (!value) throw new ArtistBackfillError(`${flag} is required with --apply`, "INVALID_ARGUMENTS");
    }
    if (!/^[0-9a-f]{64}$/.test(options.planSha256)) throw new ArtistBackfillError("--plan-sha256 must be a SHA-256 hex digest", "INVALID_ARGUMENTS");
  }
  return options;
}

function canonicalName(value) {
  return String(value ?? "").normalize("NFC").trim();
}

function sourceCredits(row) {
  return (row.artistCredits || []).map((credit) => ({
    artistMbid: normalizeArtistMbid(credit.artistMbid),
    name: String(credit.name || ""),
    joinPhrase: String(credit.joinPhrase || ""),
  }));
}

// Indexes dataset rows by release-group MBID. If two datasets describe the
// same release group with different credits, that release group is a source
// conflict and every album that claims it is flagged.
function buildSourceIndex(validations) {
  const index = new Map();
  const inputs = [];
  for (const validation of validations) {
    const dataset = validation.dataset || {};
    inputs.push({
      file: validation.sourcePath ? path.basename(validation.sourcePath) : null,
      datasetId: dataset.datasetId || null,
      schemaVersion: dataset.schemaVersion || null,
      sha256: validation.sha256 || null,
      validRows: (validation.validAlbums || []).length,
      quarantinedRows: (validation.quarantined || []).length,
    });
    for (const item of validation.validAlbums || []) {
      const releaseGroupMbid = normalizeArtistMbid(item.row?.releaseGroupMbid);
      if (!releaseGroupMbid) continue;
      const credits = sourceCredits(item.row);
      const source = { datasetId: dataset.datasetId || null, rowIndex: item.index };
      const current = index.get(releaseGroupMbid);
      if (!current) {
        index.set(releaseGroupMbid, { credits, sources: [source], conflict: false });
      } else {
        current.sources.push(source);
        if (stableJson(current.credits) !== stableJson(credits)) current.conflict = true;
      }
    }
  }
  return { index, inputs };
}

function releaseGroupMbids(album) {
  return [...new Set((album.externalReferences || [])
    .filter((reference) => String(reference?.provider || "").toLowerCase() === "musicbrainz"
      && String(reference?.entityType || "").toLowerCase() === "release-group")
    .map((reference) => normalizeArtistMbid(reference.externalId))
    .filter(Boolean))];
}

// Credits owned by a contributor or moderator are never rewritten by this
// automated backfill. A row with no credit provenance is treated as
// user-owned unless the whole album came from the importer.
function creditOwnership(album) {
  const entry = album.fieldProvenance?.artistCredits;
  const source = String((typeof entry === "string" ? entry : entry?.source) || "").toLowerCase();
  if (USER_OWNED_SOURCES.has(source)) return { userOwned: true, source };
  if (source) return { userOwned: false, source };
  const catalogSource = String(album.catalogSource || "community").toLowerCase();
  return catalogSource === "import"
    ? { userOwned: false, source: "import (no credit provenance)" }
    : { userOwned: true, source: `${catalogSource} (no credit provenance)` };
}

function nameMatches(catalogName, credit) {
  const name = canonicalName(catalogName);
  // Legacy migrations folded MusicBrainz join phrases into credit names
  // ("A with "). Accept that exact form; never fuzzy-match.
  return name === canonicalName(credit.name) || name === canonicalName(`${credit.name}${credit.joinPhrase}`);
}

function storedRevision(album) {
  const value = album.catalogRevision;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function flag(album, releaseGroupMbid, code, message, details = {}) {
  return { albumId: album.albumId, title: album.title || "", releaseGroupMbid: releaseGroupMbid || null, code, message, details };
}

// Classifies one album without touching the database. `artistsByMbid` is the
// registry state; `artistsById` resolves identities already on credits.
function classifyAlbum(album, sourceIndex, { artistsByMbid, artistsById }) {
  const groups = releaseGroupMbids(album);
  if (groups.length === 0) return { kind: "noReleaseGroup" };
  if (groups.length > 1) {
    return { kind: "flagged", entry: flag(album, null, "MULTIPLE_RELEASE_GROUPS", "Album has more than one MusicBrainz release-group reference", { releaseGroupMbids: groups }) };
  }
  const [releaseGroupMbid] = groups;
  const source = sourceIndex.get(releaseGroupMbid);
  if (!source) return { kind: "noSource", entry: { albumId: album.albumId, releaseGroupMbid } };
  if (source.conflict) {
    return { kind: "flagged", entry: flag(album, releaseGroupMbid, "SOURCE_CONFLICT", "Input datasets disagree about this release group's credits", { sources: source.sources }) };
  }
  if (!source.credits.length || source.credits.some((credit) => !credit.artistMbid)) {
    return { kind: "flagged", entry: flag(album, releaseGroupMbid, "INVALID_SOURCE_CREDIT", "A dataset credit for this release group has no valid MusicBrainz artist MBID", { sources: source.sources }) };
  }

  const ownership = creditOwnership(album);
  const credits = Array.isArray(album.artistCredits) ? album.artistCredits : [];
  const userOwned = ownership.userOwned ? { userOwned: true, provenance: ownership.source } : {};
  if (credits.length !== source.credits.length) {
    return {
      kind: "flagged",
      entry: flag(album, releaseGroupMbid, "CREDIT_COUNT_MISMATCH", "Catalog and dataset have a different number of artist credits", {
        catalogNames: credits.map((credit) => credit.name),
        sourceNames: source.credits.map((credit) => credit.name),
        ...userOwned,
      }),
    };
  }
  const mismatched = credits
    .map((credit, index) => (nameMatches(credit.name, source.credits[index]) ? null : { index, catalogName: credit.name, sourceName: source.credits[index].name }))
    .filter(Boolean);
  if (mismatched.length) {
    return {
      kind: "flagged",
      entry: flag(album, releaseGroupMbid, "CREDIT_NAME_MISMATCH", "A catalog credit name does not exactly match the dataset credit at the same position", { positions: mismatched, ...userOwned }),
    };
  }

  const identityConflicts = [];
  credits.forEach((credit, index) => {
    const expectedMbid = source.credits[index].artistMbid;
    const { artistId, artistMbid } = creditIdentity(credit);
    const registered = artistsByMbid.get(expectedMbid);
    if (artistMbid && artistMbid !== expectedMbid) {
      identityConflicts.push({ index, reason: "credit has a different MusicBrainz artist", creditArtistMbid: artistMbid, sourceArtistMbid: expectedMbid });
    } else if (artistId && registered && registered.artistId !== artistId) {
      identityConflicts.push({ index, reason: "credit artistId differs from the registry artist for this MBID", creditArtistId: artistId, registryArtistId: registered.artistId });
    } else if (artistId && !registered) {
      const holder = artistsById.get(artistId);
      identityConflicts.push({
        index,
        reason: holder ? "credit artistId belongs to an artist with a different MusicBrainz identity" : "credit artistId is not in the registry",
        creditArtistId: artistId,
        registryArtistMbid: holder ? artistMbidOf(holder) || null : null,
      });
    }
  });
  if (identityConflicts.length) {
    return { kind: "flagged", entry: flag(album, releaseGroupMbid, "EXISTING_IDENTITY_CONFLICT", "A catalog credit already carries a different identity", { positions: identityConflicts, ...userOwned }) };
  }

  const alreadyLinked = credits.every((credit, index) => {
    const { artistId, artistMbid } = creditIdentity(credit);
    const registered = artistsByMbid.get(source.credits[index].artistMbid);
    return artistMbid === source.credits[index].artistMbid && registered && artistId === registered.artistId;
  });
  if (alreadyLinked) return { kind: "unchanged", entry: { albumId: album.albumId, releaseGroupMbid } };

  if (ownership.userOwned) {
    return {
      kind: "review",
      entry: {
        albumId: album.albumId,
        title: album.title || "",
        releaseGroupMbid,
        code: "USER_OWNED_CREDITS",
        message: "Credits are contributor- or moderator-owned; link them through a reviewed catalog correction",
        provenance: ownership.source,
        proposedIdentities: credits.map((credit, index) => ({
          index,
          name: credit.name,
          artistMbid: source.credits[index].artistMbid,
          registryArtistId: artistsByMbid.get(source.credits[index].artistMbid)?.artistId || null,
        })),
      },
    };
  }
  return { kind: "link", releaseGroupMbid, source, credits };
}

// Keeps every existing credit key and value (name, role, order) and adds only
// the identity pair.
function linkedCredit(credit, artistId, artistMbid) {
  const next = clone(credit);
  next.artistId = artistId;
  next.artistMbid = artistMbid;
  return next;
}

function buildPlan({ albums, validations, artistsByMbid, artistsById, databaseName, now = new Date(), newArtistId = () => crypto.randomUUID() }) {
  if (!databaseName) throw new ArtistBackfillError("The target database name is required", "MISSING_TARGET");
  const { index, inputs } = buildSourceIndex(validations);
  const sorted = [...albums].sort((left, right) => String(left.albumId).localeCompare(String(right.albumId)));
  const registrations = new Map();
  const reused = new Map();
  const plan = {
    kind: PLAN_KIND,
    planVersion: PLAN_VERSION,
    generatedAt: now.toISOString(),
    target: { databaseName },
    inputs,
    counts: {},
    artistRegistrations: [],
    reusedArtists: [],
    albumUpdates: [],
    review: [],
    flagged: [],
    unchanged: [],
    noSource: [],
  };
  let withoutReleaseGroup = 0;

  for (const album of sorted) {
    const result = classifyAlbum(album, index, { artistsByMbid, artistsById });
    if (result.kind === "noReleaseGroup") withoutReleaseGroup += 1;
    else if (result.kind !== "link") plan[result.kind].push(result.entry);
    if (result.kind !== "link") continue;

    const afterCredits = result.credits.map((credit, position) => {
      const sourceCredit = result.source.credits[position];
      const artistMbid = sourceCredit.artistMbid;
      let artistId = artistsByMbid.get(artistMbid)?.artistId;
      if (artistId) {
        reused.set(artistMbid, artistId);
      } else {
        if (!registrations.has(artistMbid)) {
          const sourceRef = result.source.sources[0];
          registrations.set(artistMbid, newArtistDocument({
            artistId: newArtistId(),
            name: sourceCredit.name,
            artistMbid,
            source: "import",
            provenance: {
              source: "musicbrainz",
              method: "artist-identity-backfill",
              datasetId: sourceRef.datasetId,
              releaseGroupMbid: result.releaseGroupMbid,
            },
          }));
        }
        artistId = registrations.get(artistMbid).artistId;
      }
      return linkedCredit(credit, artistId, artistMbid);
    });
    const revision = storedRevision(album);
    plan.albumUpdates.push({
      albumId: album.albumId,
      title: album.title || "",
      releaseGroupMbid: result.releaseGroupMbid,
      storedCatalogRevision: revision,
      catalogRevision: revision || 1,
      datasetIds: [...new Set(result.source.sources.map((source) => source.datasetId))],
      beforeCredits: clone(result.credits),
      afterCredits,
    });
  }

  plan.artistRegistrations = [...registrations.values()];
  plan.reusedArtists = [...reused.entries()].map(([artistMbid, artistId]) => ({ artistId, artistMbid }));
  plan.counts = {
    scanned: sorted.length,
    withoutReleaseGroup,
    link: plan.albumUpdates.length,
    unchanged: plan.unchanged.length,
    review: plan.review.length,
    flagged: plan.flagged.length,
    noSource: plan.noSource.length,
    artistRegistrations: plan.artistRegistrations.length,
    reusedArtists: plan.reusedArtists.length,
  };
  return sealPlan(plan);
}

async function resolveQuery(query) {
  let resolved = query;
  if (resolved && typeof resolved.lean === "function") resolved = resolved.lean();
  if (resolved && typeof resolved.exec === "function") resolved = resolved.exec();
  return resolved;
}

const ALBUM_PROJECTION = "albumId title artistCredits externalReferences fieldProvenance catalogSource catalogRevision";

async function loadCandidateAlbums(AlbumCatalog) {
  const rows = await resolveQuery(AlbumCatalog.find({
    externalReferences: { $elemMatch: { provider: "musicbrainz", entityType: "release-group" } },
  }).select(ALBUM_PROJECTION));
  return rows || [];
}

async function createPlan({ validations, AlbumCatalog, Artist, databaseName, now, newArtistId }) {
  const albums = await loadCandidateAlbums(AlbumCatalog);
  const mbids = new Set();
  for (const validation of validations) {
    for (const item of validation.validAlbums || []) {
      for (const credit of item.row?.artistCredits || []) {
        const mbid = normalizeArtistMbid(credit.artistMbid);
        if (mbid) mbids.add(mbid);
      }
    }
  }
  const creditArtistIds = albums.flatMap((album) => (album.artistCredits || []).map((credit) => normalizeArtistId(credit?.artistId)).filter(Boolean));
  const artistsByMbid = await loadArtistsByMbid(Artist, mbids);
  const artistsById = await loadArtistsById(Artist, creditArtistIds);
  return buildPlan({ albums, validations, artistsByMbid, artistsById, databaseName, now, newArtistId });
}

async function defaultCarryRevision({ albumId, fromRevision, toRevision, session, now }) {
  // Identity links do not change the album or its reviewed tracklist, so the
  // reviewed baseline and active Last.fm mappings follow the album to its new
  // revision in the same transaction (as the cover backfill does).
  const { carryReviewedBaseline } = require("../baselines/service");
  const { carryMappingsForward } = require("../listening/mappingRevisions");
  const baselineCarried = await carryReviewedBaseline({
    albumId,
    fromRevision,
    toRevision,
    session,
    actorUserId: ACTOR,
    reason: "Linking artist identities cannot change the reviewed tracklist",
  });
  const mappingsCarried = await carryMappingsForward({ albumId, fromRevision, toRevision, session, now });
  return { baselineCarried: Boolean(baselineCarried), mappingsCarried: Number(mappingsCarried || 0) };
}

async function withTransaction(mongoose, work) {
  if (!mongoose || typeof mongoose.startSession !== "function") {
    throw new ArtistBackfillError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  }
  const session = await mongoose.startSession();
  try {
    if (typeof session.withTransaction !== "function") {
      throw new ArtistBackfillError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
    }
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// Registers planned artists and re-checks reused ones in one transaction,
// before any album changes. A registration that already exists with the
// planned artistId (a rerun) is accepted; any other registry drift aborts.
async function applyRegistry({ plan, Artist, mongoose }) {
  return withTransaction(mongoose, async (session) => {
    const wanted = [
      ...plan.artistRegistrations.map((artist) => ({ artistId: artist.artistId, artistMbid: artistMbidOf(artist) })),
      ...plan.reusedArtists,
    ];
    const current = await loadArtistsByMbid(Artist, wanted.map((entry) => entry.artistMbid), { session });
    const drift = wanted.filter((entry) => current.has(entry.artistMbid) && current.get(entry.artistMbid).artistId !== entry.artistId);
    const missingReused = plan.reusedArtists.filter((entry) => !current.has(entry.artistMbid));
    if (drift.length || missingReused.length) {
      throw new ArtistBackfillError("The artist registry changed after the plan was created; create a new plan", "ARTIST_REGISTRY_CHANGED", [...drift, ...missingReused]);
    }
    const inserts = plan.artistRegistrations.filter((artist) => !current.has(artistMbidOf(artist)));
    if (inserts.length) await Artist.create(clone(inserts), { session, ordered: true });
    return { registered: inserts.length, alreadyRegistered: plan.artistRegistrations.length - inserts.length };
  });
}

// Reads and writes the stored document through the raw collection. A Mongoose
// filter or $set would cast credits through the schema (trimming names,
// adding default roles, reordering keys), so legacy credits such as
// "Alpha & " could never match and linked names would not stay byte-exact.
async function applyAlbumUpdate({ update, plan, AlbumCatalog, mongoose, carryRevision, now }) {
  return withTransaction(mongoose, async (session) => {
    const nextRevision = update.catalogRevision + 1;
    const current = await AlbumCatalog.collection.findOne({ albumId: update.albumId }, { session });
    if (!current) return { albumId: update.albumId, status: "conflict", reason: "album no longer exists" };
    if (storedRevision(current) === nextRevision && stableJson(current.artistCredits) === stableJson(update.afterCredits)) {
      return { albumId: update.albumId, status: "already_applied" };
    }
    if (storedRevision(current) !== update.storedCatalogRevision || stableJson(current.artistCredits) !== stableJson(update.beforeCredits)) {
      return { albumId: update.albumId, status: "conflict", reason: "album changed after the plan was created" };
    }
    const invalid = new AlbumCatalog({ artistCredits: update.afterCredits }).validateSync(["artistCredits"]);
    if (invalid) throw new ArtistBackfillError(`Planned credits for ${update.albumId} fail catalog validation: ${invalid.message}`, "INVALID_PLAN");
    const written = await AlbumCatalog.collection.updateOne(
      { _id: current._id, catalogRevision: current.catalogRevision === undefined ? { $exists: false } : current.catalogRevision },
      {
        $set: {
          artistCredits: update.afterCredits,
          catalogRevision: nextRevision,
          updatedAt: now,
          "fieldProvenance.artistIdentity": {
            source: "musicbrainz",
            method: "artist-identity-backfill",
            planSha256: plan.planSha256,
            datasetIds: update.datasetIds,
            releaseGroupMbid: update.releaseGroupMbid,
            appliedAt: now,
          },
        },
      },
      { session },
    );
    if (Number(written?.matchedCount) !== 1) {
      return { albumId: update.albumId, status: "conflict", reason: "album changed while it was being linked" };
    }
    const carried = await carryRevision({ albumId: update.albumId, fromRevision: update.catalogRevision, toRevision: nextRevision, session, now });
    return { albumId: update.albumId, status: "applied", fromRevision: update.catalogRevision, toRevision: nextRevision, ...carried };
  });
}

async function applyPlan({ plan, expectedSha256, confirmTarget, databaseName, AlbumCatalog, Artist, mongoose, carryRevision = defaultCarryRevision, now = new Date() }) {
  const planSha256 = verifySealedPlan(plan, expectedSha256);
  if (!databaseName || plan.target?.databaseName !== databaseName || confirmTarget !== databaseName) {
    throw new ArtistBackfillError(
      `Target mismatch: plan targets ${plan.target?.databaseName || "(none)"}, connected to ${databaseName || "(none)"}, confirmed ${confirmTarget || "(none)"}`,
      "TARGET_MISMATCH",
    );
  }
  const report = {
    kind: `${PLAN_KIND}-report`,
    planSha256,
    target: { databaseName },
    startedAt: now.toISOString(),
    registry: null,
    albums: [],
    counts: { applied: 0, alreadyApplied: 0, conflict: 0, baselinesCarried: 0, mappingsCarried: 0 },
    databaseCommitted: false,
    completed: false,
  };
  try {
    report.registry = await applyRegistry({ plan, Artist, mongoose });
    if (report.registry.registered) report.databaseCommitted = true;
    for (const update of plan.albumUpdates) {
      const outcome = await applyAlbumUpdate({ update, plan, AlbumCatalog, mongoose, carryRevision, now });
      report.albums.push(outcome);
      if (outcome.status === "applied") {
        report.databaseCommitted = true;
        report.counts.applied += 1;
        if (outcome.baselineCarried) report.counts.baselinesCarried += 1;
        report.counts.mappingsCarried += outcome.mappingsCarried || 0;
      } else if (outcome.status === "already_applied") {
        report.counts.alreadyApplied += 1;
      } else {
        report.counts.conflict += 1;
      }
    }
    report.completed = true;
  } catch (error) {
    report.error = { message: error.message, code: typeof error.code === "string" ? error.code : "ARTIST_BACKFILL_FAILED" };
    error.backfillReport = report;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

module.exports = {
  ACTOR,
  ArtistBackfillError,
  PLAN_KIND,
  PLAN_VERSION,
  applyPlan,
  buildPlan,
  buildSourceIndex,
  classifyAlbum,
  createPlan,
  creditOwnership,
  parseBackfillArgs,
  planDigest,
  sealPlan,
  stableJson,
  verifySealedPlan,
};
