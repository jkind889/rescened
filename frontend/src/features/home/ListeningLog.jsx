import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowIcon } from "./SignalPanels";
import { formatCalendarDate, getAlbumId, sortTracks } from "./signals";

function ListenTracklist({ listen, id }) {
    const tracks = sortTracks(listen.album?.tracks);

    return (
        <div className="listening-log-tracks" id={id}>
            {tracks.length ? (
                <ul>
                    {tracks.map((track, index) => (
                        <li key={track.trackId || `${track.discNumber}-${track.trackNumber}-${index}`}>
                            {track.title || "Untitled track"}
                        </li>
                    ))}
                </ul>
            ) : (
                <p>No tracklist in the catalog yet.</p>
            )}
            <Link to={`/album/${getAlbumId(listen)}`} className="listening-log-album-link">
                Open album <ArrowIcon />
            </Link>
        </div>
    );
}

function ListenRow({ listen, isOpen, onToggle }) {
    const panelId = `listen-tracks-${listen.listenId}`;

    return (
        <li className={isOpen ? "listening-log-item is-open" : "listening-log-item"}>
            <button
                type="button"
                className="listening-log-row"
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onClick={onToggle}
            >
                <span className="listening-log-title">{listen.album?.title || "Untitled album"}</span>
                <span className="listening-log-artist">{listen.album?.artistDisplayName || "Unknown artist"}</span>
                <span className="listening-log-source">{listen.source === "automatic" ? "Auto" : ""}</span>
                <time dateTime={listen.listenedOn}>{formatCalendarDate(listen.listenedOn)}</time>
            </button>
            {isOpen && <ListenTracklist listen={listen} id={panelId} />}
        </li>
    );
}

export function ListeningLog({ listens, isSignedIn, isLoading }) {
    const [openListenId, setOpenListenId] = useState("");
    let body;

    if (!isSignedIn) {
        body = (
            <p className="listening-log-note">
                Sign in and connect Last.fm to have finished albums written here automatically.
            </p>
        );
    } else if (listens.length) {
        body = (
            <ol className="listening-log-list">
                {listens.map((listen) => (
                    <ListenRow
                        key={listen.listenId}
                        listen={listen}
                        isOpen={openListenId === listen.listenId}
                        onToggle={() => setOpenListenId((current) => current === listen.listenId ? "" : listen.listenId)}
                    />
                ))}
            </ol>
        );
    } else {
        body = (
            <p className="listening-log-note">
                {isLoading
                    ? "Reading your diary..."
                    : <>Nothing logged yet. <Link to="/account" state={{ activeTab: "lastfm" }}>Connect Last.fm</Link> to log finished albums automatically.</>}
            </p>
        );
    }

    return (
        <section className="listening-log" aria-labelledby="listening-log-title">
            <h2 id="listening-log-title" className="listening-log-label">Listening log</h2>
            {body}
        </section>
    );
}

export default ListeningLog;
