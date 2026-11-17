import { Link } from "react-router-dom";
import { artistSuggestionActionLabel, artistSuggestionStatusLabel, proposalName } from "../../features/artists/artistSuggestionPayload.js";
import { formatCommunityDate } from "../../features/community/community";

function ProposalBlock({ proposal }) {
  if (proposal?.kind === "musicbrainz") {
    const observation = proposal.observation || {};
    return (
      <dl className="suggestion-metadata-grid">
        <div><dt>Proposed artist</dt><dd>{observation.name || proposal.artistMbid}</dd></div>
        <div><dt>Source</dt><dd>MusicBrainz artist, added when approved</dd></div>
        {observation.disambiguation ? <div><dt>MusicBrainz says</dt><dd>{[observation.disambiguation, observation.type].filter(Boolean).join(" · ")}</dd></div> : null}
        {observation.observedAt ? <div><dt>Checked</dt><dd>{formatCommunityDate(observation.observedAt)}</dd></div> : null}
        <div>
          <dt>MusicBrainz</dt>
          <dd><a className="suggestion-external-link" href={`https://musicbrainz.org/artist/${proposal.artistMbid}`} target="_blank" rel="noopener noreferrer">View on MusicBrainz</a></dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="suggestion-metadata-grid">
      <div><dt>Proposed artist</dt><dd>{proposal?.canonicalName}</dd></div>
      <div><dt>Source</dt><dd>New community artist, reviewed by a moderator</dd></div>
      {Array.isArray(proposal?.evidence) && proposal.evidence.length ? (
        <div>
          <dt>Private evidence</dt>
          <dd>
            {proposal.evidence.map((entry, index) => (
              <span key={entry.url}>{index ? ", " : ""}<a className="suggestion-external-link" href={entry.url} target="_blank" rel="noopener noreferrer">link {index + 1}</a></span>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

// One artist suggestion as its owner or a moderator sees it. Evidence and
// notes appear only in this detail view.
export function ArtistSuggestionDetail({ suggestion, showContributor = false, actions = null }) {
  if (!suggestion) return null;
  return (
    <article className="suggestion-detail artist-suggestion-detail">
      <header className="suggestion-detail-header">
        <div className="suggestion-detail-heading-copy">
          <div className="suggestion-detail-status-row">
            <span className={`suggestion-status suggestion-status-${suggestion.status}`}>{artistSuggestionStatusLabel(suggestion.status)}</span>
            <span className="suggestion-detail-revision">Revision {suggestion.currentRevision}</span>
          </div>
          <h2 className="suggestion-detail-title">{proposalName(suggestion.proposal) || "Artist suggestion"}</h2>
          {showContributor ? <p className="suggestion-detail-contributor">Contributor: <code>{suggestion.submittedByUserId}</code></p> : null}
        </div>
        {actions ? <div className="suggestion-detail-actions">{actions}</div> : null}
      </header>
      <section className="suggestion-detail-section">
        <ProposalBlock proposal={suggestion.proposal} />
        {suggestion.note ? <p className="suggestion-detail-note">Note: {suggestion.note}</p> : null}
        {suggestion.approvedArtistId ? (
          <p className="suggestion-detail-note">
            {suggestion.approvalOutcome === "reused" ? "Linked to the artist already on Rescened: " : "Added to Rescened: "}
            <Link to={`/artist/${suggestion.approvedArtistId}`}>open the artist</Link>
          </p>
        ) : null}
        {suggestion.duplicateOfArtistId ? (
          <p className="suggestion-detail-note">Already on Rescened: <Link to={`/artist/${suggestion.duplicateOfArtistId}`}>open the artist</Link></p>
        ) : null}
      </section>
      {Array.isArray(suggestion.moderationHistory) && suggestion.moderationHistory.length ? (
        <section className="suggestion-detail-section">
          <h3 className="suggestion-detail-section-title">History</h3>
          <ol className="suggestion-timeline">
            {suggestion.moderationHistory.map((event, index) => (
              <li key={`${event.action}-${index}`}>
                <strong>{artistSuggestionActionLabel(event.action)}</strong> · revision {event.revision} · {formatCommunityDate(event.createdAt)}
                {event.reason ? <p>{event.reason}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}

export default ArtistSuggestionDetail;
