import { API_BASE_URL } from "../config/api";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import BoardListens from "../Components/BoardListens";
import { getApiErrorMessage } from "../utils/apiErrors";
import AsyncState from "../Components/Loading/AsyncState";
import PickAlbum from "../Components/PickAlbum";
import ShareButton from "../Components/ShareButton";
import { moveItem } from "../features/queue/queue";
import { normalizeDraft, orderLimitOf, rankMap, sameOrder, saveBoardOrder, saveBoardSettings } from "../features/boards/boardOrder";
import "../features/boards/boards.css";

const MAX_DESCRIPTION_LENGTH = 280;
const UNSAVED_ORDER_HINT = "Save or discard your new order first";

function byText(first, second) {
  return String(first || "").localeCompare(String(second || ""), undefined, { sensitivity: "base" });
}

function byYear(first, second, direction) {
  // Albums without a year go last in either direction.
  const a = Number(first.releaseYear) || null;
  const b = Number(second.releaseYear) || null;
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction * (a - b);
}

// A manual board's saved order. It is the default sort there and does not re-sort.
const CUSTOM_SORT = "custom";

const ALBUM_SORTS = {
  recent: { label: "Recently added", compare: (a, b) => new Date(b.savedAt) - new Date(a.savedAt) },
  oldest: { label: "First added", compare: (a, b) => new Date(a.savedAt) - new Date(b.savedAt) },
  newest_release: { label: "Release year, newest", compare: (a, b) => byYear(a, b, -1) },
  oldest_release: { label: "Release year, oldest", compare: (a, b) => byYear(a, b, 1) },
  artist: { label: "Artist A–Z", compare: (a, b) => byText(a.artistDisplayName, b.artistDisplayName) || byText(a.title, b.title) },
  title: { label: "Title A–Z", compare: (a, b) => byText(a.title, b.title) },
  listens: { label: "Most listened", compare: (a, b) => (b.listenCount || 0) - (a.listenCount || 0) },
};

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
  // null follows the board: ranked boards open as a list, others as a grid.
  const [viewMode, setViewMode] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [savingAlbumId, setSavingAlbumId] = useState("");
  const [removingAlbumId, setRemovingAlbumId] = useState("");
  const [albumFilter, setAlbumFilter] = useState("all");
  // null follows the board: Custom order on a manual board, otherwise Recently added.
  const [albumSort, setAlbumSort] = useState(null);
  const [description, setDescription] = useState("");
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [orderDraft, setOrderDraft] = useState({ base: null, order: [] });
  const [dragIndex, setDragIndex] = useState(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [orderStatus, setOrderStatus] = useState("");

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
      setDescription(data.description || "");
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

  const isManual = board?.orderMode === "manual";
  const isRanked = board?.displayStyle === "ranked";
  const orderLimit = orderLimitOf(board);
  const sortKey = albumSort === CUSTOM_SORT && !isManual ? "recent" : (albumSort ?? (isManual ? CUSTOM_SORT : "recent"));
  const effectiveViewMode = viewMode ?? (isRanked ? "list" : "grid");
  const savedOrder = useMemo(() => (board?.albums || []).map((album) => album.albumId), [board?.albums]);
  const albumsById = useMemo(() => new Map((board?.albums || []).map((album) => [album.albumId, album])), [board?.albums]);
  // A new server order (save, removal, reload) replaces the draft.
  const order = orderDraft.base === savedOrder ? orderDraft.order : savedOrder;
  const isOrderDirty = !sameOrder(order, savedOrder);
  const isFiltered = Boolean(query.trim()) || albumFilter !== "all";
  const canArrange = !isPublicBoard && isManual && sortKey === CUSTOM_SORT && !isFiltered;
  const showRanks = isRanked && sortKey === CUSTOM_SORT;
  const showBlockEnd = isManual && sortKey === CUSTOM_SORT && !isFiltered && order.length > orderLimit;
  const ranks = useMemo(() => rankMap(order, orderLimit), [order, orderLimit]);

  const filteredAlbums = useMemo(() => {
    const source = sortKey === CUSTOM_SORT ? order.map((albumId) => albumsById.get(albumId)).filter(Boolean) : board?.albums || [];
    const albums = source.filter((album) => albumFilter === "all" || (albumFilter === "listened" ? album.listenCount > 0 : album.explicitlySaved));
    const normalizedQuery = query.trim().toLowerCase();
    const matching = normalizedQuery
      ? albums.filter((album) => [
        album.title,
        album.artistDisplayName,
        album.releaseYear,
      ].join(" ").toLowerCase().includes(normalizedQuery))
      : albums;
    if (sortKey === CUSTOM_SORT) return matching;
    // Ties fall back to the board's own order (most recently added first).
    const compare = ALBUM_SORTS[sortKey]?.compare || ALBUM_SORTS.recent.compare;
    return [...matching].sort((a, b) => compare(a, b) || ALBUM_SORTS.recent.compare(a, b));
  }, [albumFilter, albumsById, board, order, query, sortKey]);

  function updateOrder(next, movedAlbumId) {
    const normalized = normalizeDraft(next, albumsById, orderLimit);
    setOrderDraft({ base: savedOrder, order: normalized });
    if (movedAlbumId) {
      const position = normalized.indexOf(movedAlbumId) + 1;
      const album = albumsById.get(movedAlbumId);
      setOrderStatus(position > orderLimit
        ? `${album?.title || "Album"} is now after your custom order.`
        : `${album?.title || "Album"} moved to position ${position}.`);
    }
  }

  function moveAlbum(index, targetIndex) {
    if (targetIndex < 0 || targetIndex >= order.length) return;
    updateOrder(moveItem(order, index, targetIndex), order[index]);
  }

  function handleDrop(event, targetIndex) {
    event.preventDefault();
    if (dragIndex !== null) moveAlbum(dragIndex, targetIndex);
    setDragIndex(null);
  }

  function discardOrder() {
    setOrderDraft({ base: savedOrder, order: savedOrder });
    setOrderStatus("");
  }

  // A board past the limit saves only its ordered block; the rest follow by date.
  async function saveOrder() {
    if (!board || !isOrderDirty || isSavingOrder) return;
    setIsSavingOrder(true);
    setActionError("");
    try {
      const updatedBoard = await saveBoardOrder(getToken, board, order.slice(0, orderLimit));
      if (scopeRef.current !== scope) return;
      setBoard(updatedBoard);
      setOrderStatus("Order saved.");
    } catch (orderError) {
      if (scopeRef.current !== scope) return;
      if (orderError.code === "BOARD_CHANGED") {
        setOrderStatus("");
        await fetchBoard(true);
        setActionError("This board changed somewhere else, so its latest order is shown. Your unsaved order was discarded.");
      } else {
        setActionError(orderError.message || "Could not save the new order.");
      }
    } finally {
      setIsSavingOrder(false);
    }
  }

  async function updateOrderSettings(settings) {
    if (!board || isSavingSettings || isOrderDirty) return;
    setIsSavingSettings(true);
    setActionError("");
    try {
      await saveBoardSettings(getToken, board, settings);
      if (scopeRef.current !== scope) return;
      setAlbumSort(null);
      setViewMode(null);
      setOrderStatus("");
      await fetchBoard(true);
    } catch (settingsError) {
      if (scopeRef.current === scope) setActionError(settingsError.message || "Could not update how this board is ordered.");
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function saveDescription(event) {
    event.preventDefault();
    const nextDescription = description.trim();
    if (!board || nextDescription === (board.description || "") || isSavingDescription) return;
    try {
      setIsSavingDescription(true);
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ description: nextDescription }),
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not save the description."));
      const updatedBoard = await response.json();
      if (scopeRef.current !== scope) return;
      // The summary carries the board's new revision, which the next reorder needs.
      setBoard((currentBoard) => ({ ...currentBoard, ...updatedBoard }));
      setDescription(updatedBoard.description || "");
    } catch (descriptionError) {
      setActionError(descriptionError.message || "Could not save the description.");
    } finally {
      setIsSavingDescription(false);
    }
  }

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
    if (!board || isPublicBoard || removingAlbumId || savingAlbumId || isOrderDirty) {
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
      // The removal moved the board's revision; a later reorder needs the new one.
      if (board.orderMode === "manual") await fetchBoard(true);
    } catch (removeError) {
      console.error(removeError);
      setActionError(removeError.message || "Could not remove that album.");
    } finally {
      setRemovingAlbumId("");
    }
  }

  async function keepAlbumSaved(albumId) {
    if (isPublicBoard || !isSignedIn || savingAlbumId || removingAlbumId || isOrderDirty) return;
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
        {(!isPublicBoard || count > 0) && <button type="button" disabled={Boolean(removingAlbumId || savingAlbumId || (!isPublicBoard && isOrderDirty))} title={!isPublicBoard && isOrderDirty ? UNSAVED_ORDER_HINT : undefined} onClick={() => setSelectedAlbum(album)}>{isPublicBoard ? "View listening dates" : "Manage listens"}</button>}
        {!isPublicBoard && !album.explicitlySaved && <button type="button" disabled={Boolean(savingAlbumId || removingAlbumId || isOrderDirty)} title={isOrderDirty ? UNSAVED_ORDER_HINT : undefined} onClick={() => keepAlbumSaved(album.albumId)}>{savingAlbumId === album.albumId ? "Saving…" : "Keep album saved"}</button>}
      </div>
    );
  }

  function renderRank(album) {
    const rank = showRanks ? ranks.get(album.albumId) : null;
    return rank ? <span className="board-rank" aria-label={`Number ${rank}`}>{rank}</span> : null;
  }

  // Arrow buttons move one place; in the grid "earlier" is left and up.
  function renderArrangeControls(album, index, isGrid) {
    if (!canArrange) return null;
    const label = album.title || "album";
    return (
      <span className="board-arrange-controls">
        <span className="board-arrange-handle" aria-hidden="true">⋮⋮</span>
        <button type="button" onClick={() => moveAlbum(index, index - 1)} disabled={isSavingOrder || index === 0} aria-label={`Move ${label} ${isGrid ? "earlier" : "up"}`}>{isGrid ? "←" : "↑"}</button>
        <button type="button" onClick={() => moveAlbum(index, index + 1)} disabled={isSavingOrder || index === order.length - 1} aria-label={`Move ${label} ${isGrid ? "later" : "down"}`}>{isGrid ? "→" : "↓"}</button>
      </span>
    );
  }

  function arrangeProps(index) {
    if (!canArrange) return {};
    return {
      draggable: !isSavingOrder,
      onDragStart: (event) => { setDragIndex(index); event.dataTransfer.effectAllowed = "move"; },
      onDragOver: (event) => event.preventDefault(),
      onDrop: (event) => handleDrop(event, index),
      onDragEnd: () => setDragIndex(null),
    };
  }

  function itemClassName(base, index) {
    return [base, canArrange && "is-arrangeable", dragIndex === index && "is-dragging"].filter(Boolean).join(" ");
  }

  function renderBlockEnd(index) {
    if (!showBlockEnd || index !== orderLimit - 1) return null;
    return (
      <p className="board-order-block-end" role="note">
        {isPublicBoard
          ? `Albums after the first ${orderLimit} are listed by date added.`
          : `Your custom order covers the first ${orderLimit} albums. Albums below follow by date added; move one above this line to add it to the order.`}
      </p>
    );
  }

  function renderRemoveButton(album) {
    if (isPublicBoard) return null;
    return (
      <button className="board-remove-album" type="button" disabled={Boolean(removingAlbumId || savingAlbumId || isOrderDirty)} title={isOrderDirty ? UNSAVED_ORDER_HINT : undefined} onClick={() => removeAlbum(album.albumId)}>
        {removingAlbumId === album.albumId ? "Removing…" : "Remove album"}
      </button>
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
        {isPublicBoard ? (
          board.description && <p className="board-description">{board.description}</p>
        ) : (
          <form className="board-description-form" onSubmit={saveDescription}>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={MAX_DESCRIPTION_LENGTH}
              rows={2}
              placeholder="Add a description"
              aria-label="Board description"
            />
            <div>
              <small>{description.length}/{MAX_DESCRIPTION_LENGTH}</small>
              <button type="submit" disabled={description.trim() === (board.description || "") || isSavingDescription}>
                {isSavingDescription ? "Saving…" : "Save description"}
              </button>
            </div>
          </form>
        )}
        <p>
          {board.isDefault ? "Default board" : "Board"} · {board.itemCount} album{board.itemCount === 1 ? "" : "s"} · {board.listenCount || 0} listen{board.listenCount === 1 ? "" : "s"}
          {isRanked ? " · Ranked list" : isManual ? " · Custom order" : ""}
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
          <select aria-label="Sort board albums" value={sortKey} onChange={(event) => setAlbumSort(event.target.value)}>
            {isManual && <option value={CUSTOM_SORT}>Custom order</option>}
            {Object.entries(ALBUM_SORTS).map(([value, sort]) => <option key={value} value={value}>{sort.label}</option>)}
          </select>
          <div className="profile-view-toggle" aria-label="Board view">
            <button
              className={effectiveViewMode === "grid" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setViewMode("grid")}
            >
              Grid
            </button>
            <button
              className={effectiveViewMode === "list" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setViewMode("list")}
            >
              List
            </button>
          </div>
          <ShareButton
            className="board-share-button"
            path={`/profile/${encodeURIComponent(board.userId || userId)}/boards/${board.boardId}`}
            title={`${board.title} on Rescened`}
            hint={isPublicBoard ? "" : "Others can open this link while your profile is public."}
          />
          {!isPublicBoard && !board.isDefault && (
            <button className="board-danger-button" type="button" onClick={deleteBoard}>
              Delete
            </button>
          )}
        </div>
      </div>

      {!isPublicBoard && (
        <div className="board-order-settings">
          <label>
            <span>Order</span>
            <select
              value={isManual ? "manual" : "added"}
              disabled={isSavingSettings || isOrderDirty}
              onChange={(event) => updateOrderSettings({ orderMode: event.target.value })}
            >
              <option value="added">Date added</option>
              <option value="manual" disabled={!isManual && board.itemCount > orderLimit}>Custom order</option>
            </select>
          </label>
          <label className="board-ranked-toggle">
            <input
              type="checkbox"
              checked={isRanked}
              disabled={isSavingSettings || isOrderDirty || (!isManual && board.itemCount > orderLimit)}
              onChange={(event) => updateOrderSettings(event.target.checked ? { orderMode: "manual", displayStyle: "ranked" } : { displayStyle: "grid" })}
            />
            <span>Show as a ranked list</span>
          </label>
          {!isManual && board.itemCount > orderLimit && <small>Custom order works on boards of up to {orderLimit} albums.</small>}
          {isManual && sortKey !== CUSTOM_SORT && <small>Choose Custom order in the sort menu to rearrange albums.</small>}
          {isManual && sortKey === CUSTOM_SORT && isFiltered && <small>Clear the search and filter to rearrange albums.</small>}
          {canArrange && order.length > 1 && <small>Drag albums or use the arrows to rearrange them, then save. New albums go to the bottom.</small>}
          {isSavingSettings && <small>Updating…</small>}
        </div>
      )}
      {!isPublicBoard && board.explicitSaveCount > 0 && <PickAlbum key={board.boardId} boardId={board.boardId} />}
      {!isPublicBoard && <p className="board-listening-help">Removing an album clears its saves and listening dates from this board. Your diary entries stay intact.</p>}
      {actionError && <p role="alert" className="boards-error">{actionError}</p>}

      {filteredAlbums.length === 0 ? (
        <div className="boards-empty">
          <h2>{board.albums?.length ? "No matching albums" : "No albums here yet"}</h2>
          <p>{board.albums?.length ? "Try another search or filter." : "Save albums or add listens from an album’s Boards button to build this board."}</p>
        </div>
      ) : effectiveViewMode === "grid" ? (
        <div className={showRanks ? "board-album-grid is-ranked" : "board-album-grid"}>
          {filteredAlbums.map((album, index) => (
            <Fragment key={album.albumId}>
              <article className={itemClassName("board-album-card", index)} {...arrangeProps(index)}>
                <Link to={`/album/${album.albumId}`} draggable={false}>
                  {album.cover ? <img src={album.cover} alt={`${album.title} cover`} draggable={false} /> : <span>No cover</span>}
                  <h2>{album.title || "Untitled album"}</h2>
                  <p>{getArtistName(album)}</p>
                </Link>
                {renderRank(album)}
                {renderArrangeControls(album, index, true)}
                {renderListeningSummary(album)}
                {renderRemoveButton(album)}
              </article>
              {renderBlockEnd(index)}
            </Fragment>
          ))}
        </div>
      ) : (
        <div className={showRanks ? "board-album-list is-ranked" : "board-album-list"}>
          {filteredAlbums.map((album, index) => (
            <Fragment key={album.albumId}>
              <article className={itemClassName("board-album-row", index)} {...arrangeProps(index)}>
                {renderRank(album)}
                <Link to={`/album/${album.albumId}`} draggable={false}>
                  {album.cover ? <img src={album.cover} alt={`${album.title} cover`} draggable={false} /> : <span>No cover</span>}
                  <strong>{album.title || "Untitled album"}</strong>
                  <em>{getArtistName(album)}</em>
                </Link>
                {renderArrangeControls(album, index, false)}
                {renderListeningSummary(album)}
                {renderRemoveButton(album)}
              </article>
              {renderBlockEnd(index)}
            </Fragment>
          ))}
        </div>
      )}
      {!isPublicBoard && <p className="board-order-status" role="status" aria-live="polite">{orderStatus}</p>}
      {!isPublicBoard && isOrderDirty && (
        <div className="board-order-bar" role="region" aria-label="Unsaved order">
          <span>You changed the order of this board.</span>
          <button type="button" onClick={discardOrder} disabled={isSavingOrder}>Discard</button>
          <button type="button" className="is-primary" onClick={saveOrder} disabled={isSavingOrder}>{isSavingOrder ? "Saving…" : "Save order"}</button>
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
