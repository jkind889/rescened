const {
  ArtistIdentityError,
  artistMbidOf,
  creditIdentity,
  loadArtistsById,
  loadArtistsByMbid,
  newArtistDocument,
  newCommunityArtistDocument,
  normalizeArtistId,
  normalizeArtistMbid,
  normalizeArtistName,
} = require("./identity");

// Private artist identity proposals that travel with a parent suggestion
// revision (an album suggestion, a linkage correction, or a standalone artist
// suggestion). This module defines the request contract, the server-prepared
// stored shape, and the transactional resolver that turns reviewed proposals
// into registry artists at approval. It never infers identity from a name,
// never fetches arbitrary URLs, and never calls a provider during approval.
//
// Request shape (client-supplied, strict):
//   artistProposals: [
//     { proposalKey, kind: "musicbrainz", artistMbid },
//     { proposalKey, kind: "community", canonicalName, evidence: [{ url, description? }] },
//   ]
//   artistSelections: [
//     { position, kind: "existing", artistId },
//     { position, kind: "proposal", proposalKey },
//   ]
// A selection links one credit position. A proposal key may be reused by
// several selections in the same revision; nothing else implies reuse.

const MAX_ARTIST_PROPOSALS = 20;
const MAX_ARTIST_SELECTIONS = 20;
const MAX_PROPOSAL_EVIDENCE = 5;
const MAX_CANONICAL_NAME_LENGTH = 200;
const MAX_EVIDENCE_URL_LENGTH = 2048;
const MAX_EVIDENCE_DESCRIPTION_LENGTH = 200;
const MAX_OBSERVATION_TEXT_LENGTH = 500;
const MAX_OBSERVATION_TYPE_LENGTH = 50;
const PROPOSAL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROPOSAL_KINDS = ["musicbrainz", "community"];
const SELECTION_KINDS = ["existing", "proposal"];
const RESOLUTION_OUTCOMES = ["linked", "created", "reused"];

class ArtistProposalValidationError extends Error {
  constructor(message, code = "INVALID_ARTIST_PROPOSAL", details = []) {
    super(message);
    this.name = "ArtistProposalValidationError";
    this.status = 400;
    this.code = code;
    this.details = details.length ? details : [message];
  }
}

function fail(message, code, details) {
  throw new ArtistProposalValidationError(message, code, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail(`${path} must be an object`);
}

function assertKeys(value, allowed, path) {
  Object.keys(value).forEach((key) => {
    if (!allowed.includes(key)) fail(`${path}.${key} is not allowed`);
  });
}

function proposalKey(value, path) {
  if (typeof value !== "string" || !PROPOSAL_KEY_PATTERN.test(value)) {
    fail(`${path} must be 1-40 lowercase letters, digits, or hyphens`);
  }
  return value;
}

function canonicalName(value, path) {
  let name;
  try {
    name = normalizeArtistName(value);
  } catch {
    fail(`${path} must be a non-empty name without control characters`);
  }
  if (name.length > MAX_CANONICAL_NAME_LENGTH) fail(`${path} must be ${MAX_CANONICAL_NAME_LENGTH} characters or fewer`);
  return name;
}

// Evidence stays private and is never fetched by the server. Only plain
// HTTPS URLs without embedded credentials are accepted.
function evidenceUrl(value, path) {
  if (typeof value !== "string" || !value.trim()) fail(`${path} is required`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_EVIDENCE_URL_LENGTH) fail(`${path} must be ${MAX_EVIDENCE_URL_LENGTH} characters or fewer`);
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    fail(`${path} must be a valid https URL`);
  }
  if (url.protocol !== "https:" || !url.hostname) fail(`${path} must use https`);
  if (url.username || url.password) fail(`${path} must not contain credentials`);
  return trimmed;
}

