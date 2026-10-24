import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../../config/api";
import { getApiErrorMessage } from "../../utils/apiErrors";

export const QUEUE_LIMIT = 15;
export const EMPTY_QUEUE = { albums: [], count: 0, limit: QUEUE_LIMIT, revision: 0 };

export function normalizeQueue(data) {
  const albums = Array.isArray(data?.albums) ? data.albums.filter((album) => album?.albumId) : [];
  return {
    albums,
    count: Number.isFinite(data?.count) ? data.count : albums.length,
    limit: Number(data?.limit) || QUEUE_LIMIT,
    revision: Number(data?.revision) || 0,
  };
}

export function moveItem(list, from, to) {
  if (from === to || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

async function failure(response, fallback) {
  const data = await response.clone().json().catch(() => ({}));
  const error = new Error(await getApiErrorMessage(response, fallback));
  error.status = response.status;
  error.code = data.code || "";
  return error;
}

// Signed-in calls against the viewer's own queue: GET, POST, PUT, or DELETE /profile/me/queue.
export async function queueRequest(getToken, { method = "GET", path = "", body } = {}) {
  const token = await getToken();
  const response = await fetch(`${API_BASE_URL}/profile/me/queue${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw await failure(response, method === "GET" ? "Your queue is unavailable right now." : "Could not update your queue.");
  return normalizeQueue(await response.json());
}

export async function fetchProfileQueue(userId, token, signal) {
  const response = await fetch(`${API_BASE_URL}/profile/${encodeURIComponent(userId)}/queue`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!response.ok) throw await failure(response, "This queue is unavailable right now.");
  return normalizeQueue(await response.json());
}

// The viewer's own queue. refreshKey reloads it, e.g. after a listen was logged
// (logging removes the album server-side). A QUEUE_CHANGED conflict reloads the
// queue once so the next action starts from the current order; writes are never retried.
export function useListenQueue({ enabled = true, refreshKey = 0 } = {}) {
  const { getToken, isSignedIn } = useAuth();
  const active = Boolean(enabled && isSignedIn);
  const [queue, setQueue] = useState(EMPTY_QUEUE);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let isCurrent = true;
    async function load() {
      setStatus("loading");
      try {
        const data = await queueRequest(getToken);
        if (!isCurrent) return;
        setQueue(data);
        setStatus("ready");
      } catch (error) {
        if (!isCurrent) return;
        setStatus("error");
        setMessage(error.message);
      }
    }
    void load();
    return () => { isCurrent = false; };
  }, [active, getToken, refreshKey, reloadKey]);

  const mutate = useCallback(async (request, success) => {
    setIsSaving(true);
    setMessage("");
    try {
      setQueue(await request());
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(error.message);
      if (error.code === "QUEUE_CHANGED") setReloadKey((key) => key + 1);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, []);

  // Without a position, a new album goes to the bottom and a queued one stays put.
  const add = useCallback((albumId, position) => mutate(
    () => queueRequest(getToken, { method: "POST", body: position ? { albumId, position } : { albumId } }),
    position === "top" ? "Now first in your queue." : "Added to your queue.",
  ), [getToken, mutate]);
  const remove = useCallback((albumId) => mutate(
    () => queueRequest(getToken, { method: "DELETE", path: `/${encodeURIComponent(albumId)}` }),
    "Removed from your queue.",
  ), [getToken, mutate]);
  const reorder = useCallback((albumIds) => mutate(
    () => queueRequest(getToken, { method: "PUT", body: { albumIds, revision: queue.revision } }),
    "Queue order saved.",
  ), [getToken, mutate, queue.revision]);

  return {
    queue: active ? queue : EMPTY_QUEUE,
    status: active ? status : "idle",
    message,
    isSaving,
    add,
    remove,
    reorder,
  };
}
