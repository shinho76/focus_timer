/**
 * core/clock.js — hybrid monotonic/wall clock with delta accumulation and
 * cross-checking (spec §4.2).
 *
 * `Date.now()` alone jumps on NTP correction and manual clock changes;
 * `performance.now()` alone stops during system sleep on some platforms.
 * So we accumulate *deltas* of both and cross-check them each tick.
 *
 * Hard invariant (spec §4.2, CLAUDE.md 절대 규칙): the remaining time NEVER
 * increases as a result of a tick. The only way it can go up is an explicit
 * re-baseline via {@link setRemaining} (a new timer / resume), never a tick.
 *
 * No DOM, no `Date.now()`, no `performance.now()` — time comes exclusively
 * from the injected port.
 */

/**
 * Forward wall-clock jumps larger than the monotonic delta by more than this
 * are not real elapsed time unless a gap was expected (spec §4.2).
 * @type {number}
 */
export const MAX_JUMP = 2000;

/**
 * @typedef {object} ClockPort
 * @property {() => number} wall wall-clock ms since epoch (`Date.now`)
 * @property {() => number} mono monotonic ms (`performance.now`)
 * @property {(fn: () => void, ms: number) => any} setTimeout
 * @property {(id: any) => void} clearTimeout
 */

/**
 * @typedef {object} ClockAnomaly
 * @property {'rewind'|'jump'} kind
 *   `rewind` — the wall clock moved backwards, it was discarded and the
 *   monotonic delta used instead.
 *   `jump` — the wall clock jumped forward far beyond the monotonic delta
 *   without a gap being expected (system clock change); discarded.
 * @property {number} deltaMs the rejected wall delta
 * @property {number} monoDeltaMs the monotonic delta that was used instead
 */

/**
 * Create a hybrid clock over a time port.
 *
 * @param {ClockPort} port
 * @param {object} [options]
 * @param {number} [options.remainingMs=0] initial remaining time
 * @returns {{
 *   tick: () => number,
 *   markGap: () => void,
 *   setRemaining: (ms: number) => void,
 *   on: (event: 'tick'|'clockanomaly'|'expire', cb: Function) => () => void,
 *   readonly remainingMs: number,
 *   readonly gapExpected: boolean,
 *   readonly port: ClockPort,
 *   wall: () => number,
 *   mono: () => number,
 *   schedule: (fn: () => void, ms: number) => any,
 *   cancel: (id: any) => void
 * }}
 */
export function createClock(port, { remainingMs = 0 } = {}) {
  if (!port || typeof port.wall !== 'function' || typeof port.mono !== 'function') {
    throw new TypeError('createClock(port): port must provide wall() and mono()');
  }

  let remaining = Math.max(0, Number.isFinite(remainingMs) ? remainingMs : 0);
  let lastP = port.mono();
  let lastW = port.wall();
  let gapExpected = false;
  let expired = remaining === 0;

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  /**
   * @param {string} event
   * @param {any} [detail]
   */
  function emit(event, detail) {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(detail);
      } catch {
        /* a listener must never break the clock (spec §11 criterion 39) */
      }
    }
  }

  return {
    /**
     * Subscribe to `tick` ({remainingMs, deltaMs}), `clockanomaly`
     * ({@link ClockAnomaly}) or `expire` (fired once when remaining hits 0).
     * @param {'tick'|'clockanomaly'|'expire'} event
     * @param {Function} cb
     * @returns {() => void} unsubscribe
     */
    on(event, cb) {
      if (typeof cb !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      const set = /** @type {Set<Function>} */ (listeners.get(event));
      set.add(cb);
      return () => set.delete(cb);
    },

    /**
     * Declare that a legitimate time gap is about to happen: the page is being
     * hidden / frozen / put into bfcache (spec §4.2, §4.3). Consumed by exactly
     * the next {@link tick} call and then cleared, whatever that tick decides.
     */
    markGap() {
      gapExpected = true;
    },

    /**
     * Re-baseline the clock. This is the ONLY way remaining time may increase,
     * and it is never called from a tick — a new timer or a resume calls it.
     * @param {number} ms
     */
    setRemaining(ms) {
      remaining = Math.max(0, Number.isFinite(ms) ? ms : 0);
      lastP = port.mono();
      lastW = port.wall();
      gapExpected = false;
      expired = remaining === 0;
    },

    /**
     * Advance the clock by cross-checking the monotonic and wall deltas
     * (spec §4.2, verbatim algorithm).
     * @returns {number} the new remaining time in ms
     */
    tick() {
      const p = port.mono();
      const w = port.wall();
      const dp = p - lastP;
      const dw = w - lastW;
      let d;

      if (dw < 0) {
        // Wall clock rewound (NTP / manual change) → discard it entirely.
        d = dp;
        emit('clockanomaly', { kind: 'rewind', deltaMs: dw, monoDeltaMs: dp });
      } else if (dw > dp + MAX_JUMP) {
        // Big forward wall jump: real elapsed time only if we expected a gap.
        if (gapExpected) {
          d = dw;
        } else {
          d = dp;
          emit('clockanomaly', { kind: 'jump', deltaMs: dw, monoDeltaMs: dp });
        }
      } else {
        d = Math.max(dp, dw, 0);
      }

      // Never increase: `d` can only subtract, and the result is floored at 0.
      const next = Math.min(remaining - d, remaining);
      remaining = Math.max(0, next);

      lastP = p;
      lastW = w;
      gapExpected = false;

      emit('tick', { remainingMs: remaining, deltaMs: d });
      if (remaining === 0 && !expired) {
        expired = true;
        emit('expire', { remainingMs: 0 });
      }
      return remaining;
    },

    get remainingMs() {
      return remaining;
    },

    get gapExpected() {
      return gapExpected;
    },

    /** The underlying port, so schedule/runtime can arm timers through it. */
    get port() {
      return port;
    },

    /** @returns {number} current wall time from the port */
    wall() {
      return port.wall();
    },

    /** @returns {number} current monotonic time from the port */
    mono() {
      return port.mono();
    },

    /**
     * @param {() => void} fn
     * @param {number} ms
     * @returns {any} timer handle
     */
    schedule(fn, ms) {
      return port.setTimeout(fn, ms);
    },

    /** @param {any} id */
    cancel(id) {
      if (id != null) port.clearTimeout(id);
    },
  };
}
