import { useEffect, useState } from "react";
import { API_BASE_URL } from "../../config/api";
import { requestCommunityJson } from "../community/community";

// Whether the server has artist linking turned on: "loading" until the
// answer arrives, then "enabled" or "disabled", or "unavailable" when the
// check failed. Only "disabled" is a confirmed answer that links are off;
// forms must not treat loading or a failed check as off, or they would
// silently drop a revision's stored links.
export function useArtistLinkingState(getToken) {
  const [state, setState] = useState(typeof getToken === "function" ? "loading" : "unavailable");
  useEffect(() => {
    if (typeof getToken !== "function") return undefined;
    const controller = new AbortController();
    (async () => {
      try {
        const token = await getToken();
        if (controller.signal.aborted) return;
        if (!token) {
          setState("unavailable");
          return;
        }
        const data = await requestCommunityJson(`${API_BASE_URL}/artist-discovery/capabilities`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }, "Could not check artist linking.");
        if (!controller.signal.aborted) setState(data?.enabled === true ? "enabled" : "disabled");
      } catch {
        if (!controller.signal.aborted) setState("unavailable");
      }
    })();
    return () => controller.abort();
  }, [getToken]);
  return state;
}
