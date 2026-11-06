const crypto = require("node:crypto");
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/iu;
function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function fail(message, code = "INVALID_BASELINE_REQUEST", status = 400, details = []) { throw new BaselineError(message, code, status, details); }
class BaselineError extends Error {
  constructor(message, code, status = 400, details = []) {
    super(message);
    this.name = "BaselineError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function serializeCandidate(value, { includeTrackIds = false } = {}) {
  const candidate = plain(value); if (!candidate) return null;
  return { ...candidate, tracks: (candidate.tracks || []).map((track) => {
    const source = plain(track); if (includeTrackIds) return source;
    const { trackId, ...externalTrack } = source; return externalTrack;
  }) };
}

function assertMbid(value, name) { if (typeof value !== "string") fail(`${name} must be a MusicBrainz UUID`); const normalized = value.trim().toLowerCase(); if (!MBID.test(normalized)) fail(`${name} must be a MusicBrainz UUID`); return normalized; }

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") fail("Provider candidate is invalid", "INVALID_PROVIDER_CANDIDATE", 502);
  ["releaseMbid", "releaseGroupMbid"].forEach((field) => assertMbid(candidate[field], field));
  if (!HASH.test(String(candidate.tracklistHash || ""))) fail("Provider candidate has no valid tracklist hash", "INVALID_PROVIDER_CANDIDATE", 502);
  if (candidate.license !== "CC0" || !candidate.retrievedAt || String(candidate.sourceUrl || "") !== `https://musicbrainz.org/release/${String(candidate.releaseMbid || "").toLowerCase()}`) fail("Provider candidate provenance is invalid", "INVALID_PROVIDER_CANDIDATE", 502);
  if (!Array.isArray(candidate.tracks) || !candidate.tracks.length || candidate.tracks.length > 200) fail("Provider candidate tracklist is incomplete", "INCOMPLETE_TRACKLIST", 409);
  const positions = new Set();
  const byDisc = new Map(); let previousPosition = null;
  candidate.tracks.forEach((track) => {
    const disc = Number(track.discNumber); const number = Number(track.trackNumber);
    if (!Number.isSafeInteger(disc) || disc < 1 || !Number.isSafeInteger(number) || number < 1 || !String(track.title || "").trim()) fail("Provider candidate has an invalid track", "INVALID_PROVIDER_CANDIDATE", 502);
    if (!MBID.test(String(track.releaseTrackMbid || "")) || !MBID.test(String(track.recordingMbid || ""))) fail("Provider candidate track identifiers are invalid", "INVALID_PROVIDER_CANDIDATE", 502);
    const key = `${disc}:${number}`; if (positions.has(key)) fail("Provider candidate has duplicate track positions", "INCOMPLETE_TRACKLIST", 409); positions.add(key);
    if (previousPosition && (disc < previousPosition.disc || (disc === previousPosition.disc && number <= previousPosition.number))) fail("Provider candidate tracks are not in disc and track order", "INCOMPLETE_TRACKLIST", 409);
    previousPosition = { disc, number };
    if (!byDisc.has(disc)) byDisc.set(disc, []); byDisc.get(disc).push(number);
  });
  const discs = [...byDisc.keys()];
  if (discs.some((disc, index) => disc !== index + 1) || [...byDisc.values()].some((numbers) => numbers.some((number, index) => number !== index + 1))) fail("Provider candidate track positions are incomplete", "INCOMPLETE_TRACKLIST", 409);
  const hashTracks = candidate.tracks.map(({ discNumber, trackNumber, title, durationMs, artistDisplayName, releaseTrackMbid, recordingMbid }) => ({ discNumber, trackNumber, title, durationMs, artistDisplayName, releaseTrackMbid, recordingMbid }));
  const calculated = crypto.createHash("sha256").update(JSON.stringify({ releaseMbid: candidate.releaseMbid, releaseGroupMbid: candidate.releaseGroupMbid, title: candidate.title, artistDisplayName: candidate.artistDisplayName, tracks: hashTracks })).digest("hex");
  if (calculated !== candidate.tracklistHash) fail("Provider candidate tracklist hash does not match its tracks", "CANDIDATE_HASH_MISMATCH", 409);
  return candidate;
}

function releaseId(value) {
  const raw = String(value || "").trim();
  if (MBID.test(raw)) return raw.toLowerCase();
  try { const url = new URL(raw); if (url.protocol === "https:" && url.hostname === "musicbrainz.org") { const match = url.pathname.match(/^\/release\/([0-9a-f-]{36})\/?$/i); if (match && MBID.test(match[1])) return match[1].toLowerCase(); } } catch { /* handled below */ }
  fail("releaseMbid must be a MusicBrainz release UUID or URL");
}
module.exports = { BaselineError, serializeCandidate, assertMbid, validateCandidate, releaseId };
