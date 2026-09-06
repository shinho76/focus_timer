/**
 * core/machine.js — the 5-state machine (spec §2.2) as an inspectable data
 * table, not a chain of `if`s.
 *
 * States: idle · setting · running · paused · ringing (+ the terminal
 * `destroyed` sink, which spec §2.2 requires to swallow every later event).
 *
 * The transition table IS the specification: an event that has no entry for
 * the current state is a silent no-op — no exception, no console output
 * (spec §11 criterion 18). The seven explicitly forbidden transitions are
 * therefore forbidden *by absence*, which is what makes them testable by
 * inspecting `TRANSITIONS` directly.
 *
 * No DOM, no time, no side effects: `send()` only moves a string.
 */

/** @typedef {'idle'|'setting'|'running'|'paused'|'ringing'|'destroyed'} TimerState */

/** All states, in spec order. @type {readonly TimerState[]} */
export const STATES = Object.freeze([
  'idle',
  'setting',
  'running',
  'paused',
  'ringing',
  'destroyed',
]);

/**
 * The transition table: `TRANSITIONS[state][event] === nextState`.
 * Frozen so no consumer can bend the state machine at runtime.
 *
 * Event vocabulary (spec §2.2 triggers):
 * - `dialdown`   pointerdown on the dial (also the audio-unlock gesture point)
 * - `dialup`     pointerup ending a drag → autostart
 * - `dialcancel` pointercancel / lostpointercapture → roll the value back
 * - `start`      explicit start (start button, preset, keyboard, autostart=off)
 * - `pause` / `resume` / `reset`
 * - `expire`     the schedule reached 0 within the grace window
 * - `acknowledge` local ack of the alarm; `remoteack` another tab acked
 * - `clockrewind` clock anomaly while running → stays running (§2.2 row 7)
 * - `destroy`    teardown; everything after it is swallowed
 *
 * @type {Readonly<Record<TimerState, Readonly<Record<string, TimerState>>>>}
 */
export const TRANSITIONS = Object.freeze({
  idle: Object.freeze({
    dialdown: 'setting',
    start: 'running',
    destroy: 'destroyed',
    // forbidden by absence: pause, resume
  }),
  setting: Object.freeze({
    dialup: 'running',
    dialcancel: 'idle',
    start: 'running',
    reset: 'idle',
    destroy: 'destroyed',
  }),
  running: Object.freeze({
    pause: 'paused',
    expire: 'ringing',
    reset: 'idle',
    clockrewind: 'running',
    destroy: 'destroyed',
    // forbidden by absence: start (double-start bug), resume,
    //                       dialdown/dialup/dialcancel (§3.4)
  }),
  paused: Object.freeze({
    resume: 'running',
    // v1.6: paused → dialdown → setting. 사용자 요청("일시정지 상태에서만
    // 다이얼로 시간 재조정 허용")에 따라 §2.2 원안의 "정지 중 다이얼 조작
    // 거부"를 running 에만 한정하고 paused 에는 새로 허용했다 — running
    // 자체의 다이얼 거부(FORBIDDEN 목록의 7개 중 하나)는 그대로 유지된다.
    // 커밋(dialup)까지는 안 간다 — 값만 정하고 나면 항상 'setting' 에
    // 머물러 있다가, 사용자가 명시적으로 시작해야 진짜 새 세션이 된다.
    dialdown: 'setting',
    reset: 'idle',
    destroy: 'destroyed',
    // forbidden by absence: pause
  }),
  ringing: Object.freeze({
    acknowledge: 'idle',
    remoteack: 'idle',
    reset: 'idle',
    destroy: 'destroyed',
    // forbidden by absence: dial manipulation
  }),
  destroyed: Object.freeze({}), // terminal sink: every event is a no-op
});

/**
 * The seven forbidden transitions of spec §2.2, as data, so the acceptance
 * test can iterate them instead of hand-listing them.
 * @type {readonly {from: TimerState, event: string, why: string}[]}
 */
export const FORBIDDEN = Object.freeze([
  { from: 'idle', event: 'pause', why: 'idle→pause' },
  { from: 'idle', event: 'resume', why: 'idle→resume' },
  { from: 'running', event: 'start', why: 'running→start (double-start)' },
  { from: 'paused', event: 'pause', why: 'paused→pause' },
  { from: 'running', event: 'resume', why: 'running→resume' },
  { from: 'running', event: 'dialdown', why: 'dial manipulation while running' },
  { from: 'destroyed', event: 'start', why: 'any event after destroy' },
]);

/**
 * Pure lookup: what would `event` do in `state`?
 * @param {TimerState} state
 * @param {string} event
 * @returns {TimerState|null} the next state, or null if the event is a no-op
 */
export function nextState(state, event) {
  const row = TRANSITIONS[/** @type {TimerState} */ (state)];
  if (!row) return null;
  const to = row[event];
  return to === undefined ? null : to;
}

/**
 * @param {TimerState} state
 * @param {string} event
 * @returns {boolean} true if the event is accepted in this state
 */
export function canTransition(state, event) {
  return nextState(state, event) !== null;
}

/**
 * @typedef {object} StateChange
 * @property {TimerState} from
 * @property {TimerState} to
 * @property {string} event
 * @property {any} payload
 */

/**
 * Create a state machine instance.
 *
 * @param {TimerState} [initialState='idle']
 * @returns {{
 *   send: (event: string, payload?: any) => boolean,
 *   on: (event: 'statechange', cb: (change: StateChange) => void) => () => void,
 *   readonly state: TimerState,
 *   readonly isDestroyed: boolean,
 *   can: (event: string) => boolean
 * }}
 */
export function createMachine(initialState = 'idle') {
  let state = /** @type {TimerState} */ (
    STATES.includes(/** @type {TimerState} */ (initialState)) ? initialState : 'idle'
  );

  /** @type {Set<(change: StateChange) => void>} */
  const listeners = new Set();

  return {
    /**
     * Fire an event. Unknown events and forbidden transitions are silent
     * no-ops: they return false and throw nothing (spec §11 criterion 18).
     * @param {string} event
     * @param {any} [payload]
     * @returns {boolean} true if the event was accepted by the table
     */
    send(event, payload) {
      const to = nextState(state, event);
      if (to === null) return false;
      const from = state;
      state = to;
      if (to !== from) {
        for (const cb of [...listeners]) {
          try {
            cb({ from, to, event, payload });
          } catch {
            /* a listener must never break the machine */
          }
        }
      }
      return true;
    },

    /**
     * @param {'statechange'} event
     * @param {(change: StateChange) => void} cb
     * @returns {() => void} unsubscribe
     */
    on(event, cb) {
      if (event !== 'statechange' || typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    get state() {
      return state;
    },

    get isDestroyed() {
      return state === 'destroyed';
    },

    /**
     * @param {string} event
     * @returns {boolean} whether `event` is currently accepted
     */
    can(event) {
      return canTransition(state, event);
    },
  };
}
