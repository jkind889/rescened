import { useEffect } from "react";

// Unsent suggestion drafts live only in this browser. They are a convenience:
// every read and write tolerates blocked or cleared storage.
const PREFIX = "rescened:suggestion-draft:v1:";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 400;

export function suggestionDraftKey(userId, context) {
  return userId && context ? `${PREFIX}${userId}:${context}` : "";
}

export function readDraft(key) {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Number.isFinite(parsed.savedAt) || !parsed.value || typeof parsed.value !== "object") {
      window.localStorage.removeItem(key);
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft(key, value) {
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }));
  } catch { /* storage unavailable or full */ }
}

export function clearDraft(key) {
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch { /* storage unavailable */ }
}

// Saves `value` shortly after it changes, and removes the stored draft once the
// form matches its starting point again.
export function useDraftAutosave(key, value, isPristine) {
  useEffect(() => {
    if (!key) return undefined;
    if (isPristine) {
      clearDraft(key);
      return undefined;
    }
    const timer = setTimeout(() => writeDraft(key, value), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, value, isPristine]);
}

export function formatDraftTime(savedAt) {
  try {
    return new Date(savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "earlier";
  }
}
