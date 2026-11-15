// Pure helpers for the shared artist picker. A picker links one credit to an
// artist only when a person explicitly chooses a result or proposes a new
// community artist. Search results are never applied by name, and the credit
// keeps its own wording whatever the artist's canonical name is.
//
// Selection shapes (client state; later milestones map them to requests):
//   { kind: "existing", artistId, name, artistMbid }      a Rescened artist
//   { kind: "musicbrainz", artistMbid, name, disambiguation, type, country }
//   { kind: "community", canonicalName, evidence: [{ url }] }

import { API_BASE_URL } from "../../config/api";
import { requestCommunityJson } from "../community/community";

export const MAX_PICKER_QUERY_LENGTH = 200;
export const MAX_CANONICAL_NAME_LENGTH = 200;
export const MAX_EVIDENCE_LINKS = 5;
export const MAX_EVIDENCE_URL_LENGTH = 2048;
export const PICKER_LOCAL_LIMIT = 8;

const ARTIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function normalizePickerQuery(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function pickerQueryProblem(value) {
  const query = normalizePickerQuery(value);
  if (!query) return "Type an artist name to search.";
  if (query.length > MAX_PICKER_QUERY_LENGTH) return `Searches can be at most ${MAX_PICKER_QUERY_LENGTH} characters.`;
  return "";
}

export function discoveryUrl(source, query, baseUrl = API_BASE_URL) {
  if (source !== "local" && source !== "musicbrainz") throw new TypeError(`Unknown discovery source: ${source}`);
  const params = new URLSearchParams({ q: normalizePickerQuery(query) });
  if (source === "local") params.set("limit", String(PICKER_LOCAL_LIMIT));
  return `${baseUrl}/artist-discovery/${source}?${params}`;
}

// One discovery request. Errors carry the server's code and any
// retryAfterSeconds; the caller decides what to show. Never retries.
export async function fetchArtistDiscovery(source, query, { getToken, signal, baseUrl = API_BASE_URL } = {}) {
  const token = await getToken();
  const fallback = source === "local" ? "Could not search Rescened artists." : "MusicBrainz artist search is unavailable.";
  return requestCommunityJson(discoveryUrl(source, query, baseUrl), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  }, fallback);
}

// Keeps only well-formed rows, so a malformed response cannot produce a
// selection without a real identity.
export function localResultsFrom(data) {
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.filter((row) => ARTIST_ID.test(String(row?.artistId || "")) && typeof row?.name === "string" && row.name.trim())
    .map((row) => ({
      artistId: row.artistId.toLowerCase(),
      name: row.name,
      artistMbid: MBID.test(String(row.artistMbid || "")) ? row.artistMbid.toLowerCase() : "",
      releaseCount: Number.isInteger(row.releaseCount) && row.releaseCount > 0 ? row.releaseCount : 0,
      knownFor: Array.isArray(row.knownFor) ? row.knownFor.filter((title) => typeof title === "string").slice(0, 2) : [],
      match: row.match && typeof row.match.name === "string" ? { name: row.match.name, kind: row.match.kind } : null,
    }));
}

export function providerCandidatesFrom(data) {
  const rows = Array.isArray(data?.candidates) ? data.candidates : [];
  return rows.filter((row) => MBID.test(String(row?.artistMbid || "")) && typeof row?.name === "string" && row.name.trim())
    .map((row) => ({
      artistMbid: row.artistMbid.toLowerCase(),
      name: row.name,
      disambiguation: typeof row.disambiguation === "string" ? row.disambiguation : "",
      type: typeof row.type === "string" ? row.type : "",
      country: typeof row.country === "string" ? row.country : "",
      registeredArtistId: ARTIST_ID.test(String(row.registeredArtistId || "")) ? row.registeredArtistId.toLowerCase() : null,
      registeredName: typeof row.registeredName === "string" ? row.registeredName.trim() : "",
      sourceUrl: `https://musicbrainz.org/artist/${row.artistMbid.toLowerCase()}`,
    }));
}

export function selectionFromLocal(result) {
  return { kind: "existing", artistId: result.artistId, name: result.name, artistMbid: result.artistMbid || "" };
}

// A MusicBrainz candidate whose exact MBID is already registered selects
// that Rescened artist under its registry name (MusicBrainz may word it
// differently); otherwise it proposes the MusicBrainz artist.
export function selectionFromCandidate(candidate) {
  if (candidate.registeredArtistId) {
    return { kind: "existing", artistId: candidate.registeredArtistId, name: candidate.registeredName || candidate.name, artistMbid: candidate.artistMbid };
  }
  return {
    kind: "musicbrainz",
    artistMbid: candidate.artistMbid,
    name: candidate.name,
    disambiguation: candidate.disambiguation || "",
    type: candidate.type || "",
    country: candidate.country || "",
  };
}

