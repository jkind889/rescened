// Cached artist biographies: what a page shows, how resolver outcomes are
// stored, and moderator commands. Page reads touch only MongoDB.
//
// Ownership: resolver/refresh writes identity, accepted, candidate, content
// check times, and fetch state; it never writes `manual` or `moderation`.
// Moderator commands write `manual` and `moderation` (and accept a reviewed
// candidate). Every write matches the record's current `revision` and
// advances it, so whichever of two racing writers lands second is rejected
// and must re-read: a refresh that raced a suppression cannot undo it.

const ArtistBiography = require("../../models/ArtistBiography");
const Artist = require("../../models/Artist");
const { normalizeArtistId } = require("./identity");
const { BiographyTextError, normalizeManualText, textHash } = require("./biographyText");

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = Object.freeze({
  contentRefreshMs: 7 * DAY, // weekly article revision checks
  identityRefreshMs: 30 * DAY, // monthly MusicBrainz -> Wikidata -> Wikipedia revalidation
  retryBaseMs: 60 * 60 * 1000, // first retry after a transient error: 1 hour
  retryMaxMs: 7 * DAY,
  maxGraphemes: 250,
});
const LANGUAGE = "en";
const COMMANDS = ["suppress", "unsuppress", "reject_match", "confirm_match", "clear_verdict", "correct_text", "clear_correction", "accept_revision", "dismiss_revision"];
const MAX_REASON_LENGTH = 500;

function biographyError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function add(now, ms) {
  return new Date(now.getTime() + ms);
}

function plain(record) {
  return record && typeof record.toObject === "function" ? record.toObject({ depopulate: true, versionKey: false }) : record;
}

// What an artist page may show, or null. Hidden when suppressed, when a
// moderator rejected the match, when identity is not currently verified,
// or when the accepted excerpt belongs to another Wikidata item.
function displayBiography(record) {
  const value = plain(record);
  if (!value || value.moderation?.suppressed || value.moderation?.verdict === "match_rejected") return null;
  if (value.identity?.state !== "verified" || !value.identity.qid) return null;
  // A moderator-based publication needs that confirmation to still stand.
  if (value.identity.basis === "moderator" && !(value.moderation?.verdict === "match_confirmed" && value.moderation.verdictQid === value.identity.qid)) return null;
  const accepted = value.accepted;
  if (!accepted || accepted.qid !== value.identity.qid) return null;
  const manual = value.manual && value.manual.qid === value.identity.qid ? value.manual : null;
  const source = manual ? manual.basedOn : accepted.article;
  return {
    language: LANGUAGE,
    text: manual ? manual.text : accepted.text,
    // Change notice: an excerpt of the lead, shortened when it is not the
    // whole lead, edited when a moderator corrected the wording.
    excerpt: true,
    shortened: manual ? true : accepted.shortened === true,
    edited: Boolean(manual),
    source: "Wikipedia",
    article: { title: source.title, url: source.url, revisionId: source.revisionId, revisionUrl: source.revisionUrl },
    license: { name: accepted.license?.name || "CC BY-SA 4.0", url: accepted.license?.url || "https://creativecommons.org/licenses/by-sa/4.0/" },
    retrievedAt: accepted.retrievedAt,
    checkedAt: value.contentCheckedAt || value.identity.checkedAt || null,
  };
}

async function publicBiography(rawArtistId, { Model = ArtistBiography } = {}) {
  const artistId = normalizeArtistId(rawArtistId);
  if (!artistId) throw biographyError("artistId must be a Rescened artist ID", 400, "INVALID_ARTIST_ID");
  // Only the fields the display rule reads; never history or evidence.
  const record = await Model.findOne({ artistId, language: LANGUAGE }).select("identity.state identity.qid identity.basis identity.checkedAt accepted manual moderation.suppressed moderation.verdict moderation.verdictQid contentCheckedAt").lean();
  return { artistId, biography: displayBiography(record) };
}

function excerptFrom(candidate, { now, by = "system" }) {
  return { ...candidate, acceptedAt: now, acceptedBy: by };
}

function sameArticle(left, right) {
  return Boolean(left && right && left.qid === right.qid && left.article?.pageId === right.article?.pageId);
}

