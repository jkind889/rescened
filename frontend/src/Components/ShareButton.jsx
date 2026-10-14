import { useEffect, useRef, useState } from "react";

// Copies an in-app path as an absolute link. Uses the native share sheet when
// the device offers one (mostly phones) and falls back to the clipboard.
// hint explains who can open the link, shown on hover and read by screen readers.
export function ShareButton({ path, title, label = "Share", className = "share-button", hint = "" }) {
    const [status, setStatus] = useState("");
    const resetTimer = useRef(null);

    useEffect(() => () => clearTimeout(resetTimer.current), []);

    function flash(message) {
        setStatus(message);
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setStatus(""), 2000);
    }

    async function share() {
        const url = new URL(path, window.location.origin).toString();
        const canUseShareSheet = typeof navigator.share === "function"
            && window.matchMedia?.("(pointer: coarse)").matches;
        try {
            if (canUseShareSheet) {
                await navigator.share({ title, url });
                return;
            }
            await navigator.clipboard.writeText(url);
            flash("Link copied");
        } catch (error) {
            // Closing the share sheet is not a failure worth reporting.
            if (error?.name !== "AbortError") flash("Could not copy link");
        }
    }

    return (
        <button className={className} type="button" onClick={share} aria-live="polite" title={hint || undefined} aria-description={hint || undefined}>
            {status || label}
        </button>
    );
}

export default ShareButton;
