import { API_BASE_URL } from "../config/api";
import {Link, useLocation, useNavigate, useParams} from "react-router-dom";
import {useState, useEffect, useRef } from "react";
import ReviewForm from "./ReviewForm";
import ListenForm from "./ListenForm";
import AlbumReviewFeed from "./AlbumReviewFeed";
import LikeButton from "./LikeButton";
import AsyncState from "./Loading/AsyncState";
import { SignInButton, useAuth } from "@clerk/react";
import { getApiErrorMessage } from "../utils/apiErrors";

const RATING_BUCKETS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

const getEmptyRatingDistribution = () => (
    RATING_BUCKETS.map((rating) => ({ rating, count: 0 }))
);

const normalizeRatingDistribution = (distribution) => {
    const countsByRating = new Map(
        (Array.isArray(distribution) ? distribution : []).map((bucket) => [
            Number(bucket.rating),
            Number(bucket.count) || 0,
        ])
    );

    return getEmptyRatingDistribution().map((bucket) => ({
        ...bucket,
        count: countsByRating.get(bucket.rating) || 0,
    }));
};

const getAverageRatingFromDistribution = (distribution) => {
    const reviewCount = distribution.reduce((total, bucket) => total + bucket.count, 0);

    if (!reviewCount) {
        return null;
    }

    const ratingTotal = distribution.reduce((total, bucket) => total + (bucket.rating * bucket.count), 0);
    return (ratingTotal / reviewCount).toFixed(1);
};

const adjustRatingDistribution = (distribution, rating, delta) => {
    const normalizedRating = Number(rating);

    if (!RATING_BUCKETS.includes(normalizedRating)) {
        return normalizeRatingDistribution(distribution);
    }

    return normalizeRatingDistribution(distribution).map((bucket) => (
        bucket.rating === normalizedRating
            ? { ...bucket, count: Math.max(0, bucket.count + delta) }
            : bucket
    ));
};

const getDefaultAlbumSocial = () => ({
    savedCount: 0,
    reviewCount: 0,
    averageRating: null,
    ratingDistribution: getEmptyRatingDistribution(),
    followedReviewers: [],
    followedAlbumLikers: [],
});