// A newer revision of the published page, found by refresh or by a plan
// apply. Once a biography is published only a moderator changes its text:
// changed text is staged as pendingRevision while the accepted excerpt keeps
// showing. Identical text only moves the source pointer (and its extraction
// metadata) to the newer revision, which changes nothing a reader sees. Text
// a moderator already dismissed is not staged again, and the newest text
// supersedes any older staged text. Returns the audit event, or null.
function revisionUpdate(current, candidate, set, { now, mode }) {
  const details = { revisionId: candidate.article.revisionId, previousRevisionId: current.accepted.article?.revisionId ?? null, textHash: candidate.textHash };
  if (candidate.textHash === current.accepted.textHash) {
    set.accepted = {
      ...current.accepted,
      article: candidate.article,
      license: candidate.license || current.accepted.license,
      retrievedAt: candidate.retrievedAt || now,
      // Same text, but whether it is the whole lead can differ by revision.
      shortened: candidate.shortened,
      cut: candidate.cut,
      extractionVersion: candidate.extractionVersion,
    };
    // The text went back to what is published (a reverted edit): nothing is pending.
    if (current.pendingRevision) set.pendingRevision = null;
    return current.accepted.article?.revisionId === candidate.article.revisionId ? null : { action: `${mode}:revision_unchanged_text`, details };
  }
  if (current.dismissedRevision?.textHash === candidate.textHash) {
    // Wikipedia is back on text a moderator declined: an older staged text is
    // no longer what the page says, so it is not left waiting to be published.
    if (current.pendingRevision) set.pendingRevision = null;
    return null;
  }
  if (current.pendingRevision?.textHash === candidate.textHash) return null;
  set.pendingRevision = { ...candidate };
  return { action: `${mode}:revision_staged`, details: { ...details, replacedPendingRevisionId: current.pendingRevision?.article?.revisionId ?? null } };
}

