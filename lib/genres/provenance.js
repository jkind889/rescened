// The $set for an album's genre provenance. Dotted paths keep other fields'
// provenance; a legacy album whose fieldProvenance isn't an object (such as
// null, where MongoDB refuses a dotted path) gets a fresh one.
function genreProvenanceSet(album, value) {
  const current = album.fieldProvenance;
  if (current && typeof current === "object" && !Array.isArray(current)) return { "fieldProvenance.genres": value };
  return { fieldProvenance: { genres: value } };
}

module.exports = { genreProvenanceSet };
