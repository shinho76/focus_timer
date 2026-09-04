/**
 * core/schedule.js — owns the single countdown handle and the expiry
 * settlement rules (spec §4.4).
 *
 * Data model (deliberate, and load-bearing for the Phase 5 restore path):
 * - running: the truth is `deadlineWall` — an absolute wall timestamp, so a
 *   reload can recompute the remaining time even though the JS heap is gone.
 * - paused: the truth is `remainingMs` — a frozen duration, and `deadlineWall`
 *   becomes null. A paused timer restored after a refresh must NOT have the
 *   time spent paused deducted (spec §11 criterion 19), which is exactly what
 *   "no deadline while paused" encodes.
 *
 * Exactly one timer handle exists at any moment: `start()` on an already
 * running schedule is a no-op, not a second handle (spec §11 criterion 17).
 *
 * No DOM, no time except through the injected clock.
 */

/** Grace window after expiry within which we still ring (spec §4.4). @type {number} */
export const GRACE_MS = 90_000;

/** Default tick cadence; foreground expiry error budget is ±200ms (§11 #9). @type {number} */
export const TICK_MS = 200;

/** @typedef {'idle'|'running'|'paused'|'expired'} ScheduleStatus */

/**
 * @typedef {object} Settlement
 * @property {'idle'|'running'|'paused'|'ringing'|'completed'} status what the
 *   caller should do: `ringing` → transition to ringing and play the alarm;
 *   `completed` → grace exceeded, show the banner, DO NOT play an alarm.
 * @property {boolean} shouldRing
 * @property {number} remainingMs 0 once expired
 * @property {number} overdueMs how long ago it expired (0 if not expired)
 * @property {number} totalMs the planned duration, for the "N분 타이머가 …" banner
 */

/**
 * @param {ReturnType<import('./clock.js').createClock>} clock
 * @param {object} [options]
 * @param {number} [options.tickMs=TICK_MS]
 * @param {number} [options.graceMs=GRACE_MS]
 * @returns {{
 *   start: (totalMs: number) => boolean,
 *   pause: () => boolean,
 *   resume: () => boolean,
 *   reset: () => void,
 *   settle: (nowWall?: number) => Settlement,
 *   readonly remainingMs: number,
 *   readonly deadlineWall: number|null,
 *   readonly totalMs: number,
 *   readonly status: ScheduleStatus,
 *   readonly handleCount: number
 * }}
 */
export function createSchedule(clock, { tickMs = TICK_MS, graceMs = GRACE_MS } = {}) {
  if (!clock || typeof clock.tick !== 'function') {
    throw new TypeError('createSchedule(clock): needs a core/clock instance');
  }

  /** @type {ScheduleStatus} */
  let status = 'idle';
  let totalMs = 0;
  /** @type {number|null} */
  let deadlineWall = null;
  let pausedRemaining = 0;
  /** @type {any} */
  let timerId = null;

  function cancelTimer() {
    if (timerId != null) {
      clock.cancel(timerId);
      timerId = null;
    }
  }

  function arm() {
    cancelTimer();
    const delay = Math.min(tickMs, Math.max(0, clock.remainingMs));
    timerId = clock.schedule(onTimer, delay);
  }

  function onTimer() {
    timerId = null;
    if (status !== 'running') return;
    clock.tick();
    if (clock.remainingMs <= 0) {
      status = 'expired';
      return; // no re-arm: the handle count drops to 0 at expiry
    }
    arm();
  }

  // The clock is the authority on reaching zero (a tick driven from elsewhere,
  // e.g. a lifecycle resume, may get there before our own timer fires).
  clock.on('expire', () => {
    if (status === 'running') {
      status = 'expired';
      cancelTimer();
    }
  });

  return {
    /**
     * Start a countdown. No-op (returns false) when one is already running —
     * this is the double-start guard behind spec §11 criterion 17.
     * @param {number} ms total duration
     * @returns {boolean} true if a new countdown was actually started
     */
    start(ms) {
      if (status === 'running') return false;
      const total = Math.max(0, Number.isFinite(ms) ? ms : 0);
      totalMs = total;
      pausedRemaining = 0;
      clock.setRemaining(total);
      deadlineWall = clock.wall() + total;
      if (total <= 0) {
        status = 'expired';
        cancelTimer();
        return true;
      }
      status = 'running';
      arm();
      return true;
    },

    /**
     * Freeze the countdown. Only legal while running.
     * @returns {boolean}
     */
    pause() {
      if (status !== 'running') return false;
      clock.tick(); // settle up to this instant before freezing
      cancelTimer();
      pausedRemaining = clock.remainingMs;
      deadlineWall = null; // paused has no deadline — see the header comment
      status = 'paused';
      return true;
    },

    /**
     * Resume a paused countdown with a fresh deadline. Only legal while paused.
     * @returns {boolean}
     */
    resume() {
      if (status !== 'paused') return false;
      clock.setRemaining(pausedRemaining); // re-baseline: paused time is not deducted
      deadlineWall = clock.wall() + pausedRemaining;
      status = 'running';
      arm();
      return true;
    },

    /** Back to idle: cancel the handle and forget everything. */
    reset() {
      cancelTimer();
      status = 'idle';
      totalMs = 0;
      pausedRemaining = 0;
      deadlineWall = null;
      clock.setRemaining(0);
    },

    /**
     * Decide what should happen given a wall time — on resume from
     * background/bfcache, on restore after a refresh, or right at expiry.
     * Pure: it inspects, it does not mutate the schedule.
     *
     * Grace rules (spec §4.4): expired ≤ 90s ago → ring; expired > 90s ago →
     * completed with `overdueMs` and NO alarm; never auto-advance a phase.
     *
     * @param {number} [nowWall=clock.wall()]
     * @returns {Settlement}
     */
    settle(nowWall = clock.wall()) {
      const now = Number.isFinite(nowWall) ? nowWall : clock.wall();

      if (status === 'paused') {
        // Frozen: elapsed wall time is irrelevant, nothing is overdue.
        return {
          status: 'paused',
          shouldRing: false,
          remainingMs: pausedRemaining,
          overdueMs: 0,
          totalMs,
        };
      }

      if (status === 'idle' || deadlineWall === null) {
        return {
          status: 'idle',
          shouldRing: false,
          remainingMs: 0,
          overdueMs: 0,
          totalMs,
        };
      }

      const overdueMs = now - deadlineWall;
      if (overdueMs < 0) {
        return {
          status: 'running',
          shouldRing: false,
          remainingMs: -overdueMs,
          overdueMs: 0,
          totalMs,
        };
      }
      if (overdueMs <= graceMs) {
        return { status: 'ringing', shouldRing: true, remainingMs: 0, overdueMs, totalMs };
      }
      return { status: 'completed', shouldRing: false, remainingMs: 0, overdueMs, totalMs };
    },

    get remainingMs() {
      if (status === 'paused') return pausedRemaining;
      if (status === 'idle') return 0;
      return clock.remainingMs;
    },

    /** Absolute wall deadline while running; null while paused/idle. */
    get deadlineWall() {
      return deadlineWall;
    },

    get totalMs() {
      return totalMs;
    },

    get status() {
      return status;
    },

    /** Number of live timer handles. Must never exceed 1 (§11 criterion 17). */
    get handleCount() {
      return timerId == null ? 0 : 1;
    },
  };
}
