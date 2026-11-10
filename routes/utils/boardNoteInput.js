const { fail, fields } = require("./diaryValidation");
const { BOARD_NOTE_LIMIT, normalizeBoardNote, boardNoteLength } = require("../../lib/boardNoteText");

function noteInput(body) {
  fields(body, ["note", "revision"]);
  if (typeof body.note !== "string") throw fail(400, "INVALID_BOARD_NOTE", "Board note must be text");
  const note = normalizeBoardNote(body.note);
  if (boardNoteLength(note) > BOARD_NOTE_LIMIT) throw fail(400, "INVALID_BOARD_NOTE", "Board note must be 100 characters or fewer");
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw fail(400, "INVALID_BOARD_NOTE", "revision must be a non-negative integer");
  return { note, revision: body.revision };
}
module.exports = { noteInput };
