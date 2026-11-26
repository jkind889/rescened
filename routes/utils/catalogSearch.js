const { preferredArtistsForQuery } = require("./searchArtistAliases");

const SEARCH_FIELDS = [
  "title",
  "artistDisplayName",
  "artistCredits.name",
  "label",
];
const APOSTROPHE_PATTERN = "['’]";
function latinBase(character) {
  return character.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function compressCharacterClass(codes) {
  const sorted = [...codes].sort((a, b) => a - b);
  let characters = "";
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (sorted[end + 1] === sorted[end] + 1) end += 1;
    if (end - start >= 2) {
      characters += `${String.fromCodePoint(sorted[start])}-${String.fromCodePoint(sorted[end])}`;
    } else {
      characters += String.fromCodePoint(...sorted.slice(start, end + 1));
    }
    start = end + 1;
  }
  return characters;
}

// Keep canonical Latin variants compact so long queries fit MongoDB's regex budget.
const latinVariants = new Map();
for (const [first, last] of [[0x00c0, 0x024f], [0x1e00, 0x1eff]]) {
  for (let code = first; code <= last; code += 1) {
    const base = latinBase(String.fromCodePoint(code));
    if (!/^[a-z]$/.test(base)) continue;
    if (!latinVariants.has(base)) latinVariants.set(base, new Set([base.codePointAt(0)]));
    latinVariants.get(base).add(code);
  }
}
const LATIN_PATTERNS = new Map([...latinVariants].map(([base, codes]) => [
  base, `[${compressCharacterClass(codes)}][\u0300-\u036f]*`,
]));

function normalizeQuery(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchPattern(value) {
  const normalized = normalizeQuery(value);

  return [...normalized]
    .map((character) => (character === "'" || character === "’" ? APOSTROPHE_PATTERN : escapeRegex(character)))
    .join("");
}

function buildRankedSearchPattern(value) {
  return [...normalizeQuery(value)].map((character) => {
    if (character === "'" || character === "’") return APOSTROPHE_PATTERN;
    return LATIN_PATTERNS.get(latinBase(character)) ?? escapeRegex(character);
  }).join("");
}

function matchFields(fields, pattern) {
  return { $or: fields.map((field) => ({ [field]: { $regex: pattern, $options: "i" } })) };
}

function regexExpression(input, regex) {
  return { $regexMatch: { input: { $ifNull: [input, ""] }, regex, options: "i" } };
}

function artistExpression(pattern) {
  return { $or: [
    regexExpression("$artistDisplayName", pattern),
    { $anyElementTrue: [{ $map: {
      input: { $ifNull: ["$artistCredits", []] }, as: "credit",
      in: regexExpression("$$credit.name", pattern),
    } }] },
  ] };
}

// True when any credit carries one of the given registry artistIds.
function creditIdentityExpression(artistIds) {
  return { $anyElementTrue: [{ $map: {
    input: { $ifNull: ["$artistCredits", []] }, as: "credit",
    in: { $in: [{ $ifNull: ["$$credit.artistId", ""] }, artistIds] },
  } }] };
}

// artistIds: registry artists whose name or reviewed alias equals the whole
// query (see lib/artists/read). Their linked releases match and rank with
// exact artist matches even when credited under another spelling or script.
function buildRankedCatalogSearchPipeline(value, { skip = 0, limit = 24, genreIds = null, artistIds = [] } = {}) {
  const query = normalizeQuery(value);
  const pattern = buildRankedSearchPattern(query);
  const tokens = [...new Set(query.split(" "))];
  const phrase = matchFields(SEARCH_FIELDS, pattern);
  // Keep label discovery phrase-based. Mixed input must match title/artist
  // tokens on the same record, never words scattered across separate albums.
  const textMatch = tokens.length > 1 && tokens.length <= 12
    ? { $or: [phrase, { $and: tokens.map((token) => matchFields(
      SEARCH_FIELDS.slice(0, 3), buildRankedSearchPattern(token),
    )) }] }
    : phrase;
  const preferredArtists = preferredArtistsForQuery(query);
  const preferredPattern = preferredArtists.length
    ? `^(?:${preferredArtists.map(buildRankedSearchPattern).join("|")})$`
    : null;
  const identityIds = Array.isArray(artistIds) ? artistIds.filter((id) => typeof id === "string" && id) : [];
  const alternatives = [
    ...(preferredPattern ? [matchFields(SEARCH_FIELDS.slice(1, 3), preferredPattern)] : []),
    ...(identityIds.length ? [{ "artistCredits.artistId": { $in: identityIds } }] : []),
  ];
  const match = alternatives.length ? { $or: [textMatch, ...alternatives] } : textMatch;
  const exact = `^${pattern}$`;
  return [
    { $match: genreIds ? { $and: [match, { genres: { $in: genreIds } }] } : match },
    { $set: { searchRank: { $switch: { branches: [
      ...(preferredPattern ? [{ case: artistExpression(preferredPattern), then: -1 }] : []),
      ...(identityIds.length ? [{ case: creditIdentityExpression(identityIds), then: 0 }] : []),
      { case: artistExpression(exact), then: 0 },
      { case: regexExpression("$title", exact), then: 1 },
      { case: regexExpression("$label", exact), then: 2 },
      { case: { $or: [artistExpression(pattern), regexExpression("$title", pattern)] }, then: 3 },
    ], default: 4 } } } },
    { $sort: { searchRank: 1, artistDisplayName: 1, title: 1, albumId: 1 } },
    { $skip: skip },
    { $limit: limit },
    { $unset: "searchRank" },
  ];
}

function buildCatalogSearchQuery(value) {
  const pattern = buildSearchPattern(value);
  if (!pattern) return {};

  return {
    $or: SEARCH_FIELDS.map((field) => ({
      [field]: { $regex: pattern, $options: "i" },
    })),
  };
}

module.exports = {
  buildCatalogSearchQuery,
  buildRankedCatalogSearchPipeline,
  buildRankedSearchPattern,
  buildSearchPattern,
  escapeRegex,
};
