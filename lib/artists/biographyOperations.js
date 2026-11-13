// Operator workflows for cached artist biographies. Nothing here runs on a
// schedule or on a page view.
//   plan    - read-only: resolve a bounded batch and seal a reviewable plan.
//   apply   - re-resolve only the reviewed artists and write those whose
//             record and outcome still match the plan.
//   refresh - check due accepted biographies (weekly revision checks,
//             monthly identity revalidation), never accepting a new match.

const ArtistBiography = require("../../models/ArtistBiography");
const Artist = require("../../models/Artist");
const { artistMbidOf, normalizeArtistId } = require("./identity");
const crypto = require("node:crypto");
const { planDigest, sealPlan, stableJson } = require("./backfill");
const { refreshArticle, resolveBiography } = require("./biographyResolver");
const { DEFAULT_SETTINGS, LANGUAGE, writeOutcome } = require("./biographies");

const PLAN_KIND = "rescened-artist-biography-plan";
const PLAN_VERSION = 1;
const MAX_BATCH = 200;
// "error" is applyable so a reviewed provider failure records its fetch
// backoff (no text, identity, or moderation change). Without that record,
// planning would select the same failing artists every time and could never
// reach artists that sort after them.
const APPLYABLE = new Set(["accepted", "needs_review", "conflict", "not_linked", "no_article", "unsuitable", "error"]);

class BiographyOperationError extends Error {
  constructor(message, code = "BIOGRAPHY_OPERATION_FAILED") {
    super(message);
    this.name = "BiographyOperationError";
    this.code = code;
  }
}

function boundedLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new BiographyOperationError(`limit must be 1-${MAX_BATCH}`, "INVALID_ARGUMENTS");
  return limit;
}

// What a reviewer approved: the outcome, its exact text and revision, its
// reasons, and the decision-relevant evidence (links, P434 statements with
// IDs, ranks and qualifiers, classes, type, sitelink, page). Revision
// counters of unrelated item edits are left out on purpose.
function identityEvidence(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(identityEvidence);
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["revisionId", "wikidataRevisionId"].includes(key)).map(([key, entry]) => [key, identityEvidence(entry)]));
}

function decisionEvidence(evidence = {}) {
  return {
    artistMbid: evidence.artistMbid || null,
    musicBrainzType: evidence.musicBrainzType || null,
    musicBrainzId: evidence.musicBrainzId || null,
    musicBrainzRedirects: identityEvidence(evidence.musicBrainzRedirects),
    wikidataLinks: [...(evidence.wikidataLinks || [])].sort(),
    wikidataId: evidence.wikidataId || null,
    wikidataRedirects: (evidence.wikidataRedirects || []).map(({ from, to }) => ({ from, to })),
    p434: [...(evidence.p434 || [])].map((claim) => ({
      statementId: claim.statementId || null, value: claim.value || null, rank: claim.rank || null, snaktype: claim.snaktype || null, qualifierPolicy: claim.qualifierPolicy || null,
      qualifiers: [...(claim.qualifiers || [])].map((qualifier) => ({ property: qualifier.property, values: [...(qualifier.values || [])].sort() }))
        .sort((left, right) => left.property.localeCompare(right.property)),
    }))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    p31: [...(evidence.p31 || [])].sort(),
    // Nested provider proof is rechecked by apply too. Exclude only returned
    // revision counters, not relationship direction/dates/ranks/qualifiers.
    personAliases: identityEvidence(evidence.personAliases),
    soloProject: identityEvidence(evidence.soloProject),
    sitelinkTitle: evidence.sitelinkTitle || null,
    pageId: evidence.pageId ?? null,
  };
}

function signature(outcome) {
  const decision = {
    status: outcome.status,
    qid: outcome.qid || null,
    reasons: [...(outcome.reasons || [])].sort(),
    revisionId: outcome.candidate?.article?.revisionId || null,
    pageId: outcome.candidate?.article?.pageId || null,
    textHash: outcome.candidate?.textHash || null,
    evidence: decisionEvidence(outcome.evidence),
  };
  return crypto.createHash("sha256").update(stableJson(decision), "utf8").digest("hex");
}

