import { describe, it, expect, vi } from 'vitest';
import { createLeaderElection } from '../../src/runtime/leader.js';
import { createFakeClock } from '../fakes/fakeClock.js';

/**
 * Fake `navigator.locks`: exclusive, FIFO. `request(name, opts, cb)` invokes cb
 * immediately for the first holder; the returned promise stays pending until
 * the holder resolves it, at which point the next waiter is granted the lock.
 * jsdom implements neither Web Locks nor BroadcastChannel, so we fake both.
 */
function createFakeLocks() {
  /** @type {Map<string, Array<{cb: Function, settle: Function}>>} */
  const queues = new Map();

  function grant(name) {
    const q = queues.get(name);
    if (!q || q.length === 0) return;
    const entry = q[0];
    if (entry.granted) return;
    entry.granted = true;
    // Real Web Locks grants asynchronously; keep that so subscribers attached
    // right after createLeaderElection() still observe the transition.
    queueMicrotask(() => {
      Promise.resolve(entry.cb()).then(() => {
        q.shift();
        grant(name);
        entry.settle();
      });
    });
  }

  return {
    held: () => [...queues.entries()].map(([n, q]) => [n, q.length]),
    request(name, opts, cb) {
      expect(opts).toEqual({ mode: 'exclusive' });
      if (!queues.has(name)) queues.set(name, []);
      const q = queues.get(name);
      let settle;
      const done = new Promise((r) => {
        settle = r;
      });
      q.push({ cb, settle, granted: false });
      grant(name);
      return done;
    },
  };
}

/** Fake BroadcastChannel: records posts, fans out to same-named siblings. */
function makeBroadcastChannelClass() {
  const byName = new Map();
  const posted = [];
  class FakeBC {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      this.closed = false;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(this);
    }
    addEventListener(type, fn) {
      if (type === 'message') this.listeners.add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.delete(fn);
    }
    postMessage(data) {
      if (this.closed) throw new Error('closed');
      posted.push({ from: this, data });
      for (const peer of byName.get(this.name) || []) {
        if (peer === this || peer.closed) continue;
        for (const fn of [...peer.listeners]) fn({ data });
      }
    }
    close() {
      this.closed = true;
      byName.get(this.name)?.delete(this);
    }
  }
  FakeBC.posted = posted;
  return FakeBC;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createLeaderElection — Web Locks path', () => {
  it('first tab becomes leader, second waits, release() hands over (criteria 21/24)', async () => {
    const locks = createFakeLocks();
    const BC = makeBroadcastChannelClass();
    const a = createLeaderElection(locks, 'ft-test', { BroadcastChannelCtor: BC, instanceId: 'A' });
    const b = createLeaderElection(locks, 'ft-test', { BroadcastChannelCtor: BC, instanceId: 'B' });
    await flush();

    expect(a.mode).toBe('locks');
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);

    a.release();
    await flush();
    expect(a.isLeader).toBe(false);
    expect(b.isLeader).toBe(true);
  });

  it('announces leadership on the BroadcastChannel', async () => {
    const locks = createFakeLocks();
    const BC = makeBroadcastChannelClass();
    createLeaderElection(locks, 'ft-announce', { BroadcastChannelCtor: BC, instanceId: 'A' });
    await flush();
    const msgs = BC.posted.map((p) => p.data);
    expect(msgs).toContainEqual({ instanceId: 'A', type: 'leader-changed', isLeader: true });
  });

  it('onLeaderChange fires with the new value and can be unsubscribed', async () => {
    const locks = createFakeLocks();
    const BC = makeBroadcastChannelClass();
    const seen = [];
    const el = createLeaderElection(locks, 'ft-cb', { BroadcastChannelCtor: BC, instanceId: 'A' });
    const off = el.onLeaderChange((isLeader) => seen.push(isLeader));
    await flush();
    expect(seen).toEqual([true]);

    off(); // unsubscribed: the release transition is no longer observed
    el.release();
    await flush();
    expect(seen).toEqual([true]);

    // The next tab observes its own promotion.
    const el2 = createLeaderElection(locks, 'ft-cb', { BroadcastChannelCtor: BC, instanceId: 'B' });
    const seen2 = [];
    el2.onLeaderChange((v) => seen2.push(v));
    await flush();
    expect(seen2).toEqual([true]);
    el2.release();
  });

  it('release() is idempotent and leaves no listeners', async () => {
    const locks = createFakeLocks();
    const BC = makeBroadcastChannelClass();
    const el = createLeaderElection(locks, 'ft-idem', { BroadcastChannelCtor: BC });
    await flush();
    const cb = vi.fn();
    el.onLeaderChange(cb);
    el.release();
    el.release();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(false, expect.objectContaining({ via: 'release' }));
  });

  it('onMessage mirrors arbitrary broadcasts between instances (integration state-sync hook)', async () => {
    const locks = createFakeLocks();
    const BC = makeBroadcastChannelClass();
    const a = createLeaderElection(locks, 'ft-msg', { BroadcastChannelCtor: BC, instanceId: 'A' });
    const b = createLeaderElection(locks, 'ft-msg', { BroadcastChannelCtor: BC, instanceId: 'B' });
    await flush();

    const seenByB = [];
    const off = b.onMessage((data) => seenByB.push(data));
    a.post({ type: 'sync', remainingMs: 12345 });
    expect(seenByB).toContainEqual(
      expect.objectContaining({ instanceId: 'A', type: 'sync', remainingMs: 12345 }),
    );

    off();
    seenByB.length = 0;
    a.post({ type: 'sync', remainingMs: 1 });
    expect(seenByB).toEqual([]); // unsubscribed

    a.release();
    b.release();
  });

  it('works without any BroadcastChannel implementation', async () => {
    const locks = createFakeLocks();
    const el = createLeaderElection(locks, 'ft-nobc', { BroadcastChannelCtor: undefined });
    await flush();
    expect(el.isLeader).toBe(true);
    expect(() => el.post({ type: 'x' })).not.toThrow();
    el.release();
  });
});

