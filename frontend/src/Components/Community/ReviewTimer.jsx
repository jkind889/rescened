import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../../config/api.js";
import { requestCommunityJson } from "../../features/community/community.js";
import { REVIEW_EFFORT_PATH, activeMs, effortPayload, emptyTimer, formatElapsed, hasTiming, newEffortId, pauseTimer, startTimer } from "../../features/reviewEffort/reviewEffort.js";
import "./ReviewTimer.css";

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function tokenMatchesSession(token, userId, sessionId) {
  if (!token) return false;
  const parts = String(token).split(".");
  if (parts.length !== 3) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== "object") return false;
  if (userId && typeof payload.sub === "string" && payload.sub !== userId) return false;
  if (sessionId && typeof payload.sid === "string" && payload.sid !== sessionId) return false;
  return true;
}

// Opt-in active-effort timer for one review target. The server hides it unless
// REVIEW_EFFORT_TIMER_ENABLED is on, and nothing is timed until the moderator opts in and
// presses Start. An empty targetId turns the timer off, so embedded panels can share a parent's timer.
export function useReviewTimer({ kind, targetKind, targetId }) {
  const { getToken, isLoaded = true, isSignedIn, sessionId = "", userId = "" } = useAuth();
  const authSession = isLoaded && isSignedIn ? `${userId || ""}:${sessionId || ""}` : "";
  const targetKey = authSession && targetId ? `${authSession}:${kind}:${targetKind}:${targetId}` : "";
  const [statusState, setStatusState] = useState({ session: authSession, enabled: false, optedIn: false });
  const status = statusState.session === authSession ? statusState : { session: authSession, enabled: false, optedIn: false };
  // Both the Clerk session and the target own the elapsed time.
  const [scoped, setScoped] = useState({ key: targetKey, timer: emptyTimer(), message: "" });
  const current = scoped.key === targetKey ? scoped : { key: targetKey, timer: emptyTimer(), message: "" };
  const { timer, message } = current;
  const [now, setNow] = useState(() => Date.now());
  const timerRef = useRef(timer);
  const targetRef = useRef({ authSession, kind, targetKind, targetId });
  const latestSessionRef = useRef(authSession);
  const sessionController = useRef(null);
  const optInController = useRef(null);
  const tokenRefreshController = useRef(null);
  const sessionTokenRef = useRef({ session: "", token: "" });
  const unmountedRef = useRef(false);
  const submitRef = useRef(null);

  useLayoutEffect(() => {
    const previous = latestSessionRef.current;
    latestSessionRef.current = authSession;
    if (!sessionController.current || previous !== authSession) {
      if (previous !== authSession) {
        sessionController.current?.abort();
        optInController.current?.abort();
        optInController.current = null;
        tokenRefreshController.current?.abort();
        tokenRefreshController.current = null;
        sessionTokenRef.current = { session: "", token: "" };
        timerRef.current = emptyTimer();
      }
      sessionController.current = new AbortController();
    }
  }, [authSession]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      optInController.current?.abort();
      optInController.current = null;
      tokenRefreshController.current?.abort();
      tokenRefreshController.current = null;
    };
  }, []);
  useEffect(() => { timerRef.current = timer; targetRef.current = { authSession, kind, targetKind, targetId }; }, [authSession, kind, targetId, targetKind, timer]);

  const update = useCallback((change) => setScoped((state) => {
    const base = state.key === targetKey ? state : { key: targetKey, timer: emptyTimer(), message: "" };
    return { ...base, ...change(base) };
  }), [targetKey]);

  const acquireToken = useCallback(async (signal) => {
    if (signal?.aborted || latestSessionRef.current !== authSession || unmountedRef.current) {
      throw Object.assign(new Error("Request cancelled."), { name: "AbortError" });
    }
    const token = await getToken();
    if (signal?.aborted || latestSessionRef.current !== authSession || unmountedRef.current || !tokenMatchesSession(token, userId, sessionId)) {
      throw Object.assign(new Error("Request cancelled."), { name: "AbortError" });
    }
    sessionTokenRef.current = { session: authSession, token };
    return token;
  }, [authSession, getToken, sessionId, userId]);

  const refreshSessionToken = useCallback(() => {
    if (!authSession || latestSessionRef.current !== authSession || unmountedRef.current) return;
    tokenRefreshController.current?.abort();
    const controller = new AbortController();
    tokenRefreshController.current = controller;
    acquireToken(controller.signal)
      .catch(() => {})
      .finally(() => { if (tokenRefreshController.current === controller) tokenRefreshController.current = null; });
  }, [acquireToken, authSession]);

  const request = useCallback(async (path, options = {}) => {
    const { token: presetToken, ...fetchOptions } = options;
    if (fetchOptions.signal?.aborted) throw Object.assign(new Error("Request cancelled."), { name: "AbortError" });
    const token = presetToken || await acquireToken(fetchOptions.signal);
    if (fetchOptions.signal?.aborted) throw Object.assign(new Error("Request cancelled."), { name: "AbortError" });
    return requestCommunityJson(`${API_BASE_URL}${REVIEW_EFFORT_PATH}${path}`, { ...fetchOptions, headers: { Authorization: `Bearer ${token}`, ...(fetchOptions.headers || {}) } }, "The review timer request failed.");
  }, [acquireToken]);

  useEffect(() => {
    if (!authSession || !targetId) return undefined;
    const controller = new AbortController();
    request("", { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setStatusState({ session: authSession, enabled: data?.enabled === true, optedIn: data?.optedIn === true });
    }).catch(() => {});
    return () => controller.abort();
  }, [authSession, request, targetId]);

  // Submission is best effort: a failed timing never blocks or retries a review.
  const submit = useCallback((snapshot, target, outcome, targetRevision, signalOverride) => {
    const signal = signalOverride || sessionController.current?.signal;
    if (!authSession || latestSessionRef.current !== authSession || !signal || signal.aborted) return;
    const cachedToken = sessionTokenRef.current.session === authSession ? sessionTokenRef.current.token : "";
    // After unmount, useAuth() no longer observes session changes, so refuse a fresh getToken() call.
    if (unmountedRef.current && !cachedToken) return;
    const payload = effortPayload(snapshot, Date.now(), { effortId: newEffortId(), ...target, targetRevision, outcome });
    if (!payload) return;
    const key = `${authSession}:${target.kind}:${target.targetKind}:${target.targetId}`;
    const note = (text) => {
      if (!signal.aborted && !unmountedRef.current && latestSessionRef.current === authSession) {
        setScoped((state) => (state.key === key ? { ...state, message: text } : state));
      }
    };
    request("", { method: "POST", body: JSON.stringify(payload), signal, token: cachedToken || undefined })
      .then(() => note(outcome === "decided" ? "Review time saved." : "Timing saved as unfinished."))
      .catch(() => note("This review's timing was not saved."));
  }, [authSession, request]);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  // Leaving a target or the review page records unfinished timing in the same session.
  // A session change invalidates the old timing before this cleanup runs.
  useEffect(() => () => {
    const signal = sessionController.current?.signal;
    if (authSession && targetId && latestSessionRef.current === authSession && signal && !signal.aborted && hasTiming(timerRef.current)) {
      submitRef.current?.(timerRef.current, { kind, targetKind, targetId }, "abandoned", 0, signal);
    }
    timerRef.current = emptyTimer();
    const key = `${authSession}:${kind}:${targetKind}:${targetId}`;
    if (!unmountedRef.current) setScoped((state) => (state.key === key ? { key: "", timer: emptyTimer(), message: "" } : state));
  }, [authSession, kind, targetId, targetKind]);

  useEffect(() => {
    if (!timer.runningSince) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [timer.runningSince]);

  const activeTiming = Boolean(timer.runningSince || hasTiming(timer));
  useEffect(() => {
    if (!activeTiming || !authSession) return undefined;
    const refresh = setInterval(refreshSessionToken, 30_000);
    return () => clearInterval(refresh);
  }, [activeTiming, authSession, refreshSessionToken]);

  // Called by the parent after a decision is recorded, with the target it decided and the revision
  // the moderator reviewed. If the moderator moved on while the decision was saving, that target's
  // timing was already recorded as abandoned, so nothing else is submitted.
  const finish = useCallback((decidedTargetId, targetRevision) => {
    const signal = sessionController.current?.signal;
    const target = targetRef.current;
    if (!authSession || target.authSession !== authSession || !signal || signal.aborted) return;
    if (!target.targetId || target.targetId !== decidedTargetId || !hasTiming(timerRef.current)) return;
    submit(timerRef.current, target, "decided", Number.isSafeInteger(targetRevision) ? targetRevision : 0, signal);
    timerRef.current = emptyTimer();
    update(() => ({ timer: emptyTimer() }));
  }, [authSession, submit, update]);

  const abandon = useCallback(() => {
    const signal = sessionController.current?.signal;
    if (!authSession || targetRef.current.authSession !== authSession || !signal || signal.aborted) return;
    submit(timerRef.current, targetRef.current, "abandoned", 0, signal);
    timerRef.current = emptyTimer();
    update(() => ({ timer: emptyTimer() }));
  }, [authSession, submit, update]);

  const toggle = useCallback(() => {
    const at = Date.now();
    setNow(at);
    update((base) => ({ timer: base.timer.runningSince ? pauseTimer(base.timer, at) : startTimer(base.timer, at) }));
    refreshSessionToken();
  }, [refreshSessionToken, update]);

  const setOptIn = useCallback(async (optedIn) => {
    if (!authSession || targetRef.current.authSession !== authSession || latestSessionRef.current !== authSession || unmountedRef.current) return;
    optInController.current?.abort();
    const controller = new AbortController();
    optInController.current = controller;
    const { signal } = controller;
    const isCurrent = () => !signal.aborted && !unmountedRef.current && latestSessionRef.current === authSession;
    try {
      const data = await request("/opt-in", { method: "PUT", body: JSON.stringify({ optedIn }), signal });
      if (!isCurrent()) return;
      setStatusState({ session: authSession, enabled: true, optedIn: data?.optedIn === true });
      if (!optedIn) update(() => ({ timer: emptyTimer(), message: "Review timing is off." }));
    } catch {
      if (isCurrent()) update(() => ({ message: "The timer setting could not be saved." }));
    } finally {
      if (optInController.current === controller) optInController.current = null;
    }
  }, [authSession, request, update]);

  let panel = null;
  if (targetId && status.enabled) {
    const running = Boolean(timer.runningSince);
    panel = (
      <div className="review-timer" aria-label="Review timer">
        {status.optedIn ? (
          <>
            <span className="review-timer-elapsed" aria-live="off">{formatElapsed(activeMs(timer, now))}</span>
            <button className="community-secondary-button" onClick={toggle} type="button">{running ? "Pause" : hasTiming(timer) ? "Resume" : "Start timing"}</button>
            {hasTiming(timer) ? <button className="community-text-button" onClick={abandon} type="button">Stop without deciding</button> : null}
            <button className="community-text-button" onClick={() => setOptIn(false)} type="button">Stop timing my reviews</button>
            <small>Saving a decision stops the timer. Only the time you run it is recorded.</small>
          </>
        ) : (
          <>
            <span>Effort study: time your active review work for this pilot.</span>
            <button className="community-secondary-button" onClick={() => setOptIn(true)} type="button">Opt in</button>
          </>
        )}
        {message ? <small role="status">{message}</small> : null}
      </div>
    );
  }
  return { panel, finish };
}
