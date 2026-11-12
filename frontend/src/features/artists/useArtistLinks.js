import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { API_BASE_URL } from "../../config/api";
import { createArtistLinkStore } from "./artistLinkStore";
import { creditArtistIds } from "./artists";

const LINK_REQUEST_TIMEOUT_MS = 10_000;

async function loadArtistLinks(ids) {
  // Bounded, so a hung request cannot hold its credits in flight forever.
  const response = await fetch(`${API_BASE_URL}/artists/links?ids=${ids.join(",")}`, { signal: AbortSignal.timeout(LINK_REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error(body?.error || "Artist links are unavailable");
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  const body = await response.json();
  return Array.isArray(body?.artistIds) ? body.artistIds : [];
}

// One store per page load, shared by every credit on screen.
export const artistLinkStore = createArtistLinkStore({ load: loadArtistLinks });
const store = artistLinkStore;

// Returns isLinked(artistId) for the credits of `albums` (one album or a list).
// An album response that carries artistPages.artistIds (album detail) is
// already authoritative and is used as is. For every other album, the credited
// artistIds are checked with the API; nothing links until it confirms them.
export function useArtistLinks(albums) {
  const list = useMemo(() => (Array.isArray(albums) ? albums : [albums]).filter(Boolean), [albums]);
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const provided = useMemo(
    () => new Set(list.flatMap((album) => (Array.isArray(album.artistPages?.artistIds) ? album.artistPages.artistIds : []))),
    [list],
  );
  const pendingKey = creditArtistIds(list.filter((album) => !Array.isArray(album.artistPages?.artistIds))).join(",");
  const providedKey = [...provided].join(",");

  useEffect(() => {
    if (providedKey) store.confirm(providedKey.split(","));
  }, [providedKey]);
  useEffect(() => {
    if (pendingKey) store.request(pendingKey.split(","));
  }, [pendingKey]);

  // A new function whenever the store learns something, so memoized consumers update too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((artistId) => provided.has(artistId) || store.isLinked(artistId), [provided, version]);
}
