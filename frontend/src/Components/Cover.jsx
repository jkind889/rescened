import { useState } from "react";

// Catalog covers point at Cover Art Archive's 500px release thumbnail. CAA also
// serves a 250px thumbnail for the same image, which is plenty for small fixed
// thumbnails. Other URLs are used exactly as stored.
const CAA_FRONT_500 = /^(https:\/\/coverartarchive\.org\/release\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/front-500$/i;
const SMALL_THUMBNAIL_MAX = 125;

function coverSources(src, size) {
  const match = size && size <= SMALL_THUMBNAIL_MAX ? CAA_FRONT_500.exec(String(src || "")) : null;
  if (!match) return { src };
  const small = `${match[1]}/front-250`;
  return { src: small, srcSet: `${small} 250w, ${src} 500w`, sizes: `${size}px` };
}

// A lazily decoded album cover. width/height only reserve a square box while the
// image loads; the .cover-image rule keeps each caller's CSS in charge of size.
// Pass size (CSS px) only for fixed-size thumbnails, which lets small CAA covers
// use the 250px thumbnail.
export function Cover({ src, alt = "", className = "", size, eager = false, onError, ...rest }) {
  const [failedSmall, setFailedSmall] = useState("");
  const sources = failedSmall === src ? { src } : coverSources(src, size);
  const dimension = size || 500;

  return (
    <img
      {...rest}
      className={className ? `cover-image ${className}` : "cover-image"}
      src={sources.src}
      srcSet={sources.srcSet}
      sizes={sources.sizes}
      alt={alt}
      width={dimension}
      height={dimension}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={(event) => {
        // Fall back to the stored URL if the derived thumbnail is missing.
        if (sources.srcSet) setFailedSmall(src);
        else onError?.(event);
      }}
    />
  );
}

export default Cover;