function summarize(outcome) {
  return {
    status: outcome.status,
    reasons: outcome.reasons,
    qid: outcome.qid,
    evidence: outcome.evidence,
    error: outcome.error,
    candidate: outcome.candidate ? {
      text: outcome.candidate.text,
      textHash: outcome.candidate.textHash,
      shortened: outcome.candidate.shortened,
      cut: outcome.candidate.cut,
      article: outcome.candidate.article,
    } : null,
  };
}

async function selectPlanArtists({ ArtistModel = Artist, BiographyModel = ArtistBiography, artistIds = [], limit, now }) {
  if (artistIds.length) {
    const ids = artistIds.map(normalizeArtistId);
    if (ids.some((id) => !id)) throw new BiographyOperationError("--artist must be a Rescened artist ID", "INVALID_ARGUMENTS");
    return ArtistModel.find({ artistId: { $in: ids } }).select("artistId name externalReferences").sort({ artistId: 1 }).lean();
  }
  // Artists never checked, or whose identity check is due and not in backoff.
  const notDue = await BiographyModel.find({ language: LANGUAGE, $or: [{ "identity.nextCheckAt": { $gt: now } }, { "fetch.nextAttemptAt": { $gt: now } }] }).distinct("artistId");
  return ArtistModel.find({
    artistId: { $nin: notDue },
    externalReferences: { $elemMatch: { provider: "musicbrainz", entityType: "artist" } },
  }).select("artistId name externalReferences").sort({ artistId: 1 }).limit(limit).lean();
}

async function createBiographyPlan({ ArtistModel = Artist, BiographyModel = ArtistBiography, sources, artistIds = [], limit = 25, now = new Date(), databaseName, settings = DEFAULT_SETTINGS, onProgress }) {
  boundedLimit(limit);
  if (artistIds.length > MAX_BATCH) throw new BiographyOperationError(`At most ${MAX_BATCH} --artist values`, "INVALID_ARGUMENTS");
  const artists = await selectPlanArtists({ ArtistModel, BiographyModel, artistIds, limit, now });
  const items = [];
  for (const artist of artists) {
    const record = await BiographyModel.findOne({ artistId: artist.artistId, language: LANGUAGE }).select("revision").lean();
    const outcome = await resolveBiography({ artistMbid: artistMbidOf(artist), sources, maxGraphemes: settings.maxGraphemes, now });
    items.push({
      artistId: artist.artistId,
      artistName: artist.name,
      artistMbid: artistMbidOf(artist) || null,
      recordRevision: record?.revision ?? null,
      outcome: summarize(outcome),
      signature: signature(outcome),
    });
    onProgress?.({ completed: items.length, total: artists.length });
  }
  const counts = {};
  for (const item of items) counts[item.outcome.status] = (counts[item.outcome.status] || 0) + 1;
  return sealPlan({
    kind: PLAN_KIND,
    planVersion: PLAN_VERSION,
    target: { databaseName },
    generatedAt: now.toISOString(),
    settings: { language: LANGUAGE, maxGraphemes: settings.maxGraphemes },
    counts,
    items,
  });
}

function verifyBiographyPlan(plan, expectedSha256) {
  if (!plan || plan.kind !== PLAN_KIND || plan.planVersion !== PLAN_VERSION || !Array.isArray(plan.items)) {
    throw new BiographyOperationError("The file is not a supported artist biography plan", "INVALID_PLAN");
  }
  const actual = planDigest(plan);
  if (plan.planSha256 !== actual) throw new BiographyOperationError("The plan was modified after it was sealed", "PLAN_CHECKSUM_MISMATCH");
  if (String(expectedSha256 || "").toLowerCase() !== actual) throw new BiographyOperationError("--plan-sha256 does not match the reviewed plan", "PLAN_CHECKSUM_MISMATCH");
  if (plan.items.length > MAX_BATCH) throw new BiographyOperationError("The plan is larger than one batch", "INVALID_PLAN");
  return actual;
}

// Runs one row, reporting it through onResult as soon as it is known. An
// exception is tagged with the artist and stage ("resolving" or "writing")
// so the caller can tell a row that certainly did not write from one whose
// write may have committed.
async function runRow(artistId, results, onResult, work) {
  const stage = { value: "resolving" };
  let row;
  try {
    row = await work(stage);
  } catch (error) {
    error.biographyRow = { artistId, stage: stage.value };
    throw error;
  }
  results.push(row);
  // Outside the tagged block: a checkpoint failure after a committed write
  // must not turn that row into an "uncertain" one.
  await onResult?.(row, results);
  return row;
}

