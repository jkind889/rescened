import { Link } from "react-router-dom";
import { describeGenreApplication } from "../../features/community/genres.js";
import "./GenreSuggestion.css";
import {
  formatCommunityAction,
  formatCommunityDate,
  formatCommunityStatus,
  formatCommunityValue,
} from "../../features/community/community";

const SOURCE_LABELS = {
  musicbrainz: "MusicBrainz",
  official_artist: "Official artist",
  official_label: "Official label",
  distributor: "Distributor",
  store: "Store",
  spotify: "Spotify evidence",
  other: "Other",
};

function values(value) {
  return Array.isArray(value) ? value : [];
}

function genreNames(genres) {
  return values(genres).map((genre) => genre?.name).filter(Boolean).join(", ");
}

// A genre suggestion's proposed operations, as stored ({ add, remove, primary, note }).
function GenreChangesBlock({ changes, baseGenres, compact = false }) {
  const add = values(changes?.add);
  const remove = values(changes?.remove);
  const primary = changes?.primary;
  const primaryName = primary?.genre?.name
    || (Number.isInteger(primary?.addIndex) ? (add[primary.addIndex]?.genre?.name || add[primary.addIndex]?.newGenre?.name) : "");

  return (
    <div className={`genre-changes${compact ? " genre-changes-compact" : ""}`}>
      <p className="genre-form-muted">When suggested: {genreNames(baseGenres) || "no genres"}</p>
      <ul className="genre-change-list">
        {add.map((entry, index) => (
          <li className="genre-change-add" key={`add-${index}`}>
            {entry.genre ? entry.genre.name : (
              <>
                {entry.newGenre?.name} <span className="genre-badge">New genre</span>
                {entry.newGenre?.parent ? <> under {entry.newGenre.parent.name}</> : null}
              </>
            )}
          </li>
        ))}
        {remove.map((genre) => <li className="genre-change-remove" key={`remove-${genre.genreId}`}>{genre.name}</li>)}
        {primaryName ? <li>Primary genre: {primaryName}</li> : null}
      </ul>
      {changes?.note ? <p className="suggestion-detail-note">Note: {changes.note}</p> : null}
    </div>
  );
}

