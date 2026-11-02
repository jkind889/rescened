import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { API_BASE_URL } from "../../config/api.js";
import { requestCommunityJson } from "../../features/community/community.js";
import { REVIEW_EFFORT_PATH, activeMs, effortPayload, emptyTimer, formatElapsed, hasTiming, newEffortId, pauseTimer, startTimer } from "../../features/reviewEffort/reviewEffort.js";
import "./ReviewTimer.css";

// Opt-in active-effort timer for one review target. The server hides it unless
// REVIEW_EFFORT_TIMER_ENABLED is on, and nothing is timed until the moderator opts in and
// presses Start. Leaving a target with timed work records it as abandoned. An empty targetId
// turns the timer off, so embedded panels can share a parent's timer instead.
export function useReviewTimer({ kind, targetKind, targetId }) {
  const { getToken, isSignedIn } = useAuth();
  const targetKey = targetId ? `${kind}:${targetKind}:${targetId}` : "";
  const [status, setStatus] = useState({ enabled: false, optedIn: false });
  // Timer state belongs to one target; another target starts from an empty timer.
  const [scoped, setScoped] = useState({ key: targetKey, timer: emptyTimer(), message: "" });
  const current = scoped.key === targetKey ? scoped : { key: targetKey, timer: emptyTimer(), message: "" };
  const { timer, message } = current;
  const [now, setNow] = useState(() => Date.now());
  const timerRef = useRef(timer);
  const targetRef = useRef({ kind, targetKind, targetId });
  const submitRef = useRef(null);
  useEffect(() => { timerRef.current = timer; targetRef.current = { kind, targetKind, targetId }; }, [kind, targetId, targetKind, timer]);

  const update = useCallback((change) => setScoped((state) => {
    const base = state.key === targetKey ? state : { key: targetKey, timer: emptyTimer(), message: "" };
    return { ...base, ...change(base) };
  }), [targetKey]);

  const request = useCallback(async (path, options = {}) => {
    const token = await getToken();
    return requestCommunityJson(`${API_BASE_URL}${REVIEW_EFFORT_PATH}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } }, "The review timer request failed.");
  }, [getToken]);

  useEffect(() => {
    if (!isSignedIn || !targetId) return undefined;
    let active = true;
    request("").then((data) => { if (active) setStatus({ enabled: data?.enabled === true, optedIn: data?.optedIn === true }); }).catch(() => {});
    return () => { active = false; };
  }, [isSignedIn, request, targetId]);

  // Submission is best effort: a failed timing never blocks or retries a review.
  const submit = useCallback((snapshot, target, outcome, targetRevision) => {
    const payload = effortPayload(snapshot, Date.now(), { effortId: newEffortId(), ...target, targetRevision, outcome });
    if (!payload) return;
    const key = `${target.kind}:${target.targetKind}:${target.targetId}`;
    const note = (text) => setScoped((state) => (state.key === key ? { ...state, message: text } : state));
    request("", { method: "POST", body: JSON.stringify(payload) })
      .then(() => note(outcome === "decided" ? "Review time saved." : "Timing saved as unfinished."))
      .catch(() => note("This review's timing was not saved."));
  }, [request]);
  useEffect(() => { submitRef.current = submit; }, [submit]);

  // Leaving a target, or the review page, ends that target's timing as abandoned and clears it,
  // so returning to the target starts fresh. Closing or reloading the tab records nothing.
  useEffect(() => () => {
    if (targetId && hasTiming(timerRef.current)) submitRef.current?.(timerRef.current, { kind, targetKind, targetId }, "abandoned", 0);
    timerRef.current = emptyTimer();
    const key = `${kind}:${targetKind}:${targetId}`;
    setScoped((state) => (state.key === key ? { key: "", timer: emptyTimer(), message: "" } : state));
  }, [kind, targetId, targetKind]);

  useEffect(() => {
    if (!timer.runningSince) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [timer.runningSince]);

  // Called by the parent after a decision is recorded, with the target it decided and the revision
  // the moderator reviewed. If the moderator moved on while the decision was saving, that target's
  // timing was already recorded as abandoned, so nothing else is submitted.
  const finish = useCallback((decidedTargetId, targetRevision) => {
    if (!targetRef.current.targetId || targetRef.current.targetId !== decidedTargetId || !hasTiming(timerRef.current)) return;
    submit(timerRef.current, targetRef.current, "decided", Number.isSafeInteger(targetRevision) ? targetRevision : 0);
    timerRef.current = emptyTimer();
    update(() => ({ timer: emptyTimer() }));
  }, [submit, update]);

  const abandon = useCallback(() => {
    submit(timerRef.current, targetRef.current, "abandoned", 0);
    timerRef.current = emptyTimer();
    update(() => ({ timer: emptyTimer() }));
  }, [submit, update]);

  const toggle = useCallback(() => {
    const at = Date.now();
    setNow(at);
    update((base) => ({ timer: base.timer.runningSince ? pauseTimer(base.timer, at) : startTimer(base.timer, at) }));
  }, [update]);

  const setOptIn = useCallback(async (optedIn) => {
    try {
      const data = await request("/opt-in", { method: "PUT", body: JSON.stringify({ optedIn }) });
      setStatus({ enabled: true, optedIn: data?.optedIn === true });
      if (!optedIn) update(() => ({ timer: emptyTimer(), message: "Review timing is off." }));
    } catch { update(() => ({ message: "The timer setting could not be saved." })); }
  }, [request, update]);

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
