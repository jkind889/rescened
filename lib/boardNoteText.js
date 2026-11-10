// Keep normalization and grapheme counting aligned with the frontend helper.
const BOARD_NOTE_LIMIT = 100;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function normalizeBoardNote(value) { return value.normalize("NFC").replace(/\s+/gu, " ").trim(); }
function boardNoteLength(value) { return [...segmenter.segment(value)].length; }
module.exports = { BOARD_NOTE_LIMIT, normalizeBoardNote, boardNoteLength };
