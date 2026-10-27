import { API_BASE_URL } from "../config/api";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { RedirectToSignIn, useAuth } from "@clerk/react";
import AsyncState from "../Components/Loading/AsyncState";

const tabs = [
  { id: "followers", label: "Followers" },
  { id: "following", label: "Following" },
];

function ProfileAvatar({ user }) {
  const displayName = user.username || user.userId || "rescened user";

  if (user.imageUrl) {
    return <img className="profile-network-avatar" src={user.imageUrl} alt={`${displayName} avatar`} />;
  }

  return (
    <div className="profile-network-avatar profile-avatar-fallback">
      {displayName.charAt(0).toUpperCase()}
    </div>
  );
}

export function ProfileNetwork() {
  const { userId } = useParams();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { getToken, isLoaded, isSignedIn, userId: viewerId } = useAuth();
  const requestedTab = searchParams.get("tab") || location.state?.activeTab || "followers";
  const [activeTab, setActiveTab] = useState(
    tabs.some((tab) => tab.id === requestedTab) ? requestedTab : "followers",
  );
  const [network, setNetwork] = useState({
    userId: userId || "",
    followers: [],
    following: [],
    followerCount: 0,
    followingCount: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const isOwnNetwork = !userId;
  const displayName = location.state?.profileUser?.username || (isOwnNetwork ? "Your network" : "Network");

  useEffect(() => {
    const nextTab = tabs.some((tab) => tab.id === requestedTab) ? requestedTab : "followers";
    setActiveTab(nextTab);
  }, [requestedTab]);

  useEffect(() => {
    // Wait for Clerk so the network is fetched once, with the right token.
    if (!isLoaded) return undefined;
    let isCurrent = true;

    async function fetchNetwork() {
      if (isOwnNetwork && !isSignedIn) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError("");

        const token = isSignedIn ? await getToken() : null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const networkUrl = isOwnNetwork
          ? `${API_BASE_URL}/profile/me/social`
          : `${API_BASE_URL}/profile/${encodeURIComponent(userId)}/network`;
        const response = await fetch(networkUrl, { headers });

        if (!response.ok) {
          throw new Error("Failed to load network");
        }

        const data = await response.json();

        if (!isCurrent) {
          return;
        }

        setNetwork({
          userId: data.userId || userId || viewerId || "",
          followers: Array.isArray(data.followers) ? data.followers : [],
          following: Array.isArray(data.following) ? data.following : [],
          followerCount: Number(data.followerCount) || 0,
          followingCount: Number(data.followingCount) || 0,
        });
      } catch (networkError) {
        console.error(networkError);

        if (isCurrent) {
          setError("Could not load this network right now.");
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    fetchNetwork();

    return () => {
      isCurrent = false;
    };
  }, [getToken, isLoaded, isOwnNetwork, isSignedIn, userId, viewerId]);

  const activeUsers = activeTab === "followers" ? network.followers : network.following;
  const counts = useMemo(() => ({
    followers: network.followerCount,
    following: network.followingCount,
  }), [network.followerCount, network.followingCount]);

  function selectTab(tabId) {
    setActiveTab(tabId);
    setSearchParams({ tab: tabId });
  }

  if (isOwnNetwork && isLoaded && !isSignedIn) {
    return <RedirectToSignIn />;
  }

  return (
    <main className="profile-network-page">
      <header className="profile-network-header">
        <Link className="board-back-link" to={isOwnNetwork ? "/account" : `/profile/${network.userId || userId}`}>
          Profile
        </Link>
        <h1>{displayName}</h1>
      </header>

      <nav className="profile-tabs profile-network-tabs" aria-label="Profile network">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab.id ? "profile-tab profile-tab-active" : "profile-tab"}
            key={tab.id}
            type="button"
            onClick={() => selectTab(tab.id)}
          >
            {tab.label} {counts[tab.id]}
          </button>
        ))}
      </nav>

      <section className="profile-tab-panel">
        <AsyncState
          isLoading={isLoading}
          error={error}
          isEmpty={!isLoading && !error && activeUsers.length === 0}
          loadingVariant="profile"
          loadingMessage="Loading listeners"
          errorTitle="Network unavailable"
          emptyTitle={activeTab === "followers" ? "No followers yet" : "Not following anyone yet"}
          emptyBody={activeTab === "followers"
            ? "Followers will show up here once listeners connect."
            : "Following will show up here once this listener follows someone."}
        >
          <div className="profile-network-list">
            {activeUsers.map((networkUser) => (
              <Link
                className="profile-network-row"
                key={networkUser.userId}
                to={`/profile/${encodeURIComponent(networkUser.userId)}`}
                state={{ profileUser: networkUser }}
              >
                <ProfileAvatar user={networkUser} />
                <div>
                  <h2>{networkUser.username || "rescened user"}</h2>
                </div>
              </Link>
            ))}
          </div>
        </AsyncState>
      </section>
    </main>
  );
}

export default ProfileNetwork;
