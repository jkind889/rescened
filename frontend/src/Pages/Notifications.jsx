import { API_BASE_URL } from "../config/api";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import AsyncState from "../Components/Loading/AsyncState";
import { getApiErrorMessage } from "../utils/apiErrors";

const PREFERENCE_OPTIONS = [
  { type: "review_like", label: "Likes on your reviews" },
  { type: "follow", label: "New followers" },
  { type: "followed_review", label: "Reviews from people you follow", detail: "Only for albums on one of your boards." },
  { type: "suggestion_status", label: "Updates on your suggestions", detail: "Always on, so you know when a suggestion needs changes." },
];

const SUGGESTION_STATUS_COPY = {
  approved: "was approved",
  needs_changes: "needs changes",
  rejected: "was not accepted",
  duplicate: "was marked as a duplicate",
};

const SUGGESTION_TYPE_LABELS = {
  new_album: "Album suggestion",
  catalog_correction: "Correction",
  genre_suggestion: "Genre suggestion",
};

function formatNotificationDate(value) {
  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return "Date unavailable";
  }

  return parsedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function albumLine(album) {
  if (!album) return "Album unavailable";
  return `${album.title || "Untitled album"} by ${album.artistDisplayName || "Unknown artist"}`;
}

// Copy and destination for each type. Unknown future types fall back to a
// generic row, so an older page never breaks on a new type.
function describeNotification(notification) {
  const actorName = notification.actor?.username || "Someone";
  const subject = notification.subject;

  if (notification.type === "review_like") {
    return {
      label: "Review like",
      title: `${actorName} liked your review`,
      detail: subject ? albumLine(subject.album) : "This review is no longer available",
      path: subject?.review?.reviewId ? `/review/${subject.review.reviewId}` : "",
    };
  }

  if (notification.type === "followed_review") {
    return {
      label: "From your circle",
      title: `${actorName} reviewed an album on your boards`,
      detail: subject ? albumLine(subject.album) : "This review is no longer available",
      path: subject?.review?.reviewId ? `/review/${subject.review.reviewId}` : "",
    };
  }

  if (notification.type === "follow") {
    return {
      label: "Follow",
      title: `${actorName} followed you`,
      detail: notification.actor?.username || "",
      path: notification.actorUserId ? `/profile/${encodeURIComponent(notification.actorUserId)}` : "",
    };
  }

  if (notification.type === "suggestion_status") {
    const status = SUGGESTION_STATUS_COPY[subject?.status] || "was updated";
    return {
      label: SUGGESTION_TYPE_LABELS[subject?.submissionType] || "Suggestion",
      title: `Your suggestion ${status}`,
      detail: subject ? subject.title || "Untitled suggestion" : "This suggestion is no longer available",
      path: subject?.submissionId ? `/suggestions/${subject.submissionId}` : "",
    };
  }

  return { label: "Notification", title: `${actorName} sent you a notification`, detail: "", path: "" };
}

