import { API_BASE_URL } from "../config/api";
import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";
import Cover from "./Cover";

export function RecentlySaved() {
    const [savedAlbums, setSavedAlbums] = useState([]);
    const { getToken } = useAuth();
    useEffect(() => {
        async function fetchSavedAlbums() {
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/boards/default`, {
                headers: {
                    "Authorization": `Bearer ${token}`
                }
            });
            const saved = await res.json();
            const savedAlbums = Array.isArray(saved.albums) ? saved.albums : [];
            setSavedAlbums(savedAlbums.slice(0, 5)); // Show only the 5 most recently saved albums
        }
        fetchSavedAlbums();
    }, [getToken]);


    return (
        <div className="recently-saved">
            {savedAlbums.map((album) => (
                <div key={album.albumId} className="recent-saved-album">
                    <Cover src={album.cover} alt={`${album.title} cover`} className="recent-saved-album-cover" />
                    <div className="recent-saved-album-info">
                        <h3>{album.title}</h3>
                        <p>{album.artistDisplayName}</p>
                    </div>
                </div>
            ))}
        </div>
    );



 }

 export default RecentlySaved;
