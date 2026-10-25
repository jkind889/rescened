import { useEffect, useRef } from "react";

// A disclosure keeps ordinary links/buttons in the normal Tab order.
export default function AlbumMoreActions({ children }) {
    const detailsRef = useRef(null);

    useEffect(() => {
        function closeOutside(event) {
            const details = detailsRef.current;
            if (details?.open && !details.contains(event.target)) details.open = false;
        }
        document.addEventListener("pointerdown", closeOutside);
        return () => document.removeEventListener("pointerdown", closeOutside);
    }, []);

    function closeAndFocus(event) {
        const details = event.currentTarget.closest("details");
        details.open = false;
        details.querySelector("summary").focus();
    }

    function closeOnEscape(event) {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary").focus();
    }

    function closeOnBlur(event) {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
            event.currentTarget.open = false;
        }
    }

    return (
        <details className="album-more-actions" ref={detailsRef} onKeyDown={closeOnEscape} onBlur={closeOnBlur}>
            <summary aria-label="More album actions">More <span aria-hidden="true">···</span></summary>
            <div className="album-more-actions-panel" role="group" aria-label="More album actions">
                {children(closeAndFocus)}
            </div>
        </details>
    );
}
