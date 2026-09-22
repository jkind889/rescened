// Reviewed search preferences, not catalog identities. Match a complete query
// and expand only to exact artist names; never rewrite titles or public IDs.
const ARTIST_SEARCH_ALIASES = [
  { queries: ["ye", "kanye west"], artists: ["Kanye West", "Ye"] },
  { queries: ["travis"], artists: ["Travis Scott"] },
  {
    queries: ["pierre", "pierre bourne", "pi'erre", "pi'erre bourne"],
    artists: ["Pi'erre Bourne", "Pierre Bourne"],
  },
];

function preferredArtistsForQuery(query) {
  const key = String(query ?? "").normalize("NFC").trim()
    .replace(/\s+/gu, " ").replace(/’/gu, "'").toLowerCase();
  return ARTIST_SEARCH_ALIASES.find((entry) => entry.queries.includes(key))?.artists || [];
}

module.exports = { preferredArtistsForQuery };
