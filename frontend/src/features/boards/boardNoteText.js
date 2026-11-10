// Matches lib/boardNoteText.js. Count user-perceived characters, not UTF-16 units.
export const BOARD_NOTE_LIMIT = 100;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
export function normalizeBoardNote(value) { return value.normalize("NFC").replace(/\s+/gu, " ").trim(); }
export function boardNoteLength(value) { return [...segmenter.segment(value)].length; }
