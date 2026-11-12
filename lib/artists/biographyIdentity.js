// Extra identity proof for descriptive name annotations and corroborated
// solo projects. Names are evidence labels, never identity matching keys.
const { BiographySourceError, QID_PATTERN } = require('./biographySources');
const { normalizeArtistMbid } = require('./identity');
const MAX_REDIRECTS = 3;
const MAX_ALIASES = 8;

function sourceInvalid(message) {
  throw new BiographySourceError(message, { code: 'BIOGRAPHY_INVALID_RESPONSE', provider: 'wikidata' });
}

async function linkedEntity(artist, sources, evidence) {
  const links = artist.wikidata.filter(relation => !relation.ended);
  evidence.wikidataLinks = links.map(relation => relation.qid || relation.resource);
  if (links.some(relation => !relation.qid)) return { problem: 'UNRECOGNIZED_WIKIDATA_URL' };
  const qids = [...new Set(links.map(relation => relation.qid))];
  if (!qids.length) return { problem: 'NO_WIKIDATA_LINK' };
  if (qids.length > 1) return { problem: 'MULTIPLE_WIKIDATA_LINKS' };
  let qid = qids[0];
  const visited = new Set([qid]);
  evidence.wikidataRedirects = [];
  for (;;) {
    const entity = await sources.wikidataEntity(qid);
    if (entity.missing) return { qid, problem: 'WIKIDATA_ITEM_MISSING' };
    if (!entity.redirected) {
      if (entity.id !== qid) sourceInvalid('Wikidata returned an unexpected item');
      evidence.wikidataRevisionId = entity.revisionId;
      if (evidence.wikidataRedirects.length) evidence.wikidataId = qid;
      return { qid, entity };
    }
    if (!QID_PATTERN.test(entity.redirectTo || '') || entity.id !== entity.redirectTo) sourceInvalid('Wikidata returned an invalid redirect');
    if (visited.has(entity.redirectTo)) return { qid, problem: 'WIKIDATA_REDIRECT_LOOP' };
    if (evidence.wikidataRedirects.length >= MAX_REDIRECTS) return { qid, problem: 'WIKIDATA_REDIRECT_LIMIT' };
    // The response revision belongs to the resolved entity, not necessarily
    // the source redirect page. It is observation provenance only.
    evidence.wikidataRedirects.push({ from: qid, to: entity.redirectTo, revisionId: entity.revisionId });
    qid = entity.redirectTo;
    visited.add(qid);
  }
}

function safeClaim(claim) {
  return (claim.rank === 'normal' || claim.rank === 'preferred') && claim.snaktype === 'value' &&
    normalizeArtistMbid(claim.value) && ['plain', 'name'].includes(claim.qualifierPolicy);
}

function p434Problem(claims, mbid) {
  if (!claims.length) return { status: 'needs_review', reason: 'P434_MISSING' };
  if (!claims.some(claim => claim.value === mbid && safeClaim(claim))) {
    if (claims.some(claim => claim.value === mbid && claim.rank !== 'deprecated')) return { status: 'needs_review', reason: 'P434_UNCERTAIN' };
    if (claims.some(claim => claim.value === mbid && claim.rank === 'deprecated')) return { status: 'conflict', reason: 'P434_DEPRECATED' };
    if (claims.some(claim => ['normal', 'preferred'].includes(claim.rank) && claim.snaktype === 'value' && claim.value !== mbid)) return { status: 'conflict', reason: 'P434_MISMATCH' };
    return { status: 'needs_review', reason: 'P434_UNCERTAIN' };
  }
  // An unknown rank, no-value claim, unsupported qualifier, malformed value,
  // or another uncertain current claim must not be hidden by one safe match.
  if (claims.some(claim => claim.rank !== 'deprecated' && !safeClaim(claim))) return { status: 'needs_review', reason: 'P434_UNCERTAIN' };
  return null;
}

