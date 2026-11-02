// Pure state helpers for the opt-in moderator review timer. Times are epoch milliseconds; only
// intervals the moderator actively timed are submitted.
export const REVIEW_EFFORT_PATH = "/moderation/review-effort";
const MAX_INTERVALS = 100;

export function emptyTimer() {
  return { intervals: [], runningSince: null };
}

export function startTimer(timer, now) {
  return timer.runningSince ? timer : { ...timer, runningSince: now };
}

export function pauseTimer(timer, now) {
  if (!timer.runningSince) return timer;
  if (now <= timer.runningSince) return { ...timer, runningSince: null };
  return { intervals: [...timer.intervals, { startedAt: timer.runningSince, endedAt: now }], runningSince: null };
}

export function activeMs(timer, now) {
  const closed = timer.intervals.reduce((sum, interval) => sum + (interval.endedAt - interval.startedAt), 0);
  return closed + (timer.runningSince ? Math.max(0, now - timer.runningSince) : 0);
}

export function hasTiming(timer) {
  return Boolean(timer.runningSince || timer.intervals.length);
}

// The request body for POST /moderation/review-effort, or null when nothing was timed.
export function effortPayload(timer, now, { effortId, kind, targetKind, targetId, targetRevision, outcome }) {
  const closed = pauseTimer(timer, now);
  if (!closed.intervals.length) return null;
  return {
    effortId, kind, targetKind, targetId, targetRevision, outcome,
    intervals: closed.intervals.slice(-MAX_INTERVALS).map((interval) => ({ startedAt: new Date(interval.startedAt).toISOString(), endedAt: new Date(interval.endedAt).toISOString() })),
  };
}

export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60) % 60;
  const hours = Math.floor(seconds / 3600);
  const rest = `${String(seconds % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function newEffortId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((value, index) => `${[4, 6, 8, 10].includes(index) ? "-" : ""}${value.toString(16).padStart(2, "0")}`).join("");
}
