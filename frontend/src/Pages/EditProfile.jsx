import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RedirectToSignIn, Show, useAuth, useUser } from "@clerk/react";
import { getApiErrorMessage } from "../utils/apiErrors";

const MAX_BIO_LENGTH = 280;
const MAX_FAVORITES = 5;
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

function getErrorMessage(error, fallback) {
  return error?.errors?.[0]?.longMessage
    || error?.errors?.[0]?.message
    || error?.message
    || fallback;
}

function validateUsername(value) {
  const nextUsername = value.trim();

  if (!nextUsername) {
    return "Enter a username.";
  }

  if (nextUsername.length < 3 || nextUsername.length > 30) {
    return "Username must be 3-30 characters.";
  }

  if (!USERNAME_PATTERN.test(nextUsername)) {
    return "Use only letters, numbers, and underscores.";
  }

  return "";
}

function getClerkUsernameError(error) {
  const clerkError = error?.errors?.[0];
  const code = clerkError?.code || "";
  const message = `${clerkError?.longMessage || clerkError?.message || error?.message || ""}`.toLowerCase();

  if (code.includes("username") && (code.includes("taken") || code.includes("exists"))
    || message.includes("username") && (message.includes("taken") || message.includes("already"))) {
    return "That username is already taken.";
  }

  if (code.includes("username") && (code.includes("invalid") || code.includes("format"))
    || message.includes("username") && (message.includes("invalid") || message.includes("format"))) {
    return "Use only letters, numbers, and underscores.";
  }

  if (code.includes("username") && (code.includes("too_short") || code.includes("too_long"))
    || message.includes("username") && (message.includes("too short") || message.includes("too long"))) {
    return "Username must be 3-30 characters.";
  }

  return getErrorMessage(error, "Could not update username.");
}

function getAlbumId(album) {
  return album.albumId;
}

function AlbumCover({ src, title }) {
  if (!src) {
    return <div className="edit-profile-cover-fallback">No cover</div>;
  }

  return <img className="edit-profile-cover" src={src} alt={`${title} cover`} />;
}

