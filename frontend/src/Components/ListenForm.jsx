import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "../utils/apiErrors";

function shiftDate(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

export default function ListenForm({ album, boardId, onSubmitted, onBusyChange }) {
    const { getToken } = useAuth();
    const [listenedOn, setListenedOn] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    });
    const [request, setRequest] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [automaticNearby, setAutomaticNearby] = useState({ key: "", date: "" });
    const nearbyKey = `${album.albumId}:${listenedOn}`;

    // Best-effort, non-blocking: point out an automatic entry within a day of this date.
    useEffect(() => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(listenedOn)) return undefined;
        const controller = new AbortController();
        (async () => {
            try {
                const token = await getToken();
                const query = new URLSearchParams({ albumId: album.albumId, from: shiftDate(listenedOn, -1), to: shiftDate(listenedOn, 1), limit: "10" });
                const response = await fetch(`${API_BASE_URL}/diary?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
                if (!response.ok || controller.signal.aborted) return;
                const data = await response.json();
                const match = (data.listens || []).find((listen) => listen.source === "automatic");
                if (!controller.signal.aborted) setAutomaticNearby({ key: `${album.albumId}:${listenedOn}`, date: match?.listenedOn || "" });
            } catch {
                // The notice is optional; logging still works without it.
            }
        })();
        return () => controller.abort();
    }, [album.albumId, getToken, listenedOn]);

    async function submit(event) {
        event.preventDefault();
        if (isSubmitting) return;
        const nextRequest = request || {
            key: crypto.randomUUID(),
            body: { albumId: album.albumId, listenedOn, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(boardId ? { boardIds: [boardId] } : {}) },
        };
        setRequest(nextRequest);
        setIsSubmitting(true);
        onBusyChange?.(true);
        setError("");
        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/diary`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": nextRequest.key },
                body: JSON.stringify(nextRequest.body),
            });
            if (!response.ok) {
                if (response.status >= 400 && response.status < 500) setRequest(null);
                throw new Error(await getApiErrorMessage(response, "Could not log your listen."));
            }
            onSubmitted(await response.json());
        } catch (failure) {
            setError(failure.message || "Could not log your listen. Try again.");
        } finally {
            setIsSubmitting(false);
            onBusyChange?.(false);
        }
    }

    return (
        <form className="review-form-card" onSubmit={submit}>
            <div className="review-form-header"><div><p className="review-form-kicker">Your listening diary</p><h2>Log {album.title}</h2></div></div>
            <label className="review-form-field">
                <span>Listened on</span>
                <input type="date" required value={listenedOn} disabled={isSubmitting || Boolean(request)} onChange={(event) => setListenedOn(event.target.value)} />
            </label>
            <p>{boardId ? "This listen will be added to your diary and this board." : "Each entry records one listen. Use Boards to add it to a board afterward."}</p>
            {automaticNearby.key === nearbyKey && automaticNearby.date ? (
                <p className="listen-form-notice" role="status">This album was already logged automatically on {automaticNearby.date}. Logging it here adds a separate entry.</p>
            ) : null}
            {error && <p className="review-action-message" role="alert">{error}</p>}
            <button className="review-submit-button" type="submit" disabled={isSubmitting}>{isSubmitting ? "Logging…" : "Log listen"}</button>
        </form>
    );
}
