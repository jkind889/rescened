import { formatDraftTime } from "../../features/community/drafts.js";

export function DraftNotice({ savedAt, onDiscard, disabled = false }) {
  if (!savedAt) return null;

  return (
    <div className="suggestion-draft-notice" role="status">
      <p>Restored your unsent draft from {formatDraftTime(savedAt)}.</p>
      <button disabled={disabled} onClick={onDiscard} type="button">Discard draft</button>
    </div>
  );
}

export default DraftNotice;