export function EditProfile() {
  const navigate = useNavigate();
  const { getToken, isSignedIn } = useAuth();
  const { user, isLoaded } = useUser();
  const [bio, setBio] = useState("");
  const [spotifyProfileUrl, setSpotifyProfileUrl] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [favoriteAlbums, setFavoriteAlbums] = useState([]);
  const [listeningNextAlbum, setListeningNextAlbum] = useState(null);
  const [pinnedReviewId, setPinnedReviewId] = useState("");
  const [pinnedBoardId, setPinnedBoardId] = useState("");
  const [reviews, setReviews] = useState([]);
  const [nextReviewCursor, setNextReviewCursor] = useState(null);
  const [isLoadingMoreReviews, setIsLoadingMoreReviews] = useState(false);
  const [boards, setBoards] = useState([]);
  const [isProfileLoading, setIsProfileLoading] = useState(true);
  const [profileStatus, setProfileStatus] = useState("");
  const [profileError, setProfileError] = useState("");
  const [username, setUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [pendingEmailAddress, setPendingEmailAddress] = useState(null);
  const [emailStatus, setEmailStatus] = useState("");
  const [emailError, setEmailError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchStatus, setSearchStatus] = useState("");
  const [searchError, setSearchError] = useState("");
  const usernameValidationError = validateUsername(username);

  useEffect(() => {
    if (isLoaded && user) {
      setUsername(user.username || "");
    }
  }, [isLoaded, user]);
// isCurrent is our safe guard incase a user exits the page before the fetch finishes or signs out 
  useEffect(() => {
    let isCurrent = true;
    const controller = new AbortController();

    async function fetchProfile() {
      if (!isSignedIn) {
        setIsProfileLoading(false);
        return;
      }

      try {
        setIsProfileLoading(true);
        setProfileError("");

        const token = await getToken();
        const headers = {
          Authorization: `Bearer ${token}`,
        };
        const [profileResponse, reviewsResponse, boardsResponse] = await Promise.all([
          fetch(`${API_BASE_URL}/profile/me`, { headers, signal: controller.signal }),
          fetch(`${API_BASE_URL}/reviews/review/user/?sort=recent`, { headers, signal: controller.signal }),
          fetch(`${API_BASE_URL}/boards`, { headers, signal: controller.signal }),
        ]);

        if (!profileResponse.ok || !reviewsResponse.ok || !boardsResponse.ok) {
          throw new Error("Failed to load profile");
        }

        const [data, reviewsData, boardsData] = await Promise.all([
          profileResponse.json(),
          reviewsResponse.json(),
          boardsResponse.json(),
        ]);

        if (!isCurrent) {
          return;
        }

        setBio(typeof data.bio === "string" ? data.bio : "");
        setSpotifyProfileUrl(typeof data.spotifyProfileUrl === "string" ? data.spotifyProfileUrl : "");
        setIsPrivate(Boolean(data.isPrivate));
        setFavoriteAlbums(Array.isArray(data.favoriteAlbums) ? data.favoriteAlbums : []);
        setListeningNextAlbum(data.listeningNextAlbum || null);
        setPinnedReviewId(data.pinnedReview?.reviewId || "");
        setPinnedBoardId(data.pinnedBoard?.boardId || "");
        const initialReviews = Array.isArray(reviewsData.reviews) ? reviewsData.reviews : [];
        const currentPinnedReview = data.pinnedReview || null;
        setReviews(currentPinnedReview && !initialReviews.some((review) => review.reviewId === currentPinnedReview.reviewId)
          ? [currentPinnedReview, ...initialReviews]
          : initialReviews);
        setNextReviewCursor(reviewsData.nextCursor || null);
        setBoards(Array.isArray(boardsData) ? boardsData : []);
      } catch (error) {
        if (isCurrent && !controller.signal.aborted) {
          setProfileError(getErrorMessage(error, "Could not load profile settings."));
        }
      } finally {
        if (isCurrent) {
          setIsProfileLoading(false);
        }
      }
    }

    fetchProfile();

    return () => {
      isCurrent = false;
      controller.abort();
    };
  }, [getToken, isSignedIn]);

  async function loadMoreReviews() {
    if (!nextReviewCursor || isLoadingMoreReviews) return;
    setIsLoadingMoreReviews(true);
    try {
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/reviews/review/user/?sort=recent&cursor=${encodeURIComponent(nextReviewCursor)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load more reviews."));
      const data = await response.json();
      setReviews((current) => {
        const ids = new Set(current.map((review) => review.reviewId));
        return [...current, ...(Array.isArray(data.reviews) ? data.reviews.filter((review) => !ids.has(review.reviewId)) : [])];
      });
      setNextReviewCursor(data.nextCursor || null);
    } catch (error) {
      setProfileError(error.message || "Could not load more reviews.");
    } finally {
      setIsLoadingMoreReviews(false);
    }
  }

  async function handleUsernameSubmit(event) {
    event.preventDefault();

    if (!user) {
      return;
    }

    if (usernameValidationError) {
      setUsernameStatus("");
      setUsernameError(username.trim() ? "" : usernameValidationError);
      return;
    }

    try {
      setUsernameError("");
      setUsernameStatus("Saving username...");

      await user.update({ username: username.trim() });
      await user.reload();
      setUsernameStatus("Username updated.");
    } catch (error) {
      setUsernameStatus("");
      setUsernameError(getClerkUsernameError(error));
    }
  }

  async function handleEmailStart(event) {
    event.preventDefault();

    if (!user) {
      return;
    }

    try {
      setEmailError("");
      setEmailStatus("Sending verification code...");

      const emailAddress = await user.createEmailAddress({ email: newEmail.trim() });
      const preparedEmailAddress = await emailAddress.prepareVerification({ strategy: "email_code" });
      setPendingEmailAddress(preparedEmailAddress);
      setEmailStatus("Check your new email for a verification code.");
    } catch (error) {
      setEmailStatus("");
      setEmailError(getErrorMessage(error, "Could not start email verification."));
    }
  }

  async function handleEmailVerify(event) {
    event.preventDefault();

    if (!user || !pendingEmailAddress) {
      return;
    }

    try {
      setEmailError("");
      setEmailStatus("Verifying email...");

      const verifiedEmail = await pendingEmailAddress.attemptVerification({ code: emailCode.trim() });
      await user.update({ primaryEmailAddressId: verifiedEmail.id });
      await user.reload();

      setNewEmail("");
      setEmailCode("");
      setPendingEmailAddress(null);
      setEmailStatus("Primary email updated.");
    } catch (error) {
      setEmailStatus("");
      setEmailError(getErrorMessage(error, "Could not verify that email."));
    }
  }

  async function handlePasswordSubmit(event) {
    event.preventDefault();

    if (!user) {
      return;
    }

    try {
      setPasswordError("");
      setPasswordStatus("Updating password...");

      await user.updatePassword({
        currentPassword: user.passwordEnabled ? currentPassword : undefined,
        newPassword,
        signOutOfOtherSessions: true,
      });
      await user.reload();

      setCurrentPassword("");
      setNewPassword("");
      setPasswordStatus("Password updated.");
    } catch (error) {
      setPasswordStatus("");
      setPasswordError(getErrorMessage(error, "Could not update password."));
    }
  }

  async function handleSearch() {
    const query = searchQuery.trim();

    if (!query) {
      setSearchResults([]);
      setSearchStatus("");
      setSearchError("");
      return;
    }

    try {
      setSearchError("");
      setSearchStatus("Searching...");

      const response = await fetch(`${API_BASE_URL}/search/search?q=${encodeURIComponent(query)}`);

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response, "Search failed"));
      }

      const data = await response.json();
      setSearchResults(Array.isArray(data) ? data : []);
      setSearchStatus("");
    } catch (error) {
      setSearchResults([]);
      setSearchStatus("");
      setSearchError(error.message || getErrorMessage(error, "Could not search albums."));
    }
  }

  function addFavoriteAlbum(album) {
    const albumId = getAlbumId(album);

    if (!albumId || favoriteAlbums.some((favoriteAlbum) => getAlbumId(favoriteAlbum) === albumId)) {
      return;
    }

    if (favoriteAlbums.length >= MAX_FAVORITES) {
      setSearchError("Choose up to five favorite albums.");
      return;
    }

    setSearchError("");
    setFavoriteAlbums((currentFavorites) => [...currentFavorites, { ...album, albumId }]);
  }

  function removeFavoriteAlbum(albumId) {
    setFavoriteAlbums((currentFavorites) => (
      currentFavorites.filter((album) => getAlbumId(album) !== albumId)
    ));
  }

  function setNextAlbum(album) {
    const albumId = getAlbumId(album);

    if (!albumId) {
      return;
    }

    setListeningNextAlbum({ ...album, albumId });
  }

  function moveFavoriteAlbum(albumId, direction) {
    setFavoriteAlbums((currentFavorites) => {
      const currentIndex = currentFavorites.findIndex((album) => getAlbumId(album) === albumId);
      const nextIndex = currentIndex + direction;

      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= currentFavorites.length) {
        return currentFavorites;
      }

      const nextFavorites = [...currentFavorites];
      const [album] = nextFavorites.splice(currentIndex, 1);
      nextFavorites.splice(nextIndex, 0, album);
      return nextFavorites;
    });
  }

  async function handleProfileSubmit(event) {
    event?.preventDefault();

    try {
      setProfileError("");
      setProfileStatus("Saving profile...");

      const token = await getToken();
      const profileResponse = await fetch(`${API_BASE_URL}/profile/me`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bio,
          spotifyProfileUrl,
          favoriteAlbumIds: favoriteAlbums.map(getAlbumId),
          listeningNextAlbumId: listeningNextAlbum ? getAlbumId(listeningNextAlbum) : "",
          pinnedReviewId,
          pinnedBoardId,
        }),
      });

      const profileData = await profileResponse.json();

      if (!profileResponse.ok) {
        throw new Error(profileData.error || "Failed to save profile");
      }

      const privacyResponse = await fetch(`${API_BASE_URL}/profile/me`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isPrivate,
        }),
      });

      const privacyData = await privacyResponse.json();

      if (!privacyResponse.ok) {
        throw new Error(privacyData.error || "Failed to save profile privacy");
      }

      const data = {
        ...profileData,
        isPrivate: privacyData.isPrivate,
      };

      setBio(typeof data.bio === "string" ? data.bio : "");
      setSpotifyProfileUrl(typeof data.spotifyProfileUrl === "string" ? data.spotifyProfileUrl : "");
      setIsPrivate(Boolean(data.isPrivate));
      setFavoriteAlbums(Array.isArray(data.favoriteAlbums) ? data.favoriteAlbums : []);
      setListeningNextAlbum(data.listeningNextAlbum || null);
      setPinnedReviewId(data.pinnedReview?.reviewId || "");
      setPinnedBoardId(data.pinnedBoard?.boardId || "");
      setProfileStatus("Profile saved.");
    } catch (error) {
      setProfileStatus("");
      setProfileError(getErrorMessage(error, "Could not save profile."));
    }
  }

  return (
    <>
      <Show when="signed-in">
        <section className="edit-profile-page">
          <div className="edit-profile-header">
            <div>
              <p className="profile-kicker">Account</p>
              <h1>Edit Profile</h1>
            </div>
            <button className="profile-secondary-button" type="button" onClick={() => navigate("/account")}>
              Back to Profile
            </button>
          </div>

          {isProfileLoading ? (
            <div className="profile-empty-state">
              <h3>Loading settings</h3>
              <p>Pulling in your profile details.</p>
            </div>
          ) : (
            <div className="edit-profile-grid">
              <section className="edit-profile-panel edit-profile-wide-panel">
                <div className="profile-section-header">
                  <h2>Profile Display</h2>
                  <span>{bio.length}/{MAX_BIO_LENGTH}</span>
                </div>

                <label className="edit-profile-field">
                  <span>Bio</span>
                  <textarea
                    value={bio}
                    maxLength={MAX_BIO_LENGTH}
                    rows="4"
                    onChange={(event) => setBio(event.target.value)}
                    placeholder="A little note for your profile..."
                  />
                </label>

                <label className="edit-profile-field">
                  <span>Spotify Profile</span>
                  <input
                    value={spotifyProfileUrl}
                    onChange={(event) => setSpotifyProfileUrl(event.target.value)}
                    placeholder="https://open.spotify.com/user/..."
                  />
                </label>

                <label className="edit-profile-field">
                  <span>Private Account</span>
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(event) => setIsPrivate(event.target.checked)}
                  />
                </label>
                <p className="edit-profile-current-value">
                  Private accounts only show profile identity and follower counts to other listeners.
                </p>

                <div className="edit-profile-favorites">
                  <div className="profile-section-header">
                    <h2>Listening Next</h2>
                  </div>

                  {listeningNextAlbum ? (
                    <article className="edit-profile-selected-album">
                      <span className="edit-profile-rank">Next</span>
                      <AlbumCover src={listeningNextAlbum.cover} title={listeningNextAlbum.title} />
                      <div>
                        <h3>{listeningNextAlbum.title || "Untitled album"}</h3>
                        <p>{listeningNextAlbum.artistDisplayName || "Artist unknown"}</p>
                      </div>
                      <div className="edit-profile-album-actions">
                        <button type="button" onClick={() => setListeningNextAlbum(null)}>
                          Clear
                        </button>
                      </div>
                    </article>
                  ) : (
                    <div className="profile-empty-state">
                      <h3>No album queued</h3>
                      <p>Search below and choose one album to show as Listening Next.</p>
                    </div>
                  )}
                </div>

                <div className="edit-profile-favorites">
                  <div className="profile-section-header">
                    <h2>Favorite Albums</h2>
                    <span>{favoriteAlbums.length}/{MAX_FAVORITES}</span>
                  </div>

                  {favoriteAlbums.length === 0 ? (
                    <div className="profile-empty-state">
                      <h3>No favorites selected</h3>
                      <p>Search below and add up to five albums.</p>
                    </div>
                  ) : (
                    <div className="edit-profile-selected-list">
                      {favoriteAlbums.map((album, index) => {
                        const albumId = getAlbumId(album);

                        return (
                          <article className="edit-profile-selected-album" key={albumId}>
                            <span className="edit-profile-rank">{index + 1}</span>
                            <AlbumCover src={album.cover} title={album.title} />
                            <div>
                              <h3>{album.title || "Untitled album"}</h3>
                              <p>{album.artistDisplayName || "Artist unknown"}</p>
                            </div>
                            <div className="edit-profile-album-actions">
                              <button
                                type="button"
                                onClick={() => moveFavoriteAlbum(albumId, -1)}
                                disabled={index === 0}
                              >
                                Up
                              </button>
                              <button
                                type="button"
                                onClick={() => moveFavoriteAlbum(albumId, 1)}
                                disabled={index === favoriteAlbums.length - 1}
                              >
                                Down
                              </button>
                              <button type="button" onClick={() => removeFavoriteAlbum(albumId)}>
                                Remove
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}

                  <div className="edit-profile-search">
                    <label className="edit-profile-field">
                      <span>Search albums</span>
                      <input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder="Find an album..."
                      />
                    </label>
                    <button className="album-action-button" type="button" onClick={handleSearch}>Search</button>
                  </div>

                  {searchStatus && <p className="edit-profile-status">{searchStatus}</p>}
                  {searchError && <p className="edit-profile-error">{searchError}</p>}

                  {searchResults.length > 0 && (
                    <div className="edit-profile-search-results">
                      {searchResults.map((album) => {
                        const albumId = getAlbumId(album);
                        const isSelected = favoriteAlbums.some((favoriteAlbum) => getAlbumId(favoriteAlbum) === albumId);
                        const isListeningNext = getAlbumId(listeningNextAlbum || {}) === albumId;

                        return (
                          <article className="edit-profile-search-result" key={albumId}>
                            <AlbumCover src={album.cover} title={album.title} />
                            <div>
                              <h3>{album.title || "Untitled album"}</h3>
                              <p>{album.artistDisplayName || "Artist unknown"}</p>
                            </div>
                            <div className="edit-profile-album-actions">
                              <button
                                type="button"
                                disabled={isSelected || favoriteAlbums.length >= MAX_FAVORITES}
                                onClick={() => addFavoriteAlbum(album)}
                              >
                                {isSelected ? "Added" : "Add"}
                              </button>
                              <button
                                type="button"
                                disabled={isListeningNext}
                                onClick={() => setNextAlbum(album)}
                              >
                                {isListeningNext ? "Queued" : "Set Next"}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="edit-profile-favorites">
                  <div className="profile-section-header">
                    <h2>Profile Pins</h2>
                  </div>

                  <label className="edit-profile-field">
                    <span>Pinned Review</span>
                    <select value={pinnedReviewId} onChange={(event) => setPinnedReviewId(event.target.value)}>
                      <option value="">No pinned review</option>
                      {reviews.map((review) => (
                        <option key={review.reviewId} value={review.reviewId}>
                          {review.title || "Untitled album"} · {review.rating}/5
                        </option>
                      ))}
                    </select>
                  </label>
                  {nextReviewCursor && (
                    <button className="profile-secondary-button" type="button" onClick={loadMoreReviews} disabled={isLoadingMoreReviews}>
                      {isLoadingMoreReviews ? "Loading reviews..." : "Load older reviews"}
                    </button>
                  )}

                  <label className="edit-profile-field">
                    <span>Pinned Board</span>
                    <select value={pinnedBoardId} onChange={(event) => setPinnedBoardId(event.target.value)}>
                      <option value="">No pinned board</option>
                      {boards.map((board) => (
                        <option key={board.boardId} value={board.boardId}>
                          {board.title || "Untitled board"} · {board.itemCount || 0} album{board.itemCount === 1 ? "" : "s"}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {profileStatus && <p className="edit-profile-status">{profileStatus}</p>}
                {profileError && <p className="edit-profile-error">{profileError}</p>}
                <button className="album-action-button" type="button" onClick={handleProfileSubmit}>Save Profile</button>
              </section>

              <form className="edit-profile-panel" onSubmit={handleUsernameSubmit}>
                <div className="profile-section-header">
                  <h2>Username</h2>
                </div>
                <label className="edit-profile-field">
                  <span>Username</span>
                  <input
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      setUsernameStatus("");
                      setUsernameError("");
                    }}
                    placeholder="username"
                  />
                </label>
                <p className="edit-profile-current-value">
                  Use 3-30 characters: letters, numbers, and underscores only.
                </p>
                {usernameValidationError && username && (
                  <p className="edit-profile-error">{usernameValidationError}</p>
                )}
                {usernameStatus && <p className="edit-profile-status">{usernameStatus}</p>}
                {usernameError && <p className="edit-profile-error">{usernameError}</p>}
                <button
                  className="album-action-button"
                  type="submit"
                  disabled={!!usernameValidationError}
                >
                  Save Username
                </button>
              </form>

              <section className="edit-profile-panel">
                <div className="profile-section-header">
                  <h2>Email</h2>
                </div>
                <p className="edit-profile-current-value">
                  Current: {user?.primaryEmailAddress?.emailAddress || "No primary email"}
                </p>

                <form onSubmit={handleEmailStart}>
                  <label className="edit-profile-field">
                    <span>New email</span>
                    <input
                      type="email"
                      required
                      value={newEmail}
                      onChange={(event) => setNewEmail(event.target.value)}
                      placeholder="you@example.com"
                    />
                  </label>
                  <button className="album-action-button" type="submit">Send Code</button>
                </form>

                {pendingEmailAddress && (
                  <form className="edit-profile-verification-form" onSubmit={handleEmailVerify}>
                    <label className="edit-profile-field">
                      <span>Verification code</span>
                      <input
                        value={emailCode}
                        required
                        onChange={(event) => setEmailCode(event.target.value)}
                        placeholder="Enter code"
                      />
                    </label>
                    <button className="album-action-button" type="submit">Verify Email</button>
                  </form>
                )}

                {emailStatus && <p className="edit-profile-status">{emailStatus}</p>}
                {emailError && <p className="edit-profile-error">{emailError}</p>}
              </section>

              <form className="edit-profile-panel" onSubmit={handlePasswordSubmit}>
                <div className="profile-section-header">
                  <h2>Password</h2>
                </div>
                {user?.passwordEnabled && (
                  <label className="edit-profile-field">
                    <span>Current password</span>
                    <input
                      type="password"
                      required
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                    />
                  </label>
                )}
                <label className="edit-profile-field">
                  <span>{user?.passwordEnabled ? "New password" : "Password"}</span>
                  <input
                    type="password"
                    required
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                {passwordStatus && <p className="edit-profile-status">{passwordStatus}</p>}
                {passwordError && <p className="edit-profile-error">{passwordError}</p>}
                <button className="album-action-button" type="submit">Update Password</button>
              </form>

              <Link className="edit-profile-footer-link" to="/account">
                Return to profile
              </Link>
            </div>
          )}
        </section>
      </Show>

      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
    </>
  );
}

export default EditProfile;
