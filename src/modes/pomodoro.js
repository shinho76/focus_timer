/**
 * modes/pomodoro.js — optional cycle layer (spec §6).
 *
 * Active only for `mode="pomodoro"`. `mode="simple"` (the default) never wraps
 * the schedule at all. This module is a *layer on top of* the object produced by
 * core/schedule.js and never modifies core:
 *   schedule = { start(totalMs), pause(), resume(), reset(),
 *                get remainingMs, get deadlineWall, settle(nowWall) }
 *
 * Defaults (spec): 50m focus / 10m break / after 3 focus completions a 30m long
 * break, then `cycleIndex` resets to 0. The classic 25/5/15/4 preset is
 * available via `{ preset: 'classic' }`; every value is user-overridable.
 *
 * Auto-advance is TWO independent toggles, never one:
 *   autoStartBreak (focus -> break) default ON
 *   autoStartFocus (break -> focus) default OFF  (the user may have stepped away)
 *
 * §4.4 long absence: `complete()` advances exactly ONE phase per call and, when
 * `overdueMs` exceeds the 90s grace, auto-start is suppressed entirely, so a
 * three-hour absence can never chain phases that were never actually worked.
 */

const MIN = 60_000;

/** Grace window from spec §4.4: expiry within 90s still counts as "just now". */
export const GRACE_MS = 90_000;

export const PHASES = /** @type {const} */ (['focus', 'short-break', 'long-break']);

/** Named presets. All values remain user-overridable. */
export const POMODORO_PRESETS = {
  default: { focusMs: 50 * MIN, shortBreakMs: 10 * MIN, longBreakMs: 30 * MIN, focusesPerCycle: 3 },
  classic: { focusMs: 25 * MIN, shortBreakMs: 5 * MIN, longBreakMs: 15 * MIN, focusesPerCycle: 4 },
};

const BASE_CONFIG = {
  ...POMODORO_PRESETS.default,
  autoStartBreak: true, // focus -> break
  autoStartFocus: false, // break -> focus
  graceMs: GRACE_MS,
};

/** Phase identity exposed as data; colour + label rendering belongs to view/. */
const PHASE_META = {
  focus: { phase: 'focus', token: 'phase-focus', labelKey: 'phase.focus', isBreak: false },
  'short-break': { phase: 'short-break', token: 'phase-short-break', labelKey: 'phase.shortBreak', isBreak: true },
  'long-break': { phase: 'long-break', token: 'phase-long-break', labelKey: 'phase.longBreak', isBreak: true },
};

const MINUTE_ALIASES = {
  focusMinutes: 'focusMs',
  shortBreakMinutes: 'shortBreakMs',
  longBreakMinutes: 'longBreakMs',
};

/**
 * @param {object} [config]
 * @param {object} [base]
 * @returns {typeof BASE_CONFIG}
 */
function normalizeConfig(config = {}, base = BASE_CONFIG) {
  const preset = config.preset && POMODORO_PRESETS[config.preset];
  const out = { ...base, ...(preset || {}) };
  for (const [key, value] of Object.entries(config)) {
    if (key === 'preset' || value === undefined || value === null) continue;
    if (MINUTE_ALIASES[key]) out[MINUTE_ALIASES[key]] = Number(value) * MIN;
    else if (key in BASE_CONFIG) out[key] = value;
  }
  out.focusMs = Math.max(1, Number(out.focusMs));
  out.shortBreakMs = Math.max(1, Number(out.shortBreakMs));
  out.longBreakMs = Math.max(1, Number(out.longBreakMs));
  out.focusesPerCycle = Math.max(1, Math.floor(Number(out.focusesPerCycle)));
  out.autoStartBreak = !!out.autoStartBreak;
  out.autoStartFocus = !!out.autoStartFocus;
  out.graceMs = Number.isFinite(out.graceMs) ? out.graceMs : GRACE_MS;
  return out;
}

/**
 * @param {{ start:Function, pause:Function, resume:Function, reset:Function,
 *           remainingMs:number, deadlineWall:number|null, settle:Function }} schedule
 * @param {object} [config]
 */