function NotificationRow({ notification }) {
  const { label, title, detail, path } = describeNotification(notification);
  const className = notification.readAt ? "notification-row" : "notification-row notification-row-unread";
  const avatarName = notification.actor?.username || "A";
  const content = (
    <>
      {!notification.readAt && <span className="notification-unread-dot" aria-label="Unread notification" />}
      <div className="notification-avatar-wrap">
        {notification.actor?.imageUrl ? (
          <img className="notification-avatar" src={notification.actor.imageUrl} alt="" />
        ) : (
          <span className="notification-avatar notification-avatar-fallback">
            {avatarName.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>
      <div className="notification-copy">
        <span>{label}</span>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      <time dateTime={notification.createdAt}>{formatNotificationDate(notification.createdAt)}</time>
    </>
  );

  return path
    ? <Link className={className} to={path}>{content}</Link>
    : <div className={className}>{content}</div>;
}

function NotificationSettings({ request }) {
  const [preferences, setPreferences] = useState(null);
  const [savingType, setSavingType] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let isCurrent = true;

    request("/profile/me/notification-preferences")
      .then((data) => { if (isCurrent) setPreferences(data.preferences); })
      .catch((settingsError) => { if (isCurrent) setError(settingsError.message); });

    return () => { isCurrent = false; };
  }, [request]);

  async function toggle(type, enabled) {
    setSavingType(type);
    setError("");

    try {
      const data = await request("/profile/me/notification-preferences", {
        method: "PATCH",
        body: { [type]: enabled },
      });
      setPreferences(data.preferences);
    } catch (settingsError) {
      setError(settingsError.message);
    } finally {
      setSavingType("");
    }
  }

  return (
    <section className="notification-settings" aria-labelledby="notification-settings-title">
      <h2 id="notification-settings-title">Notify me about</h2>
      {!preferences && !error && <p className="notification-settings-note">Loading settings...</p>}
      {preferences && (
        <ul>
          {PREFERENCE_OPTIONS.map((option) => {
            const isLocked = option.type === "suggestion_status";
            return (
              <li key={option.type}>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences[option.type] !== false}
                    disabled={isLocked || Boolean(savingType)}
                    onChange={(event) => toggle(option.type, event.target.checked)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.detail && <small>{option.detail}</small>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p className="notification-settings-note">
        Muting stops new notifications of that type. Ones you already have stay until you clear them.
      </p>
      {error && <p className="notification-settings-error" role="alert">{error}</p>}
    </section>
  );
}

export function Notifications() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");

  const request = useCallback(async (path, { method = "GET", body } = {}) => {
    const token = await getToken();
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response, "Something went wrong. Please try again."));
    }

    return response.json();
  }, [getToken]);

  // Rows stay highlighted for this visit; the server records them as read.
  const markLoadedRead = useCallback(async (rows) => {
    const unreadIds = rows.filter((row) => !row.readAt).map((row) => row.notificationId);
    if (!unreadIds.length) return;

    try {
      await request("/notifications/read", { method: "POST", body: { notificationIds: unreadIds } });
    } catch (readError) {
      console.error(readError);
    }
  }, [request]);

  const fetchPage = useCallback(async (cursor) => {
    const params = new URLSearchParams({ markRead: "false" });
    if (cursor) params.set("cursor", cursor);
    const data = await request(`/notifications?${params}`);
    const rows = Array.isArray(data.notifications) ? data.notifications : [];
    markLoadedRead(rows);
    return { rows, nextCursor: data.nextCursor || null };
  }, [markLoadedRead, request]);

  useEffect(() => {
    let isCurrent = true;

    async function fetchNotifications() {
      if (!isLoaded) {
        return;
      }

      if (!isSignedIn) {
        setIsLoading(false);
        setNotifications([]);
        return;
      }

      try {
        setIsLoading(true);
        setError("");
        const page = await fetchPage(null);

        if (!isCurrent) {
          return;
        }

        setNotifications(page.rows);
        setNextCursor(page.nextCursor);
      } catch (notificationError) {
        console.error(notificationError);

        if (isCurrent) {
          setError("Could not load your notifications right now.");
        }
      } finally {
        if (isCurrent) {
          setIsLoading(false);
        }
      }
    }

    fetchNotifications();

    return () => {
      isCurrent = false;
    };
  }, [fetchPage, isLoaded, isSignedIn]);

  async function loadMore() {
    setIsLoadingMore(true);
    setActionError("");

    try {
      const page = await fetchPage(nextCursor);
      setNotifications((current) => {
        const seen = new Set(current.map((row) => row.notificationId));
        return [...current, ...page.rows.filter((row) => !seen.has(row.notificationId))];
      });
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setActionError(loadError.message);
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function markAllRead() {
    setIsUpdating(true);
    setActionError("");

    try {
      await request("/notifications/read", { method: "POST", body: { all: true } });
      const now = new Date().toISOString();
      setNotifications((current) => current.map((row) => (row.readAt ? row : { ...row, readAt: now })));
    } catch (readError) {
      setActionError(readError.message);
    } finally {
      setIsUpdating(false);
    }
  }

  async function clearAll() {
    if (!window.confirm("Clear all of your notifications? This cannot be undone.")) return;
    setIsUpdating(true);
    setActionError("");

    try {
      await request("/notifications/clear", { method: "POST", body: { all: true } });
      setNotifications([]);
      setNextCursor(null);
    } catch (clearError) {
      setActionError(clearError.message);
    } finally {
      setIsUpdating(false);
    }
  }

  const hasNotifications = notifications.length > 0;

  return (
    <section className="notifications-page">
      <div className="notifications-header">
        <div>
          <p className="reviews-kicker">Account</p>
          <h1>Notifications</h1>
        </div>
        {isSignedIn && (
          <div className="notifications-actions">
            {hasNotifications && (
              <>
                <button className="community-text-button" type="button" onClick={markAllRead} disabled={isUpdating}>
                  Mark all read
                </button>
                <button className="community-text-button" type="button" onClick={clearAll} disabled={isUpdating}>
                  Clear all
                </button>
              </>
            )}
            <button
              className="community-secondary-button"
              type="button"
              aria-expanded={showSettings}
              onClick={() => setShowSettings((current) => !current)}
            >
              {showSettings ? "Hide settings" : "Settings"}
            </button>
          </div>
        )}
      </div>

      {showSettings && <NotificationSettings request={request} />}
      {actionError && <p className="notification-settings-error" role="alert">{actionError}</p>}

      <AsyncState
        isLoading={isLoading || !isLoaded}
        error={error}
        isEmpty={!hasNotifications}
        loadingVariant="list"
        loadingMessage="Loading notifications..."
        errorTitle="Notifications unavailable"
        emptyTitle="No notifications yet"
        emptyBody="Likes, follows, reviews from your circle, and suggestion updates will appear here."
      >
        <div className="notifications-list">
          {notifications.map((notification) => (
            <NotificationRow key={notification.notificationId} notification={notification} />
          ))}
        </div>
        {nextCursor && (
          <button className="community-secondary-button notifications-more" type="button" onClick={loadMore} disabled={isLoadingMore}>
            {isLoadingMore ? "Loading..." : "Load more"}
          </button>
        )}
      </AsyncState>
    </section>
  );
}

export default Notifications;
