import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { fetchProfileQueue, moveItem, normalizeQueue, useListenQueue } from "./queue";
import "./queue.css";

function QueueCover({ album }) {
  return album.cover
    ? <img className="listen-queue-cover" src={album.cover} alt="" loading="lazy" />
    : <span className="listen-queue-cover listen-queue-cover-empty" aria-hidden="true" />;
}

function AlbumCopy({ album }) {
  return (
    <span className="listen-queue-copy">
      <strong>{album.title || "Untitled album"}</strong>
      <small>{album.artistDisplayName || "Artist unknown"}{album.releaseYear ? ` · ${album.releaseYear}` : ""}</small>
    </span>
  );
}

function sameOrder(first, second) {
  return first.length === second.length && first.every((albumId, index) => albumId === second[index]);
}

// The owner's queue: drag or arrow reordering behind a Save / Discard bar, and
// immediate removal. Removal waits until an unsaved order is saved or discarded.
// onQueueChange receives every loaded or saved queue, so a page can keep its own
// summary (such as a profile pin) in step.
export function ListenQueueEditor({ emptyHint = "Add albums from an album page to plan what you play next.", onQueueChange }) {
  const { queue, status, message, isSaving, remove, reorder } = useListenQueue();
  useEffect(() => {
    if (status === "ready") onQueueChange?.(queue);
  }, [onQueueChange, queue, status]);
  const savedOrder = useMemo(() => queue.albums.map((album) => album.albumId), [queue.albums]);
  const [draft, setDraft] = useState({ base: savedOrder, order: savedOrder });
  const [dragIndex, setDragIndex] = useState(null);
  // A new server order (save, removal, reload) replaces the draft.
  const order = draft.base === savedOrder ? draft.order : savedOrder;
  const albumsById = useMemo(() => new Map(queue.albums.map((album) => [album.albumId, album])), [queue.albums]);
  const isDirty = !sameOrder(order, savedOrder);

  function updateOrder(next) { setDraft({ base: savedOrder, order: next }); }
  function handleDrop(event, targetIndex) {
    event.preventDefault();
    if (dragIndex !== null) updateOrder(moveItem(order, dragIndex, targetIndex));
    setDragIndex(null);
  }

  if (status === "loading" && !queue.albums.length) return <p className="listen-queue-note">Loading your queue…</p>;
  if (status === "error" && !queue.albums.length) return <p className="listen-queue-note" role="alert">{message}</p>;

  return (
    <div className="listen-queue">
      {order.length === 0 ? (
        <p className="listen-queue-note">Nothing queued. {emptyHint}</p>
      ) : (
        <ol className="listen-queue-list listen-queue-editable">
          {order.map((albumId, index) => {
            const album = albumsById.get(albumId);
            if (!album) return null;
            const label = album.title || "album";
            return (
              <li
                key={albumId}
                className={dragIndex === index ? "listen-queue-row is-dragging" : "listen-queue-row"}
                draggable
                onDragStart={(event) => { setDragIndex(index); event.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(event, index)}
                onDragEnd={() => setDragIndex(null)}
              >
                <span className="listen-queue-handle" aria-hidden="true">⋮⋮</span>
                <span className="listen-queue-position">{index + 1}</span>
                <Link className="listen-queue-album" to={`/album/${albumId}`} draggable={false}>
                  <QueueCover album={album} />
                  <AlbumCopy album={album} />
                </Link>
                <span className="listen-queue-controls">
                  <button type="button" onClick={() => updateOrder(moveItem(order, index, index - 1))} disabled={isSaving || index === 0} aria-label={`Move ${label} up`}>↑</button>
                  <button type="button" onClick={() => updateOrder(moveItem(order, index, index + 1))} disabled={isSaving || index === order.length - 1} aria-label={`Move ${label} down`}>↓</button>
                  <button
                    type="button"
                    onClick={() => remove(albumId)}
                    disabled={isSaving || isDirty}
                    title={isDirty ? "Save or discard your new order first" : undefined}
                    aria-label={`Remove ${label} from your queue`}
                  >×</button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="listen-queue-footer">
        <small>{queue.count} of {queue.limit} queued</small>
        {isDirty && (
          <span className="listen-queue-actions">
            <button type="button" onClick={() => updateOrder(savedOrder)} disabled={isSaving}>Discard</button>
            <button type="button" className="is-primary" onClick={() => reorder(order)} disabled={isSaving}>{isSaving ? "Saving…" : "Save order"}</button>
          </span>
        )}
      </div>
      {message && status !== "error" && <p className="listen-queue-note" role="status">{message}</p>}
    </div>
  );
}

// Someone else's queue, read-only: the profile preview first, then the whole
// queue on request. Render it with key={userId} so a new profile starts fresh.
export function UpNextList({ userId, preview = [], count = 0 }) {
  const { getToken, isSignedIn } = useAuth();
  const [full, setFull] = useState(null);
  const [state, setState] = useState({ isLoading: false, error: "" });
  const albums = full ? full.albums : preview;

  async function showAll() {
    setState({ isLoading: true, error: "" });
    try {
      const token = isSignedIn ? await getToken() : null;
      setFull(normalizeQueue(await fetchProfileQueue(userId, token)));
      setState({ isLoading: false, error: "" });
    } catch (error) {
      setState({ isLoading: false, error: error.message });
    }
  }

  if (!albums.length) return <p className="listen-queue-note">Nothing queued yet.</p>;

  return (
    <div className="listen-queue">
      <ol className="listen-queue-list">
        {albums.map((album, index) => (
          <li key={album.albumId} className="listen-queue-row">
            <span className="listen-queue-position">{index + 1}</span>
            <Link className="listen-queue-album" to={`/album/${album.albumId}`}>
              <QueueCover album={album} />
              <AlbumCopy album={album} />
            </Link>
          </li>
        ))}
      </ol>
      {!full && count > preview.length && (
        <button className="listen-queue-more" type="button" onClick={showAll} disabled={state.isLoading}>
          {state.isLoading ? "Loading…" : `See all ${count}`}
        </button>
      )}
      {state.error && <p className="listen-queue-note" role="alert">{state.error}</p>}
    </div>
  );
}
