const { normalize, mappingKey } = require("./common");

// Matching keys are comparison-only. Stored scrobble, catalog, and baseline text
// is never rewritten, and a key that fits more than one position is ambiguous.
const MATCHING_VERSION = 2;
const SHORT_TRACK_MS = 30_000;
const PLACEHOLDER_TITLES = new Set(["[silence]", "[untitled]", "[data track]"]);
const NON_AUDIO_FORMATS = new Set(["dvd", "dvd-video", "blu-ray", "hd-dvd", "vhs", "laserdisc", "vcd", "svcd", "umd", "data cd", "cd-rom"]);

const REMASTER_CORE = "(?:\\d{4}\\s+)?(?:digital(?:ly)?\\s+)?remaster(?:ed)?(?:\\s+\\d{4})?(?:\\s+version)?";
const REMASTER_SUFFIX = new RegExp(`\\s+(?:-\\s+${REMASTER_CORE}|\\(${REMASTER_CORE}\\)|\\[${REMASTER_CORE}\\])$`, "u");
const FEATURED_SUFFIX = /\s+[([](?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]$/u;
const GUEST_SEPARATOR = /\s*(?:,|&|\+|\band\b|\bx\b)\s*/u;
const JOIN_BEFORE = /(?:[,&+/]|(?:^|\s)(?:feat\.?|ft\.?|featuring|with|x|and|vs\.?))\s*$/u;
const JOIN_AFTER = /^\s*(?:[,&+/]|(?:feat\.?|ft\.?|featuring|with|x|and|vs\.?)(?:\s|$))/u;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// NFKC leaves curly and straight apostrophes distinct, so fold typography here.
function matchKey(value) {
  return normalize(value)
    .replace(/[‘’‚‛′`]/gu, "'")
    .replace(/[“”„‟″]/gu, "\"")
    .replace(/[‐-―−]/gu, "-");
}

function stripRemaster(key) {
  const stripped = key.replace(REMASTER_SUFFIX, "");
  return stripped && stripped !== key ? stripped : "";
}

function stripFeatured(key) {
  const match = FEATURED_SUFFIX.exec(key);
  if (!match || match.index === 0) return null;
  return { key: key.slice(0, match.index), guest: match[1].trim() };
}

// True when `name` appears in the credit as a whole credited name, bounded by
// the start/end of the credit or a join phrase.
function creditNames(credit, name) {
  if (!name) return false;
  for (let index = credit.indexOf(name); index !== -1; index = credit.indexOf(name, index + 1)) {
    const before = credit.slice(0, index);
    const after = credit.slice(index + name.length);
    if ((!before.trim() || JOIN_BEFORE.test(before)) && (!after.trim() || JOIN_AFTER.test(after))) return true;
  }
  return false;
}

function guestsCredited(credit, guest) {
  return creditNames(credit, guest) || guest.split(GUEST_SEPARATOR).filter(Boolean).every((name) => creditNames(credit, name));
}

function primaryCredit(credit, artist) {
  return credit.startsWith(artist) && JOIN_AFTER.test(credit.slice(artist.length));
}

function addVariant(variants, key, rules, guest = "") {
  if (key && !variants.some((variant) => variant.key === key && variant.guest === guest)) variants.push({ key, rules, guest });
}

function eventTitleVariants(title) {
  const variants = [];
  const base = matchKey(title);
  addVariant(variants, base, []);
  addVariant(variants, stripRemaster(base), ["remaster_suffix"]);
  for (const variant of [...variants]) {
    const featured = stripFeatured(variant.key);
    if (featured) addVariant(variants, featured.key, [...variant.rules, "featured_artist"], featured.guest);
  }
  return variants;
}

function positionTitleVariants(title) {
  const variants = [];
  const base = matchKey(title);
  addVariant(variants, base, []);
  addVariant(variants, stripRemaster(base), ["remaster_suffix"]);
  return variants;
}

// Every scrobble artist the matcher would accept for this credit: the full credit
// and each prefix that ends at a join phrase.
function creditArtistVariants(credit) {
  const variants = new Set(credit ? [credit] : []);
  for (let index = 1; index < credit.length; index += 1) {
    const prefix = credit.slice(0, index);
    if (prefix === prefix.trim() && primaryCredit(credit, prefix)) variants.add(prefix);
  }
  return variants;
}

// Keys a plain-text scrobble of this position could carry. Two positions that
// share a key cannot be told apart without an established identifier.
function probeKeys(track) {
  const titles = new Set();
  for (const variant of positionTitleVariants(track.title)) {
    titles.add(variant.key);
    const featured = stripFeatured(variant.key);
    if (featured) titles.add(featured.key);
  }
  const keys = new Set();
  for (const artist of creditArtistVariants(matchKey(track.artistDisplayName))) {
    for (const title of titles) keys.add(JSON.stringify([artist, title]));
  }
  return keys;
}

function duplicateGroups(tracks) {
  const parent = tracks.map((_, index) => index);
  const root = (index) => (parent[index] === index ? index : (parent[index] = root(parent[index])));
  const owners = new Map();
  tracks.forEach((track, index) => {
    for (const key of probeKeys(track)) {
      if (owners.has(key)) parent[root(index)] = root(owners.get(key));
      else owners.set(key, index);
    }
  });
  const groups = new Map();
  tracks.forEach((track, index) => groups.set(root(index), [...(groups.get(root(index)) || []), track.trackId]));
  return [...groups.values()].filter((group) => group.length > 1);
}

function mbid(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MBID.test(normalized) ? normalized : "";
}

// The approved mapping already vouches that the scrobble artist names this album's
// artist, so a position credited to the album artist (alone or as primary) accepts
// it even when the spellings differ, e.g. a romanized name against a native one.
function artistRulesFor(credit, artist, albumCredit) {
  if (credit === artist) return [];
  if (primaryCredit(credit, artist)) return ["featured_artist"];
  if (!albumCredit) return null;
  if (credit === albumCredit) return ["mapped_album_artist"];
  if (primaryCredit(credit, albumCredit)) return ["featured_artist", "mapped_album_artist"];
  return null;
}

// Returns the fewest matching-key rules that connect the event to this position,
// or null when no reviewed rule does.
function positionRules(artist, titleVariants, track, albumCredit) {
  const credit = matchKey(track.artistDisplayName);
  if (!credit || !artist) return null;
  const artistRules = artistRulesFor(credit, artist, albumCredit);
  if (!artistRules) return null;
  let best = null;
  for (const positionTitle of positionTitleVariants(track.title)) {
    for (const eventTitle of titleVariants) {
      if (positionTitle.key !== eventTitle.key) continue;
      if (eventTitle.guest && !guestsCredited(credit, eventTitle.guest)) continue;
      const rules = [...new Set([...artistRules, ...positionTitle.rules, ...eventTitle.rules])].sort();
      if (!best || rules.length < best.length) best = rules;
    }
  }
  return best;
}

function mappingIndex(mappings = []) {
  const index = new Map();
  for (const mapping of mappings) {
    if (mapping?.status && mapping.status !== "active") continue;
    index.set(mapping.key || mappingKey(mapping.artist, mapping.album), mapping);
  }
  return index;
}

function matchEvent(event, { mappings, baselines }) {
  if (event.identityConflict) return { status: "identity_conflict" };
  const mapping = mappings.get(mappingKey(event.artist, event.album));
  if (!mapping) return { status: "mapping_unavailable" };
  const resolved = { albumId: mapping.albumId, mappingId: mapping.mappingId, mappingRevision: mapping.revision };
  const baseline = baselines.get(mapping.albumId);
  if (!baseline?.tracks?.length) return { status: "baseline_unavailable", ...resolved };
  const artist = matchKey(event.artist);
  const albumCredit = matchKey(baseline.artistDisplayName);
  const titles = eventTitleVariants(event.track);
  const candidates = [];
  for (const track of baseline.tracks) {
    const rules = positionRules(artist, titles, track, albumCredit);
    if (rules) candidates.push({ track, rules });
  }
  const matched = ({ track, rules }) => ({ status: "matched", ...resolved, trackId: track.trackId, discNumber: track.discNumber, trackNumber: track.trackNumber, rules });

  // A populated track ID is used only once it is established as this baseline's
  // recording or release-track ID. Last.fm often carries an ID from another
  // release, so an ID the baseline does not contain falls back to text and is
  // recorded as `foreign_track_id`. Malformed IDs, or one present as both types,
  // stay unresolved rather than guessing.
  const trackMbid = mbid(event.trackMbid);
  if (event.trackMbid && !trackMbid) return { status: "unverified_track_id", ...resolved };
  const byRecording = trackMbid ? baseline.tracks.filter((track) => mbid(track.recordingMbid) === trackMbid) : [];
  const byReleaseTrack = trackMbid ? baseline.tracks.filter((track) => mbid(track.releaseTrackMbid) === trackMbid) : [];
  if (trackMbid && byRecording.length && byReleaseTrack.length) return { status: "unverified_track_id", ...resolved };
  if (trackMbid && !byRecording.length && !byReleaseTrack.length) {
    if (candidates.length === 1) return matched({ track: candidates[0].track, rules: [...candidates[0].rules, "foreign_track_id"].sort() });
  } else if (trackMbid) {
    const identified = new Set((byRecording.length ? byRecording : byReleaseTrack).map((track) => track.trackId));
    const agreeing = candidates.filter((candidate) => identified.has(candidate.track.trackId));
    const idRule = byRecording.length ? "recording_id" : "release_track_id";
    if (identified.size === 1) {
      // Text that points only at other positions contradicts the identifier.
      if (candidates.length && !agreeing.length) return { status: "identity_conflict", ...resolved };
      const track = baseline.tracks.find((item) => identified.has(item.trackId));
      return matched({ track, rules: [...new Set([...(agreeing[0]?.rules || []), idRule])].sort() });
    }
    // A shared recording cannot distinguish its positions; only text can.
    if (agreeing.length === 1) return matched({ track: agreeing[0].track, rules: [...agreeing[0].rules, idRule].sort() });
    return agreeing.length ? { status: "ambiguous_track", ...resolved, candidateCount: agreeing.length } : { status: "identity_conflict", ...resolved };
  }

  if (!candidates.length) return { status: "unmatched_track", ...resolved };
  if (candidates.length > 1) return { status: "ambiguous_track", ...resolved, candidateCount: candidates.length };
  return matched(candidates[0]);
}

function requiredPositions(countable) {
  // ceil(0.8 × countable) in integer arithmetic.
  return countable > 0 ? Math.floor((4 * countable + 4) / 5) : 0;
}

// Derive the positions that count toward coverage. Excluded positions can still
// match an event, but coverage never needs them.
function countablePositions(baseline) {
  const tracks = baseline?.tracks || [];
  const nonAudioDiscs = new Set((baseline?.media || [])
    .filter((medium) => NON_AUDIO_FORMATS.has(matchKey(medium?.format)))
    .map((medium) => Number(medium.discNumber)));
  const excluded = new Map();
  for (const track of tracks) {
    const duration = Number(track.durationMs);
    if (nonAudioDiscs.has(Number(track.discNumber))) excluded.set(track.trackId, "non_audio_medium");
    else if (PLACEHOLDER_TITLES.has(matchKey(track.title))) excluded.set(track.trackId, "placeholder_title");
    else if (Number.isFinite(duration) && duration > 0 && duration < SHORT_TRACK_MS) excluded.set(track.trackId, "short_track");
  }
  for (const group of duplicateGroups(tracks)) {
    group.forEach((trackId) => { if (!excluded.has(trackId)) excluded.set(trackId, "duplicate_position"); });
  }
  const countable = tracks.map((track) => track.trackId).filter((trackId) => !excluded.has(trackId));
  const unknownDurations = tracks.filter((track) => !(Number(track.durationMs) > 0)).length;
  return {
    total: tracks.length,
    countable,
    required: requiredPositions(countable.length),
    excluded: tracks.filter((track) => excluded.has(track.trackId)).map((track) => ({ trackId: track.trackId, reason: excluded.get(track.trackId) })),
    unknownDurations,
    eligible: countable.length > 0,
    diagnostic: !countable.length || excluded.size * 5 > tracks.length ? "baseline_countability" : null,
  };
}

module.exports = {
  MATCHING_VERSION, SHORT_TRACK_MS,
  countablePositions, eventTitleVariants, mappingIndex, matchEvent, matchKey, requiredPositions, stripFeatured, stripRemaster,
};
