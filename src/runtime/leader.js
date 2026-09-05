/**
 * runtime/leader.js — multi-tab leader election (spec §7.2).
 *
 * Only the leader plays the alarm, shows notifications, writes storage and owns
 * `document.title`; followers render only. Minimum requirement: every tab shows
 * the same remaining time and the alarm rings exactly once (criterion 21).
 *
 * Election strategies, chosen in this order:
 *   1. 'locks'     — `locksApi.request(name, { mode:'exclusive' }, cb)` (Web Locks).
 *                    The callback returns a promise that we only resolve from
 *                    `release()`, exactly like the spec sample; resolving it
 *                    hands leadership to the next waiting tab.
 *   2. 'heartbeat' — fallback when Web Locks is missing. Requires BOTH
 *                    `options.storage` (localStorage-like) and `options.clock`
 *                    (`{ wall(), setTimeout(), clearTimeout() }`, so we never
 *                    call `Date.now()`/`setTimeout` directly — CLAUDE.md rule).
 *                    Freshest live heartbeat wins; a record older than
 *                    `staleMs` is treated as a dead tab and taken over.
 *   3. 'solo'      — neither available: we assume a single tab and become
 *                    leader immediately, so the timer never silently stops
 *                    ringing. Degradation is reported via `mode`.
 *
 * BroadcastChannel is constructed internally from `channelName`
 * (`options.BroadcastChannelCtor` overrides it for tests; if no constructor
 * exists at all, mirroring is skipped and election still works).
 */

const DEFAULT_LOCK_NAME = 'focus-timer-leader';
const DEFAULT_STORAGE_KEY = 'focus-timer.v1:leader';
const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_STALE_MS = 5000;

let instanceSeq = 0;

/**
 * @typedef {Object} LeaderOptions
 * @property {Function} [BroadcastChannelCtor] Defaults to globalThis.BroadcastChannel.
 * @property {{ getItem(k:string):?string, setItem(k:string,v:string):void, removeItem(k:string):void }} [storage]
 * @property {{ wall():number, setTimeout(fn:Function, ms:number):any, clearTimeout(id:any):void }} [clock]
 * @property {string} [instanceId]
 * @property {string} [lockName]
 * @property {string} [storageKey]
 * @property {number} [heartbeatMs]
 * @property {number} [staleMs]
 */

/**
 * @param {{ request: Function }|undefined|null} locksApi  usually `navigator.locks`
 * @param {string} channelName  BroadcastChannel name, e.g. 'focus-timer.v1'
 * @param {LeaderOptions} [options]
 * @returns {{ readonly isLeader: boolean, readonly mode: string, readonly instanceId: string,
 *            onLeaderChange(cb: (isLeader: boolean, info: object) => void): () => void,
 *            post(message: object): void, release(): void }}
 */
