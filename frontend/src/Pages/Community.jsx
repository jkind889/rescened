import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
    AlbumCover,
    DispatchList,
    EmptySignal,
    RankedAlbumList,
    SignalPanel,
} from "../features/home/SignalPanels";
import { PeopleToFollow } from "../features/home/PeopleToFollow";
import { fetchJson, formatShortDate, getAlbumId, settledArray, uniqueAlbums } from "../features/home/signals";
import "../features/home/home.css";

const EMPTY_SIGNALS = { featured: [], popular: [], recent: [], reviews: [] };

function useCommunitySignals() {
    const [signals, setSignals] = useState(EMPTY_SIGNALS);
    const [status, setStatus] = useState("loading");

    useEffect(() => {
        const controller = new AbortController();

        async function fetchSignals() {
            const options = { signal: controller.signal };
            const results = await Promise.allSettled([
                fetchJson("/reviews/featured?limit=10", options),
                fetchJson("/reviews/popular?limit=5&window=30d", options),
                fetchJson("/reviews/recent-albums?limit=6", options),
                fetchJson("/reviews/popular-reviews?limit=4", options),
            ]);

            if (controller.signal.aborted) {
                return;
            }

            const [featured, popular, recent, reviews] = results;
            setSignals({
                featured: settledArray(featured),
                popular: settledArray(popular),
                recent: settledArray(recent),
                reviews: settledArray(reviews),
            });
            setStatus(results.some((result) => result.status === "fulfilled") ? "ready" : "error");
        }

        fetchSignals();

        return () => controller.abort();
    }, []);

    return { signals, status };
}

function LeadAlbum({ album, isLoading }) {
    if (!album) {
        return (
            <div className="community-lead community-lead-empty">
                <span className="community-lead-label">Lead album</span>
                <span>{isLoading ? "Reading live album signals..." : "No live album signals yet."}</span>
            </div>
        );
    }

    return (
        <Link className="community-lead" to={`/album/${getAlbumId(album)}`}>
            <span className="community-lead-label">Lead album</span>
            <AlbumCover album={album} className="community-lead-cover" />
            <span className="community-lead-copy">
                <strong>{album.title || "Untitled album"}</strong>
                <small>{album.artistDisplayName || "Unknown artist"} / {album.releaseYear || "----"}</small>
            </span>
        </Link>
    );
}

export function Community() {
    const { signals, status } = useCommunitySignals();
    const isLoading = status === "loading";
    const leadAlbum = useMemo(() => uniqueAlbums([
        ...signals.featured,
        ...signals.popular,
        ...signals.recent,
    ])[0], [signals]);

    return (
        <div className="home-page home-page-open community-signals-page">
            <div className="home-rail">
                <LeadAlbum album={leadAlbum} isLoading={isLoading} />
                <PeopleToFollow />
            </div>

            <div className="home-feed">
                {status === "error" && (
                    <EmptySignal>The community feed is temporarily unavailable.</EmptySignal>
                )}

                <SignalPanel id="community-popular-title" title="Popular this month" moreTo="/popular-albums">
                    {signals.popular.length ? (
                        <RankedAlbumList albums={signals.popular} />
                    ) : (
                        <EmptySignal>{isLoading ? "Calculating popular albums..." : "No popular albums yet."}</EmptySignal>
                    )}
                </SignalPanel>

                <SignalPanel id="community-recent-title" title="Newly reviewed">
                    {signals.recent.length ? (
                        <div className="signal-tape">
                            {signals.recent.map((album) => (
                                <Link className="signal-tape-album" to={`/album/${getAlbumId(album)}`} key={getAlbumId(album)}>
                                    <AlbumCover album={album} />
                                    <span>{album.title || "Untitled album"}</span>
                                    <small>{formatShortDate(album.latestReviewDate)}</small>
                                </Link>
                            ))}
                        </div>
                    ) : (
                        <EmptySignal>{isLoading ? "Looking for fresh reviews..." : "No reviewed albums yet."}</EmptySignal>
                    )}
                </SignalPanel>

                <SignalPanel id="community-dispatches-title" title="Review dispatches" moreTo="/review-dispatches">
                    {signals.reviews.length ? (
                        <DispatchList reviews={signals.reviews.slice(0, 3)} />
                    ) : (
                        <EmptySignal>{isLoading ? "Gathering review dispatches..." : "No popular reviews yet."}</EmptySignal>
                    )}
                </SignalPanel>
            </div>
        </div>
    );
}

export default Community;
