import { describe, it, expect } from 'vitest';
import { createFakeClock } from '../fakes/fakeClock.js';
import { MAX_JUMP, createClock } from '../../src/core/clock.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * @param {number} remainingMs
 */
function setup(remainingMs) {
  const port = createFakeClock();
  const clock = createClock(port, { remainingMs });
  /** @type {any[]} */
  const anomalies = [];
  clock.on('clockanomaly', (a) => anomalies.push(a));
  return { port, clock, anomalies };
}

describe('createClock basics', () => {
  it('starts at the given remaining time and deducts real elapsed time', () => {
    const { port, clock } = setup(10 * MIN);
    expect(clock.remainingMs).toBe(10 * MIN);
    port.advance(1000);
    clock.tick();
    expect(clock.remainingMs).toBe(10 * MIN - 1000);
  });

  it('never goes below zero and fires `expire` exactly once', () => {
    const { port, clock } = setup(5000);
    let expires = 0;
    clock.on('expire', () => expires++);
    port.advance(4000);
    clock.tick();
    expect(clock.remainingMs).toBe(1000);
    port.advance(60_000);
    clock.tick();
    expect(clock.remainingMs).toBe(0);
    port.advance(60_000);
    clock.tick();
    expect(clock.remainingMs).toBe(0);
    expect(expires).toBe(1);
  });
});

// 수용 기준 14 — 시스템 시계 ±2시간 변경 시 잔여 점프 없음
describe('wall-only jump (criterion 14: system clock change)', () => {
  it('ignores a +2h wall jump when no gap was expected', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    port.advance(1000);
    clock.tick();
    const before = clock.remainingMs;

    port.advanceWallOnly(2 * HOUR); // user drags the OS clock forward
    clock.tick();

    expect(clock.remainingMs).toBe(before); // no real time passed → no deduction
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('jump');
    expect(anomalies[0].deltaMs).toBe(2 * HOUR);
  });

  it('accepts a small wall-ahead skew below MAX_JUMP as real elapsed time', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    port.advanceWallOnly(MAX_JUMP - 1);
    clock.tick();
    expect(clock.remainingMs).toBe(50 * MIN - (MAX_JUMP - 1));
    expect(anomalies).toHaveLength(0);
  });
});

// 수용 기준 14 — 되감김
describe('wall rewind (criterion 14: NTP / manual rewind)', () => {
  it('emits clockanomaly and does NOT increase the remaining time', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    port.advance(30 * MIN);
    clock.tick();
    const before = clock.remainingMs;
    expect(before).toBe(20 * MIN);

    port.rewindWall(2 * HOUR); // clock moves backwards
    clock.tick();

    expect(clock.remainingMs).toBe(before); // no mono delta → no change
    expect(clock.remainingMs).toBeLessThanOrEqual(before); // never up
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('rewind');
    expect(anomalies[0].deltaMs).toBeLessThan(0);
  });

  it('still counts down from the monotonic clock while the wall clock is behind', () => {
    const { port, clock } = setup(50 * MIN);
    port.rewindWall(HOUR);
    clock.tick(); // discards the wall clock
    const afterRewind = clock.remainingMs;

    port.advance(5 * MIN); // real time passes; wall is still an hour behind
    clock.tick();
    expect(clock.remainingMs).toBe(afterRewind - 5 * MIN);
  });

  it('remaining is monotonically non-increasing across a rewind storm', () => {
    const { port, clock } = setup(30 * MIN);
    let prev = clock.remainingMs;
    for (let i = 0; i < 20; i++) {
      port.advance(1000);
      port.rewindWall(10 * MIN);
      clock.tick();
      expect(clock.remainingMs).toBeLessThanOrEqual(prev);
      prev = clock.remainingMs;
    }
    expect(prev).toBe(30 * MIN - 20 * 1000);
  });
});

describe('mono-only jump (suspend where the wall clock is frozen)', () => {
  it('trusts the monotonic delta with no anomaly', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    port.advanceMonoOnly(10 * MIN);
    clock.tick();
    expect(clock.remainingMs).toBe(40 * MIN);
    expect(anomalies).toHaveLength(0);
  });
});

// 수용 기준 12 계열 — 둘 다 갭
describe('both clocks jump together (a real background gap)', () => {
  it('deducts the full elapsed time even without markGap', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    port.advance(30 * MIN); // both wall and mono moved: unambiguous
    clock.tick();
    expect(clock.remainingMs).toBe(20 * MIN);
    expect(anomalies).toHaveLength(0);
  });
});

