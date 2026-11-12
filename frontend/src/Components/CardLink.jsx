import { Link } from "react-router-dom";
import "./CardLink.css";

// A card that opens one album from anywhere on its surface, without wrapping
// its artist links in another link. Put <CardTitleLink> around the album
// title inside it; everything else, including <ArtistCredits>, is free to hold
// its own links.
export function CardLink({ as = "div", className = "", children, ...rest }) {
  const Tag = as;
  return (
    <Tag {...rest} className={`card-link ${className}`.trim()}>
      {children}
    </Tag>
  );
}

export function CardTitleLink({ to, className = "", children, ...rest }) {
  return (
    <Link {...rest} to={to} className={`card-link-title ${className}`.trim()}>
      {children}
    </Link>
  );
}

export default CardLink;
