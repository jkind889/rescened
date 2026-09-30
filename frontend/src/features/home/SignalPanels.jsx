import { Link } from "react-router-dom";
import { formatCalendarDate, formatRating, formatReviewCount, getAlbumId } from "./signals";

export function ArrowIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M5 12h13M13 6l6 6-6 6" />
        </svg>
    );
}

export function AlbumCover({ album, className = "" }) {
    const cover = album?.cover || "";
    const title = album?.title || "album";

    if (!cover) {
        return <span className={`signal-cover signal-cover-empty ${className}`}>No cover</span>;
    }

    return <img className={`signal-cover ${className}`} src={cover} alt={`${title} cover`} loading="lazy" />;
}

export function SignalPanel({ id, title, moreTo, moreLabel = "More", action, children }) {
    return (
        <section className="signal-panel" aria-labelledby={id}>
            <header className="signal-panel-header">
                <h2 id={id}>{title}</h2>
                {action}
                {moreTo && (
                    <Link to={moreTo} className="signal-more">
                        {moreLabel} <ArrowIcon />
                    </Link>
                )}
            </header>
            {children}
        </section>
    );
}

export function EmptySignal({ children }) {
    return <p className="signal-empty">{children}</p>;
}

export function RankedAlbumList({ albums }) {
    return (
        <ol className="signal-rank-list">
            {albums.map((album, index) => (
                <li key={getAlbumId(album)}>
                    <Link className="signal-rank-row" to={`/album/${getAlbumId(album)}`}>
                        <span className="signal-rank">{String(index + 1).padStart(2, "0")}</span>
                        <AlbumCover album={album} className="signal-rank-cover" />
                        <span className="signal-rank-copy">
                            <strong>{album.title || "Untitled album"}</strong>
                            <small>{album.artistDisplayName || "Unknown artist"}</small>
                        </span>
                        <span className="signal-rank-context">
                            {formatReviewCount(album.reviewCount)} / {formatRating(album.averageRating)}
                        </span>
                    </Link>
                </li>
            ))}
        </ol>
    );
}

export function DispatchList({ reviews }) {
    return (
        <div className="signal-dispatch-list">
            {reviews.map((review) => {
                const username = review.author?.username || "rescened user";
                const albumId = getAlbumId(review);
                const likeCount = Number(review.likeCount) || 0;

                return (
                    <article className="signal-dispatch" key={review.reviewId}>
                        <Link to={`/album/${albumId}`} className="signal-dispatch-cover" tabIndex={-1} aria-hidden="true">
                            <AlbumCover album={review} />
                        </Link>
                        <div className="signal-dispatch-copy">
                            <p className="signal-dispatch-meta">
                                {review.userId
                                    ? <Link to={`/profile/${review.userId}`}>{username}</Link>
                                    : <span>{username}</span>}
                                <span>{formatRating(review.rating)}/5</span>
                                <span>{likeCount} {likeCount === 1 ? "like" : "likes"}</span>
                            </p>
                            <h3>
                                <Link to={`/album/${albumId}`}>{review.title || "Untitled album"}</Link>
                            </h3>
                            {review.reviewText && <blockquote>{review.reviewText}</blockquote>}
                        </div>
                    </article>
                );
            })}
        </div>
    );
}

export function ReviewQueue({ albums }) {
    return (
        <ol className="signal-queue">
            {albums.map((row) => (
                <li key={getAlbumId(row)} className="signal-queue-row">
                    <Link to={`/album/${getAlbumId(row)}`} className="signal-queue-album">
                        <AlbumCover album={row.album} className="signal-queue-cover" />
                        <span className="signal-rank-copy">
                            <strong>{row.album?.title || "Untitled album"}</strong>
                            <small>
                                {row.album?.artistDisplayName || "Unknown artist"}
                                {" / "}
                                {row.listenCount > 1 ? `${row.listenCount} listens, last ` : "listened "}
                                {formatCalendarDate(row.lastListenedOn)}
                            </small>
                        </span>
                    </Link>
                    <Link
                        to={`/album/${getAlbumId(row)}`}
                        state={{ openReview: true }}
                        className="signal-queue-action"
                        aria-label={`Review ${row.album?.title || "this album"}`}
                    >
                        Review <ArrowIcon />
                    </Link>
                </li>
            ))}
        </ol>
    );
}

export function Masthead({ edition, reference }) {
    return (
        <div className="masthead-card">
            <div>
                <p className="masthead-name">rescened</p>
                <p>a social music journal</p>
            </div>
            <span className="masthead-rule" aria-hidden="true" />
            <div className="masthead-edition">
                <p>Live Issue / {edition}</p>
                <p>Catalog Ref. ABX-{String(reference).padStart(4, "0")}</p>
            </div>
        </div>
    );
}
