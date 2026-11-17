import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { ArtistPicker } from "../../features/artists/ArtistPicker.jsx";
import { proposalFromSelection, selectionFromProposal } from "../../features/artists/artistSuggestionPayload.js";
import { useArtistLinkingState } from "../../features/artists/useArtistLinking";

// Suggest one artist: a MusicBrainz artist or a new community artist with
// private supporting links. Choosing an artist already on Rescened is not a
// suggestion; the form points to that artist instead. Nothing is submitted
// unless the server confirms artist suggestions are on.
export function ArtistSuggestionForm({ initialProposal = null, initialNote = "", onSubmit, isSubmitting = false, error = null, submitLabel = "Send for review", getToken }) {
  const id = useId();
  const linkingState = useArtistLinkingState(getToken);
  const [selection, setSelection] = useState(() => selectionFromProposal(initialProposal));
  const [note, setNote] = useState(initialNote || "");
  const [problem, setProblem] = useState("");
  const existing = selection?.kind === "existing" ? selection : null;

  function submit(event) {
    event.preventDefault();
    setProblem("");
    if (linkingState !== "enabled") {
      setProblem(linkingState === "loading"
        ? "Still checking whether artist suggestions are available. Try again in a moment."
        : linkingState === "unavailable"
          ? "Could not check whether artist suggestions are available. Reload the page to try again."
          : "Artist suggestions are turned off right now.");
      return;
    }
    if (existing) {
      setProblem("This artist is already on Rescened, so there is nothing to suggest.");
      return;
    }
    const artistProposal = proposalFromSelection(selection);
    if (!artistProposal) {
      setProblem("Choose a MusicBrainz artist, or propose a new artist with supporting links.");
      return;
    }
    onSubmit?.({ artistProposal, note: note.trim() });
  }

  const alreadyOnRescened = error?.code === "ARTIST_ALREADY_EXISTS" ? error.existingArtist || null : null;
  return (
    <form className="community-form artist-suggestion-form" onSubmit={submit} noValidate>
      {linkingState === "disabled" ? (
        <p className="community-message community-message-error" role="status">Artist suggestions are turned off right now.</p>
      ) : null}
      {linkingState === "enabled" ? (
        <ArtistPicker label="Artist" creditName="" value={selection} onChange={setSelection} disabled={isSubmitting} />
      ) : linkingState === "loading" ? (
        <p className="community-message" role="status">Checking whether artist suggestions are available…</p>
      ) : linkingState === "unavailable" ? (
        <p className="community-message community-message-error" role="status">Could not check whether artist suggestions are available. Reload the page to try again.</p>
      ) : null}
      {existing ? (
        <p className="community-message" role="status">
          <strong>{existing.name}</strong> is already on Rescened. <Link to={`/artist/${existing.artistId}`}>Open the artist</Link> instead of suggesting it.
        </p>
      ) : null}
      <div className="community-field">
        <label htmlFor={`${id}-note`}>Note for moderators <span>optional</span></label>
        <textarea id={`${id}-note`} maxLength={500} rows={3} value={note} onChange={(event) => setNote(event.target.value)} disabled={isSubmitting} />
        <small>Private to you and moderators.</small>
      </div>
      {problem ? <p className="community-message community-message-error" role="alert">{problem}</p> : null}
      {error && !alreadyOnRescened ? <p className="community-message community-message-error" role="alert">{error.message}</p> : null}
      {alreadyOnRescened ? (
        <p className="community-message community-message-error" role="alert">
          This MusicBrainz artist is already on Rescened{alreadyOnRescened.name ? ` as ${alreadyOnRescened.name}` : ""}. <Link to={`/artist/${alreadyOnRescened.artistId}`}>Open the artist</Link>.
        </p>
      ) : null}
      <button className="community-primary-button" type="submit" disabled={isSubmitting || existing !== null}>
        {isSubmitting ? "Sending…" : submitLabel}
      </button>
    </form>
  );
}

export default ArtistSuggestionForm;
