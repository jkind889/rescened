export const COMMUNITY_STATUSES = Object.freeze([
  "pending",
  "needs_changes",
  "approved",
  "rejected",
  "duplicate",
  "withdrawn",
]);

export const COMMUNITY_STATUS_LABELS = Object.freeze({
  pending: "Pending review",
  needs_changes: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  duplicate: "Marked duplicate",
  withdrawn: "Withdrawn",
});

export const RELEASE_TYPE_OPTIONS = Object.freeze([
  { value: "album", label: "Album" },
  { value: "ep", label: "EP" },
  { value: "single", label: "Single" },
  { value: "mixtape", label: "Mixtape" },
  { value: "soundtrack", label: "Soundtrack" },
  { value: "compilation", label: "Compilation" },
  { value: "live", label: "Live" },
  { value: "remix", label: "Remix" },
  { value: "other", label: "Other" },
]);

export const SOURCE_TYPE_OPTIONS = Object.freeze([
  { value: "musicbrainz", label: "MusicBrainz" },
  { value: "official_artist", label: "Official artist" },
  { value: "official_label", label: "Official label" },
  { value: "distributor", label: "Distributor" },
  { value: "store", label: "Store" },
  { value: "spotify", label: "Spotify evidence" },
  { value: "other", label: "Other" },
]);

export const WITHDRAWABLE_SUGGESTION_STATUSES = Object.freeze([
  "pending",
  "needs_changes",
]);

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function wordsFromIdentifier(value) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function retryAfterFrom(response, data) {
  const value = data?.retryAfterSeconds ?? response?.headers?.get?.("Retry-After");
  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

export function formatCommunityDate(value) {
  if (!value) {
    return "Date unavailable";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : DATE_FORMATTER.format(date);
}

export function formatCommunityStatus(status) {
  return COMMUNITY_STATUS_LABELS[status] || wordsFromIdentifier(status) || "Unknown";
}

export function formatCommunityAction(action) {
  const labels = {
    submitted: "Submitted",
    revised: "Revision submitted",
    withdrawn: "Withdrawn",
    request_changes: "Changes requested",
    requested_changes: "Changes requested",
    approved: "Approved",
    rejected: "Rejected",
    mark_duplicate: "Marked duplicate",
    marked_duplicate: "Marked duplicate",
  };

  return labels[action] || wordsFromIdentifier(action) || "Updated";
}

export function formatCommunityValue(value) {
  const labels = {
    ep: "EP",
    artistLinks: "Artist links",
    musicbrainz: "MusicBrainz",
    spotify: "Spotify",
  };

  if (Object.prototype.hasOwnProperty.call(labels, value)) {
    return labels[value];
  }

  return wordsFromIdentifier(value) || "Not supplied";
}

export async function parseCommunityApiError(response, fallback = "Request failed") {
  const data = await response?.json?.().catch(() => ({})) || {};
  const status = Number(response?.status) || 0;
  const details = Array.isArray(data.details)
    ? data.details.filter((detail) => typeof detail === "string" && detail.trim())
    : [];

  const parsed = {
    message: typeof data.error === "string" && data.error.trim() ? data.error : fallback,
    code: typeof data.code === "string" && data.code.trim()
      ? data.code
      : status
        ? `HTTP_${status}`
        : "REQUEST_FAILED",
    details,
  };
  const retryAfterSeconds = retryAfterFrom(response, data);

  if (retryAfterSeconds) {
    parsed.retryAfterSeconds = retryAfterSeconds;
  }

  return parsed;
}

export async function requestCommunityJson(url, options = {}, fallback = "Request failed") {
  const headers = new Headers(options.headers || {});

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const parsed = await parseCommunityApiError(response, fallback);
    const error = new Error(parsed.message);
    Object.assign(error, parsed, { status: response.status });
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    const error = new Error("The server returned an unreadable response.");
    error.code = "INVALID_RESPONSE";
    error.details = [];
    error.status = response.status;
    throw error;
  }
}

export function communityErrorFrom(error, fallback = "Request failed") {
  if (error?.name === "AbortError") {
    return null;
  }

  return {
    message: error?.message || fallback,
    code: error?.code || (error instanceof TypeError ? "NETWORK_ERROR" : "REQUEST_FAILED"),
    details: Array.isArray(error?.details) ? error.details : [],
    retryAfterSeconds: Number.isFinite(error?.retryAfterSeconds)
      ? error.retryAfterSeconds
      : undefined,
    status: Number(error?.status) || 0,
  };
}
