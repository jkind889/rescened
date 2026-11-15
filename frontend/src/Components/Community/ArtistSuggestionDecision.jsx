import { useId, useState } from "react";
import { Link } from "react-router-dom";

const ACTIONS = [
  { id: "approve", label: "Approve", description: "Create the artist, or link the artist already registered for this exact MusicBrainz ID." },
  { id: "request_changes", label: "Request changes", description: "Send it back to the contributor with a reason." },
  { id: "reject", label: "Reject", description: "Close it without adding an artist." },
  { id: "mark_duplicate", label: "Already on Rescened", description: "Close it as the artist named below. Nothing is created." },
];

// A moderator's decision on one artist suggestion. Every command names the
// revision shown on the page (`suggestion.currentRevision`), read when the
// decision is sent rather than refetched, so a newer revision is refused.
export function ArtistSuggestionDecision({ suggestion, context = null, pending = false, error = null, onCommand }) {
  const id = useId();
  const [action, setAction] = useState("approve");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState(context?.registeredArtist?.artistId || "");
  const [problem, setProblem] = useState("");
  if (suggestion?.status !== "pending") return null;
  const candidates = [
    ...(context?.registeredArtist ? [{ ...context.registeredArtist, why: "Registered for this exact MusicBrainz ID" }] : []),
    ...(context?.sameNameArtists || []).filter((artist) => artist.artistId !== context?.registeredArtist?.artistId)
      .map((artist) => ({ ...artist, why: `Same name, ${artist.releaseCount || 0} release${artist.releaseCount === 1 ? "" : "s"}` })),
  ];

  function submit(event) {
    event.preventDefault();
    setProblem("");
    const reviewedRevision = suggestion.currentRevision;
    if (!Number.isSafeInteger(reviewedRevision) || reviewedRevision < 1) {
      setProblem("Reload this suggestion before deciding.");
      return;
    }
    if (["request_changes", "reject"].includes(action) && !reason.trim()) {
      setProblem("Add a reason for the contributor.");
      return;
    }
    if (action === "mark_duplicate" && !target.trim()) {
      setProblem("Choose the artist this suggestion duplicates.");
      return;
    }
    onCommand?.(action, {
      expectedRevision: reviewedRevision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(action === "mark_duplicate" ? { duplicateOfArtistId: target.trim() } : {}),
    });
  }

  return (
    <form className="community-form moderation-decision" onSubmit={submit} noValidate>
      <fieldset>
        <legend>Decision</legend>
        {ACTIONS.map((option) => (
          <label key={option.id} className="moderation-correction-field">
            <input type="radio" name={`${id}-action`} checked={action === option.id} onChange={() => setAction(option.id)} disabled={pending} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>
        ))}
      </fieldset>
      {context?.registeredArtist && action === "approve" ? (
        <p className="community-message" role="status">
          This MusicBrainz artist is already on Rescened as <strong>{context.registeredArtist.name}</strong>; approval links that artist.
        </p>
      ) : null}
      {action === "mark_duplicate" ? (
        <fieldset>
          <legend>Existing artist</legend>
          {candidates.map((artist) => (
            <label key={artist.artistId} className="moderation-correction-field">
              <input type="radio" name={`${id}-target`} checked={target === artist.artistId} onChange={() => setTarget(artist.artistId)} disabled={pending} />
              <span><strong>{artist.name}</strong><small>{artist.why} · <Link to={`/artist/${artist.artistId}`}>open</Link></small></span>
            </label>
          ))}
          <div className="community-field">
            <label htmlFor={`${id}-artist-id`}>Rescened artist ID</label>
            <input id={`${id}-artist-id`} value={target} onChange={(event) => setTarget(event.target.value)} disabled={pending} placeholder="Artist UUID" />
          </div>
        </fieldset>
      ) : null}
      <div className="community-field">
        <label htmlFor={`${id}-reason`}>Reason {["request_changes", "reject"].includes(action) ? "" : <span>optional</span>}</label>
        <textarea id={`${id}-reason`} rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} />
      </div>
      {problem ? <p className="community-message community-message-error" role="alert">{problem}</p> : null}
      {error ? <p className="community-message community-message-error" role="alert">{error.message}</p> : null}
      <button className="community-primary-button" type="submit" disabled={pending}>{pending ? "Applying…" : "Apply decision"}</button>
    </form>
  );
}

export default ArtistSuggestionDecision;
