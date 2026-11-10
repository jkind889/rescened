import { useEffect, useRef } from "react";
import { BOARD_NOTE_LIMIT, normalizeBoardNote, boardNoteLength } from "../features/boards/boardNoteText";

export default function BoardItemNote({ album, readOnly, editor, disabled, saving, missing = false, onEdit, onChange, onCancel, onSave }) {
  const inputRef = useRef(null);
  const buttonRef = useRef(null);
  const wasEditing = useRef(false);
  const editing = Boolean(editor);
  const note = album.note || "";
  const normalized = normalizeBoardNote(editor?.draft || "");
  const length = boardNoteLength(normalized);
  const tooLong = length > BOARD_NOTE_LIMIT;
  useEffect(() => {
    if (editing && !saving) inputRef.current?.focus();
    else if (wasEditing.current) buttonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing, saving]);

  if (readOnly && !note) return null;
  return (
    <div className="board-item-note" onDragStart={(event) => event.stopPropagation()}>
      {note && <p className="board-item-note-text">{note}</p>}
      {!readOnly && (editing ? (
        <form className="board-item-note-form" onSubmit={onSave}>
          <label htmlFor={`board-note-${album.albumId}`}>Note for {album.title || "this album"}</label>
          <input
            id={`board-note-${album.albumId}`}
            ref={inputRef}
            value={editor.draft}
            disabled={saving}
            aria-invalid={tooLong || undefined}
            aria-describedby={`board-note-count-${album.albumId}`}
            placeholder="Add a short note"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && !saving) { event.preventDefault(); onCancel(); } }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain").replace(/\s+/gu, " ");
              event.preventDefault();
              const { selectionStart, selectionEnd } = event.currentTarget;
              onChange(editor.draft.slice(0, selectionStart) + text + editor.draft.slice(selectionEnd));
            }}
          />
          <div className="board-item-note-actions">
            <small id={`board-note-count-${album.albumId}`} className={tooLong ? "is-over-limit" : undefined}>{length}/{BOARD_NOTE_LIMIT}</small>
            <button type="button" disabled={saving} onClick={onCancel}>Cancel</button>
            <button type="submit" disabled={disabled || saving || missing || tooLong || normalized === note}>{saving ? "Saving…" : normalized ? "Save note" : "Clear note"}</button>
          </div>
          <small>Visible to anyone who can see this board.</small>
          {missing && <p role="alert">This album is no longer in this board. Your draft is kept here until you cancel.</p>}
          {editor.error && <p role="alert">{editor.error}</p>}
        </form>
      ) : (
        <button ref={buttonRef} type="button" disabled={disabled} aria-label={`${note ? "Edit" : "Add"} note for ${album.title || "this album"}`} onClick={onEdit}>{note ? "Edit note" : "Add note"}</button>
      ))}
    </div>
  );
}