describe('createLeaderElection — localStorage heartbeat fallback', () => {
  function memStorage() {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      _map: map,
    };
  }

  it('elects the first tab and keeps it while its heartbeat is fresh', () => {
    const clock = createFakeClock();
    const storage = memStorage();
    const opts = { storage, clock, instanceId: 'A', heartbeatMs: 1000, staleMs: 3000 };
    const a = createLeaderElection(undefined, 'ft-hb', { ...opts, BroadcastChannelCtor: undefined });
    expect(a.mode).toBe('heartbeat');
    expect(a.isLeader).toBe(true);

    const b = createLeaderElection(null, 'ft-hb', {
      storage,
      clock,
      instanceId: 'B',
      heartbeatMs: 1000,
      staleMs: 3000,
      BroadcastChannelCtor: undefined,
    });
    expect(b.isLeader).toBe(false);

    clock.advance(1000); // both beat; A refreshes, B still defers
    expect(a.isLeader).toBe(true);
    expect(b.isLeader).toBe(false);

    a.release();
    clock.advance(1000);
    expect(b.isLeader).toBe(true);
    b.release();
  });

  it('takes over a stale record (dead tab)', () => {
    const clock = createFakeClock();
    const storage = memStorage();
    storage.setItem('focus-timer.v1:leader', JSON.stringify({ id: 'ghost', at: clock.wall() - 60_000 }));
    const el = createLeaderElection(undefined, 'ft-stale', {
      storage,
      clock,
      instanceId: 'A',
      staleMs: 5000,
      BroadcastChannelCtor: undefined,
    });
    expect(el.isLeader).toBe(true);
    el.release();
  });

  it('stays leader when storage writes throw (private mode / quota)', () => {
    const clock = createFakeClock();
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {},
    };
    const el = createLeaderElection(undefined, 'ft-blocked', {
      storage,
      clock,
      instanceId: 'A',
      BroadcastChannelCtor: undefined,
    });
    expect(el.isLeader).toBe(true);
    el.release();
  });
});

describe('createLeaderElection — solo degradation', () => {
  it('becomes leader immediately when neither Web Locks nor storage+clock exist', () => {
    const el = createLeaderElection(undefined, 'ft-solo', { BroadcastChannelCtor: undefined });
    expect(el.mode).toBe('solo');
    expect(el.isLeader).toBe(true);
    el.release();
    expect(el.isLeader).toBe(false);
  });
});
