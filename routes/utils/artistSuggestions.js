const Artist = require("../../models/Artist");
const { creditIdentity, loadArtistsById, loadArtistsByMbid, artistMbidOf } = require("../../lib/artists/identity");
const {
  ArtistProposalValidationError,
  normalizeArtistProposals,
  normalizeArtistSelections,
  prepareArtistProposals,
} = require("../../lib/artists/proposals");
// Called through the module object so tests can replace the adapter; normal
// tests never reach MusicBrainz.
const musicBrainz = require("../../lib/musicBrainzSearch");
const { normalizeRequestKey, payloadDigest } = require("./requestKeys");
const { isArtistSuggestionsEnabled } = require("./serverConfig");

// Embedded artist proposals on new-album suggestions (milestone 3). The
// request carries artistProposals and artistSelections beside the ordinary
// suggestion body; credits keep their own wording, roles and order, and a
// selection only adds an identity at its credit position.

const ARTIST_REQUEST_FIELDS = ["artistProposals", "artistSelections", "requestKey"];

class ArtistSuggestionError extends Error {
  constructor(message, status, code, extra = {}) {
    super(message);
    this.name = "ArtistSuggestionError";
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function plain(value) {
  return value && typeof value.toObject === "function" ? value.toObject() : value;
}

function isEmptyList(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

// Separates the artist fields from the ordinary suggestion body, which keeps
// its strict validation unchanged. Legacy bodies pass through untouched.
function splitArtistRequest(body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const rest = { ...source };
  ARTIST_REQUEST_FIELDS.forEach((field) => { delete rest[field]; });
  const present = !isEmptyList(source.artistProposals) || !isEmptyList(source.artistSelections);
  return {
    rest: body && typeof body === "object" && !Array.isArray(body) ? rest : body,
    artist: { artistProposals: source.artistProposals, artistSelections: source.artistSelections, present },
    requestKey: source.requestKey,
  };
}

function assertArtistSuggestionsEnabled(message = "Artist linking is currently disabled") {
  if (!isArtistSuggestionsEnabled()) {
    throw new ArtistSuggestionError(message, 503, "ARTIST_SUGGESTIONS_DISABLED");
  }
}

// Normalizes the client's proposals and selections against the normalized
// credits. Returns null when the request carries no artist work.
function normalizeArtistWork(artist, credits) {
  if (!artist?.present) return null;
  const proposals = normalizeArtistProposals(artist.artistProposals ?? []);
  const selections = normalizeArtistSelections(artist.artistSelections ?? [], proposals, { creditCount: credits.length });
  const linked = selections
    .filter((selection) => {
      const identity = creditIdentity(credits[selection.position]);
      return Boolean(identity.artistId || identity.artistMbid);
    })
    .map((selection) => selection.position);
  if (linked.length) {
    throw new ArtistProposalValidationError(
      "A credit cannot carry both an identity and an artist link; remove one",
      "CREDIT_ALREADY_LINKED",
      linked.map((position) => `artistSelections position ${position} already has an artist identity`),
    );
  }
  return { proposals, selections };
}

// Existing selections must name registered artists when submitted, like
// identities on credits. Approval checks again in its transaction.
async function assertExistingSelections(selections, { ArtistModel = Artist } = {}) {
  const ids = selections.filter((selection) => selection.kind === "existing").map((selection) => selection.artistId);
  if (!ids.length) return;
  const found = await loadArtistsById(ArtistModel, ids);
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new ArtistProposalValidationError("A linked artist is not on Rescened", "ARTIST_NOT_FOUND", missing.map((id) => `artistId ${id} is not a Rescened artist`));
  }
}

function observationsFrom(source) {
  const observations = new Map();
  for (const proposal of plain(source)?.artistProposals || []) {
    const item = plain(proposal);
    if (item?.kind === "musicbrainz" && item.observation?.artistMbid === item.artistMbid) {
      observations.set(item.artistMbid, { ...plain(item.observation) });
    }
  }
  return observations;
}

// Server-prepared stored proposals. A MusicBrainz MBID already observed on
// the previous revision keeps that observation (and its time); any other MBID
// is validated through the exact-ID lookup now. Approval never looks up.
async function prepareStoredProposals(proposals, { previous = null } = {}) {
  const known = observationsFrom(previous);
  try {
    const prepared = await prepareArtistProposals(proposals.filter((proposal) => !(proposal.kind === "musicbrainz" && known.has(proposal.artistMbid))), {
      lookupMusicBrainzArtist: (mbid) => musicBrainz.lookupMusicBrainzArtist(mbid),
    });
    const byKey = new Map(prepared.map((proposal) => [proposal.proposalKey, proposal]));
    return proposals.map((proposal) => byKey.get(proposal.proposalKey) || { ...proposal, observation: known.get(proposal.artistMbid) });
  } catch (error) {
    if (error instanceof ArtistProposalValidationError) throw error;
    if (error instanceof musicBrainz.MusicBrainzSearchError && error.status === 400) {
      throw new ArtistProposalValidationError(error.message, "INVALID_ARTIST_PROPOSAL");
    }
    const throttled = error?.code === "MUSICBRAINZ_THROTTLED" || error?.code === "MUSICBRAINZ_BUSY";
    throw new ArtistSuggestionError(
      "MusicBrainz could not confirm the selected artist right now. Your suggestion was not saved; try again shortly.",
      503,
      "ARTIST_LOOKUP_UNAVAILABLE",
      { retryAfterSeconds: throttled && Number.isInteger(error.retryAfterSeconds) ? error.retryAfterSeconds : 5 },
    );
  }
}

// Client-side normalization only: strings trimmed and NFC-normalized at any
// depth, so the digest does not depend on registry or provider data.
function normalizedClientValue(value) {
  if (typeof value === "string") return value.normalize("NFC").trim();
  if (Array.isArray(value)) return value.map(normalizedClientValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizedClientValue(entry)]));
  }
  return value;
}

