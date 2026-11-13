import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from "react";
import Cover from "./Cover";
import { CardLink, CardTitleLink } from "./CardLink";
import ArtistCredits from "../features/artists/ArtistCredits";

export function PopularAlbums({ limit = 10, window = "30d" }) {
    const [albums, setAlbums] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function fetchPopularAlbums() {
            setIsLoading(true);

            try {
                const params = new URLSearchParams({
                    limit: String(limit),
                    window,
                });
                const res = await fetch(`${API_BASE_URL}/reviews/popular?${params.toString()}`);

                if (!res.ok) {
                    setAlbums([]);
                    return;
                }

                const data = await res.json();

                if (isMounted) {
                    setAlbums(Array.isArray(data) ? data : []);
                }
            } catch (error) {
                console.error("Failed to fetch popular albums", error);

                if (isMounted) {
                    setAlbums([]);
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        fetchPopularAlbums();

        return () => {
            isMounted = false;
        };
    }, [limit, window]);

    if (isLoading) {
        return <p className="popular-albums-empty">Loading popular albums...</p>;
    }

    if (!albums.length) {
        return <p className="popular-albums-empty">No popular albums yet.</p>;
    }

    return (
        <div className="popular-albums-grid">
            {albums.map((album, index) => (
                <CardLink
                    key={album.albumId}
                    className="popular-album-card"
                >
                    <span className="popular-album-rank">{index + 1}</span>
                    {album.cover ? (
                        <Cover
                            className="popular-album-cover"
                            src={album.cover}
                            alt={`${album.title} cover`}
                            size={84}
                        />
                    ) : (
                        <div className="popular-album-cover popular-album-cover-fallback">
                            No cover
                        </div>
                    )}
                    <div className="popular-album-info">
                        <h4><CardTitleLink to={`/album/${album.albumId}`}>{album.title}</CardTitleLink></h4>
                        <p><ArtistCredits album={album} /></p>
                    </div>
                </CardLink>
            ))}
        </div>
    );
}

export default PopularAlbums;