function evidenceList(value, path) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROPOSAL_EVIDENCE) {
    fail(`${path} must contain one to ${MAX_PROPOSAL_EVIDENCE} supporting links`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    assertRecord(entry, entryPath);
    assertKeys(entry, ["url", "description"], entryPath);
    const url = evidenceUrl(entry.url, `${entryPath}.url`);
    if (seen.has(url)) fail(`${entryPath}.url is listed more than once`);
    seen.add(url);
    let description = "";
    if (entry.description !== undefined) {
      if (typeof entry.description !== "string") fail(`${entryPath}.description must be a string`);
      description = entry.description.trim();
      if (description.length > MAX_EVIDENCE_DESCRIPTION_LENGTH) {
        fail(`${entryPath}.description must be ${MAX_EVIDENCE_DESCRIPTION_LENGTH} characters or fewer`);
      }
    }
    return { url, description };
  });
}

// Normalizes the client's proposals. Two MusicBrainz proposals for the same
// MBID are rejected: the contributor must reuse one proposal key instead.
// Community proposals with the same canonical name stay distinct.
function normalizeArtistProposals(value, path = "artistProposals") {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if (value.length > MAX_ARTIST_PROPOSALS) fail(`${path} may contain at most ${MAX_ARTIST_PROPOSALS} proposals`);
  const keys = new Set();
  const mbids = new Map();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    assertRecord(entry, entryPath);
    if (!PROPOSAL_KINDS.includes(entry.kind)) fail(`${entryPath}.kind must be musicbrainz or community`);
    const key = proposalKey(entry.proposalKey, `${entryPath}.proposalKey`);
    if (keys.has(key)) fail(`${entryPath}.proposalKey is used by another proposal`, "DUPLICATE_ARTIST_PROPOSAL");
    keys.add(key);
    if (entry.kind === "musicbrainz") {
      assertKeys(entry, ["proposalKey", "kind", "artistMbid"], entryPath);
      const artistMbid = normalizeArtistMbid(entry.artistMbid);
      if (!artistMbid) fail(`${entryPath}.artistMbid must be a MusicBrainz artist MBID`);
      if (mbids.has(artistMbid)) {
        fail(
          `${entryPath}.artistMbid repeats proposal ${mbids.get(artistMbid)}; reuse that proposal key instead`,
          "DUPLICATE_ARTIST_PROPOSAL",
        );
      }
      mbids.set(artistMbid, key);
      return { proposalKey: key, kind: "musicbrainz", artistMbid };
    }
    assertKeys(entry, ["proposalKey", "kind", "canonicalName", "evidence"], entryPath);
    return {
      proposalKey: key,
      kind: "community",
      canonicalName: canonicalName(entry.canonicalName, `${entryPath}.canonicalName`),
      evidence: evidenceList(entry.evidence, `${entryPath}.evidence`),
    };
  });
}

