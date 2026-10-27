import { API_BASE_URL } from "../config/api";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { getApiErrorMessage } from "../utils/apiErrors";
import { AddToQueueButton } from "../features/queue/QueueActions";
import Cover from "./Cover";

// Suggests a random saved album the viewer has not logged or reviewed yet.
// Without boardId it draws from every board the viewer owns.
export function PickAlbum({ boardId = "" }) {
  const { getToken } = useAuth();
  const [pick, setPick] = useState(null);
  const [message, setMessage] = useState("");
  const [isPicking, setIsPicking] = useState(false);

  async function pickAlbum() {
    if (isPicking) return;
    setIsPicking(true);
    setMessage("");
    try {
      const token = await getToken();
      const query = boardId ? `?boardId=${encodeURIComponent(boardId)}` : "";
      const response = await fetch(`${API_BASE_URL}/boards/pick${query}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not pick an album right now."));
      const data = await response.json();
      setPick(data.album ? data : null);
      if (!data.album) {
        setMessage(boardId
          ? "You've logged or reviewed everything saved on this board."
          : "You've logged or reviewed every album you've saved.");
      }
    } catch (error) {
      setPick(null);
      setMessage(error.message || "Could not pick an album right now.");
    } finally {
      setIsPicking(false);
    }
  }

  const album = pick?.album;

  return (
    <div className="pick-album">
      <button className="pick-album-button" type="button" onClick={pickAlbum} disabled={isPicking}>
        {isPicking ? "Picking…" : album ? "Pick another" : "Pick something for me"}
      </button>
      {album && (
        <Link className="pick-album-result" to={`/album/${album.albumId}`}>
          {album.cover ? <Cover src={album.cover} /> : <span className="pick-album-fallback">No cover</span>}
          <span>
            <small>Not logged yet · 1 of {pick.candidateCount}</small>
            <strong>{album.title || "Untitled album"}</strong>
            <em>{album.artistDisplayName || "Artist unknown"}{album.releaseYear ? ` · ${album.releaseYear}` : ""}</em>
          </span>
        </Link>
      )}
      {album && <AddToQueueButton albumId={album.albumId} className="pick-album-queue" />}
      {message && <p className="pick-album-message" role="status">{message}</p>}
    </div>
  );
}

export default PickAlbum;
