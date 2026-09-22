const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const VERSION = '1';
const CATEGORIES = ['artist', 'album', 'formatting', 'label', 'miss'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function id(key) {
  const h = crypto.createHash('sha256').update(`rescened-search-quality:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Hand-authored metadata, not an imported discography. Label assignments and
// distractors are synthetic. No cover files, upstream identifiers, or requests.
const records = [
  ['discovery', 'Discovery', 'Daft Punk', 'Prism Records'],
  ['homework', 'Homework', 'Daft Punk', 'Prism Records'],
  ['discovery-live', 'Discovery Live', 'A Different Artist', 'Elsewhere'],
  ['moon-safari', 'Moon Safari', 'Air', 'Source'],
  ['air-title', 'Air', 'A Quiet Quartet', 'Elsewhere'],
  ['air-label', 'Windows', 'A Window Ensemble', 'Air'],
  ['debut', 'Debut', 'Björk', 'One Little Example'],
  ['black-messiah', 'Black Messiah', 'D’Angelo', 'Example Soul'],
  ['cafe', 'Café Sessions', 'Café Trio', 'Café Records'],
  ['hikari', '光', '宇多田ヒカル', 'Example Japan'],
  ['live', 'Signals [Live]', 'Bracket Band', 'Example Live'],
  ['not-live', 'Signals Live', 'A Bracket Band', 'Elsewhere'],
  ['shared-a', 'Home', 'Northbound', 'Harbour'],
  ['shared-b', 'Home', 'Southbound', 'Harbour'],
  ['edition', 'Night Windows', 'Zeta', 'Edition House'],
  ['edition-deluxe', 'Night Windows (Deluxe)', 'Alpha', 'Edition House'],
  ['edition-remix', 'Night Windows Remixes', 'Beta', 'Edition House'],
  ['collaboration', 'Crossing Paths', 'The Crossing Project', 'Example Jazz', ['The Crossing Project', 'Mira Vale']],
  ['collaborator-title', 'Mira Vale: A Tribute', 'A Tribute Band', 'Elsewhere'],
  ['blue-one', 'Coastline', 'Coastal Trio', 'Blue Lantern Records'],
  ['blue-two', 'Harbor Lights', 'Harbor Quartet', 'Blue Lantern Records'],
  ['blue-three', 'Deep Water', 'Ocean Ensemble', 'Blue Lantern Archive'],
  ['blue-title', 'Blue Lantern Records', 'A Label Tribute', 'Elsewhere'],
  ['blue-artist', 'Other Songs', 'Blue Lantern Records', 'Elsewhere'],
  ['curly-label', 'Soul Sketches', 'Soul Sketchers', 'Listener’s Choice'],
  ['regex-decoy', 'Wildcard Decoy', 'Dot Star Players', 'Elsewhere'],
  ['word-a', 'Copper', 'Amber Artist', 'Elsewhere'],
  ['word-b', 'Violet', 'Indigo Artist', 'Elsewhere'],
];
// Explicit synthetic long-discography family; judgments name this family rather
// than asking the production matcher which rows ought to be relevant.
const meridianKeys = Array.from({ length: 30 }, (_, n) => `meridian-${String(n + 1).padStart(2, '0')}`);
for (const [n, key] of meridianKeys.entries()) {
  records.push([key, `Study ${String(n + 1).padStart(2, '0')}`, 'The Meridian Ensemble', 'Meridian Editions']);
}
for (let n = 1; n <= 6; n++) {
  records.push([`meridian-tribute-${n}`, 'The Meridian Ensemble: A Tribute', `A Tribute ${n}`, 'Elsewhere']);
}

function album([key, title, artistDisplayName, label, credits = [artistDisplayName]]) {
  return {
    albumId: id(key), title, artistDisplayName,
    artistCredits: credits.map(name => ({ name, role: 'main' })), label,
    releaseType: 'album', releaseDate: '', releaseDatePrecision: '', releaseYear: null,
    tracks: [], cover: '', catalogSource: 'manual', catalogRevision: 1,
    // A unique synthetic reference exercises the real multikey catalog index.
    externalReferences: [{ provider: 'search-quality-fixture', entityType: 'album', externalId: key, url: '' }],
    fieldProvenance: {},
  };
}
function query(key, category, text, intent, relevant, explanation, preferred = []) {
  return { id: key, category, query: text, intent, explanation, relevantIds: relevant.map(id), preferredIds: preferred.map(id) };
}
const queries = [
  query('artist-exact', 'artist', 'Daft Punk', 'Find albums by an exact artist', ['discovery', 'homework'], 'Both albums are equally relevant.'),
  query('artist-short', 'artist', 'Air', 'Find albums by the artist Air', ['moon-safari'], 'Title and label collisions are distractors.', ['moon-safari']),
  query('artist-credit', 'artist', 'Mira Vale', 'Find a credited collaborator', ['collaboration'], 'Artist credits qualify even when the display name differs; a tribute title does not.'),
  query('artist-album', 'artist', 'Daft Punk Discovery', 'Find a specific artist and album', ['discovery'], 'Words may span artist and title fields.', ['discovery']),
  query('artist-album-reversed', 'artist', 'Moon Safari Air', 'Find an album with artist appended', ['moon-safari'], 'Album-first phrasing has the same intended target.', ['moon-safari']),
  query('artist-discography', 'artist', 'The Meridian Ensemble', 'Browse an exact artist with over 24 albums', meridianKeys, 'All 30 studies are equally relevant; six early-sorting tribute artists are distractors.'),
  query('album-exact', 'album', 'Discovery', 'Find the album with this exact title', ['discovery', 'discovery-live'], 'The longer live title is related, but the exact title is preferred.', ['discovery']),
  query('album-partial', 'album', 'Moon Saf', 'Find an album by a title prefix', ['moon-safari'], 'A partial title should find Moon Safari.'),
  query('album-substring', 'album', 'Safari', 'Find an album by an interior title word', ['moon-safari'], 'Search is not restricted to title prefixes.'),
  query('album-shared', 'album', 'Home', 'Find albums sharing an exact title', ['shared-a', 'shared-b', 'homework'], 'Both exact Home titles are preferred equally; Homework is a weaker partial match.', ['shared-a', 'shared-b']),
  query('album-editions', 'album', 'Night Windows', 'Find the base album and related editions', ['edition', 'edition-deluxe', 'edition-remix'], 'Prefer the exact base title; do not impose an order on other editions.', ['edition']),
  query('album-edition-specific', 'album', 'Night Windows (Deluxe)', 'Find the explicitly requested edition', ['edition-deluxe'], 'Parentheses are literal and the edition qualifier matters.', ['edition-deluxe']),
  query('format-case-space', 'formatting', '  dAfT   pUnK  ', 'Ignore input case and repeated spaces', ['discovery', 'homework'], 'Formatting should not change the artist intent.'),
  query('format-apostrophe', 'formatting', "D'Angelo", 'Match a straight apostrophe to a curly one', ['black-messiah'], 'The fixture stores D’Angelo.'),
  query('format-unicode', 'formatting', 'Cafe\u0301 Sessions', 'Match canonically equivalent Unicode', ['cafe'], 'The query is decomposed; the fixture title is composed.'),
  query('format-accent', 'formatting', 'bjork', 'Find an artist without typing the accent', ['debut'], 'Desired accent-insensitive matching; this may be a current quality gap.'),
  query('format-nonlatin', 'formatting', '宇多田ヒカル', 'Find a non-Latin artist name', ['hikari'], 'Preserve the script instead of requiring transliteration.'),
  query('format-punctuation', 'formatting', 'Signals [Live]', 'Match literal square brackets', ['live'], 'Signals Live without brackets is a distractor.'),
  query('label-exact', 'label', 'Prism Records', 'Find albums on an exact label', ['discovery', 'homework'], 'Both label members are equally relevant.'),
  query('label-partial', 'label', 'Lantern', 'Find a family of label names', ['blue-one', 'blue-two', 'blue-three'], 'Label intent excludes the unrelated title and artist collisions.'),
  query('label-case', 'label', '  bLuE   LaNtErN records ', 'Normalize label-query formatting', ['blue-one', 'blue-two'], 'Match the full label despite case and whitespace.'),
  query('label-apostrophe', 'label', "Listener's Choice", 'Normalize punctuation in a label', ['curly-label'], 'The label stores a curly apostrophe.'),
  query('label-many', 'label', 'Harbour', 'Find multiple artists on one label', ['shared-a', 'shared-b'], 'Both label members qualify without a preferred order.'),
  query('label-collision', 'label', 'Blue Lantern Records', 'Find albums from a label with name collisions', ['blue-one', 'blue-two'], 'Artist/title collisions are plausible results but irrelevant to this explicit evaluation intent.'),
  query('miss-artist', 'miss', 'Absent Astronaut Orchestra', 'Search for an absent artist', [], 'No fixture artist, title, credit, or label has this name.'),
  query('miss-album', 'miss', 'Unwritten Lunar Sonata', 'Search for an absent album', [], 'No album has this title.'),
  query('miss-label', 'miss', 'Nonexistent Wax Company', 'Search for an absent label', [], 'No record belongs to this label.'),
  query('miss-combination', 'miss', 'Copper Violet', 'Search for an unsupported word combination', [], 'Words occur on different albums, not a single relevant record.'),
  query('miss-regex-star', 'miss', '.*', 'Search for literal dot-star text', [], 'Must not turn user input into a match-all regular expression.'),
  query('miss-regex-alternation', 'miss', 'Daft Punk|Air', 'Search for a literal vertical bar', [], 'Do not interpret input as a regular-expression OR.'),
];

function corpus() { return { version: VERSION, albums: records.map(album), queries: structuredClone(queries) }; }
function validateCorpus(data) {
  assert.equal(typeof data.version, 'string');
  assert.ok(data.version.length > 0, 'Missing corpus version');
  assert.ok(Array.isArray(data.albums) && data.albums.length > 0, 'Missing fixture albums');
  const ids = new Set();
  const sortKeys = new Set();
  for (const item of data.albums) {
    assert.ok(UUID.test(item.albumId) && !ids.has(item.albumId), 'Invalid or duplicate album UUID');
    ids.add(item.albumId);
    for (const field of ['title', 'artistDisplayName', 'label']) assert.ok(typeof item[field] === 'string' && item[field].trim(), `Missing ${field}`);
    const sortKey = JSON.stringify([item.artistDisplayName, item.title]);
    assert.ok(!sortKeys.has(sortKey), 'Fixture has an unstable artist/title sorting tie');
    sortKeys.add(sortKey);
    assert.equal(item.cover, '', 'Fixtures must not load artwork');
    assert.ok(!('_id' in item), 'Fixture identities must be public UUIDs');
  }
  assert.equal(data.queries.length, 30, 'Expected 30 queries');
  const queryIds = new Set();
  for (const q of data.queries) {
    assert.ok(typeof q.id === 'string' && q.id && !queryIds.has(q.id), 'Invalid or duplicate query ID');
    queryIds.add(q.id);
    assert.ok(CATEGORIES.includes(q.category), 'Unknown category');
    for (const field of ['query', 'intent', 'explanation']) assert.ok(typeof q[field] === 'string' && q[field].trim(), `Missing query ${field}`);
    for (const field of ['relevantIds', 'preferredIds']) {
      assert.ok(Array.isArray(q[field]), `Missing ${field}`);
      assert.equal(new Set(q[field]).size, q[field].length, `Duplicate ${field}`);
      assert.ok(q[field].every(value => ids.has(value)), `Unknown album in ${field}`);
    }
    assert.equal(q.relevantIds.length === 0, q.category === 'miss', 'Only miss queries may have no relevant albums');
    assert.ok(q.preferredIds.every(value => q.relevantIds.includes(value)), 'Preferred albums must be relevant');
  }
  for (const category of CATEGORIES) assert.equal(data.queries.filter(q => q.category === category).length, 6, `Expected six ${category} queries`);
  return data;
}
module.exports = { VERSION, CATEGORIES, UUID, id, corpus, validateCorpus };