export function AlbumDetail()
{
    const {albumId} = useParams();
    const navigate = useNavigate();
    const [album, setAlbum] = useState(null);
    const [isAlbumLoading, setIsAlbumLoading] = useState(true);
    const [albumError, setAlbumError] = useState("");
    const [reviews, setReviews] = useState([]);
    const [nextReviewCursor, setNextReviewCursor] = useState(null);
    const [recentReviewPreviews, setRecentReviewPreviews] = useState([]);
    const [popularReviewPreviews, setPopularReviewPreviews] = useState([]);
    const [recentPreviewHasMore, setRecentPreviewHasMore] = useState(false);
    const [popularPreviewHasMore, setPopularPreviewHasMore] = useState(false);
    const [isReviewsLoading, setIsReviewsLoading] = useState(false);
    const [isLoadingMoreReviews, setIsLoadingMoreReviews] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [isBoardStateLoading, setIsBoardStateLoading] = useState(false);
    const [savedBoardIds, setSavedBoardIds] = useState([]);
    const [boards, setBoards] = useState([]);
    const [activeTab, setActiveTab] = useState("artist");
    const [isListenModalOpen, setIsListenModalOpen] = useState(false);
    const [listenMessage, setListenMessage] = useState("");
    const [boardListenId, setBoardListenId] = useState("");
    const [listens, setListens] = useState([]);
    const [listenCursor, setListenCursor] = useState(null);
    const [listenError, setListenError] = useState("");
    const [isLoadingListens, setIsLoadingListens] = useState(false);
    const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
    const [isBoardModalOpen, setIsBoardModalOpen] = useState(false);
    const [newBoardTitle, setNewBoardTitle] = useState("");
    const [boardSaveMessage, setBoardSaveMessage] = useState("");
    const [isSavingBoard, setIsSavingBoard] = useState(false);
    const [albumLike, setAlbumLike] = useState({ likeCount: 0, likedByViewer: false });
    const [albumSocial, setAlbumSocial] = useState(getDefaultAlbumSocial);
    const [expandedSocialSections, setExpandedSocialSections] = useState({});
    const [likeMessage, setLikeMessage] = useState("");
    const [reviewActionMessage, setReviewActionMessage] = useState("");
    const [deletingReviewId, setDeletingReviewId] = useState("");
    const [deleteErrors, setDeleteErrors] = useState({});
    const { getToken, isSignedIn, userId } = useAuth();
    const location = useLocation();
    const canUseAuthenticatedActions = Boolean(isSignedIn && userId);
    const activeAlbumIdRef = useRef(albumId);

    useEffect(() => {
        activeAlbumIdRef.current = albumId;
        const controller = new AbortController();
        const isReviewsRoute = location.pathname.endsWith("/reviews");
        const reviewSort = new URLSearchParams(location.search).get("sort") === "popular" ? "popular" : "recent";

        async function fetchReviews() {
            setIsReviewsLoading(true);
            setReviews([]);
            setNextReviewCursor(null);
            try {
                const token = userId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const baseUrl = `${API_BASE_URL}/reviews/review/album/${albumId}`;
                if (isReviewsRoute) {
                    const response = await fetch(`${baseUrl}?sort=${reviewSort}`, { headers, signal: controller.signal });
                    if (!response.ok) throw new Error("Failed to fetch reviews");
                    const data = await response.json();
                    if (!controller.signal.aborted) {
                        setReviews(Array.isArray(data.reviews) ? data.reviews : []);
                        setNextReviewCursor(data.nextCursor || null);
                    }
                    return;
                }
                const [recentResponse, popularResponse] = await Promise.all([
                    fetch(`${baseUrl}?sort=recent&limit=3`, { headers, signal: controller.signal }),
                    fetch(`${baseUrl}?sort=popular&limit=3`, { headers, signal: controller.signal }),
                ]);
                if (!recentResponse.ok || !popularResponse.ok) throw new Error("Failed to fetch review previews");
                const [recentData, popularData] = await Promise.all([recentResponse.json(), popularResponse.json()]);
                if (!controller.signal.aborted) {
                    setRecentReviewPreviews(Array.isArray(recentData.reviews) ? recentData.reviews : []);
                    setPopularReviewPreviews(Array.isArray(popularData.reviews) ? popularData.reviews : []);
                    setRecentPreviewHasMore(Boolean(recentData.nextCursor));
                    setPopularPreviewHasMore(Boolean(popularData.nextCursor));
                }
            } catch {
                if (!controller.signal.aborted) {
                    setReviews([]);
                    setRecentReviewPreviews([]);
                    setPopularReviewPreviews([]);
                }
            } finally {
                if (!controller.signal.aborted) setIsReviewsLoading(false);
            }
        }
        if (albumId) void fetchReviews();
        return () => controller.abort();
    }, [getToken, albumId, location.pathname, location.search, userId]);

    useEffect(() => {
        const controller = new AbortController();
        async function fetchAlbumLike() {
            try {
                const token = userId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const res = await fetch(`${API_BASE_URL}/likes/album/${albumId}`, { headers, signal: controller.signal });

                if (!res.ok) {
                    setAlbumLike({ likeCount: 0, likedByViewer: false });
                    return;
                }

                const data = await res.json();
                setAlbumLike({
                    likeCount: Number(data.likeCount) || 0,
                    likedByViewer: Boolean(data.likedByViewer),
                });
            } catch {
                if (controller.signal.aborted) return;
                setAlbumLike({ likeCount: 0, likedByViewer: false });
            }
        }

        if (albumId) void fetchAlbumLike();
        return () => controller.abort();
    }, [getToken, albumId, userId]);

    useEffect(() => {
        const controller = new AbortController();

        async function fetchAlbumSocial() {
            try {
                const token = userId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const res = await fetch(`${API_BASE_URL}/albums/album/${albumId}/social`, { headers, signal: controller.signal });

                if (!res.ok) {
                    throw new Error("Failed to fetch album social context");
                }

                const data = await res.json();

                if (!controller.signal.aborted) {
                    setAlbumSocial({
                        savedCount: Number(data.savedCount) || 0,
                        reviewCount: Number(data.reviewCount) || 0,
                        averageRating: Number.isFinite(Number(data.averageRating)) ? Number(data.averageRating) : null,
                        ratingDistribution: normalizeRatingDistribution(data.ratingDistribution),
                        followedReviewers: Array.isArray(data.followedReviewers) ? data.followedReviewers : [],
                        followedAlbumLikers: Array.isArray(data.followedAlbumLikers) ? data.followedAlbumLikers : [],
                    });
                }
            } catch {
                if (!controller.signal.aborted) {
                    setAlbumSocial(getDefaultAlbumSocial());
                }
            }
        }

        if (albumId) void fetchAlbumSocial();
        return () => controller.abort();
    }, [getToken, albumId, userId]);

    useEffect(() => {
        let shouldIgnore = false;

        async function checkIfSaved() {
            if (!canUseAuthenticatedActions) {
                setIsBoardStateLoading(false);
                setIsSaved(false);
                setSavedBoardIds([]);
                setBoards([]);
                setIsBoardModalOpen(false);
                return;
            }

            try {
                setIsBoardStateLoading(true);
                const token = await getToken();

                const res = await fetch(
                `${API_BASE_URL}/boards/album/${albumId}`,
                {
                    headers: {
                    Authorization: `Bearer ${token}`,
                    },
                }
                );

                if (shouldIgnore) {
                    return;
                }

                if (!res.ok) {
                    setIsSaved(false);
                    setSavedBoardIds([]);
                    return;
                }

                const data = await res.json();
                setIsSaved(data.saved);
                setSavedBoardIds(Array.isArray(data.boards) ? data.boards.map((board) => String(board.boardId)) : []);
            } catch (error) {
                console.error("Failed to check board saves", error);

                if (!shouldIgnore) {
                    setIsSaved(false);
                    setSavedBoardIds([]);
                }
            } finally {
                if (!shouldIgnore) {
                    setIsBoardStateLoading(false);
                }
            }
        }

        if (albumId) {
            checkIfSaved();
        }

        return () => {
            shouldIgnore = true;
        };
    }, [canUseAuthenticatedActions, albumId, getToken]);
        

    useEffect(() => {
        let shouldIgnore = false;

        async function fetchAlbum() {
            try {
                setIsAlbumLoading(true);
                setAlbumError("");

                const res = await fetch(`${API_BASE_URL}/albums/album/${albumId}`);

                if (!res.ok) {
                    throw new Error(await getApiErrorMessage(res, "Failed to fetch album"));
                }

                const data = await res.json();

                if (!shouldIgnore) {
                    setAlbum(data);
                }
            } catch (error) {
                console.error("Failed to fetch album", error);

                if (!shouldIgnore) {
                    setAlbum(null);
                    setAlbumError(error.message || "Could not load this album.");
                }
            } finally {
                if (!shouldIgnore) {
                    setIsAlbumLoading(false);
                }
            }
        }

        if (albumId) {
            fetchAlbum();
        }

        return () => {
            shouldIgnore = true;
        };
    }, [albumId])

    async function addReview(review, idempotencyKey) {
        if (!canUseAuthenticatedActions) {
            return false;
        }

        setReviewActionMessage("");
        try {
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/reviews/review`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
                body: JSON.stringify(review),
            });
            if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to submit review"));
            const newReview = await res.json();
            if (activeAlbumIdRef.current !== review.albumId) return true;
            setReviews((current) => current.some((item) => item.reviewId === newReview.reviewId) ? current : [newReview, ...current]);
            setRecentReviewPreviews((current) => [newReview, ...current.filter((item) => item.reviewId !== newReview.reviewId)].slice(0, 3));
            setPopularReviewPreviews((current) => current.some((item) => item.reviewId === newReview.reviewId) ? current : current);
            if (res.status === 201) {
                setAlbumSocial((currentSocial) => {
                    const ratingDistribution = adjustRatingDistribution(currentSocial.ratingDistribution, newReview.rating, 1);
                    return { ...currentSocial, reviewCount: (Number(currentSocial.reviewCount) || 0) + 1, averageRating: getAverageRatingFromDistribution(ratingDistribution), ratingDistribution };
                });
            }
            return true;
        } catch (error) {
            setReviewActionMessage(error.message || "Could not submit your review.");
            throw error;
        }

    };

    async function removeReview(reviewId) {
        if (!canUseAuthenticatedActions || deletingReviewId) {
            return false;
        }
        setDeletingReviewId(reviewId);
        setDeleteErrors((current) => ({ ...current, [reviewId]: "" }));
        try {
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/reviews/review/user/${reviewId}`, { method: "DELETE", headers: { "Authorization": `Bearer ${token}` } });
            if (!res.ok) throw new Error(await getApiErrorMessage(res, "Failed to delete review"));
            if (activeAlbumIdRef.current !== albumId) return true;
            let removedReview = null;
            setReviews((current) => {
                removedReview = current.find((review) => review.reviewId === reviewId) || null;
                return current.filter((review) => review.reviewId !== reviewId);
            });
            setRecentReviewPreviews((current) => current.filter((review) => review.reviewId !== reviewId));
            setPopularReviewPreviews((current) => current.filter((review) => review.reviewId !== reviewId));
            if (removedReview) {
                setAlbumSocial((currentSocial) => {
                    const ratingDistribution = adjustRatingDistribution(currentSocial.ratingDistribution, removedReview.rating, -1);
                    return { ...currentSocial, reviewCount: Math.max(0, (Number(currentSocial.reviewCount) || 0) - 1), averageRating: getAverageRatingFromDistribution(ratingDistribution), ratingDistribution };
                });
            }
            return true;
        } catch (error) {
            setDeleteErrors((current) => ({ ...current, [reviewId]: error.message || "Could not delete that review." }));
            return false;
        } finally {
            setDeletingReviewId("");
        }
    };

    async function loadMoreReviews() {
        if (!nextReviewCursor || isLoadingMoreReviews) return;
        setIsLoadingMoreReviews(true);
        try {
            const token = userId ? await getToken() : null;
            const headers = token ? { Authorization: `Bearer ${token}` } : {};
            const response = await fetch(`${API_BASE_URL}/reviews/review/album/${albumId}?sort=${reviewSort}&cursor=${encodeURIComponent(nextReviewCursor)}`, { headers });
            if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load more reviews."));
            const data = await response.json();
            if (activeAlbumIdRef.current !== albumId) return;
            setReviews((current) => {
                const ids = new Set(current.map((review) => review.reviewId));
                return [...current, ...(Array.isArray(data.reviews) ? data.reviews.filter((review) => !ids.has(review.reviewId)) : [])];
            });
            setNextReviewCursor(data.nextCursor || null);
        } catch (error) {
            setReviewActionMessage(error.message || "Could not load more reviews.");
        } finally {
            setIsLoadingMoreReviews(false);
        }
    }

    function updateReviewLikeState(reviewId, nextState) {
        setReviews((currentReviews) => (
            currentReviews.map((review) => (
                review.reviewId === reviewId ? { ...review, ...nextState } : review
            ))
        ));
    }

    async function toggleReviewLike(review) {
        if (!canUseAuthenticatedActions) {
            setLikeMessage("Sign in to like reviews.");
            return;
        }

        const reviewId = review.reviewId;
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
        } catch (error) {
            console.error(error);
            updateReviewLikeState(reviewId, {
                likedByViewer: Boolean(review.likedByViewer),
                likeCount: previousLikeCount,
            });
            setLikeMessage(error.message || "Could not update that like.");
        }
    }

    async function toggleAlbumLike() {
        if (!canUseAuthenticatedActions) {
            setLikeMessage("Sign in to like albums.");
            return;
        }

        const nextLiked = !albumLike.likedByViewer;
        const previousAlbumLike = albumLike;
        const nextLikeCount = Math.max(0, (Number(albumLike.likeCount) || 0) + (nextLiked ? 1 : -1));

        setLikeMessage("");
        setAlbumLike({
            likedByViewer: nextLiked,
            likeCount: nextLikeCount,
        });

        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/likes/album/${albumId}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ liked: nextLiked }),
            });

            if (!response.ok) {
                throw new Error(await getApiErrorMessage(response, "Failed to update album like"));
            }

            const data = await response.json();
            setAlbumLike({
                likedByViewer: Boolean(data.likedByViewer),
                likeCount: Number(data.likeCount) || 0,
            });
        } catch (error) {
            console.error(error);
            setAlbumLike(previousAlbumLike);
            setLikeMessage(error.message || "Could not update that like.");
        }
    }

     if (isAlbumLoading || albumError || !album) {
        return (
            <AsyncState
                isLoading={isAlbumLoading}
                error={albumError}
                isEmpty={!isAlbumLoading && !albumError && !album}
                loadingVariant="detail"
                loadingMessage="Loading album"
                errorTitle="Album unavailable"
                emptyTitle="Album unavailable"
                emptyBody="This album could not be found."
            />
        );
     }

    const artistNames = album.artistCredits?.length ? album.artistCredits.map((credit) => credit.name) : [album.artistDisplayName];
    const userReviews = reviews.filter((review) => review.userId);
    const socialReviewCount = Number(albumSocial.reviewCount) || userReviews.length;
    const socialSavedCount = Number(albumSocial.savedCount) || 0;
    const localAverageRating = userReviews.length
        ? (userReviews.reduce((total, item) => total + (Number(item.rating) || 0), 0) / userReviews.length).toFixed(1)
        : null;
    const ratingDistribution = normalizeRatingDistribution(albumSocial.ratingDistribution);
    const distributionAverageRating = getAverageRatingFromDistribution(ratingDistribution);
    const averageRating = Number.isFinite(Number(albumSocial.averageRating))
        ? Number(albumSocial.averageRating).toFixed(1)
        : distributionAverageRating || localAverageRating;
    const maxRatingBucketCount = Math.max(...ratingDistribution.map((bucket) => bucket.count), 0);
    const albumArt = album.cover;
    const isReviewsRoute = location.pathname.endsWith("/reviews");
    const reviewSort = new URLSearchParams(location.search).get("sort") === "popular" ? "popular" : "recent";
    const releaseDateLabel = album.releaseDate
        ? new Date(`${album.releaseDate}T00:00:00`).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: album.releaseDate.length > 7 ? "numeric" : undefined
          })
        : null;
    const sortedTracks = [...(album.tracks || [])].sort((first, second) => {
        const firstDisc = Number(first.discNumber) || 1;
        const secondDisc = Number(second.discNumber) || 1;
        const firstTrack = Number(first.trackNumber) || 0;
        const secondTrack = Number(second.trackNumber) || 0;

        return firstDisc - secondDisc || firstTrack - secondTrack;
    });
    const hasMultipleDiscs = sortedTracks.some((track) => Number(track.discNumber) > 1);
    const previewTracks = sortedTracks.slice(0, 14);
    const hasMoreTracks = sortedTracks.length > 14;
    const selectedReviews = reviews;
    const formatTrackDuration = (durationMs) => {
        const totalSeconds = Math.floor((Number(durationMs) || 0) / 1000);

        if (!totalSeconds) {
            return "--:--";
        }

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = String(totalSeconds % 60).padStart(2, "0");

        return `${minutes}:${seconds}`;
    };

    async function fetchListens(cursor = null) {
        setIsLoadingListens(true);
        setListenError("");
        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/diary?albumId=${albumId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!response.ok) throw new Error(await getApiErrorMessage(response, "Could not load listens."));
            const data = await response.json();
            if (activeAlbumIdRef.current !== albumId) return;
            setListens((current) => cursor ? [...current, ...data.listens] : data.listens);
            setListenCursor(data.nextCursor || null);
        } catch (error) {
            setListenError(error.message);
        } finally {
            setIsLoadingListens(false);
        }
    }

    async function fetchBoards() {
        if (!canUseAuthenticatedActions) {
            return;
        }

        const token = await getToken();
        const res = await fetch(`${API_BASE_URL}/boards`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        if (!res.ok) {
            throw new Error("Failed to fetch boards");
        }

        const data = await res.json();
        setBoards(Array.isArray(data) ? data : []);
    }

    async function openBoardModal() {
        if (!canUseAuthenticatedActions) {
            return;
        }

        try {
            await fetchBoards();
            setBoardListenId("");
            setListens([]);
            setListenCursor(null);
            void fetchListens();
            setBoardSaveMessage("");
            setIsBoardModalOpen(true);
        } catch (error) {
            console.error(error);
            alert("Failed to load boards. Please try again.");
        }
    }

    async function saveAlbumToBoard(boardId) {
        if (!canUseAuthenticatedActions || isSavingBoard) {
            return;
        }

        try {
            const wasSaved = isSaved;
            setIsSavingBoard(true);
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/boards/${boardId}/${boardListenId ? `listens/${boardListenId}` : "albums"}`, {
                method: boardListenId ? "PUT" : "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: boardListenId ? undefined : JSON.stringify({ albumId: album.albumId }),
            });

            if (!res.ok) {
                throw new Error(await getApiErrorMessage(res, "Failed to save album to board"));
            }

            const data = await res.json();
            setIsSaved(true);
            if (!wasSaved) {
                setAlbumSocial((currentSocial) => ({
                    ...currentSocial,
                    savedCount: (Number(currentSocial.savedCount) || 0) + 1,
                }));
            }
            setSavedBoardIds((currentIds) => [...new Set([...currentIds, String(boardId)])]);
            setBoardSaveMessage(boardListenId ? "Listen added to board." : `Saved to ${data.board?.title || "board"}.`);
            await fetchBoards();
        } catch (error) {
            console.error(error);
            setBoardSaveMessage(error.message || "Could not save to that board.");
        } finally {
            setIsSavingBoard(false);
        }
    }

    async function createBoardAndSave(event) {
        event.preventDefault();

        if (!canUseAuthenticatedActions) {
            return;
        }

        const title = newBoardTitle.trim();

        if (!title || isSavingBoard) {
            return;
        }

        try {
            setIsSavingBoard(true);
            const token = await getToken();
            const createResponse = await fetch(`${API_BASE_URL}/boards`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ title }),
            });

            if (!createResponse.ok) {
                throw new Error("Failed to create board");
            }

            const createdBoard = await createResponse.json();
            setBoards((currentBoards) => [createdBoard, ...currentBoards]);
            setNewBoardTitle("");
            setIsSavingBoard(false);
            await saveAlbumToBoard(createdBoard.boardId);
        } catch (error) {
            console.error(error);
            setBoardSaveMessage("Could not create that board.");
            setIsSavingBoard(false);
        }
    }

    const renderSignInAction = (label, icon = null) => (
        <SignInButton mode="modal">
            <button className="album-side-action" type="button">
                {icon && <span aria-hidden="true">{icon}</span>}
                {label}
            </button>
        </SignInButton>
    );

    const getSocialInitial = (user) => {
        const username = String(user.username || "").trim();
        return username ? username.charAt(0).toUpperCase() : "?";
    };

    const renderSocialUser = (user) => (
        <Link className="album-social-user" key={user.userId} to={`/profile/${encodeURIComponent(user.userId)}`}>
            <span className="album-social-avatar" aria-hidden="true">
                {user.imageUrl ? <img src={user.imageUrl} alt="" /> : getSocialInitial(user)}
            </span>
            <span>{user.username || "rescened user"}</span>
        </Link>
    );

    const renderSocialSection = ({ id: sectionId, title, users }) => {
        if (users.length === 0) {
            return null;
        }

        const isExpanded = Boolean(expandedSocialSections[sectionId]);
        const visibleUsers = isExpanded ? users : users.slice(0, 3);
        const hiddenCount = users.length - visibleUsers.length;

        return (
            <div className="album-social-section" key={sectionId}>
                <div className="album-social-section-header">
                    <span>{title}</span>
                    <strong>{users.length}</strong>
                </div>
                <div className="album-social-users">
                    {visibleUsers.map(renderSocialUser)}
                </div>
                {users.length > 3 && (
                    <button
                        className="album-social-toggle"
                        type="button"
                        onClick={() => setExpandedSocialSections((currentSections) => ({
                            ...currentSections,
                            [sectionId]: !isExpanded,
                        }))}
                    >
                        {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                )}
            </div>
        );
    };

    const socialSections = [
        {
            id: "reviewers",
            title: "Reviewed by people you follow",
            users: albumSocial.followedReviewers,
        },
        {
            id: "likers",
            title: "Liked by people you follow",
            users: albumSocial.followedAlbumLikers,
        },
    ];
    const hasAlbumSocialConnections = socialSections.some((section) => section.users.length > 0);



    return (

        <section className="album-detail-page">
            <div className="album-detail-shell">
                <aside className="album-detail-sidebar">
                    <div className="album-poster-card">
                        {albumArt ? (
                            <img
                                className="album-poster-image"
                                src={albumArt}
                                alt={`${album.title} cover`}
                            />
                        ) : (
                            <div className="album-poster-fallback">No cover art</div>
                        )}
                    </div>

                    <div className="album-side-actions" aria-label="Album actions">
                        <div className="album-listen-like-group" role="group" aria-label="Listens and likes">
                            {canUseAuthenticatedActions ? (
                                <button className="album-side-action" type="button" onClick={() => setIsListenModalOpen(true)}>
                                    <span aria-hidden="true">＋</span>Log listen
                                </button>
                            ) : renderSignInAction("Log listen", "＋")}
                            <div className="album-side-action album-like-action">
                                <LikeButton liked={albumLike.likedByViewer} count={albumLike.likeCount} label="album" message={likeMessage} onToggle={toggleAlbumLike} />
                                <small>{albumLike.likedByViewer ? "Liked" : "Like"}</small>
                            </div>
                        </div>
                        {canUseAuthenticatedActions ? (
                            <button className="album-side-action" type="button" onClick={openBoardModal} disabled={isBoardStateLoading}>
                                Boards…<small>{isBoardStateLoading ? "Checking…" : isSaved ? "Saved · Manage boards" : "Save or add a listen"}</small>
                            </button>
                        ) : renderSignInAction("Boards…")}
                        {canUseAuthenticatedActions ? (
                            <button className="album-side-action" type="button" onClick={() => {
                                setReviewActionMessage("");
                                setIsReviewModalOpen(true);
                            }}>
                                <span aria-hidden="true">★</span>
                                Write review
                            </button>
                        ) : renderSignInAction("Write review", "★")}
                        {canUseAuthenticatedActions ? (
                            <Link className="album-side-action" to={`/suggestions/corrections/${album.albumId}`}>
                                Suggest a correction
                            </Link>
                        ) : renderSignInAction("Suggest a correction")}
                        {listenMessage && <p className="board-save-message" role="status">{listenMessage}</p>}
                        {boardSaveMessage && <p className="board-save-message" role="status">{boardSaveMessage}</p>}
                    </div>

                    <div className="album-ratings-panel">
                        <div className="album-panel-header">
                            <span>Community</span>
                            <span>{socialReviewCount} review{socialReviewCount === 1 ? "" : "s"}</span>
                        </div>
                        <div className="album-social-stats">
                            <div>
                                <strong>{socialSavedCount}</strong>
                                <span>saved</span>
                            </div>
                            <div>
                                <strong>{socialReviewCount}</strong>
                                <span>reviewed</span>
                            </div>
                        </div>
                        <div className="album-rating-summary">
                            <div className="album-rating-bars" role="list" aria-label="Community rating distribution">
                                {ratingDistribution.map((bucket) => (
                                    <div
                                        className="album-rating-bucket"
                                        key={bucket.rating}
                                        role="listitem"
                                        aria-label={`${bucket.count} review${bucket.count === 1 ? "" : "s"} rated ${bucket.rating} stars`}
                                        title={`${bucket.rating} stars: ${bucket.count}`}
                                    >
                                        <span className="album-rating-count">{bucket.count}</span>
                                        <span
                                            className="album-rating-bar"
                                            style={{
                                                "--bar-height": maxRatingBucketCount
                                                    ? `${Math.max((bucket.count / maxRatingBucketCount) * 48, bucket.count > 0 ? 4 : 0)}px`
                                                    : "0px",
                                            }}
                                        />
                                        <span className="album-rating-label">{bucket.rating}</span>
                                    </div>
                                ))}
                            </div>
                            <strong>{averageRating || "--"}</strong>
                        </div>
                    </div>

                    {hasAlbumSocialConnections && (
                        <div className="album-social-panel">
                            {socialSections.map(renderSocialSection)}
                        </div>
                    )}
                </aside>

                <div className="album-detail-main">
                    <div className="album-title-block">
                        <p className="album-detail-kicker">{album.releaseType}</p>
                        <h1>{album.title}</h1>
                        <div className="album-meta-line">
                            <span>{album.releaseYear || "Unknown year"}</span>
                            <span>{artistNames.join(", ")}</span>
                            {album.label && <span>{album.label}</span>}
                        </div>
                    </div>

                    <nav className="album-tabs" aria-label="Album sections">
                        {["artist", "release", "format", "tracks"].map((tab) => (
                            <button
                                key={tab}
                                type="button"
                                className={activeTab === tab ? "album-tab album-tab-active" : "album-tab"}
                                onClick={() => setActiveTab(tab)}
                            >
                                {tab}
                            </button>
                        ))}
                    </nav>

                    {!isReviewsRoute && (
                        <section className="album-info-panel">
                            {activeTab === "artist" && (
                                <dl className="album-facts">
                                    <div>
                                        <dt>Artist</dt>
                                        <dd>{artistNames.join(", ")}</dd>
                                    </div>
                                    {album.label && (
                                        <div>
                                            <dt>Label</dt>
                                            <dd>{album.label}</dd>
                                        </div>
                                    )}
                                </dl>
                            )}

                            {activeTab === "release" && (
                                <dl className="album-facts">
                                    <div>
                                        <dt>Release</dt>
                                        <dd>{releaseDateLabel || album.releaseYear || "Unknown"}</dd>
                                    </div>
                                    <div>
                                        <dt>Year</dt>
                                        <dd>{album.releaseYear || "Unknown"}</dd>
                                    </div>
                                </dl>
                            )}

                            {activeTab === "format" && (
                                <dl className="album-facts">
                                    <div>
                                        <dt>Format</dt>
                                        <dd>{album.releaseType || "Album"}</dd>
                                    </div>
                                    <div>
                                        <dt>Tracks</dt>
                                        <dd>{sortedTracks.length || "Unknown"}</dd>
                                    </div>
                                </dl>
                            )}

                            {activeTab === "tracks" && (
                                <div className="album-tracklist album-tracklist-tab">
                                    {sortedTracks.length > 0 ? (
                                        <>
                                            <ol>
                                                {(hasMoreTracks ? previewTracks : sortedTracks).map((track, index) => {
                                                const trackNumber = Number(track.trackNumber) || index + 1;
                                                const discNumber = Number(track.discNumber) || 1;
                                                const trackLabel = hasMultipleDiscs
                                                    ? `${discNumber}.${trackNumber}`
                                                    : trackNumber;

                                                return (
                                                    <li key={track.trackId || `${discNumber}-${trackNumber}-${track.title}`}>
                                                        <span className="album-track-number">{trackLabel}</span>
                                                        <span className="album-track-title">{track.title || "Untitled Track"}</span>
                                                        <span className="album-track-duration">{formatTrackDuration(track.durationMs)}</span>
                                                    </li>
                                                );
                                            })}
                                            </ol>
                                            {hasMoreTracks && <span className="album-more-link">Showing first {previewTracks.length} tracks</span>}
                                        </>
                                    ) : (
                                        <p className="album-empty-copy">
                                            {album.isPartial
                                                ? "Track details are temporarily unavailable."
                                                : "No tracks available."}
                                        </p>
                                    )}
                                </div>
                            )}
                        </section>
                    )}

                    {isReviewsRoute ? (
                        <section className="album-reviews-section">
                            <div className="album-section-heading">
                                <h2>{reviewSort === "popular" ? "Popular Reviews" : "Recent Reviews"}</h2>
                                <select aria-label="Review order" value={reviewSort} onChange={(event) => navigate(`/album/${albumId}/reviews?sort=${event.target.value}`)} disabled={isReviewsLoading}>
                                    <option value="recent">Latest first</option>
                                    <option value="popular">Most liked</option>
                                </select>
                                <Link className="album-more-link" to={`/album/${albumId}`}>Back to album</Link>
                            </div>
                            <AlbumReviewFeed
                                reviews={selectedReviews}
                                currentUserId={userId}
                                onRemoveReview={removeReview}
                                onToggleReviewLike={toggleReviewLike}
                                likeMessage={likeMessage}
                                deletingReviewId={deletingReviewId}
                                deleteErrors={deleteErrors}
                            />
                            {nextReviewCursor && <button className="album-more-link" type="button" onClick={loadMoreReviews} disabled={isLoadingMoreReviews}>{isLoadingMoreReviews ? "Loading…" : "Load more reviews"}</button>}
                            {!isReviewsLoading && !nextReviewCursor && selectedReviews.length > 0 && <p className="review-list-empty">You’re all caught up.</p>}
                        </section>
                    ) : (
                        <section className="album-review-previews">
                            <div className="album-review-column">
                                <div className="album-section-heading">
                                    <h2>Popular Reviews</h2>
                                    {popularPreviewHasMore && <Link className="album-more-link" to={`/album/${albumId}/reviews?sort=popular`}>More</Link>}
                                </div>
                                <AlbumReviewFeed
                                    reviews={popularReviewPreviews.slice(0, 2)}
                                    currentUserId={userId}
                                    onRemoveReview={removeReview}
                                    onToggleReviewLike={toggleReviewLike}
                                    likeMessage={likeMessage}
                                    deletingReviewId={deletingReviewId}
                                    deleteErrors={deleteErrors}
                                />
                            </div>
                            <div className="album-review-column">
                                <div className="album-section-heading">
                                    <h2>Recent Reviews</h2>
                                    {recentPreviewHasMore && <Link className="album-more-link" to={`/album/${albumId}/reviews?sort=recent`}>More</Link>}
                                </div>
                                <AlbumReviewFeed
                                    reviews={recentReviewPreviews.slice(0, 2)}
                                    currentUserId={userId}
                                    onRemoveReview={removeReview}
                                    onToggleReviewLike={toggleReviewLike}
                                    likeMessage={likeMessage}
                                    deletingReviewId={deletingReviewId}
                                    deleteErrors={deleteErrors}
                                />
                            </div>
                        </section>
                    )}
                </div>
            </div>
            {isListenModalOpen && (
                <div className="review-modal-backdrop">
                    <div className="review-modal" role="dialog" aria-modal="true" aria-label={`Log a listen for ${album.title}`}>
                        <button className="review-modal-close" type="button" onClick={() => setIsListenModalOpen(false)} aria-label="Close listen form">×</button>
                        <ListenForm key={albumId} album={album} onSubmitted={(listen) => {
                            setIsListenModalOpen(false);
                            if (activeAlbumIdRef.current === listen.albumId) setListenMessage(`Listen logged for ${listen.listenedOn}.`);
                        }} />
                    </div>
                </div>
            )}
            {isReviewModalOpen && (
                <div className="review-modal-backdrop" role="presentation" onMouseDown={() => setIsReviewModalOpen(false)}>
                    <div className="review-modal" role="dialog" aria-modal="true" aria-label={`Review ${album.title}`} onMouseDown={(event) => event.stopPropagation()}>
                        <button className="review-modal-close" type="button" onClick={() => setIsReviewModalOpen(false)} aria-label="Close review form">
                            ×
                        </button>
                        {reviewActionMessage && <p className="review-action-message">{reviewActionMessage}</p>}
                        <ReviewForm album={album} onAddReview={addReview} onSubmitted={() => {
                            setReviewActionMessage("");
                            setIsReviewModalOpen(false);
                        }} />
                    </div>
                </div>
            )}
            {isBoardModalOpen && (
                <div className="review-modal-backdrop" role="presentation" onMouseDown={() => setIsBoardModalOpen(false)}>
                    <div className="review-modal board-save-modal" role="dialog" aria-modal="true" aria-label={`Save ${album.title} to a board`} onMouseDown={(event) => event.stopPropagation()}>
                        <button className="review-modal-close" type="button" onClick={() => setIsBoardModalOpen(false)} aria-label="Close board picker">
                            ×
                        </button>
                        <div className="board-save-modal-header">
                            <h2>Save or add a listen to a board</h2>
                            <p>{album.title}</p>
                        </div>
                        <label className="review-form-field">
                            <span>What to add</span>
                            <select value={boardListenId} onChange={(event) => { setBoardListenId(event.target.value); setBoardSaveMessage(""); }} disabled={isSavingBoard}>
                                <option value="">Save album</option>
                                {listens.map((listen) => <option key={listen.listenId} value={listen.listenId}>Listen · {listen.listenedOn} · {new Date(listen.createdAt).toLocaleTimeString()}</option>)}
                            </select>
                        </label>
                        {isLoadingListens && <p role="status">Loading listens…</p>}
                        {listenError && <p role="alert">{listenError} <button type="button" onClick={() => fetchListens(listenCursor)}>Retry</button></p>}
                        {listenCursor && <button type="button" disabled={isLoadingListens} onClick={() => fetchListens(listenCursor)}>Load older listens</button>}
                        {!isLoadingListens && !listenError && !listens.length && <p>Log a listen first to add a listening date to a board.</p>}
                        <div className="board-save-list">
                            {boards.map((board) => {
                                const boardId = String(board.boardId);
                                const alreadySaved = savedBoardIds.includes(boardId);

                                return (
                                    <button
                                        className="board-save-option"
                                        key={board.boardId}
                                        type="button"
                                        onClick={() => saveAlbumToBoard(board.boardId)}
                                        disabled={(!boardListenId && alreadySaved) || isSavingBoard}
                                    >
                                        <span>{board.title}</span>
                                        <small>{boardListenId ? "Add listen" : alreadySaved ? "Saved" : `${board.itemCount || 0} albums`}</small>
                                    </button>
                                );
                            })}
                        </div>
                        <form className="board-save-create" onSubmit={createBoardAndSave}>
                            <input
                                value={newBoardTitle}
                                onChange={(event) => setNewBoardTitle(event.target.value)}
                                placeholder="Create a new board"
                                maxLength={80}
                            />
                            <button type="submit" disabled={!newBoardTitle.trim() || isSavingBoard}>
                                Create
                            </button>
                        </form>
                        {boardSaveMessage && <p className="board-save-message">{boardSaveMessage}</p>}
                    </div>
                </div>
            )}
        </section>



        // Album Detail component rendered when user clicks on a search result, showing more information about the selected album
    );

}

export default AlbumDetail;
