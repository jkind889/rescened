import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Cover from "../../Components/Cover";
import {
  COVER_CYCLE_INTERVAL_MS,
  coverCaption,
  coverCycleLabel,
  coverCycleStep,
  currentCover,
  shouldAutoAdvance,
  usableCovers,
} from "./artists";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

// Keyboard focus pauses the cycle; a mouse click that happens to focus a
// button does not, so the cycle is not left stuck after the pointer leaves.
function isKeyboardFocus(target) {
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

function readHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

// The artist header's picture: release cover art already stored in the
// Rescened catalog, cycling through the artist's main releases. It is release
// art, not a portrait, and is labeled that way. Nothing is fetched from a
// provider, and nothing is invented: with no usable cover the component
// renders nothing, and a cover that fails to load is dropped from the cycle.
//
// Motion and accessibility:
// - With reduced motion requested it never advances by itself and does not
//   fade; previous/next buttons remain.
// - Otherwise it advances every few seconds, and stops while the pointer is
//   over it, keyboard focus is inside it, the tab is hidden, or the person pressed
//   Pause (WCAG 2.2.2 pause mechanism). Previous/next work in every case.
// - The caption is a polite live region only while the cycle is not
//   advancing by itself, so a screen reader is not interrupted every turn.
// - One cover (or none left after failures) shows no controls, is not a
//   carousel, and is not a labeled landmark.
export function ArtistCoverCycle({ covers, artistName }) {
  const [failed, setFailed] = useState([]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [moved, setMoved] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(readReducedMotion);
  const [hidden, setHidden] = useState(readHidden);

  const list = useMemo(() => usableCovers(covers, failed), [covers, failed]);
  const count = list.length;
  const cover = currentCover(list, index);
  const auto = shouldAutoAdvance({ count, paused, reducedMotion, hovered, focused, hidden });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // One timeout per turn: any change of index (including a manual step)
  // re-arms it, so a person who just stepped gets a full interval to look.
  useEffect(() => {
    if (!auto) return undefined;
    const timer = window.setTimeout(() => {
      setMoved(true);
      setIndex((current) => coverCycleStep(current, count, 1));
    }, COVER_CYCLE_INTERVAL_MS);
    // Warm the browser cache for the next cover so the change is not blank.
    const next = currentCover(list, coverCycleStep(index, count, 1));
    if (next) new window.Image().src = next.cover;
    return () => window.clearTimeout(timer);
  }, [auto, index, count, list]);

  if (!cover) return null;

  function step(direction) {
    setMoved(true);
    setIndex((current) => coverCycleStep(current, count, direction));
  }

  const multiple = count > 1;
  const url = cover.cover;
  return (
    <section
      aria-label={multiple ? `Cover art from releases by ${artistName}` : undefined}
      aria-roledescription={multiple ? "carousel" : undefined}
      className="artist-cover-cycle"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      onFocus={(event) => setFocused(isKeyboardFocus(event.target))}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(true); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setHovered(false); }}
    >
      <figure
        aria-label={multiple ? coverCycleLabel(index, count) : undefined}
        aria-roledescription={multiple ? "slide" : undefined}
        className="artist-cover-figure"
        role={multiple ? "group" : undefined}
      >
        <div className={`artist-cover-frame${moved ? " is-moving" : ""}`} key={cover.albumId}>
          <Cover
            alt={`${cover.title} cover`}
            className="artist-cover-image"
            eager
            onError={() => setFailed((current) => (current.includes(url) ? current : [...current, url]))}
            src={url}
          />
        </div>
        <figcaption aria-atomic="true" aria-live={multiple && !auto ? "polite" : "off"} className="artist-cover-caption">
          <Link to={`/album/${cover.albumId}`}>{coverCaption(cover)}</Link>
        </figcaption>
      </figure>
      {multiple ? (
        <div className="artist-cover-controls" role="group" aria-label="Cover controls">
          <button aria-label="Previous cover" className="artist-cover-button" onClick={() => step(-1)} type="button">
            <span aria-hidden="true">&lsaquo;</span>
          </button>
          {reducedMotion ? null : (
            <button aria-label={paused ? "Play cover cycle" : "Pause cover cycle"} className="artist-cover-button" onClick={() => setPaused((value) => !value)} type="button">
              <span aria-hidden="true">{paused ? "▶" : "❚❚"}</span>
            </button>
          )}
          <button aria-label="Next cover" className="artist-cover-button" onClick={() => step(1)} type="button">
            <span aria-hidden="true">&rsaquo;</span>
          </button>
          <span aria-hidden="true" className="artist-cover-position">{coverCycleLabel(index, count)}</span>
        </div>
      ) : null}
    </section>
  );
}

export default ArtistCoverCycle;
