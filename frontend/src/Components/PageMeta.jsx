import { useEffect } from "react";

// React 19 hoists the <title> and canonical <link> into <head> and removes
// them on unmount. The description updates the single default tag from
// index.html instead of adding a second one, and restores it on unmount.
export function PageMeta({ title, description, canonical }) {
  useEffect(() => {
    const tag = document.querySelector('meta[name="description"]');
    if (!tag || !description) return undefined;
    const previous = tag.getAttribute("content") || "";
    tag.setAttribute("content", description);
    return () => tag.setAttribute("content", previous);
  }, [description]);

  return (
    <>
      {title ? <title>{title}</title> : null}
      {canonical ? <link rel="canonical" href={canonical} /> : null}
    </>
  );
}

export default PageMeta;
