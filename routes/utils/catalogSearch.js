const { preferredArtistsForQuery } = require("./searchArtistAliases");

const SEARCH_FIELDS = [
  "title",
  "artistDisplayName",
  "artistCredits.name",
  "label",
];
const APOSTROPHE_PATTERN = "['’]";
// Canonical Latin accent variants only: no transliteration or punctuation removal.
const LATIN_VARIANTS = new Map();
for (let code = 0x00c0; code <= 0x024f; code += 1) {
  const character = String.fromCodePoint(code).toLowerCase();
  const base = character.normalize("NFD").replace(/\p{M}/gu, "");
  if (/^[a-z]$/.test(base) && character !== base) {
    if (!LATIN_VARIANTS.has(base)) LATIN_VARIANTS.set(base, new Set([base]));
    LATIN_VARIANTS.get(base).add(character);
  }
}

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
    const base = character.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    const variants = LATIN_VARIANTS.get(base);
    // Also accept decomposed Latin accents in existing catalog records.
    if (variants) return `[${[...variants].join("")}][\u0300-\u036f]*`;
    return escapeRegex(character);
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

function buildRankedCatalogSearchPipeline(value, { skip = 0, limit = 24 } = {}) {
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
  const match = preferredPattern
    ? { $or: [textMatch, matchFields(SEARCH_FIELDS.slice(1, 3), preferredPattern)] }
    : textMatch;
  const exact = `^${pattern}$`;
  return [
    { $match: match },
    { $set: { searchRank: { $switch: { branches: [
      ...(preferredPattern ? [{ case: artistExpression(preferredPattern), then: -1 }] : []),
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
