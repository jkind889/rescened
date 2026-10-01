import { API_BASE_URL } from "../../config/api.js";
import { requestCommunityJson } from "../community/community.js";

export const LASTFM_CONNECTION_PATH = "/connections/lastfm";
export const ALBUM_MAPPING_PATH = "/moderation/album-mappings";

export async function requestLastfmJson(url, options = {}, fallback = "Request failed") {
  return requestCommunityJson(url, options, fallback);
}

export function lastfmUrl(path, query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  });
  const queryString = params.toString();
  return `${API_BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;
}

export function formatLastfmDate(value, options = {}) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(options.time ? { timeStyle: "short" } : {}),
  }).format(date);
}

export function formatMappingStatus(value) {
  const labels = {
    pending: "Pending review",
    approved: "Approved",
    rejected: "Rejected",
    no_catalog_match: "No catalog match",
    active: "Active",
    revoked: "Revoked",
    reconfirmed: "Reconfirmed",
  };
  return labels[value] || String(value || "Unknown").replaceAll("_", " ");
}