function httpsUrlProblem(value) {
  if (value.length > MAX_EVIDENCE_URL_LENGTH) return `Links can be at most ${MAX_EVIDENCE_URL_LENGTH} characters.`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full https:// link.";
  }
  if (url.protocol !== "https:" || !url.hostname) return "Links must start with https://.";
  if (url.username || url.password) return "Links cannot contain a username or password.";
  return "";
}

// Wording for a MusicBrainz row whose MBID is already registered.
export function registeredNote(candidate) {
  if (!candidate?.registeredArtistId) return "";
  const local = candidate.registeredName;
  return local && local !== candidate.name ? `already on Rescened as ${local}` : "already on Rescened";
}

// The live status line for a finished or running search. It describes what
// happened, including failures, so it never invites choosing from results
// that are not there.
export function pickerStatusMessage({ searchedQuery, local, provider }) {
  if (!searchedQuery || (local.status === "idle" && provider.status === "idle")) return "";
  const quoted = `“${searchedQuery}”`;
  if (local.status === "loading" || provider.status === "loading") return `Searching for ${quoted}…`;
  const rows = local.rows.length + provider.rows.length;
  const localFailed = local.status === "error";
  const providerFailed = provider.status === "error";
  if (localFailed && providerFailed) return `Search failed for ${quoted}. Try again, or propose a new artist.`;
  const failure = localFailed ? " Rescened search failed." : providerFailed ? " MusicBrainz is unavailable." : "";
  if (!rows) return `No artists found for ${quoted}.${failure} Try another spelling, or propose a new artist.`;
  return `Results for ${quoted}. Choose one, or propose a new artist.${failure}`;
}

// Validates a community proposal draft the same way the server will.
// Returns { selection } or { problems: { canonicalName?, evidence?: [] } }.
export function communitySelectionFrom(draft) {
  const canonicalName = String(draft?.canonicalName ?? "").normalize("NFC").trim();
  const links = (Array.isArray(draft?.evidence) ? draft.evidence : []).map((value) => String(value ?? "").trim());
  const problems = {};
  if (!canonicalName) problems.canonicalName = "Enter the artist's name as it should appear on Rescened.";
  else if (canonicalName.length > MAX_CANONICAL_NAME_LENGTH) problems.canonicalName = `Names can be at most ${MAX_CANONICAL_NAME_LENGTH} characters.`;
  else if (CONTROL.test(canonicalName)) problems.canonicalName = "Names cannot contain control characters.";
  const filled = links.filter(Boolean);
  const evidenceProblems = links.map((link) => (link ? httpsUrlProblem(link) : ""));
  const seen = new Set();
  links.forEach((link, index) => {
    if (!link || evidenceProblems[index]) return;
    if (seen.has(link)) evidenceProblems[index] = "This link is listed twice.";
    seen.add(link);
  });
  if (!filled.length) evidenceProblems[0] = "Add at least one https:// link that shows this artist exists.";
  if (filled.length > MAX_EVIDENCE_LINKS) problems.form = `Add at most ${MAX_EVIDENCE_LINKS} links.`;
  if (evidenceProblems.some(Boolean)) problems.evidence = evidenceProblems;
  if (Object.keys(problems).length) return { problems };
  return { selection: { kind: "community", canonicalName, evidence: filled.map((url) => ({ url })) } };
}

export function selectionName(selection) {
  if (!selection) return "";
  return selection.kind === "community" ? selection.canonicalName : selection.name;
}

export function selectionSourceLabel(selection) {
  if (selection?.kind === "existing") return "On Rescened";
  if (selection?.kind === "musicbrainz") return "MusicBrainz artist, added when approved";
  if (selection?.kind === "community") return "New community artist, reviewed by a moderator";
  return "";
}

// True when the credit wording differs from the chosen artist's name, so the
// picker can say the credit keeps its own wording.
export function creditedDiffers(creditName, selection) {
  const fold = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return Boolean(fold(creditName)) && Boolean(selection) && fold(creditName) !== fold(selectionName(selection));
}

export function candidateDetail(candidate) {
  return [candidate.disambiguation, candidate.type, candidate.country].filter(Boolean).join(" · ");
}

export function discoveryErrorMessage(error, source) {
  if (!error) return "";
  if (error.code === "ARTIST_DISCOVERY_THROTTLED" || error.code === "RATE_LIMITED") {
    const seconds = Number(error.retryAfterSeconds);
    const wait = Number.isFinite(seconds) && seconds > 0 ? ` Try again in ${Math.ceil(seconds)} second${Math.ceil(seconds) === 1 ? "" : "s"}.` : " Try again shortly.";
    return source === "local" ? `Too many artist searches.${wait}` : `MusicBrainz is busy.${wait}`;
  }
  if (error.code === "ARTIST_SUGGESTIONS_DISABLED") return "Artist linking is turned off right now.";
  if (error.code === "UNAUTHORIZED") return "Sign in again to search for artists.";
  if (source === "musicbrainz") return "MusicBrainz is unavailable right now. Rescened results still work.";
  return error.message || "Could not search Rescened artists.";
}