// The $set fields and audit event for a resolver outcome. `mode` is
// "resolve" (full identity resolution) or "content" (revision refresh of an
// accepted article). Neither refresh nor a plan apply replaces the text of a
// published biography; changed text is staged for a moderator (a plan can
// still publish a first biography or move a record into review). Returns
// { set, event } or { set } without an event for routine no-change checks.
function outcomeUpdate(record, outcome, { mode, now, settings = DEFAULT_SETTINGS }) {
  const current = plain(record) || {};
  const set = {};
  const failures = current.fetch?.consecutiveFailures || 0;
  const details = { status: outcome.status, qid: outcome.qid || null, reasons: outcome.reasons || [] };

  if (outcome.status === "error") {
    const next = failures + 1;
    set["fetch.lastAttemptAt"] = now;
    set["fetch.lastErrorCode"] = outcome.error?.code || "BIOGRAPHY_PROVIDER_FAILED";
    set["fetch.lastErrorProvider"] = outcome.error?.provider || null;
    set["fetch.consecutiveFailures"] = next;
    set["fetch.nextAttemptAt"] = add(now, Math.min(settings.retryBaseMs * (2 ** (next - 1)), settings.retryMaxMs));
    // Identity, accepted text, and moderation are untouched: a transient
    // failure never hides an accepted biography.
    return { set, event: failures === 0 ? { action: `${mode}:error`, details: { ...details, errorCode: set["fetch.lastErrorCode"] } } : null };
  }

  set["fetch.lastAttemptAt"] = now;
  set["fetch.lastSuccessAt"] = now;
  set["fetch.lastErrorCode"] = null;
  set["fetch.lastErrorProvider"] = null;
  set["fetch.consecutiveFailures"] = 0;
  set["fetch.nextAttemptAt"] = null;

  if (mode === "content") {
    set.contentCheckedAt = now;
    set.nextContentCheckAt = add(now, settings.contentRefreshMs);
    if (outcome.status === "unchanged") return { set, event: null };
    if (outcome.status === "accepted" && sameArticle(current.accepted, outcome.candidate)) {
      return { set, event: revisionUpdate(current, outcome.candidate, set, { now, mode }) };
    }
    // Anything else leaves the published page; a staged revision of it is moot.
    if (current.pendingRevision) set.pendingRevision = null;
    if (outcome.status === "accepted" || outcome.status === "needs_review") {
      // A different page than the published one: the same review policy as a
      // full resolution. The stored article is kept for audit but not shown.
      set["identity.state"] = "needs_review";
      set["identity.basis"] = null;
      set["identity.reasons"] = [...new Set([...(outcome.reasons || []), "MATCH_CHANGED"])];
      set["identity.checkedAt"] = now;
      set.candidate = outcome.candidate || null;
      return { set, event: { action: "content:match_changed", details: { ...details, pageId: outcome.candidate?.article?.pageId ?? null } } };
    }
    // The article now contradicts the match or is no longer usable: hide it
    // (accepted text stays for audit) until a full resolution runs again.
    set["identity.state"] = outcome.status === "conflict" ? "conflict" : "unsuitable";
    set["identity.reasons"] = outcome.reasons || [];
    set["identity.checkedAt"] = now;
    return { set, event: { action: `content:${outcome.status}`, details } };
  }

  set["identity.checkedAt"] = now;
  set["identity.nextCheckAt"] = add(now, settings.identityRefreshMs);
  set["identity.reasons"] = outcome.reasons || [];
  set["identity.qid"] = outcome.qid || null;
  set["identity.evidence"] = outcome.evidence || {};
  const confirmedByModerator = current.moderation?.verdict === "match_confirmed" && current.moderation.verdictQid && current.moderation.verdictQid === outcome.qid;
  const acceptable = outcome.status === "accepted" || (outcome.status === "needs_review" && confirmedByModerator && outcome.candidate);

  if (acceptable) {
    const changedMatch = current.accepted && !sameArticle(current.accepted, outcome.candidate);
    if (changedMatch && current.pendingRevision) set.pendingRevision = null;
    if (changedMatch) {
      // A different item or page than the published one: never switch
      // automatically. Hold it for review and stop showing the old one.
      set["identity.state"] = "needs_review";
      set["identity.reasons"] = [...new Set([...(outcome.reasons || []), "MATCH_CHANGED"])];
      set.candidate = outcome.candidate;
      return { set, event: { action: "resolve:match_changed", details } };
    }
    set["identity.state"] = "verified";
    set["identity.basis"] = outcome.status === "accepted" ? "automatic" : "moderator";
    if (set["identity.basis"] === "moderator") set["identity.reasons"] = ["MODERATOR_CONFIRMED", ...(outcome.reasons || [])];
    set.candidate = null;
    set.contentCheckedAt = now;
    set.nextContentCheckAt = add(now, settings.contentRefreshMs);
    // A published biography keeps its text: a changed lead from the same page
    // is staged for a moderator, whether found by refresh or by a plan apply.
    if (current.accepted && current.identity?.state === "verified") {
      const event = revisionUpdate(current, outcome.candidate, set, { now, mode });
      return { set, event };
    }
    set.accepted = excerptFrom(outcome.candidate, { now });
    // A publication from a non-published state supersedes staged or dismissed text.
    set.pendingRevision = null;
    set.dismissedRevision = null;
    const changed = !current.accepted || current.accepted.article?.revisionId !== outcome.candidate.article.revisionId || current.identity?.state !== "verified";
    return { set, event: changed ? { action: "resolve:accepted", details: { ...details, revisionId: outcome.candidate.article.revisionId, textHash: outcome.candidate.textHash } } : null };
  }

  set["identity.state"] = outcome.status === "accepted" ? "verified" : outcome.status;
  set["identity.basis"] = null;
  set.candidate = outcome.status === "needs_review" ? outcome.candidate || null : null;
  if (current.pendingRevision) set.pendingRevision = null;
  const changed = current.identity?.state !== set["identity.state"] || JSON.stringify(current.identity?.reasons || []) !== JSON.stringify(set["identity.reasons"]);
  return { set, event: changed ? { action: `resolve:${outcome.status}`, details } : null };
}

function newRecord(artistId) {
  return {
    artistId,
    language: LANGUAGE,
    revision: 1,
    identity: { state: "unchecked", reasons: [], qid: null, basis: null, evidence: {}, checkedAt: null, nextCheckAt: null },
    accepted: null,
    candidate: null,
    pendingRevision: null,
    dismissedRevision: null,
    fetch: { consecutiveFailures: 0 },
    manual: null,
    moderation: { suppressed: false, suppressedReason: "", verdict: null, verdictQid: null, verdictReason: "", updatedBy: null, updatedAt: null },
    history: [],
  };
}

