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
import { earlierOrderTarget, normalizeDraft, orderLimitOf, rankMap, sameOrder, saveBoardOrder, saveBoardSettings } from "../features/boards/boardOrder";
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
  const mutationRef = useRef(false);
  const metadataRef = useRef(null);
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
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
      setIsRefreshing(false);
      requestRef.current = null;
      return false;
    }

    if (refresh) setIsRefreshing(true);
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
      const previousMetadata = metadataRef.current;
      const nextTitle = data.title || "";
      const nextDescription = data.description || "";
      // Refresh the order without erasing independently edited form fields.
      setTitle((current) => !refresh || current === previousMetadata?.title ? nextTitle : current);
      setDescription((current) => !refresh || current === previousMetadata?.description ? nextDescription : current);
      metadataRef.current = { title: nextTitle, description: nextDescription };
      setLoadError("");
      setNeedsRefresh(false);
      return true;
    } catch (boardError) {
      if (controller.signal.aborted || scopeRef.current !== scope) return;
      if (refresh) {
        setNeedsRefresh(true);
        setActionError("Could not refresh this board. Refresh it before making another change.");
      } else {
        setBoard(null);
        setLoadError(boardError.message || "Could not load this board.");
      }
      return false;
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsRefreshing(false);
        if (scopeRef.current === scope) setIsLoading(false);
      }
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
  // Hold the album snapshot and its revision steady while any write or refresh
  // is pending, including listen edits made in the modal.
  const isBoardBusy = Boolean(isSavingOrder || isSavingSettings || isSavingTitle || isSavingDescription
    || isDeleting || removingAlbumId || savingAlbumId || isRefreshing || needsRefresh || selectedAlbum);
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

  // The ref also guards repeated actions before React has rendered busy state.
  function beginMutation() {
    if (isBoardBusy || mutationRef.current || requestRef.current) return false;
    mutationRef.current = true;
    return true;
  }

  async function retryRefresh() {
    const refreshed = await fetchBoard(true);
    if (scopeRef.current !== scope || !refreshed) return;
    setActionError("");
    setOrderStatus(isOrderDirty ? "Latest board loaded. Your unsaved order was discarded." : "Board refreshed.");
  }

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
    if (!canArrange || isBoardBusy || mutationRef.current || requestRef.current
      || targetIndex < 0 || targetIndex >= order.length) return;
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
    if (!board || !isOrderDirty || !beginMutation()) return;
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
        const refreshed = await fetchBoard(true);
        if (scopeRef.current !== scope) return;
        setActionError(refreshed
          ? "This board changed somewhere else, so its latest order is shown. Your unsaved order was discarded."
          : "This board changed somewhere else, but its latest order could not load. Your unsaved order is still shown. Refresh the board before trying again.");
      } else {
        setActionError(orderError.message || "Could not save the new order.");
      }
    } finally {
      mutationRef.current = false;
      setIsSavingOrder(false);
    }
  }

  async function updateOrderSettings(settings) {
    if (!board || isOrderDirty || !beginMutation()) return;
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
      mutationRef.current = false;
      setIsSavingSettings(false);
    }
  }

  async function saveDescription(event) {
    event.preventDefault();
    const nextDescription = description.trim();
    if (!board || nextDescription === (board.description || "") || isOrderDirty || !beginMutation()) return;
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
      const summary = await response.json();
      if (scopeRef.current !== scope) return;
      setDescription((current) => current === description ? summary.description || "" : current);
      // PATCH returns a summary only. Fetch albums and revision together so a
      // metadata save cannot authorize a reorder drawn from an older snapshot.
      await fetchBoard(true);
    } catch (descriptionError) {
      if (scopeRef.current === scope) setActionError(descriptionError.message || "Could not save the description.");
    } finally {
      mutationRef.current = false;
      setIsSavingDescription(false);
    }
  }

  async function renameBoard(event) {
    event.preventDefault();

    const nextTitle = title.trim();

    if (!nextTitle || !board || nextTitle === board.title || isOrderDirty || !beginMutation()) {
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

      const summary = await response.json();
      if (scopeRef.current !== scope) return;
      setTitle((current) => current === title ? summary.title : current);
      await fetchBoard(true);
    } catch (renameError) {
      console.error(renameError);
      if (scopeRef.current === scope) setActionError("Could not rename this board.");
    } finally {
      mutationRef.current = false;
      setIsSavingTitle(false);
    }
  }

  async function deleteBoard() {
    if (!board || board.isDefault || isOrderDirty || !beginMutation()) {
      return;
    }

    try {
      setIsDeleting(true);
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

      if (scopeRef.current === scope) navigate("/boards");
    } catch (deleteError) {
      console.error(deleteError);
      if (scopeRef.current === scope) setActionError("Could not delete this board.");
    } finally {
      mutationRef.current = false;
      setIsDeleting(false);
    }
  }

  async function removeAlbum(albumId) {
    if (!board || isPublicBoard || isOrderDirty || !beginMutation()) {
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
      // Refresh the complete snapshot before any later reorder, even when the
      // board was in date order when this removal began.
      await fetchBoard(true);
    } catch (removeError) {
      console.error(removeError);
      if (scopeRef.current === scope) setActionError(removeError.message || "Could not remove that album.");
    } finally {
      mutationRef.current = false;
      setRemovingAlbumId("");
    }
  }

  async function keepAlbumSaved(albumId) {
    if (!board || isPublicBoard || !isSignedIn || isOrderDirty || !beginMutation()) return;
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
      mutationRef.current = false;
      setSavingAlbumId("");
    }
  }

  function renderListeningSummary(album) {
    const count = album.listenCount || 0;
    return (
      <div className="board-album-listening">
        <p className="board-album-membership">{album.explicitlySaved ? "Saved album" : "Added through listens"}</p>
        <p>{count} listen{count === 1 ? "" : "s"}{album.latestListenedOn && <> · Latest <time dateTime={album.latestListenedOn}>{album.latestListenedOn}</time></>}</p>
        {(!isPublicBoard || count > 0) && <button type="button" disabled={isBoardBusy || (!isPublicBoard && isOrderDirty)} title={!isPublicBoard && isOrderDirty ? UNSAVED_ORDER_HINT : undefined} onClick={() => setSelectedAlbum(album)}>{isPublicBoard ? "View listening dates" : "Manage listens"}</button>}
        {!isPublicBoard && !album.explicitlySaved && <button type="button" disabled={isBoardBusy || isOrderDirty} title={isOrderDirty ? UNSAVED_ORDER_HINT : undefined} onClick={() => keepAlbumSaved(album.albumId)}>{savingAlbumId === album.albumId ? "Saving…" : "Keep album saved"}</button>}
      </div>
    );
  }

  function renderRank(album) {
    const rank = showRanks ? ranks.get(album.albumId) : null;
    return rank ? <span className="board-rank" aria-label={`Number ${rank}`}>{rank}</span> : null;
  }

  // Overflow albums enter the last custom position directly; the remaining
  // overflow stays in date order. Inside the block arrows move one place.
  function renderArrangeControls(album, index, isGrid) {
    if (!canArrange) return null;
    const label = album.title || "album";
    const isOverflow = index >= orderLimit;
    return (
      <span className="board-arrange-controls">
        <span className="board-arrange-handle" aria-hidden="true">⋮⋮</span>
        <button type="button" onClick={() => moveAlbum(index, earlierOrderTarget(index, orderLimit))} disabled={isBoardBusy || index === 0} aria-label={isOverflow ? `Move ${label} into custom order` : `Move ${label} ${isGrid ? "earlier" : "up"}`} title={isOverflow ? `Move to position ${orderLimit}` : undefined}>{isGrid ? "←" : "↑"}</button>
        <button type="button" onClick={() => moveAlbum(index, index + 1)} disabled={isBoardBusy || isOverflow || index === order.length - 1} aria-label={`Move ${label} ${isGrid ? "later" : "down"}`}>{isGrid ? "→" : "↓"}</button>
      </span>
    );
  }

  function arrangeProps(index) {
    if (!canArrange) return {};
    return {
      draggable: !isBoardBusy,
      onDragStart: (event) => {
        if (isBoardBusy || mutationRef.current || requestRef.current) { event.preventDefault(); return; }
        setDragIndex(index);
        event.dataTransfer.effectAllowed = "move";
      },
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
      <button className="board-remove-album" type="button" disabled={isBoardBusy || isOrderDirty} title={isOrderDirty ? UNSAVED_ORDER_HINT : undefined} onClick={() => removeAlbum(album.albumId)}>
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
            <button type="submit" disabled={!title.trim() || title.trim() === board.title || isBoardBusy || isOrderDirty} title={isOrderDirty ? UNSAVED_ORDER_HINT : undefined}>
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
              <button type="submit" disabled={description.trim() === (board.description || "") || isBoardBusy || isOrderDirty} title={isOrderDirty ? UNSAVED_ORDER_HINT : undefined}>
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
            <button className="board-danger-button" type="button" disabled={isBoardBusy || isOrderDirty} onClick={deleteBoard}>
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
              disabled={isBoardBusy || isOrderDirty}
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
              disabled={isBoardBusy || isOrderDirty || (!isManual && board.itemCount > orderLimit)}
              onChange={(event) => updateOrderSettings(event.target.checked ? { orderMode: "manual", displayStyle: "ranked" } : { displayStyle: "grid" })}
            />
            <span>Show as a ranked list</span>
          </label>
          {!isManual && board.itemCount > orderLimit && <small>Custom order works on boards of up to {orderLimit} albums.</small>}
          {isManual && sortKey !== CUSTOM_SORT && <small>Choose Custom order in the sort menu to rearrange albums.</small>}
          {isManual && sortKey === CUSTOM_SORT && isFiltered && <small>Clear the search and filter to rearrange albums.</small>}
          {canArrange && order.length > 1 && <small>Drag albums or use the arrows to rearrange them, then save. New albums go to the bottom.</small>}
          {(isSavingSettings || isRefreshing) && <small>Updating…</small>}
        </div>
      )}
      {!isPublicBoard && board.explicitSaveCount > 0 && <PickAlbum key={board.boardId} boardId={board.boardId} />}
      {!isPublicBoard && <p className="board-listening-help">Removing an album clears its saves and listening dates from this board. Your diary entries stay intact.</p>}
      {actionError && <p role="alert" className="boards-error">{actionError}</p>}
      {needsRefresh && <button type="button" disabled={isRefreshing || isSavingOrder} onClick={retryRefresh}>
        {isRefreshing ? "Refreshing…" : "Refresh board"}
      </button>}

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
          <button type="button" onClick={discardOrder} disabled={isSavingOrder || isRefreshing}>Discard</button>
          <button type="button" className="is-primary" onClick={saveOrder} disabled={isBoardBusy}>{isSavingOrder ? "Saving…" : "Save order"}</button>
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
