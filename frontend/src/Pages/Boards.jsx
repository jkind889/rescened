import { API_BASE_URL } from "../config/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import AsyncState from "../Components/Loading/AsyncState";

function BoardPreview({ albums }) {
  const previewAlbums = albums.slice(0, 4);

  return (
    <div className="board-preview-grid" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => {
        const album = previewAlbums[index];

        return album?.cover ? (
          <img key={album.albumId || index} src={album.cover} alt="" />
        ) : (
          <span key={index} />
        );
      })}
    </div>
  );
}

export function Boards() {
  const { getToken, isSignedIn } = useAuth();
  const [boards, setBoards] = useState([]);
  const [newTitle, setNewTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");

  const fetchBoards = useCallback(async function fetchBoards() {
    if (!isSignedIn) {
      setBoards([]);
      setLoadError("");
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setLoadError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch boards");
      }

      const data = await response.json();
      setBoards(Array.isArray(data) ? data : []);
      setLoadError("");
    } catch (boardsError) {
      console.error(boardsError);
      setBoards([]);
      setLoadError("Could not load your boards.");
    } finally {
      setIsLoading(false);
    }
  }, [getToken, isSignedIn]);

  useEffect(() => {
    fetchBoards();
  }, [fetchBoards]);

  const sortedBoards = useMemo(() => (
    [...boards].sort((first, second) => Number(second.isDefault) - Number(first.isDefault)
      || new Date(second.updatedAt || 0) - new Date(first.updatedAt || 0))
  ), [boards]);

  async function createBoard(event) {
    event.preventDefault();

    const title = newTitle.trim();

    if (!title || isCreating) {
      return;
    }

    try {
      setIsCreating(true);
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title }),
      });

      if (!response.ok) {
        throw new Error("Failed to create board");
      }

      const board = await response.json();
      setBoards((currentBoards) => [board, ...currentBoards]);
      setNewTitle("");
      setActionError("");
    } catch (createError) {
      console.error(createError);
      setActionError("Could not create that board.");
    } finally {
      setIsCreating(false);
    }
  }

  if (!isSignedIn) {
    return (
      <section className="boards-page">
        <div className="boards-empty">
          <h1>Boards</h1>
          <p>Sign in to save albums into boards.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="boards-page">
      <div className="boards-header">
        <div>
          <p className="boards-kicker">Your library</p>
          <h1>Boards</h1>
        </div>
        <form className="board-create-form" onSubmit={createBoard}>
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="New board name"
            maxLength={80}
          />
          <button type="submit" disabled={!newTitle.trim() || isCreating}>
            Create
          </button>
        </form>
      </div>

      {actionError && <p className="boards-error">{actionError}</p>}

      <AsyncState
        isLoading={isLoading}
        error={loadError}
        isEmpty={!isLoading && !loadError && sortedBoards.length === 0}
        loadingVariant="grid"
        loadingMessage="Loading boards"
        errorTitle="Boards unavailable"
        emptyTitle="No boards yet"
        emptyBody="Create a board to start grouping albums."
      >
        <div className="boards-grid">
          {sortedBoards.map((board) => (
            <Link className="board-card" key={board.boardId} to={`/boards/${board.boardId}`}>
              <BoardPreview albums={board.previewAlbums || []} />
              <h2>{board.title}</h2>
              <p>
                {board.itemCount} album{board.itemCount === 1 ? "" : "s"} · {board.listenCount || 0} listen{board.listenCount === 1 ? "" : "s"}
                {board.isDefault ? " · Default" : ""}
              </p>
            </Link>
          ))}
        </div>
      </AsyncState>
    </section>
  );
}

export default Boards;