async function applyBiographyPlan({ plan, ArtistModel = Artist, BiographyModel = ArtistBiography, sources, now = new Date(), settings = DEFAULT_SETTINGS, onResult }) {
  const results = [];
  for (const item of plan.items) {
    await runRow(item.artistId, results, onResult, async (stage) => applyItem(item, stage));
  }
  return results;

  async function applyItem(item, stage) {
    if (!APPLYABLE.has(item.outcome.status)) return { artistId: item.artistId, result: "not_applicable", status: item.outcome.status };
    const record = await BiographyModel.findOne({ artistId: item.artistId, language: LANGUAGE }).lean();
    if ((record?.revision ?? null) !== item.recordRevision) return { artistId: item.artistId, result: "record_changed" };
    const artist = await ArtistModel.findOne({ artistId: item.artistId }).select("artistId externalReferences").lean();
    if (!artist || artistMbidOf(artist) !== item.artistMbid) return { artistId: item.artistId, result: "artist_changed" };
    // Re-resolve now and write only what was reviewed. A new article
    // revision, different evidence, or a different outcome needs a new plan.
    const outcome = await resolveBiography({ artistMbid: item.artistMbid, sources, maxGraphemes: plan.settings.maxGraphemes, now });
    // A planned failure only records backoff, so it needs the failure to
    // persist, not identical partial evidence; anything else is a new answer.
    const unchanged = item.outcome.status === "error" ? outcome.status === "error" : signature(outcome) === item.signature;
    if (!unchanged) return { artistId: item.artistId, result: "outcome_changed", status: outcome.status };
    stage.value = "writing";
    const written = await writeOutcome({ Model: BiographyModel, artistId: item.artistId, record, outcome, mode: "resolve", now, settings });
    // A recorded provider failure is a backoff record, not text: errorCode
    // keeps it distinguishable in the report, as refresh rows already are.
    return { artistId: item.artistId, result: written, status: outcome.status, ...(outcome.status === "error" ? { errorCode: outcome.error?.code || "BIOGRAPHY_PROVIDER_FAILED" } : {}) };
  }
}

async function refreshBiographies({ ArtistModel = Artist, BiographyModel = ArtistBiography, sources, limit = 25, now = new Date(), settings = DEFAULT_SETTINGS, onResult }) {
  boundedLimit(limit);
  const due = await BiographyModel.find({
    language: LANGUAGE,
    "identity.state": "verified",
    $and: [
      { $or: [{ nextContentCheckAt: { $lte: now } }, { "identity.nextCheckAt": { $lte: now } }] },
      { $or: [{ "fetch.nextAttemptAt": null }, { "fetch.nextAttemptAt": { $lte: now } }] },
    ],
  }).sort({ nextContentCheckAt: 1, artistId: 1 }).limit(limit).lean();
  const results = [];
  for (const record of due) {
    await runRow(record.artistId, results, onResult, async (stage) => {
      const identityDue = record.identity.nextCheckAt && record.identity.nextCheckAt <= now;
      let outcome;
      let mode;
      if (identityDue) {
        const artist = await ArtistModel.findOne({ artistId: record.artistId }).select("artistId externalReferences").lean();
        outcome = await resolveBiography({ artistMbid: artistMbidOf(artist), sources, maxGraphemes: settings.maxGraphemes, now });
        mode = "resolve";
      } else {
        outcome = await refreshArticle({ accepted: record.accepted, sources, maxGraphemes: settings.maxGraphemes, now });
        mode = "content";
      }
      stage.value = "writing";
      const written = await writeOutcome({ Model: BiographyModel, artistId: record.artistId, record, outcome, mode, now, settings });
      return { artistId: record.artistId, mode, status: outcome.status, result: written, errorCode: outcome.error?.code || null };
    });
  }
  return results;
}

module.exports = {
  BiographyOperationError,
  MAX_BATCH,
  PLAN_KIND,
  PLAN_VERSION,
  applyBiographyPlan,
  createBiographyPlan,
  refreshBiographies,
  selectPlanArtists,
  signature,
  verifyBiographyPlan,
};
