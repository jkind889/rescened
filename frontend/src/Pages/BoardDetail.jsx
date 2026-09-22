import { API_BASE_URL } from "../config/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import BoardListens from "../Components/BoardListens";
import { getApiErrorMessage } from "../utils/apiErrors";
import AsyncState from "../Components/Loading/AsyncState";

function getArtistName(album) {
  return album.artistDisplayName || "Artist unknown";
}

export function BoardDetail() {
  const { boardId, userId } = useParams();
  const navigate = useNavigate();
  const { getToken, isSignedIn } = useAuth();
  const isPublicBoard = Boolean(userId);
  const requestRef = useRef(null);
  const scope = `${userId || "owner"}:${boardId}:${isSignedIn}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [board, setBoard] = useState(null);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [savingAlbumId, setSavingAlbumId] = useState("");
  const [removingAlbumId, setRemovingAlbumId] = useState("");
  const [albumFilter, setAlbumFilter] = useState("all");
  const [isSavingTitle, setIsSavingTitle] = useState(false);

  const fetchBoard = useCallback(async function fetchBoard(refresh = false) {
    if (scopeRef.current !== scope) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if ((!isSignedIn && !isPublicBoard) || !boardId) {
      setBoard(null);
      setLoadError("");
      setIsLoading(false);
      return;
    }

    try {
      if (!refresh) {
        setIsLoading(true);
        setSelectedAlbum(null);
      }
      setLoadError("");
      const token = isSignedIn ? await getToken() : null;
      const boardUrl = isPublicBoard
        ? `${API_BASE_URL}/profile/${encodeURIComponent(userId)}/boards/${boardId}`
        : `${API_BASE_URL}/boards/${boardId}`;
      const response = await fetch(boardUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, "Could not load this board."));
      }

      const data = await response.json();
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      setBoard(data);
      setTitle(data.title || "");
      setLoadError("");
    } catch (boardError) {
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      if (refresh) {
        setActionError("Your change was saved, but the board could not refresh. Reload the page to see the latest totals.");
      } else {
        setBoard(null);
        setLoadError(boardError.message || "Could not load this board.");
      }
    } finally {
      if (!controller.signal.aborted && scopeRef.current === scope) setIsLoading(false);
    }
  }, [boardId, getToken, isPublicBoard, isSignedIn, userId, scope]);

  useEffect(() => {
    fetchBoard();
    return () => requestRef.current?.abort();
  }, [fetchBoard]);

  const filteredAlbums = useMemo(() => {
    const albums = (board?.albums || []).filter((album) => albumFilter === "all" || (albumFilter === "listened" ? album.listenCount > 0 : album.explicitlySaved));
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return albums;
    }

    return albums.filter((album) => [
      album.title,
      album.artistDisplayName,
      album.releaseYear,
    ].join(" ").toLowerCase().includes(normalizedQuery));
  }, [albumFilter, board, query]);

  async function renameBoard(event) {
    event.preventDefault();

    const nextTitle = title.trim();

    if (!nextTitle || !board || nextTitle === board.title || isSavingTitle) {
      return;
    }

    try {
      setIsSavingTitle(true);
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: nextTitle }),
      });

      if (!response.ok) {
        throw new Error("Failed to rename board");
      }

      const updatedBoard = await response.json();
      setBoard((currentBoard) => ({ ...currentBoard, ...updatedBoard }));
      setTitle(updatedBoard.title);
      setActionError("");
    } catch (renameError) {
      console.error(renameError);
      setActionError("Could not rename this board.");
    } finally {
      setIsSavingTitle(false);
    }
  }

  async function deleteBoard() {
    if (!board || board.isDefault) {
      return;
    }

    try {
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to delete board");
      }

      navigate("/boards");
    } catch (deleteError) {
      console.error(deleteError);
      setActionError("Could not delete this board.");
    }
  }

  async function removeAlbum(albumId) {
    if (!board || isPublicBoard || removingAlbumId || savingAlbumId) {
      return;
    }

    try {
      setRemovingAlbumId(albumId);
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}/albums/${albumId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, "Failed to remove album"));
      }

      if (scopeRef.current !== scope) return;
      setBoard((currentBoard) => ({
        ...currentBoard,
        itemCount: Math.max(0, (currentBoard.itemCount || 1) - 1),
        listenCount: Math.max(0, (currentBoard.listenCount || 0) - (currentBoard.albums.find((album) => album.albumId === albumId)?.listenCount || 0)),
        albums: currentBoard.albums.filter((album) => album.albumId !== albumId),
      }));
    } catch (removeError) {
      console.error(removeError);
      setActionError(removeError.message || "Could not remove that album.");
    } finally {
      setRemovingAlbumId("");
    }
  }

  async function keepAlbumSaved(albumId) {
    if (isPublicBoard || !isSignedIn || savingAlbumId || removingAlbumId) return;
    setSavingAlbumId(albumId);
    setActionError("");
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}/albums`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ albumId }),
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not save this album."));
      await fetchBoard(true);
    } catch (error) {
      if (scopeRef.current === scope) setActionError(error.message || "Could not save this album.");
    } finally {
      setSavingAlbumId("");
    }
  }

  function renderListeningSummary(album) {
    const count = album.listenCount || 0;
    return (
      <div className="board-album-listening">
        <p className="board-album-membership">{album.explicitlySaved ? "Saved album" : "Added through listens"}</p>
        <p>{count} listen{count === 1 ? "" : "s"}{album.latestListenedOn && <> · Latest <time dateTime={album.latestListenedOn}>{album.latestListenedOn}</time></>}</p>
        {(!isPublicBoard || count > 0) && <button type="button" disabled={Boolean(removingAlbumId || savingAlbumId)} onClick={() => setSelectedAlbum(album)}>{isPublicBoard ? "View listening dates" : "Manage listens"}</button>}
        {!isPublicBoard && !album.explicitlySaved && <button type="button" disabled={Boolean(savingAlbumId || removingAlbumId)} onClick={() => keepAlbumSaved(album.albumId)}>{savingAlbumId === album.albumId ? "Saving…" : "Keep album saved"}</button>}
      </div>
    );
  }

  if (!isSignedIn && !isPublicBoard) {
    return (
      <section className="board-detail-page">
        <div className="boards-empty">
          <h1>Board</h1>
          <p>Sign in to view your boards.</p>
        </div>
      </section>
    );
  }

  if (isLoading || loadError || !board) {
    return (
      <section className="board-detail-page">
        <AsyncState
          isLoading={isLoading}
          error={loadError}
          isEmpty={!isLoading && !loadError && !board}
          loadingVariant="detail"
          loadingMessage="Loading board"
          errorTitle="Board unavailable"
          emptyTitle="Board unavailable"
          emptyBody="This board could not be found."
        />
        <Link className="board-back-link" to={isPublicBoard ? `/profile/${userId}` : "/boards"}>
          {isPublicBoard ? "Back to profile" : "Back to boards"}
        </Link>
      </section>
    );
  }

  return (
    <section className="board-detail-page">
      <div className="board-detail-header">
        <Link className="board-back-link" to={isPublicBoard ? `/profile/${userId}` : "/boards"}>
          {isPublicBoard ? "Profile" : "Boards"}
        </Link>
        {isPublicBoard ? (
          <h1>{board.title}</h1>
        ) : (
          <form className="board-title-form" onSubmit={renameBoard}>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              aria-label="Board title"
            />
            <button type="submit" disabled={!title.trim() || title.trim() === board.title || isSavingTitle}>
              Rename
            </button>
          </form>
        )}
        <p>
          {board.isDefault ? "Default board" : "Board"} · {board.itemCount} album{board.itemCount === 1 ? "" : "s"} · {board.listenCount || 0} listen{board.listenCount === 1 ? "" : "s"}
        </p>
        <div className="board-detail-actions">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this board"
            aria-label="Search this board"
          />
          <select aria-label="Filter board albums" value={albumFilter} onChange={(event) => setAlbumFilter(event.target.value)}>
            <option value="all">All albums</option>
            <option value="saved">Saved albums</option>
            <option value="listened">With listens</option>
          </select>
          <div className="profile-view-toggle" aria-label="Board view">
            <button
              className={viewMode === "grid" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setViewMode("grid")}
            >
              Grid
            </button>
            <button
              className={viewMode === "list" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setViewMode("list")}
            >
              List
            </button>
          </div>
          {!isPublicBoard && !board.isDefault && (
            <button className="board-danger-button" type="button" onClick={deleteBoard}>
              Delete
            </button>
          )}
        </div>
      </div>

      {!isPublicBoard && <p className="board-listening-help">Removing an album clears its saves and listening dates from this board. Your diary entries stay intact.</p>}
      {actionError && <p role="alert" className="boards-error">{actionError}</p>}

      {filteredAlbums.length === 0 ? (
        <div className="boards-empty">
          <h2>{board.albums?.length ? "No matching albums" : "No albums here yet"}</h2>
          <p>{board.albums?.length ? "Try another search or filter." : "Save albums or add listens from an album’s Boards button to build this board."}</p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="board-album-grid">
          {filteredAlbums.map((album) => (
            <article className="board-album-card" key={album.albumId}>
              <Link to={`/album/${album.albumId}`}>
                {album.cover ? <img src={album.cover} alt={`${album.title} cover`} /> : <span>No cover</span>}
                <h2>{album.title || "Untitled album"}</h2>
                <p>{getArtistName(album)}</p>
              </Link>
              {renderListeningSummary(album)}
              {!isPublicBoard && (
                <button className="board-remove-album" type="button" disabled={Boolean(removingAlbumId || savingAlbumId)} onClick={() => removeAlbum(album.albumId)}>{removingAlbumId === album.albumId ? "Removing…" : "Remove album"}</button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="board-album-list">
          {filteredAlbums.map((album) => (
            <article className="board-album-row" key={album.albumId}>
              <Link to={`/album/${album.albumId}`}>
                {album.cover ? <img src={album.cover} alt={`${album.title} cover`} /> : <span>No cover</span>}
                <strong>{album.title || "Untitled album"}</strong>
                <em>{getArtistName(album)}</em>
              </Link>
              {renderListeningSummary(album)}
              {!isPublicBoard && (
                <button className="board-remove-album" type="button" disabled={Boolean(removingAlbumId || savingAlbumId)} onClick={() => removeAlbum(album.albumId)}>{removingAlbumId === album.albumId ? "Removing…" : "Remove album"}</button>
              )}
            </article>
          ))}
        </div>
      )}
      {selectedAlbum && <BoardListens
        key={`${userId || "owner"}:${board.boardId}:${selectedAlbum.albumId}`}
        album={selectedAlbum}
        boardId={board.boardId}
        userId={userId}
        onClose={() => setSelectedAlbum(null)}
        onChanged={() => fetchBoard(true)}
      />}
    </section>
  );
}

export default BoardDetail;
