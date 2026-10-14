// Shared genre name rules. Seed imports, suggestion validation, and lookups
// all go through these helpers so that one spelling always maps to one key.

const MAX_ALBUM_GENRES = 5;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 40;
// Letters (with combining marks), digits, spaces, and & ' - / + .
const NAME_PATTERN = /^[\p{L}\p{M}\p{N} &'\-/+.]+$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GENRE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class GenreNameError extends Error {
  constructor(message, code = "INVALID_GENRE_NAME") {
    super(message);
    this.name = "GenreNameError";
    this.code = code;
    this.status = 400;
  }
}

// Display form: NFKC, trimmed, with internal whitespace collapsed. Case is kept.
function cleanGenreName(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

// Matching key: the display form, case-folded, with hyphens and underscores
// treated as spaces and apostrophes and periods dropped, so "Hip-Hop",
// "hip hop", and "Hip  hop" collide while "R&B" and "Drum & bass" keep
// their ampersands. Spellings that differ beyond that become aliases.
function genreMatchKey(value) {
  return cleanGenreName(value)
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[\s\-_]+/g, " ")
    .trim();
}

// URL slug: ASCII-folded, & and + spelled out, everything else hyphenated.
function genreSlug(value) {
  return cleanGenreName(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Returns { name, normalizedName, slug } or throws GenreNameError.
function validateGenreName(value) {
  const name = cleanGenreName(value);
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    throw new GenreNameError(`Genre names must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new GenreNameError("Genre names may contain letters, digits, spaces, and & ' - / + . only");
  }
  const normalizedName = genreMatchKey(name);
  const slug = genreSlug(name);
  if (normalizedName.length < NAME_MIN_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw new GenreNameError("Genre names need at least two letters or digits");
  }
  return { name, normalizedName, slug };
}

function isGenreId(value) {
  return GENRE_ID_PATTERN.test(String(value || "").trim());
}

module.exports = {
  GENRE_ID_PATTERN,
  GenreNameError,
  MAX_ALBUM_GENRES,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  NAME_PATTERN,
  SLUG_PATTERN,
  cleanGenreName,
  genreMatchKey,
  genreSlug,
  isGenreId,
  validateGenreName,
};
