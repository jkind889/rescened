import { useEffect, useState } from "react";
import { API_BASE_URL } from "../../config/api";
import { biographyChangeNotice } from "./artists";

// Attribution required when reusing Wikipedia text: the article and exact
// revision, the change notice, and the license. Shared by the public About
// section and the moderator panel's excerpts.
export function BiographyAttribution({ article, license, shortened, edited, className = "artist-biography-attribution" }) {
  if (!article) return null;
  return (
    <p className={className}>
      From Wikipedia:{" "}
      <a href={article.url} rel="noopener noreferrer" target="_blank">{article.title}</a>
      {" "}(<a href={article.revisionUrl} rel="noopener noreferrer" target="_blank">revision {article.revisionId}</a>)
      {" · "}{biographyChangeNotice({ shortened, edited })}
      {license?.url ? <>{" · "}Text available under <a href={license.url} rel="license noopener noreferrer" target="_blank">{license.name || "CC BY-SA 4.0"}</a></> : null}
    </p>
  );
}

// The cached artist biography, read from Rescened only. Missing, hidden,
// disabled, or failed biographies render nothing, so the rest of the page
// is unaffected. Attribution follows Wikipedia's reuse terms: a link to the
// article and the exact revision, a change notice, and the license.
export function ArtistBiography({ artistId }) {
  const [state, setState] = useState({ key: "", biography: null });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/artists/${encodeURIComponent(artistId)}/biography`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { biography: null }))
      .then((data) => setState({ key: artistId, biography: data?.biography || null }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ key: artistId, biography: null });
      });
    return () => controller.abort();
  }, [artistId]);

  const biography = state.key === artistId ? state.biography : null;
  if (!biography?.text) return null;
  return (
    <section className="artist-biography" aria-labelledby="artist-biography-heading">
      <h2 id="artist-biography-heading" className="artist-biography-heading">About</h2>
      <p className="artist-biography-text" lang={biography.language || "en"}>{biography.text}</p>
      <BiographyAttribution article={biography.article} license={biography.license} shortened={biography.shortened} edited={biography.edited} />
    </section>
  );
}

export default ArtistBiography;