describe('gapExpected changes the outcome of a big wall jump', () => {
  it('WITHOUT markGap: an 8h wall-only jump is rejected', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    port.advanceMonoOnly(1000); // the mono clock barely moved (it was suspended)
    port.advanceWallOnly(8 * HOUR - 1000);
    clock.tick();
    expect(clock.remainingMs).toBe(50 * MIN - 1000);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('jump');
  });

  it('WITH markGap: the same 8h jump is accepted as real elapsed time', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    clock.markGap(); // visibilitychange(hidden) / freeze / pagehide(persisted)
    port.advanceMonoOnly(1000);
    port.advanceWallOnly(8 * HOUR - 1000);
    clock.tick();
    expect(clock.remainingMs).toBe(0); // long gone
    expect(anomalies).toHaveLength(0);
  });

  it('markGap is consumed by exactly the NEXT tick and no later one', () => {
    const { port, clock } = setup(8 * HOUR);
    clock.markGap();
    expect(clock.gapExpected).toBe(true);

    port.advanceMonoOnly(500);
    port.advanceWallOnly(HOUR);
    clock.tick(); // consumes the flag, accepts the hour of wall delta
    expect(clock.remainingMs).toBe(7 * HOUR);
    expect(clock.gapExpected).toBe(false);

    port.advanceWallOnly(HOUR); // second jump, flag already spent
    clock.tick();
    expect(clock.remainingMs).toBe(7 * HOUR); // rejected
  });

  it('markGap is cleared even by an ordinary tick that sees no gap', () => {
    const { port, clock } = setup(HOUR);
    clock.markGap();
    port.advance(1000); // ordinary elapsed time
    clock.tick();
    expect(clock.gapExpected).toBe(false);
    expect(clock.remainingMs).toBe(HOUR - 1000);

    port.advanceWallOnly(30 * MIN);
    clock.tick();
    expect(clock.remainingMs).toBe(HOUR - 1000); // no free pass
  });
});

// 수용 기준 15 — DST 전환
describe('DST transition (criterion 15)', () => {
  it('deducts the real elapsed time when a DST boundary is crossed', () => {
    // Date.now() is UTC-based, so a DST change alone is not a wall jump: both
    // clocks advance together and 50 minutes of real time must be deducted.
    const { port, clock } = setup(50 * MIN);
    for (let i = 0; i < 50; i++) {
      port.advance(MIN);
      clock.tick();
    }
    expect(clock.remainingMs).toBe(0);
  });

  it('ignores a host that shifts the wall clock by an hour with no time passing', () => {
    const { port, clock, anomalies } = setup(50 * MIN);
    port.advance(10 * MIN);
    clock.tick();
    port.advanceWallOnly(HOUR); // buggy "spring forward" with no real elapse
    clock.tick();
    expect(clock.remainingMs).toBe(40 * MIN);
    expect(anomalies.map((a) => a.kind)).toEqual(['jump']);

    port.rewindWall(HOUR); // and back again in autumn
    clock.tick();
    expect(clock.remainingMs).toBe(40 * MIN);
  });
});

// 수용 기준 10 — 50분 구동 중 표시 분 단조 감소, 중복 0, 스킵 0
describe('50-minute run (criterion 10: monotonic minutes, no dupes, no skips)', () => {
  it('walks 50 → 0 one minute at a time with a 1s tick', () => {
    const { port, clock } = setup(50 * MIN);
    const display = () => Math.ceil(clock.remainingMs / MIN);
    /** @type {number[]} */
    const changes = [display()];
    let prevRemaining = clock.remainingMs;

    for (let s = 0; s < 50 * 60; s++) {
      port.advance(1000);
      clock.tick();
      expect(clock.remainingMs).toBeLessThanOrEqual(prevRemaining); // never up
      prevRemaining = clock.remainingMs;
      const d = display();
      if (d !== changes[changes.length - 1]) changes.push(d);
    }

    expect(clock.remainingMs).toBe(0);
    expect(changes[0]).toBe(50);
    expect(changes[changes.length - 1]).toBe(0);
    expect(changes).toHaveLength(51); // 50…0, no duplicates
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i]).toBe(changes[i - 1] - 1); // no skips
    }
  });
});

describe('setRemaining re-baseline', () => {
  it('is the only way remaining goes up, and it forgets the pending gap', () => {
    const { port, clock } = setup(MIN);
    port.advance(30_000);
    clock.tick();
    expect(clock.remainingMs).toBe(30_000);

    clock.markGap();
    clock.setRemaining(25 * MIN);
    expect(clock.remainingMs).toBe(25 * MIN);
    expect(clock.gapExpected).toBe(false);

    port.advanceWallOnly(HOUR); // the stale gap must not be honoured
    clock.tick();
    expect(clock.remainingMs).toBe(25 * MIN);
  });

  it('does not deduct time that passed before the re-baseline', () => {
    const { port, clock } = setup(MIN);
    port.advance(10 * MIN); // a long pause with no ticks
    clock.setRemaining(5 * MIN);
    clock.tick();
    expect(clock.remainingMs).toBe(5 * MIN);
  });
});

describe('listener robustness (criterion 39: zero console errors)', () => {
  it('a throwing listener cannot break the clock', () => {
    const { port, clock } = setup(MIN);
    const off = clock.on('tick', () => {
      throw new Error('listener blew up');
    });
    let seen = 0;
    clock.on('tick', () => seen++);
    port.advance(1000);
    expect(() => clock.tick()).not.toThrow();
    expect(clock.remainingMs).toBe(MIN - 1000);
    expect(seen).toBe(1);
    off();
    port.advance(1000);
    clock.tick();
    expect(seen).toBe(2);
  });

  it('unsubscribing stops delivery', () => {
    const { port, clock } = setup(MIN);
    let n = 0;
    const off = clock.on('tick', () => n++);
    port.advance(1000);
    clock.tick();
    off();
    port.advance(1000);
    clock.tick();
    expect(n).toBe(1);
  });
});
