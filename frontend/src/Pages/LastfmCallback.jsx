import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useNavigate } from "react-router-dom";
import { API_BASE_URL } from "../config/api.js";
import { LASTFM_CONNECTION_PATH, requestLastfmJson } from "../features/lastfm/lastfm.js";

export default function LastfmCallback() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();
  const [callbackValues] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return {
      state: query.get("state") || "",
      token: query.get("token") || "",
    };
  });
  const completionRef = useRef(null);
  const navigatedRef = useRef(false);

  useLayoutEffect(() => {
    // Keep the provider's single-use token and state out of browser history before
    // auth hydration or the async exchange can run. The captured values live in
    // component state, so Strict Mode's render replay cannot lose them.
    if (window.location.search) {
      window.history.replaceState({}, document.title, "/account/lastfm/callback");
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return undefined;

    if (!completionRef.current) {
      const { state, token } = callbackValues;
      if (!isSignedIn) {
        completionRef.current = Promise.resolve("Sign in to Rescened before connecting Last.fm.");
      } else if (!state || !token) {
        completionRef.current = Promise.resolve("Last.fm authorization was incomplete. Try connecting again.");
      } else {
        completionRef.current = (async () => {
          try {
            const authToken = await getToken();
            await requestLastfmJson(
              `${API_BASE_URL}${LASTFM_CONNECTION_PATH}/complete`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${authToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ state, token }),
              },
              "Could not complete Last.fm authorization.",
            );
            return "Last.fm connected. Syncing starts from now.";
          } catch (error) {
            return error.message || "Could not complete Last.fm authorization.";
          }
        })();
      }
    }

    completionRef.current.then((lastfmMessage) => {
      if (navigatedRef.current || window.location.pathname !== "/account/lastfm/callback") return;
      navigatedRef.current = true;
      navigate("/account/edit", { replace: true, state: { lastfmMessage } });
    });
  }, [callbackValues, getToken, isLoaded, isSignedIn, navigate]);

  return <section className="community-page lastfm-callback-page"><div className="community-loading" role="status"><span className="community-loading-mark">L</span><p>Finishing Last.fm connection…</p></div></section>;
}