function creditPosition(value, path, creditCount) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${path} must be a non-negative integer`);
  if (value >= creditCount) fail(`${path} is outside the credit list`, "ARTIST_SELECTION_OUT_OF_RANGE");
  return value;
}

// Normalizes credit selections against the normalized proposals. Every
// proposal must be used by at least one selection, so approval can never
// publish an artist that no credit links to.
function normalizeArtistSelections(value, proposals, { creditCount, path = "artistSelections" } = {}) {
  if (!Number.isSafeInteger(creditCount) || creditCount < 0) {
    throw new TypeError("normalizeArtistSelections requires a creditCount");
  }
  const list = value === undefined ? [] : value;
  if (!Array.isArray(list)) fail(`${path} must be an array`);
  if (list.length > MAX_ARTIST_SELECTIONS) fail(`${path} may contain at most ${MAX_ARTIST_SELECTIONS} links`);
  const byKey = new Map((proposals || []).map((proposal) => [proposal.proposalKey, proposal]));
  const positions = new Set();
  const used = new Set();
  const selections = list.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    assertRecord(entry, entryPath);
    if (!SELECTION_KINDS.includes(entry.kind)) fail(`${entryPath}.kind must be existing or proposal`);
    const position = creditPosition(entry.position, `${entryPath}.position`, creditCount);
    if (positions.has(position)) fail(`${entryPath}.position is selected more than once`, "DUPLICATE_ARTIST_SELECTION");
    positions.add(position);
    if (entry.kind === "existing") {
      assertKeys(entry, ["position", "kind", "artistId"], entryPath);
      const artistId = normalizeArtistId(entry.artistId);
      if (!artistId) fail(`${entryPath}.artistId must be a Rescened artist ID`);
      return { position, kind: "existing", artistId };
    }
    assertKeys(entry, ["position", "kind", "proposalKey"], entryPath);
    const key = proposalKey(entry.proposalKey, `${entryPath}.proposalKey`);
    if (!byKey.has(key)) fail(`${entryPath}.proposalKey does not match a proposal`, "UNKNOWN_ARTIST_PROPOSAL");
    used.add(key);
    return { position, kind: "proposal", proposalKey: key };
  });
  const unattached = [...byKey.keys()].filter((key) => !used.has(key));
  if (unattached.length) {
    fail("Every artist proposal must be linked to at least one credit", "UNATTACHED_ARTIST_PROPOSAL", unattached);
  }
  return selections.sort((left, right) => left.position - right.position);
}

function boundedText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.normalize("NFC").trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// Builds the server-authored observation stored with a MusicBrainz proposal.
// `observed` is a normalized provider record for the exact requested MBID.
// A different MBID (a redirect or merge upstream) is refused, never followed.
function musicBrainzObservation(requestedMbid, observed, observedAt) {
  if (!observed) {
    fail("The selected MusicBrainz artist was not found", "ARTIST_MBID_NOT_FOUND", [requestedMbid]);
  }
  const observedMbid = normalizeArtistMbid(observed.artistMbid);
  if (observedMbid !== requestedMbid) {
    fail(
      "MusicBrainz returned a different artist for this MBID; choose the current artist explicitly",
      "ARTIST_MBID_REDIRECTED",
      [{ requested: requestedMbid, observed: observedMbid || null }],
    );
  }
  let name;
  try {
    name = normalizeArtistName(observed.name);
  } catch {
    fail("MusicBrainz returned an artist without a usable name", "ARTIST_OBSERVATION_INVALID", [requestedMbid]);
  }
  const at = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (Number.isNaN(at.getTime())) throw new TypeError("observedAt must be a valid date");
  return {
    artistMbid: requestedMbid,
    name: name.slice(0, MAX_OBSERVATION_TEXT_LENGTH),
    sortName: boundedText(observed.sortName, MAX_OBSERVATION_TEXT_LENGTH),
    disambiguation: boundedText(observed.disambiguation, MAX_OBSERVATION_TEXT_LENGTH),
    type: boundedText(observed.type, MAX_OBSERVATION_TYPE_LENGTH),
    observedAt: at,
  };
}

// Prepares normalized proposals for storage on a revision. MusicBrainz
// proposals are validated through the injected exact-ID lookup and receive a
// bounded observation snapshot; approval later uses only that snapshot.
// Lookup failures propagate so the caller can report the provider state.
async function prepareArtistProposals(proposals, { lookupMusicBrainzArtist, now = () => new Date() } = {}) {
  const list = proposals || [];
  if (list.some((proposal) => proposal.kind === "musicbrainz") && typeof lookupMusicBrainzArtist !== "function") {
    throw new TypeError("prepareArtistProposals requires lookupMusicBrainzArtist for MusicBrainz proposals");
  }
  const prepared = [];
  for (const proposal of list) {
    if (proposal.kind === "musicbrainz") {
      const observed = await lookupMusicBrainzArtist(proposal.artistMbid);
      prepared.push({ ...proposal, observation: musicBrainzObservation(proposal.artistMbid, observed, now()) });
    } else {
      prepared.push({ ...proposal, evidence: proposal.evidence.map((entry) => ({ ...entry })) });
    }
  }
  return prepared;
}

// Defensive check of stored proposals and selections at the approval
// boundary: the resolver only trusts shapes this module could have produced.
function assertPreparedProposals(proposals, selections, creditCount) {
  const byKey = new Map();
  for (const proposal of proposals || []) {
    if (!isRecord(proposal) || !PROPOSAL_KEY_PATTERN.test(proposal.proposalKey || "") || byKey.has(proposal.proposalKey)) {
      throw new ArtistIdentityError("Stored artist proposals are invalid", "ARTIST_PROPOSAL_INVALID");
    }
    if (proposal.kind === "musicbrainz") {
      const mbid = normalizeArtistMbid(proposal.artistMbid);
      if (!mbid || normalizeArtistMbid(proposal.observation?.artistMbid) !== mbid || !proposal.observation?.name) {
        throw new ArtistIdentityError("A MusicBrainz proposal has no reviewed observation", "ARTIST_PROPOSAL_INVALID", [proposal.proposalKey]);
      }
    } else if (proposal.kind === "community") {
      if (!String(proposal.canonicalName || "").trim()) {
        throw new ArtistIdentityError("A community proposal has no canonical name", "ARTIST_PROPOSAL_INVALID", [proposal.proposalKey]);
      }
    } else {
      throw new ArtistIdentityError("Stored artist proposals are invalid", "ARTIST_PROPOSAL_INVALID");
    }
    byKey.set(proposal.proposalKey, proposal);
  }
  const positions = new Set();
  const used = new Set();
  for (const selection of selections || []) {
    const { position } = selection || {};
    if (!Number.isSafeInteger(position) || position < 0 || position >= creditCount || positions.has(position)) {
      throw new ArtistIdentityError("Stored artist selections are invalid", "ARTIST_PROPOSAL_INVALID");
    }
    positions.add(position);
    if (selection.kind === "existing") {
      if (!normalizeArtistId(selection.artistId)) {
        throw new ArtistIdentityError("Stored artist selections are invalid", "ARTIST_PROPOSAL_INVALID");
      }
    } else if (selection.kind === "proposal" && byKey.has(selection.proposalKey)) {
      used.add(selection.proposalKey);
    } else {
      throw new ArtistIdentityError("Stored artist selections are invalid", "ARTIST_PROPOSAL_INVALID");
    }
  }
  if (used.size !== byKey.size) {
    throw new ArtistIdentityError("A stored artist proposal is not linked to any credit", "ARTIST_PROPOSAL_INVALID");
  }
  return byKey;
}

// A MusicBrainz artist registered from a reviewed observation. The name is
// the observed canonical MusicBrainz name, never the credit wording.
function newObservedMusicBrainzArtistDocument({ observation, provenance = {}, source = "community", artistId } = {}) {
  const observedAt = observation?.observedAt ? new Date(observation.observedAt) : null;
  const observedProvenance = { ...provenance, ...(observedAt ? { observedAt } : {}) };
  return newArtistDocument({
    artistName: observation?.name,
    artistMbid: observation?.artistMbid,
    source,
    provenance: observedProvenance,
    ...(artistId ? { artistId } : {}),
  });
}

// Adds identity to a credit without touching anything else: wording, role
// (including a missing role), and any other stored keys stay byte-for-byte.
// Selected credits are known to carry no identity yet.
function linkedCredit(credit, artistId, artistMbid) {
  const { artistId: _artistId, artistMbid: _artistMbid, ...rest } = credit || {};
  return { ...rest, artistId, ...(artistMbid ? { artistMbid } : {}) };
}

function isDuplicateKey(error) {
  return error?.code === 11000 || (Array.isArray(error?.writeErrors) && error.writeErrors.some((item) => item?.code === 11000));
}

// Resolves reviewed selections to registry identities inside the caller's
// transaction. Existing selections must name a registered artist. A
// MusicBrainz proposal reuses the artist already registered for its exact
// MBID without renaming it, or registers one from the reviewed observation.
// A community proposal always registers a new artist: names never match.
// Selected credit positions must not already carry an identity, and every
// credit's wording, role and order is preserved.
//
// Returns { credits, resolutions, createdArtists }. `resolutions` is the
// receipt material: one entry per selection, in position order.
async function resolveArtistSelections({ credits, proposals = [], selections = [] }, { Artist, session, provenance = {} } = {}) {
  if (!Artist) throw new TypeError("resolveArtistSelections requires the Artist model");
  const list = Array.isArray(credits) ? credits : [];
  const byKey = assertPreparedProposals(proposals, selections, list.length);
  const ordered = [...(selections || [])].sort((left, right) => left.position - right.position);
  const alreadyLinked = ordered
    .filter((selection) => {
      const identity = creditIdentity(list[selection.position]);
      return Boolean(identity.artistId || identity.artistMbid);
    })
    .map((selection) => ({ position: selection.position, code: "CREDIT_ALREADY_LINKED" }));
  if (alreadyLinked.length) {
    throw new ArtistIdentityError("A selected credit already links to an artist", "ARTIST_IDENTITY_CONFLICT", alreadyLinked);
  }

  const existingIds = ordered.filter((selection) => selection.kind === "existing").map((selection) => selection.artistId);
  const mbids = [...byKey.values()].filter((proposal) => proposal.kind === "musicbrainz").map((proposal) => proposal.artistMbid);
  const byId = await loadArtistsById(Artist, existingIds, { session });
  const byMbid = await loadArtistsByMbid(Artist, mbids, { session });
  const missing = existingIds
    .filter((artistId) => !byId.has(normalizeArtistId(artistId)))
    .map((artistId) => ({ code: "ARTIST_NOT_FOUND", artistId }));
  if (missing.length) {
    throw new ArtistIdentityError("A selected artist is not in the artist registry", "ARTIST_IDENTITY_CONFLICT", missing);
  }

  const resolvedByKey = new Map();
  const createdArtists = [];
  for (const proposal of byKey.values()) {
    if (!ordered.some((selection) => selection.proposalKey === proposal.proposalKey)) continue;
    if (proposal.kind === "musicbrainz") {
      const existing = byMbid.get(normalizeArtistMbid(proposal.artistMbid));
      if (existing) {
        resolvedByKey.set(proposal.proposalKey, { artist: existing, outcome: "reused" });
        continue;
      }
      const document = newObservedMusicBrainzArtistDocument({ observation: proposal.observation, provenance });
      createdArtists.push(document);
      resolvedByKey.set(proposal.proposalKey, { artist: document, outcome: "created" });
    } else {
      const document = newCommunityArtistDocument({
        canonicalName: proposal.canonicalName,
        provenance,
        proposalKey: proposal.proposalKey,
      });
      createdArtists.push(document);
      resolvedByKey.set(proposal.proposalKey, { artist: document, outcome: "created" });
    }
  }

  if (createdArtists.length) {
    try {
      await Artist.create(createdArtists, { session, ordered: true });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ArtistIdentityError(
          "Another change registered one of these MusicBrainz artists at the same time; retry",
          "ARTIST_IDENTITY_CONFLICT",
          createdArtists
            .filter((artist) => artistMbidOf(artist))
            .map((artist) => ({ code: "ARTIST_REGISTRATION_RACE", artistMbid: artistMbidOf(artist) })),
        );
      }
      throw error;
    }
  }

  const resolvedCredits = list.map((credit) => ({ ...credit }));
  const resolutions = ordered.map((selection) => {
    let artist;
    let outcome;
    let kind;
    if (selection.kind === "existing") {
      artist = byId.get(normalizeArtistId(selection.artistId));
      outcome = "linked";
      kind = "existing";
    } else {
      ({ artist, outcome } = resolvedByKey.get(selection.proposalKey));
      kind = byKey.get(selection.proposalKey).kind;
    }
    const artistMbid = artistMbidOf(artist);
    resolvedCredits[selection.position] = linkedCredit(list[selection.position], artist.artistId, artistMbid);
    return {
      position: selection.position,
      kind,
      proposalKey: selection.kind === "proposal" ? selection.proposalKey : "",
      artistId: artist.artistId,
      artistMbid: artistMbid || "",
      outcome,
    };
  });
  return { credits: resolvedCredits, resolutions, createdArtists };
}

module.exports = {
  ArtistProposalValidationError,
  MAX_ARTIST_PROPOSALS,
  MAX_ARTIST_SELECTIONS,
  MAX_PROPOSAL_EVIDENCE,
  PROPOSAL_KEY_PATTERN,
  PROPOSAL_KINDS,
  RESOLUTION_OUTCOMES,
  SELECTION_KINDS,
  assertPreparedProposals,
  musicBrainzObservation,
  newObservedMusicBrainzArtistDocument,
  normalizeArtistProposals,
  normalizeArtistSelections,
  prepareArtistProposals,
  resolveArtistSelections,
};
