import { useEffect, useMemo, useState } from "react";
import { useUser } from "@clerk/react";
import { Link } from "react-router-dom";
import { API_BASE_URL } from "../config/api";
import SearchBar from "../Components/Searchbar";

const EMPTY_SIGNALS = {
    featured: [],
    popular: [],
    recent: [],
    reviews: [],
    catalog: [],
};

function getSettledArray(result) {
    if (result.status !== "fulfilled") {
        return [];
    }

    return Array.isArray(result.value) ? result.value : [];
}

function ArrowIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M5 12h13M13 6l6 6-6 6" />
        </svg>
    );
}

function formatAlbumYear(album) {
    return album?.releaseYear || "----";
}

function formatRating(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue.toFixed(1).replace(".0", "") : "-";
}

function formatDate(value) {
    if (!value) {
        return "recent";
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime())
        ? "recent"
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatWordmarkUsername(user) {
    const username = String(user?.username || user?.fullName || "").trim();

    return username ? username.slice(0, 10) : "LIVE";
}

function getAlbumId(album) {
    return album?.albumId || "";
}

function getAlbumCover(album) {
    return album?.cover || "";
}

function uniqueAlbums(albums) {
    const seenIds = new Set();

    return albums.filter((album) => {
        const albumId = getAlbumId(album);

        if (!albumId || seenIds.has(albumId)) {
            return false;
        }

        seenIds.add(albumId);
        return true;
    });
}

async function fetchJson(path, signal) {
    const response = await fetch(`${API_BASE_URL}${path}`, { signal });

    if (!response.ok) {
        throw new Error(`${path} failed`);
    }

    return response.json();
}

function useHomepageSignals() {
    const [signals, setSignals] = useState(EMPTY_SIGNALS);
    const [status, setStatus] = useState("loading");

    useEffect(() => {
        const controller = new AbortController();

        async function fetchSignals() {
            try {
                setStatus("loading");

                const [featured, popular, recent, reviews, catalogResponse] = await Promise.allSettled([
                    fetchJson("/reviews/featured?limit=10", controller.signal),
                    fetchJson("/reviews/popular?limit=5&window=30d", controller.signal),
                    fetchJson("/reviews/recent-albums?limit=6", controller.signal),
                    fetchJson("/reviews/popular-reviews?limit=4", controller.signal),
                    fetchJson("/albums/catalog?page=1&limit=12", controller.signal),
                ]);

                if (controller.signal.aborted) {
                    return;
                }

                const catalogValue = catalogResponse.status === "fulfilled" ? catalogResponse.value : [];

                const catalog = Array.isArray(catalogValue)
                    ? catalogValue
                    : catalogValue.results;

                setSignals({
                    featured: getSettledArray(featured),
                    popular: getSettledArray(popular),
                    recent: getSettledArray(recent),
                    reviews: getSettledArray(reviews),
                    catalog: Array.isArray(catalog) ? catalog : [],
                });
                setStatus(
                    [featured, popular, recent, reviews, catalogResponse].some((result) => result.status === "fulfilled")
                        ? "ready"
                        : "error",
                );
            } catch (error) {
                if (error.name !== "AbortError") {
                    setSignals(EMPTY_SIGNALS);
                    setStatus("error");
                }
            }
        }

        fetchSignals();

        return () => controller.abort();
    }, []);

    return { signals, status };
}

function AlbumCover({ album, className = "" }) {
    const cover = getAlbumCover(album);
    const title = album?.title || "album";

    if (!cover) {
        return <span className={`front-cover-fallback ${className}`}>No cover</span>;
    }

    return <img className={className} src={cover} alt={`${title} cover`} />;
}

function LiveAlbumRow({ album, index, context }) {
    const albumId = getAlbumId(album);

    return (
        <Link className="front-live-row" to={`/album/${albumId}`}>
            <span className="front-live-rank">{String(index + 1).padStart(2, "0")}</span>
            <AlbumCover album={album} className="front-live-cover" />
            <span className="front-live-copy">
                <strong>{album.title || "Untitled album"}</strong>
                <small>{album.artistDisplayName || "Unknown artist"}</small>
            </span>
            <span className="front-live-context">{context}</span>
        </Link>
    );
}

function ReviewDispatch({ review }) {
    const username = review.author?.username || "rescened user";
    const albumId = getAlbumId(review);

    return (
        <article className="front-review-dispatch">
            <Link to={`/album/${albumId}`} className="front-review-cover">
                <AlbumCover album={review} />
            </Link>
            <div className="front-review-copy">
                <p>
                    {review.userId ? <Link to={`/profile/${review.userId}`}>{username}</Link> : <span>{username}</span>}
                    <span>{formatRating(review.rating)}/5</span>
                    <span>{review.likeCount || 0} likes</span>
                </p>
                <h3>
                    <Link to={`/album/${albumId}`}>{review.title || "Untitled album"}</Link>
                </h3>
                {review.reviewText && <blockquote>{review.reviewText}</blockquote>}
            </div>
        </article>
    );
}

function EmptySignal({ children }) {
    return <p className="front-signal-empty">{children}</p>;
}

export function FrontPage() {
    const { user } = useUser();
    const { signals, status } = useHomepageSignals();
    const discoveryAlbums = useMemo(() => (
        uniqueAlbums([
            ...signals.featured,
            ...signals.popular,
            ...signals.recent,
            ...signals.catalog,
        ])
    ), [signals]);
    const leadAlbum = discoveryAlbums[0];
    const leadAlbumId = getAlbumId(leadAlbum);
    const isLoading = status === "loading";
    const wordmarkUsername = formatWordmarkUsername(user);

    return (
        <section className="front-page">
            <div className="front-ruler front-ruler-top" aria-hidden="true" />
            <div className="front-ruler front-ruler-right" aria-hidden="true" />
            <div className="front-ruler front-ruler-bottom" aria-hidden="true" />
            <div className="front-ruler front-ruler-left" aria-hidden="true" />

            <div className="front-editorial">
                <div className="front-identification">
                    <div>
                        <h1>rescened</h1>
                        <p>a social music journal</p>
                    </div>
                    <span className="front-identification-rule" aria-hidden="true" />
                    <div className="front-edition">
                        <p>Live Issue / Community Signals</p>
                        <p>Catalog Ref. ABX-{String(discoveryAlbums.length).padStart(4, "0")}</p>
                    </div>
                </div>

                {leadAlbum ? (
                    <Link className="front-lead" to={`/album/${leadAlbumId}`}>
                        <span className="front-lead-label">Lead album</span>
                        <AlbumCover album={leadAlbum} className="front-lead-cover" />
                        <span className="front-lead-copy">
                            <strong>{leadAlbum.title || "Untitled album"}</strong>
                            <small>{leadAlbum.artistDisplayName || "Unknown artist"} / {formatAlbumYear(leadAlbum)}</small>
                        </span>
                    </Link>
                ) : (
                    <div className="front-lead front-lead-empty">
                        <span className="front-lead-label">Lead album</span>
                        <span>{isLoading ? "Reading live album signals" : "No live album signals yet"}</span>
                    </div>
                )}

                <div className="front-wordmark" aria-hidden="true">
                    {wordmarkUsername}
                </div>
            </div>

            <aside className="front-signal-board" aria-labelledby="front-signal-title">
                <header className="front-signal-header">
                    <p id="front-signal-title">Live Discovery</p>
                    <span>{status === "error" ? "offline" : `${discoveryAlbums.length} albums`}</span>
                </header>

                {status === "error" && (
                    <EmptySignal>The live discovery feed is temporarily unavailable.</EmptySignal>
                )}

                <section className="front-signal-section" aria-labelledby="front-popular-title">
                    <div className="front-section-title">
                        <h2 id="front-popular-title">Popular this month</h2>
                        <Link to="/popular-albums">More <ArrowIcon /></Link>
                    </div>
                    {signals.popular.length ? (
                        <div className="front-live-list">
                            {signals.popular.slice(0, 5).map((album, index) => (
                                <LiveAlbumRow
                                    album={album}
                                    context={`${album.reviewCount || 0} reviews / ${formatRating(album.averageRating)}`}
                                    index={index}
                                    key={getAlbumId(album)}
                                />
                            ))}
                        </div>
                    ) : (
                        <EmptySignal>{isLoading ? "Calculating popular albums..." : "No popular albums yet."}</EmptySignal>
                    )}
                </section>

                <section className="front-signal-section" aria-labelledby="front-recent-title">
                    <div className="front-section-title">
                        <h2 id="front-recent-title">Newly reviewed</h2>
                    </div>
                    {signals.recent.length ? (
                        <div className="front-album-tape">
                            {signals.recent.slice(0, 6).map((album) => (
                                <Link className="front-tape-album" to={`/album/${getAlbumId(album)}`} key={getAlbumId(album)}>
                                    <AlbumCover album={album} />
                                    <span>{album.title || "Untitled album"}</span>
                                    <small>{formatDate(album.latestReviewDate)}</small>
                                </Link>
                            ))}
                        </div>
                    ) : (
                        <EmptySignal>{isLoading ? "Looking for fresh reviews..." : "No reviewed albums yet."}</EmptySignal>
                    )}
                </section>

                <section className="front-signal-section" aria-labelledby="front-reviews-title">
                    <div className="front-section-title">
                        <h2 id="front-reviews-title">Review dispatches</h2>
                        <Link to="/review-dispatches">More <ArrowIcon /></Link>
                    </div>
                    {signals.reviews.length ? (
                        <div className="front-review-stack">
                            {signals.reviews.slice(0, 3).map((review) => (
                                <ReviewDispatch review={review} key={review.reviewId} />
                            ))}
                        </div>
                    ) : (
                        <EmptySignal>{isLoading ? "Gathering review dispatches..." : "No popular reviews yet."}</EmptySignal>
                    )}
                </section>

                <section className="front-signal-section" aria-labelledby="front-catalog-title">
                    <div className="front-section-title front-catalog-title">
                        <h2 id="front-catalog-title">Catalog index</h2>
                        <div className="front-catalog-search">
                            <SearchBar placeholder="Search catalog" />
                        </div>
                    </div>
                    {signals.catalog.length ? (
                        <div className="front-index-list">
                            {signals.catalog.slice(0, 8).map((album) => (
                                <Link to={`/album/${getAlbumId(album)}`} key={getAlbumId(album)}>
                                    <span>{album.title || "Untitled album"}</span>
                                    <small>{album.artistDisplayName || "Unknown artist"}</small>
                                    <em>{formatAlbumYear(album)}</em>
                                </Link>
                            ))}
                        </div>
                    ) : (
                        <EmptySignal>{isLoading ? "Reading the catalog..." : "No catalog albums yet."}</EmptySignal>
                    )}
                </section>
            </aside>
        </section>
    );
}

export default FrontPage;
