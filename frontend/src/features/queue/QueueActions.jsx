import { useState } from "react";
import { useAuth } from "@clerk/react";
import { queueRequest, useListenQueue } from "./queue";
import "./queue.css";

function queueSummary(status, queue) {
  if (status === "loading") return "Checking…";
  if (status === "error") return "Queue unavailable";
  if (queue.count >= queue.limit) return `Queue is full (${queue.limit})`;
  return `${queue.count} of ${queue.limit} queued`;
}

// Album page action: queue the album at either end, move it to the top, or remove it.
export function AlbumQueueAction({ albumId, refreshKey = 0 }) {
  const { queue, status, message, isSaving, add, remove } = useListenQueue({ refreshKey });
  const index = queue.albums.findIndex((album) => album.albumId === albumId);
  const isQueued = index >= 0;
  const isFull = queue.count >= queue.limit;
  const isBusy = isSaving || status === "loading";

  return (
    <div className="album-queue-action" role="group" aria-label="Listen queue">
      {isQueued ? (
        <>
          <button className="album-side-action" type="button" onClick={() => remove(albumId)} disabled={isBusy}>
            In your queue<small>#{index + 1} of {queue.count} · Remove</small>
          </button>
          <button className="album-side-action" type="button" onClick={() => add(albumId, "top")} disabled={isBusy || index === 0}>
            {index === 0 ? "Up next" : "Move to top"}
          </button>
        </>
      ) : (
        <>
          <button className="album-side-action" type="button" onClick={() => add(albumId)} disabled={isBusy || isFull}>
            Add to queue<small>{queueSummary(status, queue)}</small>
          </button>
          <button className="album-side-action" type="button" onClick={() => add(albumId, "top")} disabled={isBusy || isFull}>
            Listen next
          </button>
        </>
      )}
      {message && <p className="board-save-message" role="status">{message}</p>}
    </div>
  );
}

// A one-shot add for places that don't load the whole queue, such as pick
// results. An album that is already queued keeps its place.
export function AddToQueueButton({ albumId, className = "" }) {
  const { getToken } = useAuth();
  const [state, setState] = useState({ albumId: "", message: "", isSaving: false });
  const current = state.albumId === albumId ? state : { albumId, message: "", isSaving: false };

  async function addAlbum() {
    setState({ albumId, message: "", isSaving: true });
    try {
      const queue = await queueRequest(getToken, { method: "POST", body: { albumId } });
      const position = queue.albums.findIndex((album) => album.albumId === albumId) + 1;
      setState({ albumId, message: `Queued · #${position} of ${queue.count}`, isSaving: false });
    } catch (error) {
      setState({ albumId, message: error.message, isSaving: false });
    }
  }

  return (
    <span className={`queue-add ${className}`.trim()}>
      <button type="button" onClick={addAlbum} disabled={current.isSaving}>
        {current.isSaving ? "Adding…" : "Add to queue"}
      </button>
      {current.message && <small role="status">{current.message}</small>}
    </span>
  );
}