// Stores an outcome against the record as it was read. Returns "written" or
// "stale" (another writer advanced the record; nothing was changed).
async function writeOutcome({ Model = ArtistBiography, artistId, record, outcome, mode, now = new Date(), settings = DEFAULT_SETTINGS, onEvent }) {
  const { set, event } = outcomeUpdate(record, outcome, { mode, now, settings });
  onEvent?.(event);
  const history = event ? [{ at: now, actorType: "system", actorId: null, ...event }] : [];
  if (!record) {
    const document = newRecord(artistId);
    for (const [path, value] of Object.entries(set)) {
      const parts = path.split(".");
      let target = document;
      while (parts.length > 1) { const key = parts.shift(); target[key] = target[key] || {}; target = target[key]; }
      target[parts[0]] = value;
    }
    document.history = history;
    try {
      await Model.create([document]);
      return "written";
    } catch (error) {
      if (error?.code === 11000) return "stale";
      throw error;
    }
  }
  const update = { $set: set, $inc: { revision: 1 } };
  if (history.length) update.$push = { history: { $each: history } };
  const result = await Model.updateOne({ artistId, language: LANGUAGE, revision: record.revision }, update);
  return result.modifiedCount === 1 ? "written" : "stale";
}

function normalizeCommand(action, body = {}) {
  if (!COMMANDS.includes(action)) throw biographyError("Unknown biography command", 404, "INVALID_BIOGRAPHY_COMMAND");
  const allowed = { expectedRevision: true, reason: ["suppress", "reject_match", "dismiss_revision"].includes(action), text: action === "correct_text", note: action === "correct_text" };
  for (const key of Object.keys(body || {})) {
    if (!allowed[key]) throw biographyError(`Unsupported field ${key}`, 400, "INVALID_BIOGRAPHY_COMMAND");
  }
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) throw biographyError("expectedRevision is required", 400, "INVALID_BIOGRAPHY_COMMAND");
  const command = { action, expectedRevision: body.expectedRevision };
  if (allowed.reason) {
    if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > MAX_REASON_LENGTH) throw biographyError(`reason is required (1-${MAX_REASON_LENGTH} characters)`, 400, "INVALID_BIOGRAPHY_COMMAND");
    command.reason = body.reason.trim();
  }
  if (action === "correct_text") {
    try { command.text = normalizeManualText(body.text); } catch (error) {
      if (error instanceof BiographyTextError) throw biographyError(error.message, 400, "INVALID_BIOGRAPHY_COMMAND");
      throw error;
    }
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > MAX_REASON_LENGTH)) throw biographyError("note is too long", 400, "INVALID_BIOGRAPHY_COMMAND");
    command.note = (body.note || "").trim();
  }
  return command;
}