export function createPomodoro(schedule, config = {}) {
  let cfg = normalizeConfig(config);

  let phase = 'focus';
  let cycleIndex = 0; // completed focus sessions inside the current cycle
  let completedFocus = 0; // completed (non-skipped) focus sessions, lifetime
  let started = false; // is the current phase actually running on the schedule?

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch {
        /* a bad subscriber must not break the cycle */
      }
    }
  }

  function durationOf(p) {
    if (p === 'focus') return cfg.focusMs;
    if (p === 'short-break') return cfg.shortBreakMs;
    return cfg.longBreakMs;
  }

  /**
   * Phase that follows `from`, given the cycle counter that results from it.
   * @param {string} from
   * @param {number} nextCycleIndex
   */
  function phaseAfter(from, nextCycleIndex) {
    if (from === 'focus') {
      return nextCycleIndex >= cfg.focusesPerCycle ? 'long-break' : 'short-break';
    }
    return 'focus';
  }

  function meta(p = phase) {
    return { ...PHASE_META[p], plannedMs: durationOf(p) };
  }

  function startPhase(reason) {
    started = true;
    schedule.start(durationOf(phase));
    emit('phasestart', { ...meta(), cycleIndex, completedFocus, reason });
    return durationOf(phase);
  }

  function loadPhase(next, reason, autoStart) {
    const from = phase;
    phase = next;
    started = false;
    if (typeof schedule.reset === 'function') schedule.reset();
    emit('phasechange', {
      from,
      to: phase,
      ...meta(),
      cycleIndex,
      completedFocus,
      autoStarted: autoStart,
      reason,
    });
    if (autoStart) startPhase(reason);
  }

  /**
   * Complete the current phase and advance exactly one step.
   * @param {{ skipped?: boolean, overdueMs?: number, actualMs?: number }} [opts]
   * @returns {object} the completion record (maps to `ft:complete`).
   */
  function completePhase(opts = {}) {
    const skipped = !!opts.skipped;
    const overdueMs = Math.max(0, Number(opts.overdueMs) || 0);
    const plannedMs = durationOf(phase);
    const remaining = Number(schedule && schedule.remainingMs);
    const actualMs = Number.isFinite(opts.actualMs)
      ? opts.actualMs
      : Number.isFinite(remaining)
        ? Math.max(0, plannedMs - Math.max(0, remaining))
        : plannedMs;

    const from = phase;
    // Skipping never increments the completed-focus counter (spec §6).
    if (from === 'focus' && !skipped) {
      cycleIndex += 1;
      completedFocus += 1;
    }
    const next = phaseAfter(from, cycleIndex);
    // A long break closes the cycle whether it was completed or skipped.
    if (from === 'long-break') cycleIndex = 0;

    // §4.4: never auto-chain after a long absence — banner only, user decides.
    const overdue = overdueMs > cfg.graceMs;
    const autoStart = !overdue && (PHASE_META[next].isBreak ? cfg.autoStartBreak : cfg.autoStartFocus);

    const record = {
      phase: from,
      phaseToken: PHASE_META[from].token,
      plannedMs,
      actualMs,
      skipped,
      overdueMs,
      overdue,
      cycleIndex,
      completedFocus,
      next: { phase: next, token: PHASE_META[next].token, plannedMs: durationOf(next), autoStarted: autoStart },
    };
    emit('complete', record);
    loadPhase(next, skipped ? 'skip' : 'complete', autoStart);
    return record;
  }

  return {
    // ---- phase identity exposed as data (view renders colour + label) ------
    get phase() {
      return phase;
    },
    get phaseToken() {
      return PHASE_META[phase].token;
    },
    get phaseLabelKey() {
      return PHASE_META[phase].labelKey;
    },
    get isBreak() {
      return PHASE_META[phase].isBreak;
    },
    get phaseInfo() {
      return meta();
    },
    get cycleIndex() {
      return cycleIndex;
    },
    get completedFocus() {
      return completedFocus;
    },
    get plannedMs() {
      return durationOf(phase);
    },
    get isStarted() {
      return started;
    },
    get schedule() {
      return schedule;
    },
    get config() {
      return { ...cfg };
    },
    /** The two auto-advance toggles, deliberately kept separate. */
    get autoStart() {
      return { break: cfg.autoStartBreak, focus: cfg.autoStartFocus };
    },
    /** Phase that a natural completion of the current phase would lead to. */
    get nextPhase() {
      const nextIndex = phase === 'focus' ? cycleIndex + 1 : cycleIndex;
      return phaseAfter(phase, nextIndex);
    },

    /** @param {object} partial */
    setConfig(partial) {
      cfg = normalizeConfig(partial, cfg);
      return { ...cfg };
    },

    /** @param {string} name @param {Function} cb @returns {() => void} unsubscribe */
    on(name, cb) {
      if (typeof cb !== 'function') return () => {};
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return () => listeners.get(name)?.delete(cb);
    },

    /** Start (or restart) the current phase on the underlying schedule. */
    start() {
      return startPhase('manual');
    },
    pause() {
      return schedule.pause();
    },
    resume() {
      return schedule.resume();
    },
    settle(nowWall) {
      return typeof schedule.settle === 'function' ? schedule.settle(nowWall) : undefined;
    },

    /** Complete the current phase and advance exactly one step. */
    complete: completePhase,

    /** Skip the current phase: logged as `skipped:true`, no count increment. */
    skip(opts = {}) {
      return completePhase({ ...opts, skipped: true });
    },

    /** Back to a fresh cycle: focus phase, cycleIndex 0, schedule reset. */
    reset({ keepCompletedFocus = true } = {}) {
      const from = phase;
      phase = 'focus';
      cycleIndex = 0;
      started = false;
      if (!keepCompletedFocus) completedFocus = 0;
      if (typeof schedule.reset === 'function') schedule.reset();
      if (from !== 'focus') {
        emit('phasechange', {
          from,
          to: phase,
          ...meta(),
          cycleIndex,
          completedFocus,
          autoStarted: false,
          reason: 'reset',
        });
      }
    },

    /** Persistence hook for the §7.1 storage schema. */
    snapshot() {
      return { phase, cycleIndex, completedFocus };
    },
    /** @param {{ phase?: string, cycleIndex?: number, completedFocus?: number }} state */
    restore(state = {}) {
      if (state.phase && PHASE_META[state.phase]) phase = state.phase;
      if (Number.isFinite(state.cycleIndex)) cycleIndex = Math.max(0, Math.floor(state.cycleIndex));
      if (Number.isFinite(state.completedFocus)) completedFocus = Math.max(0, Math.floor(state.completedFocus));
      started = false;
    },
  };
}
