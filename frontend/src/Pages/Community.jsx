import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SearchBar from "../Components/Searchbar";
import {
    AlbumCover,
    ArrowIcon,
    DispatchList,
    EmptySignal,
    Masthead,
    RankedAlbumList,
    SignalPanel,
} from "../features/home/SignalPanels";
import { fetchJson, formatShortDate, getAlbumId, settledArray, uniqueAlbums } from "../features/home/signals";
import "../features/home/home.css";

const EMPTY_SIGNALS = { featured: [], popular: [], recent: [], reviews: [], catalog: [] };

function useCommunitySignals() {
    const [signals, setSignals] = useState(EMPTY_SIGNALS);
    const [status, setStatus] = useState("loading");

    useEffect(() => {
        const controller = new AbortController();

        async function fetchSignals() {
            setStatus("loading");
            const options = { signal: controller.signal };
            const results = await Promise.allSettled([
                fetchJson("/reviews/featured?limit=10", options),
                fetchJson("/reviews/popular?limit=5&window=30d", options),
                fetchJson("/reviews/recent-albums?limit=6", options),
                fetchJson("/reviews/popular-reviews?limit=4", options),
                fetchJson("/albums/catalog?page=1&limit=12", options),
            ]);

            if (controller.signal.aborted) {
                return;
            }

            const [featured, popular, recent, reviews, catalog] = results;
            const catalogRows = catalog.status === "fulfilled" && Array.isArray(catalog.value)
                ? catalog.value
                : settledArray(catalog, "results");

            setSignals({
                featured: settledArray(featured),
                popular: settledArray(popular),
                recent: settledArray(recent),
                reviews: settledArray(reviews),
                catalog: catalogRows,
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
    const discoveryAlbums = useMemo(() => uniqueAlbums([
        ...signals.featured,
        ...signals.popular,
        ...signals.recent,
        ...signals.catalog,
    ]), [signals]);

    return (
        <div className="home-page community-signals-page">
            <div className="home-rail">
                <LeadAlbum album={discoveryAlbums[0]} isLoading={isLoading} />
                <Masthead edition="Community Signals" reference={discoveryAlbums.length} />
                <Link to="/community/approved" className="home-community-link">
                    Recently approved catalog suggestions <ArrowIcon />
                </Link>
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

                <SignalPanel
                    id="community-catalog-title"
                    title="Catalog index"
                    action={<div className="signal-panel-search"><SearchBar placeholder="Search catalog" /></div>}
                >
                    {signals.catalog.length ? (
                        <div className="signal-index-list">
                            {signals.catalog.slice(0, 8).map((album) => (
                                <Link to={`/album/${getAlbumId(album)}`} key={getAlbumId(album)}>
                                    <span>{album.title || "Untitled album"}</span>
                                    <small>{album.artistDisplayName || "Unknown artist"}</small>
                                    <em>{album.releaseYear || "----"}</em>
                                </Link>
                            ))}
                        </div>
                    ) : (
                        <EmptySignal>{isLoading ? "Reading the catalog..." : "No catalog albums yet."}</EmptySignal>
                    )}
                </SignalPanel>
            </div>
        </div>
    );
}

export default Community;