export function createLeaderElection(locksApi, channelName, options = {}) {
  const {
    BroadcastChannelCtor = typeof globalThis !== 'undefined' ? globalThis.BroadcastChannel : undefined,
    storage,
    clock,
    lockName = DEFAULT_LOCK_NAME,
    storageKey = DEFAULT_STORAGE_KEY,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    staleMs = DEFAULT_STALE_MS,
  } = options;

  const instanceId = options.instanceId || `ft-${++instanceSeq}-${Math.random().toString(36).slice(2, 8)}`;

  const listeners = new Set();
  /** Generic broadcast subscribers — lets a caller (e.g. integration) piggyback
   * its own message types (e.g. a 'sync' tick payload) on the same channel
   * instead of opening a second BroadcastChannel. Added for spec §11 criterion
   * 21 (followers mirroring the leader's live remaining time); does not change
   * the existing `{ isLeader, onLeaderChange, release }` contract. */
  const messageListeners = new Set();
  let leader = false;
  let released = false;

  /** @type {null | (() => void)} */
  let releaseLeadership = null;
  /** @type {any} */
  let heartbeatTimer = null;

  let channel = null;
  if (channelName && typeof BroadcastChannelCtor === 'function') {
    try {
      channel = new BroadcastChannelCtor(channelName);
      if (typeof channel.addEventListener === 'function') {
        channel.addEventListener('message', onChannelMessage);
      } else {
        channel.onmessage = onChannelMessage;
      }
    } catch {
      channel = null;
    }
  }

  const hasLocks = !!(locksApi && typeof locksApi.request === 'function');
  const hasHeartbeat =
    !!storage &&
    typeof storage.getItem === 'function' &&
    !!clock &&
    typeof clock.wall === 'function' &&
    typeof clock.setTimeout === 'function';

  const mode = hasLocks ? 'locks' : hasHeartbeat ? 'heartbeat' : 'solo';

  function post(message) {
    if (!channel) return;
    try {
      channel.postMessage({ instanceId, ...message });
    } catch {
      /* channel closed — mirroring is best effort */
    }
  }

  function onChannelMessage(event) {
    const data = (event && event.data) || {};
    if (!data || data.instanceId === instanceId) return;
    // Heartbeat fallback only: another tab announcing leadership makes us step
    // down immediately instead of waiting for the next poll. With Web Locks the
    // lock itself is authoritative, so announcements are informational.
    if (mode === 'heartbeat' && data.type === 'leader-changed' && data.isLeader && leader) {
      const record = readRecord();
      if (record && record.id !== instanceId) setLeader(false, { via: 'broadcast' });
    }
    for (const cb of [...messageListeners]) {
      try {
        cb(data);
      } catch {
        /* a bad subscriber must not break election or mirroring */
      }
    }
  }

  function setLeader(next, info = {}) {
    if (leader === next) return;
    leader = next;
    if (next) post({ type: 'leader-changed', isLeader: true });
    for (const cb of [...listeners]) {
      try {
        cb(leader, { instanceId, mode, ...info });
      } catch {
        /* a bad subscriber must not break election */
      }
    }
  }

  // --- strategy 1: Web Locks ------------------------------------------------
  if (mode === 'locks') {
    try {
      const p = locksApi.request(lockName, { mode: 'exclusive' }, () =>
        new Promise((resolve) => {
          if (released) {
            resolve();
            return;
          }
          releaseLeadership = resolve;
          setLeader(true, { via: 'locks' });
        }),
      );
      if (p && typeof p.catch === 'function') {
        p.catch(() => setLeader(false, { via: 'locks-error' }));
      }
    } catch {
      setLeader(true, { via: 'locks-throw' }); // never leave the page leaderless
    }
  }

  // --- strategy 2: localStorage heartbeat -----------------------------------
  function readRecord() {
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.id !== 'string' || typeof parsed.at !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeRecord(now) {
    try {
      storage.setItem(storageKey, JSON.stringify({ id: instanceId, at: now }));
      return true;
    } catch {
      return false;
    }
  }

  function beat() {
    if (released) return;
    const now = clock.wall();
    const record = readRecord();
    // Ambiguity resolved: the spec says "most recent timestamp wins". Taken
    // literally every new tab would steal leadership forever, so we read it as
    // "the freshest *live* heartbeat wins": a live incumbent (age < staleMs)
    // keeps the lock, and only a stale record can be taken over.
    const incumbentAlive = !!record && record.id !== instanceId && now - record.at < staleMs && now - record.at >= 0;
    if (incumbentAlive) {
      setLeader(false, { via: 'heartbeat' });
    } else if (writeRecord(now)) {
      setLeader(true, { via: 'heartbeat' });
    } else {
      // Storage is blocked/full: behave like 'solo' so the timer still rings.
      setLeader(true, { via: 'heartbeat-storage-unavailable' });
    }
    heartbeatTimer = clock.setTimeout(beat, heartbeatMs);
  }

  if (mode === 'heartbeat') beat();

  // --- strategy 3: solo -----------------------------------------------------
  if (mode === 'solo') setLeader(true, { via: 'solo' });

  return {
    get isLeader() {
      return leader;
    },
    get mode() {
      return mode;
    },
    get instanceId() {
      return instanceId;
    },
    /**
     * @param {(isLeader: boolean, info: object) => void} cb
     * @returns {() => void} unsubscribe
     */
    onLeaderChange(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    post,
    /**
     * Subscribe to every incoming broadcast message (from any other instance),
     * regardless of type — used to mirror leader state to followers.
     * @param {(data: object) => void} cb
     * @returns {() => void} unsubscribe
     */
    onMessage(cb) {
      if (typeof cb !== 'function') return () => {};
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
    /** Give up leadership so another tab can take over (spec: destroy()). */
    release() {
      if (released) return;
      released = true;
      const wasLeader = leader;
      if (heartbeatTimer != null && clock && typeof clock.clearTimeout === 'function') {
        clock.clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (mode === 'heartbeat' && wasLeader) {
        const record = readRecord();
        if (record && record.id === instanceId) {
          try {
            storage.removeItem(storageKey);
          } catch {
            /* ignore */
          }
        }
      }
      setLeader(false, { via: 'release' });
      if (releaseLeadership) {
        const fn = releaseLeadership;
        releaseLeadership = null;
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      if (wasLeader) post({ type: 'leader-changed', isLeader: false, released: true });
      if (channel) {
        try {
          if (typeof channel.removeEventListener === 'function') {
            channel.removeEventListener('message', onChannelMessage);
          }
          channel.onmessage = null;
          if (typeof channel.close === 'function') channel.close();
        } catch {
          /* ignore */
        }
        channel = null;
      }
      listeners.clear();
      messageListeners.clear();
    },
  };
}
