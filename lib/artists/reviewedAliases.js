const { normalizeArtistMbid } = require("./identity");

// Reviewed multilingual search aliases. Entries are keyed by MusicBrainz
// artist MBID, because that identity is the same in every environment, while
// each database assigns its own random Rescened artistId. At read time an
// entry attaches to whichever registry artist holds that MBID, so an alias
// always belongs to exactly one stable artistId and never merges artists that
// merely share a name. An MBID with no registry artist is simply unused.
//
// Keep native-script spellings exactly as written (NFC). Add an entry only
// with a reviewed source; this is not a place for guesses or transliteration
// rules. `locale` is an optional BCP 47 tag describing the spelling.
const REVIEWED_ARTIST_ALIASES = [
  {
    // Kanye West; legally renamed Ye.
    artistMbid: "164f0d73-1234-4e2c-8743-d77bf2191051",
    aliases: [{ name: "Ye", locale: "en" }],
  },
  {
    // BTS
    artistMbid: "0d79fe8e-ba27-4859-bb8c-2f255f346853",
    aliases: [
      { name: "방탄소년단", locale: "ko" },
      { name: "Bangtan Sonyeondan", locale: "ko-Latn" },
      { name: "Bangtan Boys", locale: "en" },
    ],
  },
];

const MAX_ALIAS_LENGTH = 200;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

function validateReviewedAliases(entries) {
  const seen = new Set();
  return entries.map((entry, index) => {
    const artistMbid = normalizeArtistMbid(entry?.artistMbid);
    if (!artistMbid || artistMbid !== entry.artistMbid) throw new Error(`Reviewed alias entry ${index} needs a lowercase MusicBrainz artist MBID`);
    if (seen.has(artistMbid)) throw new Error(`Reviewed alias entry ${index} repeats MBID ${artistMbid}`);
    seen.add(artistMbid);
    if (!Array.isArray(entry.aliases) || !entry.aliases.length) throw new Error(`Reviewed alias entry ${index} has no aliases`);
    const names = new Set();
    const aliases = entry.aliases.map((alias) => {
      const name = typeof alias?.name === "string" ? alias.name : "";
      if (!name.trim() || name !== name.normalize("NFC").trim() || name.length > MAX_ALIAS_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw new Error(`Reviewed alias entry ${index} has an invalid alias name`);
      }
      if (alias.locale !== undefined && !LOCALE_PATTERN.test(alias.locale)) throw new Error(`Reviewed alias ${name} has an invalid locale`);
      if (names.has(name)) throw new Error(`Reviewed alias ${name} is repeated`);
      names.add(name);
      return Object.freeze({ name, ...(alias.locale ? { locale: alias.locale } : {}) });
    });
    return Object.freeze({ artistMbid, aliases: Object.freeze(aliases) });
  });
}

const REVIEWED = Object.freeze(validateReviewedAliases(REVIEWED_ARTIST_ALIASES));
const BY_MBID = new Map(REVIEWED.map((entry) => [entry.artistMbid, entry.aliases]));

function reviewedAliasesFor(artistMbid, entries = REVIEWED) {
  const mbid = normalizeArtistMbid(artistMbid);
  if (!mbid) return [];
  if (entries === REVIEWED) return BY_MBID.get(mbid) || [];
  return entries.find((entry) => entry.artistMbid === mbid)?.aliases || [];
}

module.exports = {
  REVIEWED_ARTIST_ALIASES: REVIEWED,
  reviewedAliasesFor,
  validateReviewedAliases,
};