function supplied(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function durationLabel(value) {
  const milliseconds = Number(value);

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "—";
  }

  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function DetailItem({ label, children }) {
  if (!supplied(children)) {
    return null;
  }

  return (
    <div className="suggestion-detail-item">
      <dt className="suggestion-detail-term">{label}</dt>
      <dd className="suggestion-detail-value">{children}</dd>
    </div>
  );
}

function MetadataBlock({ metadata = {}, compact = false, headingLevel = 4 }) {
  const artistCredits = values(metadata.artistCredits);
  const tracks = values(metadata.tracks);
  const SubheadingTag = `h${Math.min(Math.max(headingLevel, 1), 6)}`;

  return (
    <div className={compact ? "suggestion-metadata suggestion-metadata-compact" : "suggestion-metadata"}>
      <dl className="suggestion-metadata-grid">
        <DetailItem label="Title">{metadata.title}</DetailItem>
        <DetailItem label="Artist">{metadata.artistDisplayName}</DetailItem>
        <DetailItem label="Release type">{formatCommunityValue(metadata.releaseType)}</DetailItem>
        <DetailItem label="Release date">{metadata.releaseDate || metadata.releaseYear}</DetailItem>
        <DetailItem label="Date precision">{formatCommunityValue(metadata.releaseDatePrecision)}</DetailItem>
        <DetailItem label="Label">{metadata.label}</DetailItem>
        <DetailItem label="Country">{metadata.country}</DetailItem>
        <DetailItem label="Catalog number">{metadata.catalogNumber}</DetailItem>
        <DetailItem label="Barcode">{metadata.barcode}</DetailItem>
      </dl>

      {artistCredits.length ? (
        <div className="suggestion-detail-subsection">
          <SubheadingTag className="suggestion-detail-subheading">Artist credits</SubheadingTag>
          <ul className="suggestion-credit-list">
            {artistCredits.map((credit, index) => (
              <li className="suggestion-credit-item" key={`${credit.name || "artist"}-${credit.role || "main"}-${index}`}>
                <span className="suggestion-credit-name">{credit.name || "Unnamed artist"}</span>
                <span className="suggestion-credit-role">{credit.role || "main"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {metadata.coverSourceUrl ? (
        <p className="suggestion-cover-source">
          <span className="suggestion-cover-source-label">Direct cover image URL</span>
          <a
            className="suggestion-external-link"
            href={metadata.coverSourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            Review image ↗
          </a>
          <span className="suggestion-cover-source-note">If approved, this moderator-reviewed URL will be published as the album cover.</span>
        </p>
      ) : (
        <p className="suggestion-cover-source suggestion-cover-source-empty">
          <span className="suggestion-cover-source-label">Cover image</span>
          <span className="suggestion-cover-source-note">No direct image URL supplied. Approval will try Cover Art Archive; unresolved artwork can be backfilled later.</span>
        </p>
      )}

      {tracks.length ? (
        <div className="suggestion-detail-subsection">
          <SubheadingTag className="suggestion-detail-subheading">Tracklist</SubheadingTag>
          <div className="suggestion-track-table-wrap">
            <table className="suggestion-track-table">
              <thead className="suggestion-track-head">
                <tr className="suggestion-track-row">
                  <th className="suggestion-track-cell" scope="col">Disc</th>
                  <th className="suggestion-track-cell" scope="col">No.</th>
                  <th className="suggestion-track-cell suggestion-track-cell-title" scope="col">Title</th>
                  <th className="suggestion-track-cell" scope="col">Artist</th>
                  <th className="suggestion-track-cell" scope="col">Time</th>
                </tr>
              </thead>
              <tbody className="suggestion-track-body">
                {tracks.map((track, index) => (
                  <tr className="suggestion-track-row" key={`${track.discNumber || 1}-${track.trackNumber || index + 1}-${track.title || index}`}>
                    <td className="suggestion-track-cell">{track.discNumber || 1}</td>
                    <td className="suggestion-track-cell">{track.trackNumber || index + 1}</td>
                    <td className="suggestion-track-cell suggestion-track-cell-title">{track.title || "Untitled"}</td>
                    <td className="suggestion-track-cell">{track.artistDisplayName || "—"}</td>
                    <td className="suggestion-track-cell">{durationLabel(track.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EvidenceBlock({ supportingSources, externalReferences, compact = false, headingLevel = 4 }) {
  const sources = values(supportingSources);
  const references = values(externalReferences);
  const SubheadingTag = `h${Math.min(Math.max(headingLevel, 1), 6)}`;

  if (!sources.length && !references.length) {
    return <p className="suggestion-detail-empty">No evidence was supplied.</p>;
  }

  return (
    <div className={compact ? "suggestion-evidence suggestion-evidence-compact" : "suggestion-evidence"}>
      {sources.length ? (
        <div className="suggestion-detail-subsection">
          <SubheadingTag className="suggestion-detail-subheading">Supporting sources</SubheadingTag>
          <ol className="suggestion-source-list">
            {sources.map((source, index) => (
              <li className="suggestion-source-item" key={`${source.type || "source"}-${source.url || index}-${index}`}>
                <div className="suggestion-source-copy">
                  <span className="suggestion-source-type">{SOURCE_LABELS[source.type] || formatCommunityValue(source.type)}</span>
                  {source.description ? <p className="suggestion-source-description">{source.description}</p> : null}
                </div>
                {source.url ? (
                  <a className="suggestion-external-link" href={source.url} target="_blank" rel="noreferrer">
                    Open source ↗
                  </a>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {references.length ? (
        <div className="suggestion-detail-subsection">
          <SubheadingTag className="suggestion-detail-subheading">External references</SubheadingTag>
          <ul className="suggestion-reference-list">
            {references.map((reference, index) => (
              <li className="suggestion-reference-item" key={`${reference.provider || "provider"}-${reference.entityType || "entity"}-${reference.externalId || index}`}>
                <div className="suggestion-reference-copy">
                  <span className="suggestion-reference-provider">{formatCommunityValue(reference.provider)}</span>
                  <span className="suggestion-reference-entity">{formatCommunityValue(reference.entityType)}</span>
                  <code className="suggestion-reference-id">{reference.externalId || "No ID"}</code>
                </div>
                {reference.url ? (
                  <a className="suggestion-external-link" href={reference.url} target="_blank" rel="noreferrer">
                    Open record ↗
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function diffValue(value) {
  if (value === undefined || value === null || value === "") {
    return "Not supplied";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function CorrectionDiffBlock({ submission, headingLevel = 3 }) {
  const changes = values(submission.correctionDiff);
  if (submission.submissionType !== "catalog_correction" || !changes.length) {
    return null;
  }

  const HeadingTag = `h${Math.min(Math.max(headingLevel, 1), 6)}`;

  return (
    <section className="suggestion-detail-section suggestion-correction-diff">
      <div className="suggestion-detail-section-heading">
        <p className="suggestion-detail-kicker">Concurrency-safe review</p>
        <HeadingTag className="suggestion-detail-section-title">Baseline, current, and proposed</HeadingTag>
      </div>
      <p className="suggestion-detail-note">
        Approval is limited to selected groups. If the current catalog value differs from the captured baseline, the
        server rejects the approval so the moderator can re-review the correction.
      </p>
      <div className="suggestion-correction-diff-list">
        {changes.map((change) => (
          <article className={`suggestion-correction-diff-item${change.stale ? " suggestion-correction-diff-stale" : ""}`} key={change.field}>
            <div className="suggestion-correction-diff-heading">
              <h4>{formatCommunityValue(change.field)}</h4>
              <span className={`suggestion-correction-diff-status${change.stale ? " suggestion-correction-diff-status-stale" : ""}`}>
                {change.stale ? "Changed since submission" : "Baseline matches"}
              </span>
            </div>
            <dl className="suggestion-correction-diff-values">
              <div>
                <dt>Baseline</dt>
                <dd><pre>{diffValue(change.baseline)}</pre></dd>
              </div>
              <div>
                <dt>Current catalog</dt>
                <dd><pre>{diffValue(change.current)}</pre></dd>
              </div>
              <div>
                <dt>Proposed</dt>
                <dd><pre>{diffValue(change.proposed)}</pre></dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function DuplicateCandidates({ candidates, headingLevel = 3 }) {
  const catalogAlbums = values(candidates?.catalogAlbums);
  const submissions = values(candidates?.submissions);
  const level = Math.min(Math.max(headingLevel, 1), 6);
  const HeadingTag = `h${level}`;
  const SubheadingTag = `h${Math.min(level + 1, 6)}`;

  if (!catalogAlbums.length && !submissions.length) {
    return null;
  }

  return (
    <section className="suggestion-detail-section suggestion-duplicate-candidates">
      <div className="suggestion-detail-section-heading">
        <p className="suggestion-detail-kicker">Review signal</p>
        <HeadingTag className="suggestion-detail-section-title">Possible duplicate records</HeadingTag>
      </div>
      {catalogAlbums.length ? (
        <div className="suggestion-detail-subsection">
          <SubheadingTag className="suggestion-detail-subheading">Catalog albums</SubheadingTag>
          <ul className="suggestion-candidate-list">
            {catalogAlbums.map((album) => (
              <li className="suggestion-candidate-item" key={album.albumId}>
                <div className="suggestion-candidate-copy">
                  <Link className="suggestion-candidate-title" to={`/album/${album.albumId}`}>
                    {album.title || "Untitled album"}
                  </Link>
                  <span className="suggestion-candidate-meta">
                    {[album.artistDisplayName, album.releaseDate, formatCommunityValue(album.releaseType)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {values(album.matchTypes).length ? (
                  <span className="suggestion-candidate-match">{values(album.matchTypes).map(formatCommunityValue).join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {submissions.length ? (
        <div className="suggestion-detail-subsection">
          <SubheadingTag className="suggestion-detail-subheading">Other submissions</SubheadingTag>
          <ul className="suggestion-candidate-list">
            {submissions.map((candidate) => (
              <li className="suggestion-candidate-item" key={candidate.submissionId}>
                <div className="suggestion-candidate-copy">
                  <Link
                    className="suggestion-candidate-title"
                    to={`/moderation/album-suggestions/${candidate.submissionId}`}
                  >
                    {candidate.proposedMetadata?.title || "Untitled suggestion"}
                  </Link>
                  <span className="suggestion-candidate-meta">
                    {[candidate.proposedMetadata?.artistDisplayName, formatCommunityStatus(candidate.status)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {values(candidate.matchTypes).length ? (
                  <span className="suggestion-candidate-match">{values(candidate.matchTypes).map(formatCommunityValue).join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function RevisionHistory({ revisions, headingLevel = 3 }) {
  const items = values(revisions).slice().reverse();
  const level = Math.min(Math.max(headingLevel, 1), 6);
  const HeadingTag = `h${level}`;
  const nestedHeadingLevel = Math.min(level + 1, 6);

  if (!items.length) {
    return null;
  }

  return (
    <section className="suggestion-detail-section suggestion-revisions">
      <div className="suggestion-detail-section-heading">
        <p className="suggestion-detail-kicker">Archive</p>
        <HeadingTag className="suggestion-detail-section-title">Revision history</HeadingTag>
      </div>
      <div className="suggestion-revision-list">
        {items.map((revision, index) => (
          <details className="suggestion-revision" key={`${revision.revision || index}-${revision.submittedAt || index}`}>
            <summary className="suggestion-revision-summary">
              <span className="suggestion-revision-number">Revision {revision.revision || items.length - index}</span>
              <span className="suggestion-revision-date">{formatCommunityDate(revision.submittedAt)}</span>
            </summary>
            <div className="suggestion-revision-body">
              {revision.submissionType === "genre_suggestion" ? (
                <GenreChangesBlock changes={revision.genreChanges} baseGenres={revision.baseGenres} compact />
              ) : (
                <>
                  <MetadataBlock metadata={revision.proposedMetadata} compact headingLevel={nestedHeadingLevel} />
                  <EvidenceBlock
                    supportingSources={revision.supportingSources}
                    externalReferences={revision.externalReferences}
                    compact
                    headingLevel={nestedHeadingLevel}
                  />
                </>
              )}
              {revision.candidateAlbumId ? (
                <p className="suggestion-revision-candidate">
                  This revision matched <Link to={`/album/${revision.candidateAlbumId}`}>a catalog album</Link>.
                </p>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function ModerationTimeline({ history, showContributor, headingLevel = 3 }) {
  const events = values(history).slice().reverse();
  const HeadingTag = `h${Math.min(Math.max(headingLevel, 1), 6)}`;

  if (!events.length) {
    return null;
  }

  return (
    <section className="suggestion-detail-section suggestion-timeline">
      <div className="suggestion-detail-section-heading">
        <p className="suggestion-detail-kicker">Workflow</p>
        <HeadingTag className="suggestion-detail-section-title">Activity</HeadingTag>
      </div>
      <ol className="suggestion-timeline-list">
        {events.map((event, index) => {
          const contributorEvent = ["submitted", "revised", "withdrawn"].includes(event.action);
          const actor = showContributor && event.actorUserId
            ? event.actorUserId
            : contributorEvent
              ? "Contributor"
              : "Moderator";

          return (
            <li className="suggestion-timeline-item" key={`${event.action || "event"}-${event.createdAt || index}-${index}`}>
              <div className="suggestion-timeline-heading">
                <span className="suggestion-timeline-action">{formatCommunityAction(event.action)}</span>
                <time className="suggestion-timeline-date" dateTime={event.createdAt || undefined}>
                  {formatCommunityDate(event.createdAt)}
                </time>
              </div>
              <p className="suggestion-timeline-actor">{actor}</p>
              {event.reason ? <p className="suggestion-timeline-reason">{event.reason}</p> : null}
              {event.genreApplication ? <p className="suggestion-timeline-reason">{describeGenreApplication(event.genreApplication)}</p> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function SubmissionDetails({
  submission,
  showContributor = false,
  actions = null,
  headingLevel = 2,
  duplicateCandidates = null,
  genreReview = null,
}) {
  if (!submission) {
    return null;
  }
  const isGenreSuggestion = submission.submissionType === "genre_suggestion";

  const level = Number.isInteger(headingLevel) && headingLevel >= 1 && headingLevel <= 6
    ? headingLevel
    : 2;
  const HeadingTag = `h${level}`;
  const sectionHeadingLevel = Math.min(level + 1, 6);
  const nestedHeadingLevel = Math.min(sectionHeadingLevel + 1, 6);
  const SectionHeadingTag = `h${sectionHeadingLevel}`;
  const metadata = submission.proposedMetadata || submission.targetAlbum || {};

  return (
    <article className="suggestion-detail">
      <header className="suggestion-detail-header">
        <div className="suggestion-detail-heading-copy">
          <div className="suggestion-detail-status-row">
            <span className={`suggestion-status suggestion-status-${submission.status || "unknown"}`}>
              {formatCommunityStatus(submission.status)}
            </span>
            <span className="suggestion-detail-revision">Revision {submission.currentRevision || 1}</span>
            {isGenreSuggestion ? <span className="suggestion-detail-revision">Genre suggestion</span> : null}
            {submission.hasPossibleDuplicate ? (
              <span className="suggestion-detail-duplicate-flag">Possible duplicate</span>
            ) : null}
          </div>
          <HeadingTag className="suggestion-detail-title">{metadata.title || "Untitled suggestion"}</HeadingTag>
          <p className="suggestion-detail-artist">{metadata.artistDisplayName || "Artist not supplied"}</p>
          <div className="suggestion-detail-dates">
            <span>Submitted {formatCommunityDate(submission.createdAt)}</span>
            <span>Updated {formatCommunityDate(submission.updatedAt)}</span>
          </div>
          {showContributor && submission.submittedByUserId ? (
            <p className="suggestion-detail-contributor">Contributor: <code>{submission.submittedByUserId}</code></p>
          ) : null}
        </div>
        {actions ? <div className="suggestion-detail-actions">{actions}</div> : null}
      </header>

      {submission.hasPossibleDuplicate ? (
        <div className="suggestion-detail-notice">
          <strong className="suggestion-detail-notice-title">Duplicate check flagged this suggestion.</strong>
          <p className="suggestion-detail-notice-copy">This is advisory and does not prevent moderator review.</p>
        </div>
      ) : null}

      <CorrectionDiffBlock submission={submission} headingLevel={sectionHeadingLevel} />

      {isGenreSuggestion ? (
        <section className="suggestion-detail-section">
          <div className="suggestion-detail-section-heading">
            <p className="suggestion-detail-kicker">Current revision</p>
            <SectionHeadingTag className="suggestion-detail-section-title">Proposed genre changes</SectionHeadingTag>
          </div>
          {genreReview ? (
            <p className="suggestion-detail-note">
              Genres now: {genreNames(genreReview.currentGenres) || "none"}
              {genreReview.stale ? " (changed since this was suggested)" : ""}
            </p>
          ) : null}
          <GenreChangesBlock changes={submission.genreChanges} baseGenres={submission.baseGenres} />
          {submission.targetAlbumId ? (
            <p className="suggestion-detail-note"><Link to={`/album/${submission.targetAlbumId}`}>Open the album</Link></p>
          ) : null}
        </section>
      ) : (
        <>
          <section className="suggestion-detail-section">
            <div className="suggestion-detail-section-heading">
              <p className="suggestion-detail-kicker">Current revision</p>
              <SectionHeadingTag className="suggestion-detail-section-title">Release metadata</SectionHeadingTag>
            </div>
            <MetadataBlock metadata={metadata} headingLevel={nestedHeadingLevel} />
          </section>

          <section className="suggestion-detail-section">
            <div className="suggestion-detail-section-heading">
              <p className="suggestion-detail-kicker">Verification</p>
              <SectionHeadingTag className="suggestion-detail-section-title">Evidence</SectionHeadingTag>
            </div>
            <EvidenceBlock
              supportingSources={submission.supportingSources}
              externalReferences={submission.externalReferences}
              headingLevel={nestedHeadingLevel}
            />
          </section>
        </>
      )}

      {submission.candidateAlbumId || submission.approvedAlbumId || submission.duplicateAlbumId ? (
        <section className="suggestion-detail-section suggestion-linked-records">
          <div className="suggestion-detail-section-heading">
            <p className="suggestion-detail-kicker">Catalog</p>
            <SectionHeadingTag className="suggestion-detail-section-title">Linked records</SectionHeadingTag>
          </div>
          <ul className="suggestion-linked-list">
            {submission.candidateAlbumId ? (
              <li className="suggestion-linked-item">
                Possible match: <Link to={`/album/${submission.candidateAlbumId}`}>open catalog album</Link>
              </li>
            ) : null}
            {submission.approvedAlbumId ? (
              <li className="suggestion-linked-item">
                Approved album: <Link to={`/album/${submission.approvedAlbumId}`}>open catalog album</Link>
              </li>
            ) : null}
            {submission.duplicateAlbumId ? (
              <li className="suggestion-linked-item">
                Duplicate of: <Link to={`/album/${submission.duplicateAlbumId}`}>open catalog album</Link>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <DuplicateCandidates candidates={duplicateCandidates} headingLevel={sectionHeadingLevel} />
      <RevisionHistory revisions={submission.revisions} headingLevel={sectionHeadingLevel} />
      <ModerationTimeline history={submission.moderationHistory} headingLevel={sectionHeadingLevel} showContributor={showContributor} />
    </article>
  );
}

export default SubmissionDetails;