// Digest of the normalized client input for request-key comparison. Every
// part comes from the request itself (`clientPayload` is the database-free
// normalizeSubmissionPayload result), never from hydrated registry names,
// edition previews, or provider observations, which can change or expire
// between attempts.
function creationDigest({ clientPayload, work, editionPreviewId }) {
  return payloadDigest({
    proposedMetadata: clientPayload.proposedMetadata,
    supportingSources: clientPayload.supportingSources,
    externalReferences: clientPayload.externalReferences,
    proposedGenres: clientPayload.proposedGenres === undefined ? null : normalizedClientValue(clientPayload.proposedGenres),
    editionPreviewId: typeof editionPreviewId === "string" ? editionPreviewId.trim().toLowerCase() : null,
    artistProposals: work?.proposals || [],
    artistSelections: work?.selections || [],
  });
}

function artistWorkFields(work, prepared) {
  return { artistProposals: work ? prepared : [], artistSelections: work ? work.selections : [] };
}

function isArtistBearing(source) {
  const item = plain(source) || {};
  return (item.submissionType || "new_album") === "new_album" && Array.isArray(item.artistSelections) && item.artistSelections.length > 0;
}

// A catalog correction's identity-only links ({ artistProposals,
// artistSelections }), or null.
function correctionArtistLinks(source) {
  const item = plain(source) || {};
  if (item.submissionType !== "catalog_correction") return null;
  const links = plain(plain(item.proposedChanges)?.artistLinks);
  return Array.isArray(links?.artistSelections) && links.artistSelections.length ? links : null;
}

// Whether a suggestion of either kind carries artist links.
function hasArtistLinks(source) {
  return isArtistBearing(source) || Boolean(correctionArtistLinks(source));
}

function publicProposal(proposal) {
  const item = plain(proposal) || {};
  if (item.kind === "musicbrainz") {
    const observation = plain(item.observation) || {};
    return {
      proposalKey: item.proposalKey,
      kind: "musicbrainz",
      artistMbid: item.artistMbid,
      observation: {
        artistMbid: observation.artistMbid,
        name: observation.name,
        sortName: observation.sortName || "",
        disambiguation: observation.disambiguation || "",
        type: observation.type || "",
        observedAt: observation.observedAt,
      },
    };
  }
  return {
    proposalKey: item.proposalKey,
    kind: "community",
    canonicalName: item.canonicalName,
    evidence: (item.evidence || []).map((entry) => ({ url: plain(entry).url, description: plain(entry).description || "" })),
  };
}

function publicSelection(selection) {
  const item = plain(selection) || {};
  return item.kind === "existing"
    ? { position: item.position, kind: "existing", artistId: item.artistId }
    : { position: item.position, kind: "proposal", proposalKey: item.proposalKey };
}

// Private detail fields for the owner and moderators only. Evidence links
// are included here and nowhere public.
function artistDetailFields(source) {
  const item = plain(source) || {};
  if (!Array.isArray(item.artistSelections) || !item.artistSelections.length) return {};
  return {
    artistProposals: (item.artistProposals || []).map(publicProposal),
    artistSelections: item.artistSelections.map(publicSelection),
  };
}

function artistResolutionFields(source) {
  const resolutions = plain(plain(source)?.approvalReceipt)?.artistResolutions;
  if (!Array.isArray(resolutions) || !resolutions.length) return {};
  return {
    artistResolutions: resolutions.map((entry) => {
      const item = plain(entry);
      return { position: item.position, kind: item.kind, proposalKey: item.proposalKey || "", artistId: item.artistId, artistMbid: item.artistMbid || "", outcome: item.outcome };
    }),
  };
}

// Moderator context: which proposed MusicBrainz MBIDs are already registered,
// so the reviewer can see approval will reuse that artist. Exact MBIDs only.
async function proposalRegistryContext(suggestion, { ArtistModel = Artist } = {}) {
  const proposals = [...(suggestion?.artistProposals || []), ...(suggestion?.proposedChanges?.artistLinks?.artistProposals || [])];
  const mbids = proposals.filter((proposal) => proposal.kind === "musicbrainz").map((proposal) => proposal.artistMbid);
  if (!mbids.length) return {};
  const found = await loadArtistsByMbid(ArtistModel, mbids);
  const result = {};
  for (const [mbid, artist] of found) result[mbid] = { artistId: artist.artistId, name: artist.name || "", artistMbid: artistMbidOf(artist) || mbid };
  return result;
}

module.exports = {
  ARTIST_REQUEST_FIELDS,
  ArtistSuggestionError,
  artistDetailFields,
  artistResolutionFields,
  artistWorkFields,
  assertArtistSuggestionsEnabled,
  assertExistingSelections,
  correctionArtistLinks,
  creationDigest,
  hasArtistLinks,
  isArtistBearing,
  normalizeArtistWork,
  normalizeRequestKey,
  prepareStoredProposals,
  proposalRegistryContext,
  publicProposal,
  splitArtistRequest,
};
