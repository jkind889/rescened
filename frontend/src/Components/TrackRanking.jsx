import { useCallback, useEffect, useMemo, useState } from "react";
import { SignInButton, useAuth } from "@clerk/react";
import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "../utils/apiErrors";

const EMPTY_STANDINGS = { rankingCount: 0, tracks: [], viewerRanking: null };

function sameOrder(first, second) {
    return first.length === second.length && first.every((trackId, index) => trackId === second[index]);
}

function moveItem(list, from, to) {
    if (from === to || to < 0 || to >= list.length) return list;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

// Community standings and the viewer's own drag-to-rank editor for an album's
// mapped tracklist. Rendered only when the album has tracks.
export function TrackRanking({ albumId, tracks, getTrackLabel, formatDuration }) {
    const { getToken, isSignedIn, userId } = useAuth();
    const canRank = Boolean(isSignedIn && userId);
    const [view, setView] = useState("community");
    const [standings, setStandings] = useState(EMPTY_STANDINGS);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [draft, setDraft] = useState([]);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState("");
    const [dragIndex, setDragIndex] = useState(null);

    const tracksById = useMemo(() => new Map(tracks.map((track) => [track.trackId, track])), [tracks]);
    const savedRanking = useMemo(() => standings.viewerRanking?.rankedTrackIds || [], [standings.viewerRanking]);
    const unranked = tracks.map((track) => track.trackId).filter((trackId) => !draft.includes(trackId));
    const isDirty = !sameOrder(draft, savedRanking);

    const applyStandings = useCallback((data) => {
        const next = {
            rankingCount: Number(data.rankingCount) || 0,
            tracks: Array.isArray(data.tracks) ? data.tracks : [],
            viewerRanking: data.viewerRanking || null,
        };
        setStandings(next);
        setDraft(next.viewerRanking?.rankedTrackIds || []);
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        async function fetchStandings() {
            setIsLoading(true);
            setLoadError("");
            try {
                const token = userId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const response = await fetch(`${API_BASE_URL}/track-rankings/album/${albumId}`, { headers, signal: controller.signal });
                if (!response.ok) throw new Error(await getApiErrorMessage(response, "Track rankings are unavailable right now."));
                applyStandings(await response.json());
            } catch (error) {
                if (controller.signal.aborted) return;
                setStandings(EMPTY_STANDINGS);
                setLoadError(error.message || "Track rankings are unavailable right now.");
            } finally {
                if (!controller.signal.aborted) setIsLoading(false);
            }
        }
        if (albumId) void fetchStandings();
        return () => controller.abort();
    }, [albumId, applyStandings, getToken, userId]);

    async function submit(method) {
        setIsSaving(true);
        setMessage("");
        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/track-rankings/album/${albumId}`, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
                },
                body: method === "PUT" ? JSON.stringify({ rankedTrackIds: draft }) : undefined,
            });
            if (!response.ok) {
                throw new Error(await getApiErrorMessage(response, method === "PUT" ? "Could not save your ranking." : "Could not remove your ranking."));
            }
            applyStandings(await response.json());
            setMessage(method === "PUT" ? "Ranking saved." : "Ranking removed.");
        } catch (error) {
            console.error(error);
            setMessage(error.message);
        } finally {
            setIsSaving(false);
        }
    }

    function updateDraft(next) {
        setDraft(next);
        setMessage("");
    }

    function handleDrop(event, targetIndex) {
        event.preventDefault();
        if (dragIndex !== null) updateDraft(moveItem(draft, dragIndex, targetIndex));
        setDragIndex(null);
    }

    const renderTrackName = (trackId) => {
        const track = tracksById.get(trackId);
        return (
            <>
                <span className="track-ranking-title">{track?.title || "Untitled Track"}</span>
                <span className="track-ranking-meta">
                    {track ? getTrackLabel(track) : ""}
                    {track?.durationMs ? ` · ${formatDuration(track.durationMs)}` : ""}
                </span>
            </>
        );
    };

    const renderCommunity = () => {
        if (standings.rankingCount === 0) {
            return (
                <p className="album-empty-copy">
                    No one has ranked this album yet.{" "}
                    {canRank && (
                        <button className="track-ranking-inline-link" type="button" onClick={() => setView("mine")}>
                            Be the first.
                        </button>
                    )}
                </p>
            );
        }

        const rankedCount = standings.rankingCount;
        const rows = standings.tracks
            .filter((entry) => tracksById.has(entry.trackId))
            .map((entry) => ({ ...entry, points: Math.round((Number(entry.score) || 0) * 100) }));
        return (
            <>
                <p className="track-ranking-summary">
                    Based on {rankedCount} ranking{rankedCount === 1 ? "" : "s"}. Higher means listeners tend to put the track nearer the top.
                </p>
                <ol className="track-ranking-list">
                    {rows.map((entry) => {
                        const { points } = entry;
                        // Tracks with the same displayed score share a position.
                        const position = rows.findIndex((row) => row.points === points) + 1;
                        return (
                            <li key={entry.trackId} className="track-ranking-row">
                                <span className="track-ranking-position">{position}</span>
                                <span className="track-ranking-name">{renderTrackName(entry.trackId)}</span>
                                <span className="track-ranking-score" aria-label={`Score ${points} of 100`}>
                                    <span className="track-ranking-bar" aria-hidden="true">
                                        <span style={{ width: `${points}%` }} />
                                    </span>
                                    <strong>{points}</strong>
                                </span>
                            </li>
                        );
                    })}
                </ol>
            </>
        );
    };

    const renderEditor = () => {
        if (!canRank) {
            return (
                <div className="track-ranking-signin">
                    <p className="album-empty-copy">Sign in to rank the tracks on this album.</p>
                    <SignInButton mode="modal">
                        <button className="album-action-button" type="button">Sign in</button>
                    </SignInButton>
                </div>
            );
        }

        return (
            <>
                <p className="track-ranking-summary">
                    Drag tracks into order, or use the arrows. You can rank every track or just your favorites.
                </p>

                <h3 className="track-ranking-heading">Your ranking</h3>
                {draft.length === 0 ? (
                    <div className="track-ranking-empty">
                        <p className="album-empty-copy">Add tracks below to start your ranking.</p>
                        <button className="album-action-button" type="button" onClick={() => updateDraft(tracks.map((track) => track.trackId))}>
                            Start from tracklist order
                        </button>
                    </div>
                ) : (
                    <ol className="track-ranking-list track-ranking-editable">
                        {draft.map((trackId, index) => (
                            <li
                                key={trackId}
                                className={dragIndex === index ? "track-ranking-row track-ranking-dragging" : "track-ranking-row"}
                                draggable
                                onDragStart={(event) => { setDragIndex(index); event.dataTransfer.effectAllowed = "move"; }}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => handleDrop(event, index)}
                                onDragEnd={() => setDragIndex(null)}
                            >
                                <span className="track-ranking-handle" aria-hidden="true">⋮⋮</span>
                                <span className="track-ranking-position">{index + 1}</span>
                                <span className="track-ranking-name">{renderTrackName(trackId)}</span>
                                <span className="track-ranking-controls">
                                    <button type="button" onClick={() => updateDraft(moveItem(draft, index, index - 1))} disabled={index === 0} aria-label={`Move ${tracksById.get(trackId)?.title || "track"} up`}>↑</button>
                                    <button type="button" onClick={() => updateDraft(moveItem(draft, index, index + 1))} disabled={index === draft.length - 1} aria-label={`Move ${tracksById.get(trackId)?.title || "track"} down`}>↓</button>
                                    <button type="button" onClick={() => updateDraft(draft.filter((id) => id !== trackId))} aria-label={`Remove ${tracksById.get(trackId)?.title || "track"} from ranking`}>×</button>
                                </span>
                            </li>
                        ))}
                    </ol>
                )}

                {unranked.length > 0 && (
                    <>
                        <div className="track-ranking-subheader">
                            <h3 className="track-ranking-heading">Not ranked</h3>
                            {draft.length > 0 && (
                                <button className="track-ranking-inline-link" type="button" onClick={() => updateDraft([...draft, ...unranked])}>
                                    Add all
                                </button>
                            )}
                        </div>
                        <ul className="track-ranking-list track-ranking-pool">
                            {unranked.map((trackId) => (
                                <li key={trackId} className="track-ranking-row">
                                    <span className="track-ranking-name">{renderTrackName(trackId)}</span>
                                    <span className="track-ranking-controls">
                                        <button type="button" onClick={() => updateDraft([...draft, trackId])} aria-label={`Add ${tracksById.get(trackId)?.title || "track"} to ranking`}>+</button>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                <div className="track-ranking-actions">
                    <button className="album-action-button" type="button" onClick={() => submit("PUT")} disabled={isSaving || !isDirty || draft.length === 0}>
                        {isSaving ? "Saving…" : "Save ranking"}
                    </button>
                    {isDirty && (
                        <button className="album-action-button" type="button" onClick={() => updateDraft(savedRanking)} disabled={isSaving}>
                            Discard changes
                        </button>
                    )}
                    {standings.viewerRanking && (
                        <button className="album-action-button track-ranking-remove" type="button" onClick={() => submit("DELETE")} disabled={isSaving}>
                            Remove ranking
                        </button>
                    )}
                </div>
            </>
        );
    };

    return (
        <div className="track-ranking">
            <div className="track-ranking-toggle" role="tablist" aria-label="Track ranking view">
                {[["community", "Community"], ["mine", "Your ranking"]].map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={view === value}
                        className={view === value ? "track-ranking-toggle-active" : ""}
                        onClick={() => setView(value)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {isLoading ? (
                <p className="album-empty-copy">Loading rankings…</p>
            ) : loadError ? (
                <p className="album-empty-copy">{loadError}</p>
            ) : view === "community" ? renderCommunity() : renderEditor()}

            <p className="like-message" role="status" aria-live="polite">{message}</p>
        </div>
    );
}

export default TrackRanking;