function commandUpdate(record, command, { actorId, now }) {
  const set = { "moderation.updatedBy": actorId, "moderation.updatedAt": now };
  const details = {};
  const precondition = (ok, message) => { if (!ok) throw biographyError(message, 409, "BIOGRAPHY_STATE_CONFLICT"); };
  switch (command.action) {
    case "suppress":
      precondition(!record.moderation?.suppressed, "The biography is already suppressed");
      Object.assign(set, { "moderation.suppressed": true, "moderation.suppressedReason": command.reason });
      details.reason = command.reason;
      break;
    case "unsuppress":
      precondition(record.moderation?.suppressed, "The biography is not suppressed");
      Object.assign(set, { "moderation.suppressed": false, "moderation.suppressedReason": "" });
      break;
    case "reject_match":
      precondition(Boolean(record.identity?.qid), "There is no match to reject");
      // A rejected match hides the biography; a staged revision of it is moot.
      Object.assign(set, { "moderation.verdict": "match_rejected", "moderation.verdictQid": record.identity.qid, "moderation.verdictReason": command.reason, pendingRevision: null });
      details.qid = record.identity.qid;
      details.reason = command.reason;
      break;
    case "confirm_match":
      precondition(record.identity?.state === "needs_review" && record.candidate && record.candidate.qid === record.identity.qid, "Only a reviewable candidate can be confirmed");
      Object.assign(set, {
        "moderation.verdict": "match_confirmed",
        "moderation.verdictQid": record.identity.qid,
        "moderation.verdictReason": "",
        "identity.state": "verified",
        "identity.basis": "moderator",
        "identity.reasons": ["MODERATOR_CONFIRMED", ...(record.identity.reasons || []).filter((code) => code !== "MATCH_CHANGED")],
        accepted: { ...record.candidate, acceptedAt: now, acceptedBy: actorId },
        candidate: null,
        // A revision staged for the previously published page no longer applies.
        pendingRevision: null,
        dismissedRevision: null,
        // A correction written for a previously published article does not
        // carry over to a newly confirmed one.
        ...(record.manual && record.manual.basedOn?.pageId !== record.candidate.article.pageId ? { manual: null } : {}),
        contentCheckedAt: now,
        nextContentCheckAt: add(now, DEFAULT_SETTINGS.contentRefreshMs),
      });
      details.qid = record.identity.qid;
      details.revisionId = record.candidate.article.revisionId;
      break;
    case "clear_verdict":
      precondition(Boolean(record.moderation?.verdict), "There is no verdict to clear");
      Object.assign(set, { "moderation.verdict": null, "moderation.verdictQid": null, "moderation.verdictReason": "" });
      // A publication that rests on a moderator confirmation loses its basis
      // whenever the verdict is cleared, including after a later rejection
      // replaced the confirmation. The excerpt returns to review now.
      if (record.identity?.state === "verified" && record.identity.basis === "moderator") {
        Object.assign(set, {
          "identity.state": "needs_review",
          "identity.basis": null,
          "identity.reasons": (record.identity.reasons || []).filter((code) => code !== "MODERATOR_CONFIRMED"),
          candidate: record.accepted || record.candidate || null,
          accepted: null,
          pendingRevision: null,
        });
        details.revokedConfirmation = true;
      }
      break;
    case "correct_text":
      precondition(record.identity?.state === "verified" && record.accepted, "Only a published biography can be corrected");
      set.manual = { text: command.text, textHash: textHash(command.text), basedOn: record.accepted.article, qid: record.accepted.qid, note: command.note, editedBy: actorId, editedAt: now };
      details.textHash = set.manual.textHash;
      details.note = command.note;
      break;
    case "clear_correction":
      precondition(Boolean(record.manual), "There is no correction to clear");
      set.manual = null;
      break;
    case "accept_revision": {
      // Publishes the staged text of a newer revision of the same page. The
      // expectedRevision precondition ties this to the exact text the
      // moderator saw: any later refresh write advances the record revision.
      const pending = record.pendingRevision;
      precondition(Boolean(pending), "There is no staged revision to accept");
      precondition(record.identity?.state === "verified" && record.accepted && pending.qid === record.identity.qid && sameArticle(record.accepted, pending), "The staged revision no longer matches the published article");
      Object.assign(set, {
        accepted: { ...pending, acceptedAt: now, acceptedBy: actorId },
        pendingRevision: null,
        dismissedRevision: null,
      });
      // A moderator correction stays in place (it keeps its own source
      // revision); suppression and verdicts are untouched.
      details.revisionId = pending.article.revisionId;
      details.previousRevisionId = record.accepted.article?.revisionId ?? null;
      details.textHash = pending.textHash;
      details.correctionKept = Boolean(record.manual);
      break;
    }
    case "dismiss_revision": {
      const pending = record.pendingRevision;
      precondition(Boolean(pending), "There is no staged revision to dismiss");
      Object.assign(set, {
        pendingRevision: null,
        dismissedRevision: { revisionId: pending.article.revisionId, textHash: pending.textHash, reason: command.reason, dismissedBy: actorId, dismissedAt: now },
      });
      details.revisionId = pending.article.revisionId;
      details.textHash = pending.textHash;
      details.reason = command.reason;
      break;
    }
    default:
      throw biographyError("Unknown biography command", 404, "INVALID_BIOGRAPHY_COMMAND");
  }
  return { set, event: { at: now, actorType: "moderator", actorId, action: command.action, details } };
}