function dateRange(value) {
  if (value === null) return null;
  const match = typeof value === 'string' && /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = match[2] ? Number(match[2]) : null;
  if (year < 1000 || (month !== null && (month < 1 || month > 12))) return false;
  const days = new Date(Date.UTC(year, month || 12, 0)).getUTCDate();
  const day = match[3] ? Number(match[3]) : null;
  if (day !== null && (day < 1 || day > days)) return false;
  return [Date.UTC(year, (month || 1) - 1, day || 1), Date.UTC(year, (month || 12) - 1, day || days, 23, 59, 59, 999)];
}

function validPerformanceName(relation, now, historical = false) {
  if (!normalizeArtistMbid(relation.artistMbid) || !['forward', 'backward'].includes(relation.direction) || typeof relation.ended !== 'boolean' || relation.plain !== true) return false;
  if (!historical && (relation.ended || relation.end !== null)) return false;
  if (!relation.ended && relation.end !== null) return false;
  const begin = dateRange(relation.begin), end = dateRange(relation.end);
  if (begin === false || end === false || (begin && begin[1] > now.getTime()) || (end && end[1] > now.getTime())) return false;
  if (begin && end && begin[0] > end[1]) return false;
  return true;
}
function activePerformanceName(relation, now) { return validPerformanceName(relation, now); }

function reciprocalName(left, right, now, requiredDirection = null, historical = false) {
  return (left.performanceNames || []).some(relation => relation.artistMbid === right.id &&
    (!requiredDirection || relation.direction === requiredDirection) && validPerformanceName(relation, now, historical) &&
    (right.performanceNames || []).some(reverse => reverse.artistMbid === left.id && reverse.direction === (relation.direction === 'forward' ? 'backward' : 'forward') &&
      reverse.ended === relation.ended && reverse.begin === relation.begin && reverse.end === relation.end && validPerformanceName(reverse, now, historical)));
}

function artistEvidence(artist) {
  return { artistMbid: artist.id, musicBrainzType: artist.type, performanceNames: artist.performanceNames || [] };
}

async function canonicalArtist(id, sources, evidence) {
  const visited = new Set([id]);
  evidence.musicBrainzRedirects = [];
  let current = id;
  for (;;) {
    try {
      const artist = await sources.musicBrainzArtist(current);
      if (artist.id !== current) return null; // Never trust an unannounced substitution.
      evidence.musicBrainzId = current;
      return artist;
    } catch (error) {
      if (!(error instanceof BiographySourceError) || error.provider !== 'musicbrainz' || error.code !== 'BIOGRAPHY_MUSICBRAINZ_MERGED') throw error;
      const to = normalizeArtistMbid(error.redirectedArtistMbid);
      if (!to || visited.has(to) || evidence.musicBrainzRedirects.length >= MAX_REDIRECTS) return null;
      evidence.musicBrainzRedirects.push({ from: current, to });
      visited.add(to); current = to;
    }
  }
}

// Solo-project membership still requires the exact current person identifier.
async function relatedArtist(id, sources, evidence) {
  const artist = await canonicalArtist(id, sources, evidence);
  return artist?.id === id ? artist : null;
}

