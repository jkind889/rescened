import { useEffect } from "react";

// Preserve the defaults from index.html instead of adding a second title or
// description. React hoists the canonical link and removes it on unmount.
export function PageMeta({ title, description, canonical }) {
  useEffect(() => {
    if (!title) return undefined;
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);

  useEffect(() => {
    const tag = document.querySelector('meta[name="description"]');
    if (!tag || !description) return undefined;
    const previous = tag.getAttribute("content") || "";
    tag.setAttribute("content", description);
    return () => tag.setAttribute("content", previous);
  }, [description]);

  return canonical ? <link rel="canonical" href={canonical} /> : null;
}

export default PageMeta;
