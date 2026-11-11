import { Fragment } from "react";
import { Link } from "react-router-dom";
import { creditSegments } from "./artists";

// Album credits in stored order. Identified credits that resolve to an artist
// page are links; everything else stays plain text. Renders only text and
// links (no wrapper spans) so it can sit inside the album meta line.
export function ArtistCredits({ album }) {
  const segments = creditSegments(album, album?.artistPages?.artistIds);
  return segments.map((segment, index) => (
    <Fragment key={`${index}-${segment.name}`}>
      {index > 0 ? ", " : null}
      {segment.artistId ? (
        <Link className="artist-credit-link" to={`/artist/${segment.artistId}`}>{segment.name}</Link>
      ) : segment.name}
    </Fragment>
  ));
}

export default ArtistCredits;
