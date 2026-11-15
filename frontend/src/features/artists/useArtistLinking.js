import { useEffect, useState } from "react";
import { API_BASE_URL } from "../../config/api";
import { requestCommunityJson } from "../community/community";

// Whether the server has artist linking turned on. Off until the answer
// arrives, and off on any failure, so forms keep their existing behavior.
export function useArtistLinkingEnabled(getToken) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (typeof getToken !== "function") return undefined;
    const controller = new AbortController();
    (async () => {
      try {
        const token = await getToken();
        if (!token || controller.signal.aborted) return;
        const data = await requestCommunityJson(`${API_BASE_URL}/artist-discovery/capabilities`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }, "Could not check artist linking.");
        if (!controller.signal.aborted) setEnabled(data?.enabled === true);
      } catch {
        if (!controller.signal.aborted) setEnabled(false);
      }
    })();
    return () => controller.abort();
  }, [getToken]);
  return enabled;
}
