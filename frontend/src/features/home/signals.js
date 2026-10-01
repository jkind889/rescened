import { API_BASE_URL } from "../../config/api";

export function getAlbumId(album) {
    return album?.albumId || "";
}

export function uniqueAlbums(albums) {
    const seenIds = new Set();

    return albums.filter((album) => {
        const albumId = getAlbumId(album);

        if (!albumId || seenIds.has(albumId)) {
            return false;
        }

        seenIds.add(albumId);
        return true;
    });
}

export function formatRating(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue.toFixed(1).replace(".0", "") : "-";
}

export function formatReviewCount(count) {
    const value = Number(count) || 0;
    return `${value} ${value === 1 ? "review" : "reviews"}`;
}

export function formatShortDate(value) {
    if (!value) {
        return "recent";
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime())
        ? "recent"
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Diary listens store a calendar date that is already resolved in the
// listener's zone, so format it in UTC to avoid shifting the day.
export function formatCalendarDate(value) {
    if (!value) {
        return "";
    }

    const date = new Date(`${value}T00:00:00Z`);

    return Number.isNaN(date.getTime())
        ? value
        : date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

// Catalog order: disc first, then track number.
export function sortTracks(tracks) {
    return [...(Array.isArray(tracks) ? tracks : [])].sort((first, second) => (
        (Number(first.discNumber) || 1) - (Number(second.discNumber) || 1)
        || (Number(first.trackNumber) || 0) - (Number(second.trackNumber) || 0)
    ));
}

export async function fetchJson(path, { signal, token } = {}) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
        signal,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

    if (!response.ok) {
        throw new Error(`${path} failed`);
    }

    return response.json();
}

export function settledArray(result, key) {
    if (result.status !== "fulfilled") {
        return [];
    }

    const value = key ? result.value?.[key] : result.value;
    return Array.isArray(value) ? value.filter(Boolean) : [];
}