async function runModeratorCommand({ Model = ArtistBiography, artistId: rawArtistId, command, actorId, now = new Date() }) {
  const artistId = normalizeArtistId(rawArtistId);
  if (!artistId) throw biographyError("artistId must be a Rescened artist ID", 400, "INVALID_ARTIST_ID");
  const record = await Model.findOne({ artistId, language: LANGUAGE }).lean();
  if (!record) throw biographyError("No biography record for this artist", 404, "BIOGRAPHY_NOT_FOUND");
  if (record.revision !== command.expectedRevision) throw biographyError("The biography changed; reload and try again", 409, "BIOGRAPHY_REVISION_CONFLICT");
  const { set, event } = commandUpdate(record, command, { actorId, now });
  const result = await Model.updateOne(
    { artistId, language: LANGUAGE, revision: command.expectedRevision },
    { $set: set, $inc: { revision: 1 }, $push: { history: event } },
  );
  if (result.modifiedCount !== 1) throw biographyError("The biography changed; reload and try again", 409, "BIOGRAPHY_REVISION_CONFLICT");
  return moderatorDetail({ Model, artistId });
}

function moderatorView(record, artist) {
  const value = plain(record);
  const { _id, __v, ...rest } = value;
  return { ...rest, artistName: artist?.name || null, display: displayBiography(value) };
}

async function moderatorDetail({ Model = ArtistBiography, ArtistModel = Artist, artistId: rawArtistId }) {
  const artistId = normalizeArtistId(rawArtistId);
  if (!artistId) throw biographyError("artistId must be a Rescened artist ID", 400, "INVALID_ARTIST_ID");
  const [record, artist] = await Promise.all([
    Model.findOne({ artistId, language: LANGUAGE }).lean(),
    ArtistModel.findOne({ artistId }).select("artistId name").lean(),
  ]);
  if (!record) throw biographyError("No biography record for this artist", 404, "BIOGRAPHY_NOT_FOUND");
  return moderatorView(record, artist);
}

// Identity states, plus "revision_pending": published biographies whose page
// has changed text staged by refresh and waiting for a moderator.
const QUEUE_STATES = ["needs_review", "revision_pending", "conflict", "verified", "unsuitable", "no_article", "not_linked", "unchecked"];

async function moderatorQueue({ Model = ArtistBiography, ArtistModel = Artist, state = "needs_review", limit = 50 } = {}) {
  if (!QUEUE_STATES.includes(state)) throw biographyError(`state must be one of ${QUEUE_STATES.join(", ")}`, 400, "INVALID_BIOGRAPHY_COMMAND");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw biographyError("limit must be 1-100", 400, "INVALID_BIOGRAPHY_COMMAND");
  const filter = state === "revision_pending" ? { language: LANGUAGE, pendingRevision: { $ne: null } } : { language: LANGUAGE, "identity.state": state };
  const rows = await Model.find(filter).select("-history").sort({ updatedAt: -1, artistId: 1 }).limit(limit).lean();
  const artists = await ArtistModel.find({ artistId: { $in: rows.map((row) => row.artistId) } }).select("artistId name").lean();
  const names = new Map(artists.map((artist) => [artist.artistId, artist.name]));
  return rows.map((row) => ({
    artistId: row.artistId,
    artistName: names.get(row.artistId) || null,
    revision: row.revision,
    identity: { state: row.identity.state, reasons: row.identity.reasons, qid: row.identity.qid, checkedAt: row.identity.checkedAt },
    suppressed: Boolean(row.moderation?.suppressed),
    verdict: row.moderation?.verdict || null,
    candidateTitle: row.candidate?.article?.title || null,
    acceptedTitle: row.accepted?.article?.title || null,
    pendingRevision: Boolean(row.pendingRevision),
    shown: Boolean(displayBiography(row)),
    lastErrorCode: row.fetch?.lastErrorCode || null,
    updatedAt: row.updatedAt,
  }));
}

module.exports = {
  COMMANDS,
  DEFAULT_SETTINGS,
  LANGUAGE,
  QUEUE_STATES,
  displayBiography,
  moderatorDetail,
  moderatorQueue,
  normalizeCommand,
  outcomeUpdate,
  publicBiography,
  runModeratorCommand,
  writeOutcome,
};