// Multiple MBIDs on one human item may be real/stage names. Require every
// current identifier to be a separately checked person and form a connected
// graph of reciprocal current or historical performance-name relationships. A shared
// Wikidata item alone, or name similarity, is not sufficient.
async function verifyPersonAliases({ artist, entity, sources, now, kindOf, evidence }) {
  const ids = [...new Set(entity.p434.filter(c => c.rank !== 'deprecated').map(c => c.value))].sort();
  if (ids.length <= 1) return true;
  if (artist.type !== 'Person' || kindOf(entity.p31) !== 'person' || ids.length > MAX_ALIASES) return false;
  const nodes = new Map([[artist.id, artist]]);
  const proof = { artists: [] };
  evidence.personAliases = proof;
  for (const id of ids) {
    const row = { requestedArtistMbid: id };
    const node = id === artist.id ? artist : await canonicalArtist(id, sources, row);
    if (!node) { proof.artists.push(row); return false; }
    Object.assign(row, artistEvidence(node));
    proof.artists.push(row);
    if (node.type !== 'Person' || !ids.includes(node.id)) return false;
    const linked = await linkedEntity(node, sources, row);
    if (linked.problem || linked.qid !== entity.id || kindOf(linked.entity.p31) !== 'person' || p434Problem(linked.entity.p434, node.id)) return false;
    row.p434 = linked.entity.p434; row.p31 = linked.entity.p31;
    // All reciprocal observations must agree on the current identifier set.
    if (JSON.stringify([...new Set(linked.entity.p434.filter(c => c.rank !== 'deprecated').map(c => c.value))].sort()) !== JSON.stringify(ids)) return false;
    nodes.set(node.id, node);
  }
  const connected = new Set([artist.id]);
  for (;;) {
    const size = connected.size;
    for (const left of [...nodes.values()].filter(node => connected.has(node.id))) {
      for (const right of nodes.values()) if (reciprocalName(left, right, now, null, true)) connected.add(right.id);
    }
    if (size === connected.size) break;
  }
  return connected.size === nodes.size;
}

// Narrow bridge only: a MusicBrainz person/performance identity whose
// Wikidata item is a musical group/project. Verify the underlying human
// through both providers, and one unqualified current member in Wikidata.
async function verifySoloProject({ artist, entity, sources, now, kindOf, evidence }) {
  if (artist.type !== 'Person' || kindOf(entity.p31) !== 'group') return false;
  const members = (entity.p527 || []).filter(c => c.rank !== 'deprecated');
  const proof = { projectMembers: entity.p527 || [], projectPerformanceNames: artist.performanceNames || [] };
  evidence.soloProject = proof;
  if (!members.length || members.some(c => !['normal', 'preferred'].includes(c.rank) || c.snaktype !== 'value' || !c.value || c.qualifierPolicy !== 'plain')) return false;
  const memberIds = [...new Set(members.map(c => c.value))];
  if (memberIds.length !== 1) return false;
  // Every current backward relationship must be understood; do not silently
  // ignore an ended/ambiguous relationship and call the project a solo one.
  const people = (artist.performanceNames || []).filter(r => r.direction === 'backward');
  if (!people.length || people.some(r => !activePerformanceName(r, now))) return false;
  const personIds = [...new Set(people.map(r => r.artistMbid))];
  if (personIds.length !== 1 || personIds[0] === artist.id) return false;
  const person = await relatedArtist(personIds[0], sources, proof);
  if (!person) return false;
  proof.person = artistEvidence(person);
  if (person.id !== personIds[0] || person.type !== 'Person' || !reciprocalName(artist, person, now, 'backward')) return false;
  const linked = await linkedEntity(person, sources, proof.person);
  if (linked.problem || linked.qid !== memberIds[0] || kindOf(linked.entity.p31) !== 'person' || p434Problem(linked.entity.p434, person.id)) return false;
  proof.person.p434 = linked.entity.p434; proof.person.p31 = linked.entity.p31;
  const currentIds = [...new Set(linked.entity.p434.filter(c => c.rank !== 'deprecated').map(c => c.value))];
  if (currentIds.length !== 1) return false;
  proof.person.memberships = linked.entity.p463 || [];
  const memberships = proof.person.memberships.filter(c => c.value === entity.id && c.rank !== 'deprecated');
  if (!memberships.length || memberships.some(c => !['normal', 'preferred'].includes(c.rank) || c.snaktype !== 'value' || c.qualifierPolicy !== 'plain')) return false;
  proof.verified = true;
  return true;
}

module.exports = { canonicalArtist, linkedEntity, p434Problem, activePerformanceName, verifyPersonAliases, verifySoloProject };
