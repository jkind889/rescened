import { API_BASE_URL } from "../config/api";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  RedirectToSignIn,
  SignInButton,
  UserProfile,
  useAuth,
  useUser,
} from "@clerk/react";
import LikeButton from "../Components/LikeButton";
import ProfileReviewCard from "../Components/ProfileReviewCard";
import AsyncState from "../Components/Loading/AsyncState";
import { getApiErrorMessage } from "../utils/apiErrors";

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "saved", label: "Saved Albums" },
  { id: "reviews", label: "Reviews" },
  { id: "activity", label: "Activity" },
  { id: "boards", label: "Boards" },
  { id: "network", label: "Network" },
  { id: "settings", label: "Settings" },
];

const REVIEW_PREVIEW_LIMIT = 2;

function formatDate(value) {
  if (!value) {
    return "Date unavailable";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date unavailable";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMonthYear(value) {
  if (!value) {
    return "Month unavailable";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Month unavailable";
  }

  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

function getArtistName(album) {
  return album.artistDisplayName || "Artist unknown";
}

function ProfileEmptyState({ title, body }) {
  return (
    <div className="profile-empty-state">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function AlbumCover({ src, title }) {
  if (!src) {
    return <div className="profile-cover-fallback">No cover</div>;
  }

  return <img className="profile-cover" src={src} alt={`${title} cover`} />;
}

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

export function Account() {
  const { getToken, isSignedIn } = useAuth();
  const { user, isLoaded } = useUser();
  const { userId: publicUserId } = useParams();
  const location = useLocation();
  const isPublicProfile = Boolean(publicUserId);
  const requestedTab = location.state?.activeTab;
  const [activeTab, setActiveTab] = useState(requestedTab || "overview");
  const [savedViewMode, setSavedViewMode] = useState("grid");
  const [savedAlbums, setSavedAlbums] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [recentReviewPreviews, setRecentReviewPreviews] = useState([]);
  const [recentPreviewHasMore, setRecentPreviewHasMore] = useState(false);
  const [popularReviewPreviews, setPopularReviewPreviews] = useState([]);
  const [nextReviewCursor, setNextReviewCursor] = useState(null);
  const [reviewSort, setReviewSort] = useState("recent");
  const [isLoadingMoreReviews, setIsLoadingMoreReviews] = useState(false);
  const [deletingReviewId, setDeletingReviewId] = useState("");
  const [deleteErrors, setDeleteErrors] = useState({});
  const [activityItems, setActivityItems] = useState([]);
  const [networkItems, setNetworkItems] = useState([]);
  const [boards, setBoards] = useState([]);
  const [newBoardTitle, setNewBoardTitle] = useState("");
  const [isCreatingBoard, setIsCreatingBoard] = useState(false);
  const [profile, setProfile] = useState({
    userId: "",
    username: "",
    imageUrl: "",
    bio: "",
    spotifyProfileUrl: "",
    isPrivate: false,
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReview: null,
    pinnedBoard: null,
    followerCount: 0,
    followingCount: 0,
    isFollowing: false,
    isCurrentUser: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isFollowSaving, setIsFollowSaving] = useState(false);
  const [likeMessage, setLikeMessage] = useState("");
  const [error, setError] = useState("");
  const publicProfileState = location.state?.profileUser || {};
  const publicProfileUsername = publicProfileState.username || "";
  const publicProfileImageUrl = publicProfileState.imageUrl || "";
  const canManageProfile = !isPublicProfile;
  const isPrivateProfile = isPublicProfile && profile.isPrivate && !profile.isCurrentUser;
  const availableTabs = useMemo(
    () => tabs.filter((tab) => tab.id !== "settings" && (!isPrivateProfile || ["overview", "reviews"].includes(tab.id))),
    [isPrivateProfile],
  );

  useEffect(() => {
    let isCurrent = true;
    const controller = new AbortController();

    async function fetchProfileData() {
      if (!isPublicProfile && !isSignedIn) {
        setSavedAlbums([]);
        setReviews([]);
        setActivityItems([]);
        setNetworkItems([]);
        setBoards([]);
        setProfile({
          userId: "",
          username: "",
          imageUrl: "",
          bio: "",
          spotifyProfileUrl: "",
          isPrivate: false,
          favoriteAlbums: [],
          listeningNextAlbum: null,
          pinnedReview: null,
          pinnedBoard: null,
          followerCount: 0,
          followingCount: 0,
          isFollowing: false,
          isCurrentUser: false,
        });
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError("");

        const token = isSignedIn ? await getToken() : null;
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        let savedData = [];
        let reviewsData = { reviews: [], nextCursor: null };
        let popularReviewsData = { reviews: [], nextCursor: null };
        let activityData = [];
        let networkData = [];
        let boardsData = [];
        let profileData;

        if (isPublicProfile) {
          const encodedPublicUserId = encodeURIComponent(publicUserId);
          const [profileResponse, reviewsResponse, popularReviewsResponse] = await Promise.all([
            fetch(`${API_BASE_URL}/profile/${encodedPublicUserId}`, { headers }),
            fetch(`${API_BASE_URL}/reviews/review/user/${encodedPublicUserId}?sort=recent`, { headers, signal: controller.signal }),
            fetch(`${API_BASE_URL}/reviews/review/user/${encodedPublicUserId}?sort=popular&limit=${REVIEW_PREVIEW_LIMIT}`, { headers, signal: controller.signal }),
          ]);

          if (!profileResponse.ok) {
            throw new Error("Failed to load profile data");
          }

          profileData = await profileResponse.json();

          if (!reviewsResponse.ok || !popularReviewsResponse.ok) {
            throw new Error("Failed to load profile reviews");
          }
          reviewsData = await reviewsResponse.json();
          popularReviewsData = await popularReviewsResponse.json();

          if (!(profileData.isPrivate && !profileData.isCurrentUser)) {
            const [savedResponse, activityResponse, boardsResponse] = await Promise.all([
              fetch(`${API_BASE_URL}/profile/${encodedPublicUserId}/saved`, { headers }),
              fetch(`${API_BASE_URL}/profile/${encodedPublicUserId}/activity`, { headers }),
              fetch(`${API_BASE_URL}/profile/${encodedPublicUserId}/boards`, { headers }),
            ]);

            if (
              !savedResponse.ok
              || !activityResponse.ok
              || !boardsResponse.ok
            ) {
              throw new Error("Failed to load profile data");
            }

            [savedData, activityData, boardsData] = await Promise.all([
              savedResponse.json(),
              activityResponse.json(),
              boardsResponse.json(),
            ]);
          }
        } else {
          const [
            savedResponse,
            reviewsResponse,
            profileResponse,
            activityResponse,
            networkResponse,
            boardsResponse,
            popularReviewsResponse,
          ] = await Promise.all([
            fetch(`${API_BASE_URL}/profile/me/saved`, { headers }),
            fetch(`${API_BASE_URL}/reviews/review/user/?sort=recent`, { headers, signal: controller.signal }),
            fetch(`${API_BASE_URL}/profile/me`, { headers }),
            fetch(`${API_BASE_URL}/profile/me/activity`, { headers }),
            fetch(`${API_BASE_URL}/profile/me/network`, { headers }),
            fetch(`${API_BASE_URL}/boards`, { headers }),
            fetch(`${API_BASE_URL}/reviews/review/user/?sort=popular&limit=${REVIEW_PREVIEW_LIMIT}`, { headers, signal: controller.signal }),
          ]);

          if (
            !savedResponse.ok
            || !reviewsResponse.ok
            || !profileResponse.ok
            || !activityResponse.ok
            || !networkResponse.ok
            || !boardsResponse.ok
            || !popularReviewsResponse.ok
          ) {
            throw new Error("Failed to load profile data");
          }

          const [savedResponseData, nextReviewsData, nextProfileData, nextActivityData, nextNetworkData, nextBoardsData, nextPopularReviewsData] = await Promise.all([
            savedResponse.json(),
            reviewsResponse.json(),
            profileResponse.json(),
            activityResponse.json(),
            networkResponse.json(),
            boardsResponse.json(),
            popularReviewsResponse.json(),
          ]);
          savedData = Array.isArray(savedResponseData) ? savedResponseData : [];
          reviewsData = nextReviewsData;
          popularReviewsData = nextPopularReviewsData;
          profileData = nextProfileData;
          activityData = nextActivityData;
          networkData = nextNetworkData;
          boardsData = nextBoardsData;
        }

        if (!isCurrent) {
          return;
        }

        setSavedAlbums(Array.isArray(savedData) ? savedData : []);
        setReviews(Array.isArray(reviewsData.reviews) ? reviewsData.reviews : []);
        setRecentReviewPreviews((Array.isArray(reviewsData.reviews) ? reviewsData.reviews : []).slice(0, REVIEW_PREVIEW_LIMIT));
        setRecentPreviewHasMore(Boolean(reviewsData.nextCursor));
        setPopularReviewPreviews(Array.isArray(popularReviewsData.reviews) ? popularReviewsData.reviews : []);
        setNextReviewCursor(reviewsData.nextCursor || null);
        setActivityItems(Array.isArray(activityData) ? activityData : []);
        setNetworkItems(Array.isArray(networkData) ? networkData : []);
        setBoards(Array.isArray(boardsData) ? boardsData : []);
        setProfile({
          userId: profileData.userId || publicUserId || "",
          username: typeof profileData.username === "string" ? profileData.username : "",
          imageUrl: typeof profileData.imageUrl === "string" ? profileData.imageUrl : "",
          bio: typeof profileData.bio === "string" ? profileData.bio : "",
          spotifyProfileUrl: typeof profileData.spotifyProfileUrl === "string" ? profileData.spotifyProfileUrl : "",
          isPrivate: Boolean(profileData.isPrivate),
          favoriteAlbums: Array.isArray(profileData.favoriteAlbums) ? profileData.favoriteAlbums : [],
          listeningNextAlbum: profileData.listeningNextAlbum || null,
          pinnedReview: profileData.pinnedReview || null,
          pinnedBoard: profileData.pinnedBoard || null,
          followerCount: Number(profileData.followerCount) || 0,
          followingCount: Number(profileData.followingCount) || 0,
          isFollowing: Boolean(profileData.isFollowing),
          isCurrentUser: Boolean(profileData.isCurrentUser),
        });
      } catch (profileError) {
        console.error(profileError);

        if (isCurrent) {
          setSavedAlbums([]);
          setReviews([]);
          setActivityItems([]);
          setNetworkItems([]);
          setBoards([]);
          setProfile({
            userId: publicUserId || "",
            username: publicProfileUsername,
            imageUrl: publicProfileImageUrl,
            bio: "",
            spotifyProfileUrl: "",
            isPrivate: false,
            favoriteAlbums: [],
            listeningNextAlbum: null,
            pinnedReview: null,
            pinnedBoard: null,
            followerCount: 0,
            followingCount: 0,
            isFollowing: false,
            isCurrentUser: false,
          });
          setError(isPublicProfile
            ? "Could not load this profile right now."
            : "Could not load your profile right now.");
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    fetchProfileData();

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [getToken, isPublicProfile, isSignedIn, publicProfileImageUrl, publicProfileUsername, publicUserId]);

  useEffect(() => {
    if (!availableTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, availableTabs]);

  useEffect(() => {
    if (requestedTab && availableTabs.some((tab) => tab.id === requestedTab)) {
      setActiveTab(requestedTab);
    }
  }, [availableTabs, requestedTab]);

  const averageRating = useMemo(() => {
    if (reviews.length === 0) {
      return "--";
    }

    const total = reviews.reduce((sum, review) => sum + (Number(review.rating) || 0), 0);
    return (total / reviews.length).toFixed(1);
  }, [reviews]);

  const sortedSavedAlbums = useMemo(() => (
    [...savedAlbums].sort((first, second) => new Date(second.savedAt) - new Date(first.savedAt))
  ), [savedAlbums]);
  const sortedBoards = useMemo(() => (
    [...boards].sort((first, second) => Number(second.isDefault) - Number(first.isDefault)
      || new Date(second.updatedAt || 0) - new Date(first.updatedAt || 0))
  ), [boards]);
  const latestReviews = recentReviewPreviews;
  const previewPopularReviews = popularReviewPreviews;
  const latestSidebarActivity = useMemo(() => activityItems.slice(0, 4), [activityItems]);
  const favoriteAlbums = profile.favoriteAlbums;
  const profileUserId = profile.userId || publicUserId || user?.id || "";
  const moreReviewsPath = profileUserId
    ? `/profile/${encodeURIComponent(profileUserId)}/reviews`
    : "/viewreviews";
  const reviewListEndpoint = isPublicProfile && profileUserId
    ? `${API_BASE_URL}/reviews/review/user/${encodeURIComponent(profileUserId)}`
    : `${API_BASE_URL}/reviews/review/user/`;
  const socialPath = isPublicProfile && profileUserId
    ? `/profile/${encodeURIComponent(profileUserId)}/network`
    : "/account/network";

  async function requestReviewPage(sort, cursor = null) {
    const token = isSignedIn ? await getToken() : null;
    const params = new URLSearchParams({ sort });
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${reviewListEndpoint}?${params.toString()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load reviews."));
    return response.json();
  }

  async function changeReviewSort(nextSort) {
    if (nextSort === reviewSort || isLoadingMoreReviews) return;
    setReviewSort(nextSort);
    setIsLoadingMoreReviews(true);
    try {
      const data = await requestReviewPage(nextSort);
      setReviews(Array.isArray(data.reviews) ? data.reviews : []);
      setNextReviewCursor(data.nextCursor || null);
    } catch (reviewError) {
      setError(reviewError.message || "Could not load reviews.");
    } finally {
      setIsLoadingMoreReviews(false);
    }
  }

  async function loadMoreReviews() {
    if (!nextReviewCursor || isLoadingMoreReviews) return;
    setIsLoadingMoreReviews(true);
    try {
      const data = await requestReviewPage(reviewSort, nextReviewCursor);
      setReviews((current) => {
        const ids = new Set(current.map((review) => review.reviewId));
        return [...current, ...(Array.isArray(data.reviews) ? data.reviews.filter((review) => !ids.has(review.reviewId)) : [])];
      });
      setNextReviewCursor(data.nextCursor || null);
    } catch (reviewError) {
      setError(reviewError.message || "Could not load more reviews.");
    } finally {
      setIsLoadingMoreReviews(false);
    }
  }

  async function removeReview(reviewId) {
    if (deletingReviewId) return false;
    setDeletingReviewId(reviewId);
    setDeleteErrors((current) => ({ ...current, [reviewId]: "" }));
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/reviews/review/user/${reviewId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Failed to delete review"));
      const withoutReview = (currentReviews) => currentReviews.filter((review) => review.reviewId !== reviewId);
      setReviews(withoutReview);
      setRecentReviewPreviews(withoutReview);
      setPopularReviewPreviews(withoutReview);
      return true;
    } catch (reviewError) {
      setDeleteErrors((current) => ({ ...current, [reviewId]: reviewError.message || "Could not delete that review." }));
      return false;
    } finally {
      setDeletingReviewId("");
    }
  }

  function updateReviewLikeState(reviewId, nextState) {
    const update = (currentReviews) => currentReviews.map((review) => review.reviewId === reviewId ? { ...review, ...nextState } : review);
    setReviews(update);
    setRecentReviewPreviews(update);
    setPopularReviewPreviews(update);
    setActivityItems((currentItems) => (
      currentItems.map((activity) => (
        activity.type === "review" && activity.reviewId === reviewId ? { ...activity, ...nextState } : activity
      ))
    ));
    setNetworkItems((currentItems) => (
      currentItems.map((activity) => (
        activity.type === "review" && activity.reviewId === reviewId ? { ...activity, ...nextState } : activity
      ))
    ));
  }

  async function toggleReviewLike(review) {
    if (!isSignedIn) {
      setLikeMessage("Sign in to like reviews.");
      return;
    }

    const reviewId = review.reviewId;

    if (!reviewId) {
      return;
    }

    const nextLiked = !review.likedByViewer;
    const previousLikeCount = Number(review.likeCount) || 0;
    const nextLikeCount = Math.max(0, previousLikeCount + (nextLiked ? 1 : -1));

    setLikeMessage("");
    updateReviewLikeState(reviewId, {
      likedByViewer: nextLiked,
      likeCount: nextLikeCount,
    });

    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/likes/review/${reviewId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ liked: nextLiked }),
      });

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, "Failed to update review like"));
      }

      const data = await response.json();
      updateReviewLikeState(reviewId, {
        likedByViewer: Boolean(data.likedByViewer),
        likeCount: Number(data.likeCount) || 0,
      });
    } catch (likeError) {
      console.error(likeError);
      updateReviewLikeState(reviewId, {
        likedByViewer: Boolean(review.likedByViewer),
        likeCount: previousLikeCount,
      });
      setLikeMessage(likeError.message || "Could not update that like.");
    }
  }

  async function createBoard(event) {
    event.preventDefault();

    const title = newBoardTitle.trim();

    if (!title || isCreatingBoard || isPublicProfile) {
      return;
    }

    try {
      setIsCreatingBoard(true);
      setError("");

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
      setNewBoardTitle("");
    } catch (boardError) {
      console.error(boardError);
      setError("Could not create that board.");
    } finally {
      setIsCreatingBoard(false);
    }
  }

  async function updateFollowState(nextFollowing) {
    if (!profile.userId || isFollowSaving) {
      return;
    }

    try {
      setIsFollowSaving(true);
      setError("");

      const token = await getToken();
      const response = await fetch(
        `${API_BASE_URL}/profile/${encodeURIComponent(profile.userId)}/follow`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ following: nextFollowing }),
        },
      );

      if (!response.ok) {
        throw new Error("Failed to update follow status");
      }

      const data = await response.json();

      setProfile((currentProfile) => ({
        ...currentProfile,
        followerCount: Number(data.followerCount) || 0,
        followingCount: Number(data.followingCount) || 0,
        isFollowing: Boolean(data.isFollowing),
        isCurrentUser: Boolean(data.isCurrentUser),
      }));
    } catch (followError) {
      console.error(followError);
      setError("Could not update follow status right now.");
    } finally {
      setIsFollowSaving(false);
    }
  }

  const displayName = isPublicProfile
    ? profile.username || publicProfileUsername || profile.userId || "rescened user"
    : user?.username || user?.fullName || user?.primaryEmailAddress?.emailAddress || "Your profile";
  const profileImageUrl = isPublicProfile ? profile.imageUrl || publicProfileImageUrl : user?.imageUrl;
  const showFollowButton = isPublicProfile && !profile.isCurrentUser && (!isSignedIn || !isLoading);
  const profileHandle = displayName;
  const hasSpotifyProfile = Boolean(profile.spotifyProfileUrl);
  const sidebarFacts = [
    { label: "Albums", value: savedAlbums.length },
    { label: "Reviews", value: reviews.length },
    { label: "Avg. Rating", value: averageRating },
    { label: "Followers", value: profile.followerCount },
    { label: "Following", value: profile.followingCount },
  ];

  function renderOverview() {
    const pinnedBoardPath = profile.pinnedBoard?.boardId
      ? isPublicProfile
        ? `/profile/${encodeURIComponent(profileUserId)}/boards/${profile.pinnedBoard.boardId}`
        : `/boards/${profile.pinnedBoard.boardId}`
      : "";

    return (
      <div className="profile-overview-grid">
        <section className="profile-panel profile-wide-panel">
          <div className="profile-section-header">
            <h2>Profile Pins</h2>
          </div>
          <div className="profile-pin-grid">
            {profile.listeningNextAlbum ? (
              <Link className="profile-pin-card profile-listening-next-card" to={`/album/${profile.listeningNextAlbum.albumId}`}>
                <AlbumCover src={profile.listeningNextAlbum.cover} title={profile.listeningNextAlbum.title} />
                <div>
                  <span>Listening Next</span>
                  <h3>{profile.listeningNextAlbum.title || "Untitled album"}</h3>
                  <p>{getArtistName(profile.listeningNextAlbum)}</p>
                </div>
              </Link>
            ) : (
              <div className="profile-pin-card profile-pin-empty">
                <span>Listening Next</span>
                <h3>No album queued</h3>
                <p>{canManageProfile ? "Choose an album from edit profile." : "This listener has not picked one yet."}</p>
              </div>
            )}

            {profile.pinnedReview ? (
              <Link className="profile-pin-card" to={`/album/${profile.pinnedReview.albumId}`}>
                <AlbumCover src={profile.pinnedReview.album?.cover} title={profile.pinnedReview.album?.title || "Album"} />
                <div>
                  <span>Pinned Review</span>
                  <h3>{profile.pinnedReview.album?.title || "Untitled album"}</h3>
                  <p>{profile.pinnedReview.reviewText || `${profile.pinnedReview.rating}/5`}</p>
                </div>
              </Link>
            ) : (
              <div className="profile-pin-card profile-pin-empty">
                <span>Pinned Review</span>
                <h3>No review pinned</h3>
                <p>{canManageProfile ? "Pin one of your reviews from edit profile." : "This listener has not pinned a review yet."}</p>
              </div>
            )}

            {profile.pinnedBoard ? (
              <Link className="profile-pin-card" to={pinnedBoardPath}>
                <BoardPreview albums={profile.pinnedBoard.previewAlbums || []} />
                <div>
                  <span>Pinned Board</span>
                  <h3>{profile.pinnedBoard.title || "Untitled board"}</h3>
                  <p>{profile.pinnedBoard.itemCount || 0} album{profile.pinnedBoard.itemCount === 1 ? "" : "s"} · {profile.pinnedBoard.listenCount || 0} listen{profile.pinnedBoard.listenCount === 1 ? "" : "s"}</p>
                </div>
              </Link>
            ) : (
              <div className="profile-pin-card profile-pin-empty">
                <span>Pinned Board</span>
                <h3>No board pinned</h3>
                <p>{canManageProfile ? "Pin one of your boards from edit profile." : "This listener has not pinned a board yet."}</p>
              </div>
            )}
          </div>
        </section>

        <section className="profile-panel profile-wide-panel">
          <div className="profile-section-header">
            <h2>Favorite Albums</h2>
          </div>

          {favoriteAlbums.length === 0 ? (
            <ProfileEmptyState
              title="No favorites chosen"
              body={canManageProfile
                ? "Choose up to five favorite albums from edit profile."
                : "Favorite albums will show up here once this listener chooses them."}
            />
          ) : (
            <div className="profile-favorites-grid">
              {favoriteAlbums.map((album) => (
                <Link
                  className="profile-favorite-card"
                  key={album.albumId}
                  to={`/album/${album.albumId}`}
                >
                  <AlbumCover src={album.cover} title={album.title} />
                  <h3>{album.title || "Untitled album"}</h3>
                  <p>{getArtistName(album)}</p>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="profile-panel">
          <div className="profile-section-header">
            <h2>Recent Reviews</h2>
            {recentPreviewHasMore && (
              <Link
                className="profile-more-link"
                to={moreReviewsPath}
                state={{ profileUser: publicProfileState }}
              >
                More
              </Link>
            )}
          </div>

          {latestReviews.length === 0 ? (
            <ProfileEmptyState
              title="No reviews yet"
              body={canManageProfile
                ? "Reviews you write will appear here."
                : "Reviews are not available on this profile yet."}
            />
          ) : (
            <div className="profile-review-list">
              {latestReviews.map((review) => (
                <ProfileReviewCard
                  key={review.reviewId}
                  review={review}
                  likeMessage={likeMessage}
                  onToggleLike={toggleReviewLike}
                />
              ))}
            </div>
          )}
        </section>

        <section className="profile-panel">
          <div className="profile-section-header">
            <h2>Popular Reviews</h2>
          </div>

          {previewPopularReviews.length === 0 ? (
            <ProfileEmptyState
              title="No popular reviews yet"
              body="Liked reviews will appear here once listeners engage with them."
            />
          ) : (
            <div className="profile-review-list">
              {previewPopularReviews.map((review) => (
                <ProfileReviewCard
                  key={review.reviewId}
                  review={review}
                  likeMessage={likeMessage}
                  onToggleLike={toggleReviewLike}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderSavedAlbums() {
    if (savedAlbums.length === 0) {
      return (
        <ProfileEmptyState
          title="No saved albums"
          body={canManageProfile
            ? "Save albums from their detail pages and they will collect here."
            : "Saved albums are not available for this profile yet."}
        />
      );
    }

    return (
      <section className="profile-saved-section">
        <div className="profile-saved-toolbar">
          <div>
            <h2>Saved Albums</h2>
            <p>{sortedSavedAlbums.length} albums on this shelf</p>
          </div>
          <div className="profile-view-toggle" aria-label="Saved albums view">
            <button
              className={savedViewMode === "grid" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setSavedViewMode("grid")}
            >
              Grid
            </button>
            <button
              className={savedViewMode === "list" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setSavedViewMode("list")}
            >
              List
            </button>
          </div>
        </div>

        {savedViewMode === "grid" ? (
          <div className="profile-album-grid">
            {sortedSavedAlbums.map((album) => (
              <article className="profile-album-card" key={album.albumId}>
                <Link to={`/album/${album.albumId}`} className="profile-album-card-link">
                  <AlbumCover src={album.cover} title={album.title} />
                  <h3>{album.title || "Untitled album"}</h3>
                  <p>{getArtistName(album)}</p>
                  <span>Saved {formatMonthYear(album.savedAt)}</span>
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="profile-saved-list">
            {sortedSavedAlbums.map((album) => (
              <article className="profile-saved-row" key={album.albumId}>
                <Link to={`/album/${album.albumId}`} className="profile-saved-album">
                  <AlbumCover src={album.cover} title={album.title} />
                  <div>
                    <h3>{album.title || "Untitled album"}</h3>
                    <p>{getArtistName(album)}</p>
                  </div>
                </Link>
                <div className="profile-saved-date">
                  <span>Saved</span>
                  <strong>{formatMonthYear(album.savedAt)}</strong>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderActivityFeed(items, emptyState) {
    if (items.length === 0) {
      return (
        <ProfileEmptyState
          title={emptyState.title}
          body={emptyState.body}
        />
      );
    }

    return (
      <div className="profile-activity-list">
        {items.map((activity) => {
          const actor = activity.actor || {};
          const album = activity.album || {};
          const targetUser = activity.targetUser || {};
          const reviewAuthor = activity.reviewAuthor || {};
          const actorName = actor.username || "rescened user";
          const actionLabelByType = {
            saved_album: "Saved",
            listen: "Listened",
            review: "Reviewed",
            liked_album: "Liked",
            liked_review: "Liked",
            follow: "Followed",
          };
          const actionTextByType = {
            saved_album: "saved",
            listen: "listened to",
            review: "reviewed",
            liked_album: "liked",
            liked_review: "liked a review of",
            follow: "followed",
          };
          const actionLabel = actionLabelByType[activity.type] || "Activity";
          const actionText = actionTextByType[activity.type] || "updated";
          const actorState = {
            profileUser: {
              username: actorName,
              imageUrl: actor.imageUrl || "",
            },
          };
          const targetUserName = targetUser.username || targetUser.userId || "rescened user";
          const targetUserState = {
            profileUser: {
              username: targetUserName,
              imageUrl: targetUser.imageUrl || "",
            },
          };
          const reviewAuthorName = reviewAuthor.username || reviewAuthor.userId || "rescened user";

          return (
            <article className={`profile-activity-item${activity.type === "listen" ? " profile-activity-item--listen" : ""}`} key={activity.id}>
              {activity.type === "follow" ? (
                targetUser.imageUrl ? (
                  <img className="profile-cover" src={targetUser.imageUrl} alt={`${targetUserName} avatar`} />
                ) : (
                  <div className="profile-cover-fallback">Profile</div>
                )
              ) : (
                <AlbumCover src={album.cover} title={album.title || "Album"} />
              )}
              <div>
                <span className={activity.type === "listen" ? "profile-listen-badge" : undefined}>{activity.type === "listen" && <span aria-hidden="true">♫ </span>}{actionLabel}</span>
                {activity.type === "follow" ? (
                  <h3>
                    <Link to={`/profile/${actor.userId}`} state={actorState}>
                      {actorName}
                    </Link>
                    {` ${actionText} `}
                    <Link to={`/profile/${targetUser.userId}`} state={targetUserState}>
                      {targetUserName}
                    </Link>
                  </h3>
                ) : (
                  <h3>
                    <Link to={`/profile/${actor.userId}`} state={actorState}>
                      {actorName}
                    </Link>
                    {` ${actionText} `}
                    <Link to={`/album/${album.albumId}`}>
                      {album.title || "Untitled album"}
                    </Link>
                  </h3>
                )}
                {activity.type === "liked_review" && (
                  <p>Reviewed by {reviewAuthorName}</p>
                )}
                {activity.type !== "follow" && activity.type !== "liked_review" && (
                  <p>{album.artistDisplayName || "Artist unknown"}</p>
                )}
                {activity.type === "listen" && activity.listenedOn && (
                  <p className="profile-listen-date">
                    Listened on <time dateTime={activity.listenedOn}>{formatDate(`${activity.listenedOn}T12:00:00`)}</time>
                  </p>
                )}
                {activity.reviewText && <p className="profile-review-copy">{activity.reviewText}</p>}
                {activity.type === "review" && (
                  <div className="review-card-actions">
                    <LikeButton
                      liked={Boolean(activity.likedByViewer)}
                      count={activity.likeCount}
                      label="review"
                      message={likeMessage}
                      onToggle={() => toggleReviewLike(activity)}
                    />
                  </div>
                )}
              </div>
              <div className="profile-activity-meta">
                {activity.rating && <strong>{activity.rating}/5</strong>}
                <time dateTime={activity.createdAt}>{activity.type === "listen" ? "Logged " : ""}{formatDate(activity.createdAt)}</time>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  function renderActivity() {
    return renderActivityFeed(activityItems, {
      title: "No activity yet",
      body: canManageProfile
        ? "Listens, reviews, and saved albums will show up here."
        : "This listener has not logged a listen, saved an album, or written a review yet.",
    });
  }

  function renderBoards() {
    return (
      <section className="profile-saved-section">
        <div className="profile-saved-toolbar">
          <div>
            <h2>Boards</h2>
            <p>
              {sortedBoards.length} board{sortedBoards.length === 1 ? "" : "s"}
              {canManageProfile ? " in your library" : " on this profile"}
            </p>
          </div>
          {canManageProfile && (
            <form className="board-create-form profile-board-create" onSubmit={createBoard}>
              <input
                value={newBoardTitle}
                onChange={(event) => setNewBoardTitle(event.target.value)}
                placeholder="New board name"
                maxLength={80}
              />
              <button type="submit" disabled={!newBoardTitle.trim() || isCreatingBoard}>
                Create
              </button>
            </form>
          )}
        </div>

        {sortedBoards.length === 0 ? (
          <ProfileEmptyState
            title="No boards yet"
            body={canManageProfile
              ? "Create boards to group albums from their detail pages."
              : "This listener has not created any boards yet."}
          />
        ) : (
          <div className="boards-grid profile-boards-grid">
            {sortedBoards.map((board) => {
              const boardPath = isPublicProfile
                ? `/profile/${encodeURIComponent(profileUserId)}/boards/${board.boardId}`
                : `/boards/${board.boardId}`;

              return (
                <Link className="board-card" key={board.boardId} to={boardPath}>
                  <BoardPreview albums={board.previewAlbums || []} />
                  <h2>{board.title}</h2>
                  <p>
                    {board.itemCount} album{board.itemCount === 1 ? "" : "s"} · {board.listenCount || 0} listen{board.listenCount === 1 ? "" : "s"}
                    {board.isDefault ? " · Default" : ""}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  function renderNetwork() {
    if (isPublicProfile) {
      return (
        <ProfileEmptyState
          title="Network is private"
          body="Following activity is only available from your own profile."
        />
      );
    }

    return renderActivityFeed(networkItems, {
      title: "No network activity yet",
      body: "Follow listeners to see their latest listens and reviews here.",
    });
  }

  function renderReviews() {
    if (reviews.length === 0) {
      return (
        <ProfileEmptyState
          title="No reviews yet"
          body={canManageProfile
            ? "Your album reviews will live here once you write them."
            : "Reviews are not available on this profile yet."}
        />
      );
    }

    const renderReviewCard = (review) => (
      <article className="profile-review-card" key={review.reviewId}>
        <Link className="profile-review-album" to={`/album/${review.albumId}`}>
          <AlbumCover src={review.cover} title={review.title} />
          <div>
            <h3>{review.title || "Untitled album"}</h3>
            <p>{review.album?.artistDisplayName || "Artist unknown"}</p>
          </div>
        </Link>
        <div className="profile-review-meta">
          <span>{review.rating}/5</span>
          <time>{formatDate(review.date)}</time>
        </div>
        <p className="profile-review-copy">{review.reviewText}</p>
        <div className="review-card-actions">
          <LikeButton
            liked={Boolean(review.likedByViewer)}
            count={review.likeCount}
            label="review"
            message={likeMessage}
            onToggle={() => toggleReviewLike(review)}
          />
        </div>
        {canManageProfile && (
          <button
            className="profile-secondary-button"
            type="button"
            onClick={() => removeReview(review.reviewId)}
            disabled={deletingReviewId === review.reviewId}
          >
            {deletingReviewId === review.reviewId ? "Deleting..." : "Delete Review"}
          </button>
        )}
        {deleteErrors[review.reviewId] && <p className="review-edit-error" role="alert">{deleteErrors[review.reviewId]}</p>}
      </article>
    );

    return (
      <div className="profile-review-tab">
        <section className="profile-panel">
          <div className="profile-section-header">
            <h2>{reviewSort === "popular" ? "Most Liked Reviews" : "Latest Reviews"}</h2>
            <select value={reviewSort} onChange={(event) => changeReviewSort(event.target.value)} disabled={isLoadingMoreReviews}>
              <option value="recent">Latest first</option>
              <option value="popular">Most liked</option>
            </select>
          </div>
          <div className="profile-review-list">
            {reviews.map(renderReviewCard)}
          </div>
          {nextReviewCursor && <button className="profile-more-link" type="button" onClick={loadMoreReviews} disabled={isLoadingMoreReviews}>{isLoadingMoreReviews ? "Loading..." : "Load more reviews"}</button>}
          {!nextReviewCursor && <p className="edit-profile-current-value">You’re all caught up.</p>}
        </section>
      </div>
    );
  }

  function renderActiveTab() {
    if (isLoading) {
      return (
        <AsyncState
          isLoading
          loadingVariant="profile"
          loadingMessage={canManageProfile
            ? "Pulling together your saved albums and reviews."
            : "Pulling together this listener's profile."}
        />
      );
    }

    if (error) {
      return <AsyncState error={error} errorTitle="Profile unavailable" />;
    }

    if (isPrivateProfile && !["overview", "reviews"].includes(activeTab)) {
      return (
        <ProfileEmptyState
          title={`${displayName} account is private`}
          body="This listener is keeping their saved albums, favorites, activity, boards, and network private."
        />
      );
    }

    if (activeTab === "overview") {
      return renderOverview();
    }

    if (activeTab === "saved") {
      return renderSavedAlbums();
    }

    if (activeTab === "reviews") {
      return renderReviews();
    }

    if (activeTab === "activity") {
      return renderActivity();
    }

    if (activeTab === "boards") {
      return renderBoards();
    }

    if (activeTab === "network") {
      return renderNetwork();
    }

    return (
      <div className="profile-settings-panel">
        <UserProfile />
      </div>
    );
  }

  if (!isPublicProfile && !isSignedIn) {
    return <RedirectToSignIn />;
  }

  function renderProfileAction(className = "profile-follow-button") {
    if (!showFollowButton) {
      return null;
    }

    if (isSignedIn) {
      return (
        <button
          className={className}
          type="button"
          disabled={isFollowSaving || isLoading}
          onClick={() => updateFollowState(!profile.isFollowing)}
        >
          {isFollowSaving ? "Saving..." : profile.isFollowing ? "Following" : "Follow"}
        </button>
      );
    }

    return (
      <SignInButton mode="modal">
        <button className={className} type="button">
          Follow
        </button>
      </SignInButton>
    );
  }

  return (
    <>
      <section className="profile-page">
        <div className="profile-layout">
          <main className="profile-main">
            <header className="profile-hero">
              <div className="profile-identity">
                {isLoaded && profileImageUrl ? (
                  <img className="profile-avatar" src={profileImageUrl} alt={`${displayName} avatar`} />
                ) : (
                  <div className="profile-avatar profile-avatar-fallback">
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                )}

                <div>
                  <div className="profile-name-row">
                    <h1>{displayName}</h1>
                    {renderProfileAction()}
                  </div>
                  {profile.bio && <p className="profile-bio">{profile.bio}</p>}
                  {hasSpotifyProfile && (
                    <a
                      className="profile-spotify-inline"
                      href={profile.spotifyProfileUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Spotify
                    </a>
                  )}
                </div>
              </div>

              <div className="profile-hero-links" aria-label="Profile links">
                {isPrivateProfile ? (
                  <>
                    <button type="button" onClick={() => setActiveTab("reviews")}>
                      <span>Reviews</span>
                      <strong>{reviews.length}</strong>
                    </button>
                    <div className="profile-hero-stat">
                      <span>Followers</span>
                      <strong>{profile.followerCount}</strong>
                    </div>
                    <div className="profile-hero-stat">
                      <span>Following</span>
                      <strong>{profile.followingCount}</strong>
                    </div>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => setActiveTab("saved")}>
                      <span>Albums</span>
                      <strong>{savedAlbums.length}</strong>
                    </button>
                    <button type="button" onClick={() => setActiveTab("reviews")}>
                      <span>Reviews</span>
                      <strong>{reviews.length}</strong>
                    </button>
                    <Link
                      to={`${socialPath}?tab=followers`}
                      state={{ profileUser: publicProfileState, activeTab: "followers" }}
                    >
                      <span>Followers</span>
                      <strong>{profile.followerCount}</strong>
                    </Link>
                    <Link
                      to={`${socialPath}?tab=following`}
                      state={{ profileUser: publicProfileState, activeTab: "following" }}
                    >
                      <span>Following</span>
                      <strong>{profile.followingCount}</strong>
                    </Link>
                  </>
                )}
              </div>
              {canManageProfile && (
                <div className="profile-hero-actions">
                  <Link className="profile-edit-link" to="/account/edit">Edit Profile</Link>
                  <Link className="profile-edit-link" to="/moderation/album-suggestions">Moderation</Link>
                </div>
              )}
            </header>

            <nav className="profile-tabs" aria-label="Profile sections">
              {availableTabs.map((tab) => (
                <button
                  className={activeTab === tab.id ? "profile-tab profile-tab-active" : "profile-tab"}
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </nav>

            <div className="profile-tab-panel">
              {renderActiveTab()}
            </div>
          </main>

          {!isPrivateProfile && (
          <aside className="profile-sidebar" aria-label="Profile details">
            <div className="profile-sidebar-card">
              <div className="profile-sidebar-banner" />
              <div className="profile-sidebar-body">
                <div className="profile-sidebar-heading">
                  {isLoaded && profileImageUrl ? (
                    <img className="profile-sidebar-avatar" src={profileImageUrl} alt={`${displayName} avatar`} />
                  ) : (
                    <div className="profile-sidebar-avatar profile-avatar-fallback">
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <h2>{displayName}</h2>
                    <p>{profileHandle}</p>
                  </div>
                </div>

                {profile.bio ? (
                  <p className="profile-sidebar-bio">{profile.bio}</p>
                ) : (
                  <p className="profile-sidebar-bio">
                    {canManageProfile
                      ? "Add a bio from edit profile to introduce your listening shelf."
                      : "This listener has not added a bio yet."}
                  </p>
                )}

                <dl className="profile-sidebar-facts">
                  {sidebarFacts.map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="profile-sidebar-section">
                  <h3>Activity Log</h3>
                  {latestSidebarActivity.length === 0 ? (
                    <p>No activity logged yet.</p>
                  ) : (
                    <div className="profile-sidebar-activity">
                      {latestSidebarActivity.map((activity) => {
                        const album = activity.album || {};
                        const targetUser = activity.targetUser || {};
                        const actionLabelByType = {
                          saved_album: "Saved",
                          listen: "Listened",
                          review: "Reviewed",
                          liked_album: "Liked",
                          liked_review: "Liked",
                          follow: "Followed",
                        };
                        const actionLabel = actionLabelByType[activity.type] || "Activity";
                        const activityPath = activity.type === "follow" && targetUser.userId
                          ? `/profile/${encodeURIComponent(targetUser.userId)}`
                          : `/album/${album.albumId}`;

                        return (
                          <Link
                            className="profile-sidebar-activity-row"
                            key={activity.id}
                            to={activityPath}
                          >
                            {activity.type === "follow" ? (
                              targetUser.imageUrl ? (
                                <img className="profile-cover" src={targetUser.imageUrl} alt={`${targetUser.username || "Profile"} avatar`} />
                              ) : (
                                <div className="profile-cover-fallback">Profile</div>
                              )
                            ) : (
                              <AlbumCover src={album.cover} title={album.title || "Album"} />
                            )}
                            <div>
                              <span className={activity.type === "listen" ? "profile-listen-badge" : undefined}>{activity.type === "listen" && <span aria-hidden="true">♫ </span>}{actionLabel}</span>
                              <strong>
                                {activity.type === "follow"
                                  ? targetUser.username || targetUser.userId || "rescened user"
                                  : album.title || "Untitled album"}
                              </strong>
                              {activity.type === "listen" && activity.listenedOn && (
                                <time dateTime={activity.listenedOn}>Listened {formatDate(`${activity.listenedOn}T12:00:00`)}</time>
                              )}
                              <time dateTime={activity.createdAt}>{activity.type === "listen" ? "Logged " : ""}{formatDate(activity.createdAt)}</time>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="profile-sidebar-section">
                  <h3>Ratings Scale</h3>
                  <div className="profile-rating-scale" aria-label="Rating scale">
                    <span>1</span>
                    <div />
                    <span>5</span>
                  </div>
                </div>

              </div>
            </div>
          </aside>
          )}
        </div>
      </section>
    </>
  );
}

export default Account;
