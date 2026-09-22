import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../config/api";
import { getApiErrorMessage } from "../utils/apiErrors";
import ListenForm from "./ListenForm";

export default function BoardListens({ album, boardId, userId, onClose, onChanged }) {
  const { getToken, isSignedIn } = useAuth();
  const readOnly = Boolean(userId);
  const [mode, setMode] = useState("board");
  const [listens, setListens] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requestRef = useRef(null);
  const dialogRef = useRef(null);

  const load = useCallback(async (nextCursor = null) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const token = isSignedIn ? await getToken() : null;
      const base = mode === "diary"
        ? `${API_BASE_URL}/diary?albumId=${album.albumId}`
        : `${API_BASE_URL}${readOnly ? `/profile/${encodeURIComponent(userId)}` : ""}/boards/${boardId}/albums/${album.albumId}/listens?limit=20`;
      const response = await fetch(`${base}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal,
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load listening dates."));
      const data = await response.json();
      if (controller.signal.aborted) return;
      setListens((current) => nextCursor ? [...current, ...data.listens] : data.listens);
      setCursor(data.nextCursor || null);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || "Could not load listening dates.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [album.albumId, boardId, getToken, isSignedIn, mode, readOnly, userId]);

  useEffect(() => {
    if (mode !== "log") void load();
    return () => requestRef.current?.abort();
  }, [load, mode]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  function changeMode(nextMode) {
    if (nextMode === mode) return;
    setListens([]);
    setCursor(null);
    setError("");
    setMessage("");
    setMode(nextMode);
    dialogRef.current?.focus();
  }

  async function membership(listenId) {
    if (busy || readOnly || !isSignedIn) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${boardId}/listens/${listenId}`, {
        method: mode === "diary" ? "PUT" : "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not update this board listen."));
      setMessage(mode === "diary" ? "Listen added to this board." : "Removed from this board. The listen remains in your diary.");
      await Promise.all([load(), onChanged()]);
      dialogRef.current?.focus();
    } catch (failure) {
      setError(failure.message || "Could not update this board listen.");
    } finally {
      setBusy(false);
    }
  }

  function handleKeys(event) {
    if (event.key === "Escape" && !busy) onClose();
    if (event.key !== "Tab") return;
    const controls = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
      event.preventDefault(); first.focus();
    }
  }

  return (
    <div className="review-modal-backdrop">
      <div className="review-modal board-listens-modal" role="dialog" aria-modal="true" aria-labelledby="board-listens-title" tabIndex={-1} ref={dialogRef} onKeyDown={handleKeys}>
        <button className="review-modal-close" type="button" aria-label="Close listening dates" disabled={busy} onClick={onClose}>×</button>
        <h2 id="board-listens-title">Listens · {album.title}</h2>
        <p>Listening dates in this board.</p>
        {!readOnly && (
          <div className="board-listens-tabs" role="group" aria-label="Listening actions">
            <button type="button" aria-pressed={mode === "board"} disabled={busy} onClick={() => changeMode("board")}>In this board</button>
            <button type="button" aria-pressed={mode === "log"} disabled={busy} onClick={() => changeMode("log")}>Log listen</button>
            <button type="button" aria-pressed={mode === "diary"} disabled={busy} onClick={() => changeMode("diary")}>Add from diary</button>
          </div>
        )}
        {mode === "log" ? (
          <ListenForm album={album} boardId={boardId} onBusyChange={setBusy} onSubmitted={() => {
            changeMode("board");
            setMessage("Listen logged and added to this board.");
            void onChanged();
          }} />
        ) : (
          <>
            {mode === "diary" && <p>Choose an existing listen. Adding it again won’t create a duplicate.</p>}
            <ul className="board-listens-list">
              {listens.map((listen) => (
                <li key={listen.listenId}>
                  <time dateTime={listen.listenedOn}>{listen.listenedOn}</time>
                  {!readOnly && <button type="button" disabled={busy || loading} onClick={() => membership(listen.listenId)}>{mode === "diary" ? "Add to board" : "Remove from board"}</button>}
                </li>
              ))}
            </ul>
            {loading && <p role="status">Loading listening dates…</p>}
            {!loading && !error && !listens.length && <p>{mode === "diary" ? "No listens logged for this album yet." : "No listening dates in this board yet."}</p>}
            {cursor && <button type="button" disabled={loading || busy} onClick={() => load(cursor)}>Load older listens</button>}
          </>
        )}
        {error && <p className="boards-error" role="alert">{error} {mode !== "log" && <button type="button" disabled={busy || loading} onClick={() => load()}>Reload dates</button>}</p>}
        {message && <p className="board-listens-message" role="status">{message}</p>}
      </div>
    </div>
  );
}
