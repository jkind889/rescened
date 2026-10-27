import { useState } from "react";
import { Link } from "react-router-dom";

function ExternalAlbumCover({ candidate }) {
  const [imageFailed, setImageFailed] = useState(false);
  const title = candidate.title || "Untitled release";

  if (!candidate.cover || imageFailed) {
    return (
      <div className="external-album-cover external-album-cover-fallback" aria-label="No cover available">
        No cover
      </div>
    );
  }

  return (
    <img
      className="external-album-cover"
      src={candidate.cover}
      alt={`${title} cover`}
      loading="lazy"
      decoding="async"
      onError={() => setImageFailed(true)}
    />
  );
}

export function ExternalAlbumCard({ candidate }) {
  const title = candidate.title || "Untitled release";
  const artist = candidate.artistDisplayName || "Artist unknown";
  const releaseType = candidate.releaseType || "Release";
  const releaseYear = candidate.releaseYear || "Year unknown";
  const suggestionUrl = candidate.externalId
    ? `/suggestions/new?mbid=${encodeURIComponent(candidate.externalId)}`
    : "/suggestions/new";

  return (
    <article className="external-album-card">
      <ExternalAlbumCover candidate={candidate} />
      <div className="external-album-copy">
        <div className="external-album-label-row">
          <span className="external-album-label">Not in Rescened</span>
          <span className="external-album-type">{releaseType}</span>
        </div>
        <h4 className="external-album-title">{title}</h4>
        <p className="external-album-artist">{artist}</p>
        <p className="external-album-year">{releaseYear}</p>
        <div className="external-album-actions">
          <Link className="external-album-suggest" to={suggestionUrl}>
            Suggest this album
          </Link>
          {candidate.sourceUrl ? (
            <a
              className="external-album-source"
              href={candidate.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              MusicBrainz
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export default ExternalAlbumCard;
