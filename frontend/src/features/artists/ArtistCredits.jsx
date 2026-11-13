import { Fragment } from "react";
import { Link } from "react-router-dom";
import { artistDisplaySegments } from "./artists";
import { useArtistLinks } from "./useArtistLinks";
import "./ArtistCredits.css";

// An album's artist line. A credit links to its artist page only when it
// carries an artistId that the API confirmed has one; everything else is plain
// text, including credits without an ID and any list while the check is
// pending or unavailable. `fallback` is shown when the album has no artist.
// Renders only text and links (no wrapper element), so it can sit inside any
// text element. Never place it inside another link: use CardLink for cards.
// `linkProps` are passed to each artist link (for example draggable={false}).
export function ArtistCredits({ album, fallback = "", linkProps }) {
  const isLinked = useArtistLinks(album);
  const segments = artistDisplaySegments(album, isLinked);
  if (!segments.length) return fallback;
  return segments.map((segment, index) => (
    <Fragment key={`${index}-${segment.text}`}>
      {segment.artistId ? (
        <Link {...linkProps} className="artist-credit-link" to={`/artist/${segment.artistId}`}>{segment.text}</Link>
      ) : segment.text}
    </Fragment>
  ));
}

export default ArtistCredits;
