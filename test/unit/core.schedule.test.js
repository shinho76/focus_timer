import { describe, it, expect } from 'vitest';
import { createFakeClock } from '../fakes/fakeClock.js';
import { createClock } from '../../src/core/clock.js';
import { GRACE_MS, createSchedule } from '../../src/core/schedule.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup() {
  const port = createFakeClock();
  const clock = createClock(port);
  const schedule = createSchedule(clock);
  return { port, clock, schedule };
}

describe('start / pause / resume / reset data model', () => {
  it('running stores an absolute deadlineWall', () => {
    const { port, schedule } = setup();
    const t0 = port.wall();
    schedule.start(25 * MIN);
    expect(schedule.status).toBe('running');
    expect(schedule.deadlineWall).toBe(t0 + 25 * MIN);
    expect(schedule.remainingMs).toBe(25 * MIN);
    expect(schedule.totalMs).toBe(25 * MIN);
    expect(schedule.handleCount).toBe(1);
  });

  it('paused stores remainingMs and drops the deadline to null', () => {
    const { port, schedule } = setup();
    schedule.start(25 * MIN);
    port.advance(5 * MIN);
    expect(schedule.pause()).toBe(true);

    expect(schedule.status).toBe('paused');
    expect(schedule.remainingMs).toBe(20 * MIN);
    expect(schedule.deadlineWall).toBeNull(); // no deadline while paused
    expect(schedule.handleCount).toBe(0);
    expect(port.pendingTimerCount()).toBe(0);
  });

  // 수용 기준 19 지지 — paused 는 경과를 차감하지 않는다
  it('a paused schedule freezes: hours of wall time change nothing', () => {
    const { port, schedule } = setup();
    schedule.start(25 * MIN);
    port.advance(5 * MIN);
    schedule.pause();

    port.advance(3 * HOUR);
    expect(schedule.remainingMs).toBe(20 * MIN);
    expect(schedule.deadlineWall).toBeNull();
    expect(schedule.settle().status).toBe('paused');
    expect(schedule.settle().remainingMs).toBe(20 * MIN);
  });

  it('resume computes a fresh deadline from the frozen remainder', () => {
    const { port, schedule } = setup();
    schedule.start(25 * MIN);
    port.advance(5 * MIN);
    schedule.pause();
    port.advance(3 * HOUR); // paused in the background for ages

    const t = port.wall();
    expect(schedule.resume()).toBe(true);
    expect(schedule.status).toBe('running');
    expect(schedule.deadlineWall).toBe(t + 20 * MIN);
    expect(schedule.remainingMs).toBe(20 * MIN);

    port.advance(MIN);
    expect(schedule.remainingMs).toBe(19 * MIN);
  });

  it('reset clears the handle and all state', () => {
    const { port, schedule } = setup();
    schedule.start(25 * MIN);
    schedule.reset();
    expect(schedule.status).toBe('idle');
    expect(schedule.remainingMs).toBe(0);
    expect(schedule.deadlineWall).toBeNull();
    expect(schedule.handleCount).toBe(0);
    expect(port.pendingTimerCount()).toBe(0);
  });

  it('pause/resume are no-ops in the wrong status (no exceptions)', () => {
    const { schedule } = setup();
    expect(schedule.pause()).toBe(false); // idle
    expect(schedule.resume()).toBe(false); // idle
    schedule.start(MIN);
    expect(schedule.resume()).toBe(false); // running
    expect(schedule.pause()).toBe(true);
    expect(schedule.pause()).toBe(false); // paused twice
    expect(schedule.status).toBe('paused');
  });

  it('releases its handle at expiry and does not re-arm', () => {
    const { port, schedule } = setup();
    schedule.start(2000);
    for (let i = 0; i < 20; i++) port.advance(200);
    expect(schedule.remainingMs).toBe(0);
    expect(schedule.status).toBe('expired');
    expect(schedule.handleCount).toBe(0);
    expect(port.pendingTimerCount()).toBe(0);
  });
});

// 수용 기준 9 — 포그라운드 만료 오차 ≤ ±200ms (5회 최댓값)
describe('foreground expiry accuracy (criterion 9)', () => {
  it('fires within 200ms of the deadline across 5 runs', () => {
    /** @type {number[]} */
    const errors = [];
    for (const offset of [0, 37, 99, 137, 199]) {
      const port = createFakeClock();
      const clock = createClock(port);
      const schedule = createSchedule(clock);
      /** @type {number|null} */
      let firedAt = null;
      clock.on('expire', () => {
        firedAt = port.wall();
      });

      const total = 3 * MIN + offset;
      schedule.start(total);
      const deadline = /** @type {number} */ (schedule.deadlineWall);
      for (let i = 0; i < 2000 && firedAt === null; i++) port.advance(100);

      expect(firedAt).not.toBeNull();
      errors.push(Math.abs(/** @type {number} */ (firedAt) - deadline));
    }
    expect(Math.max(...errors)).toBeLessThanOrEqual(200);
  });
});

// 수용 기준 13 — 만료 후 복귀 정산 (grace 90초)
describe('settle() grace rules (spec §4.4, criterion 13)', () => {
  it('exactly at expiry → ring', () => {
    const { port, schedule } = setup();
    schedule.start(25 * MIN);
    const deadline = /** @type {number} */ (schedule.deadlineWall);

    const s = schedule.settle(deadline);
    expect(s.status).toBe('ringing');
    expect(s.shouldRing).toBe(true);
    expect(s.overdueMs).toBe(0);
    expect(s.remainingMs).toBe(0);
    expect(s.totalMs).toBe(25 * MIN);
    expect(port.wall()).toBeLessThanOrEqual(deadline); // settle() is pure
    expect(schedule.status).toBe('running');
  });

  it('1ms before expiry → still running, with the exact remainder', () => {
    const { schedule } = setup();
    schedule.start(25 * MIN);
    const deadline = /** @type {number} */ (schedule.deadlineWall);
    const s = schedule.settle(deadline - 1);
    expect(s.status).toBe('running');
    expect(s.shouldRing).toBe(false);
    expect(s.remainingMs).toBe(1);
    expect(s.overdueMs).toBe(0);
  });

  it('inside the 90s grace window → ring', () => {
    const { schedule } = setup();
    schedule.start(25 * MIN);
    const deadline = /** @type {number} */ (schedule.deadlineWall);
    for (const late of [1, 1000, 45_000, GRACE_MS - 1, GRACE_MS]) {
      const s = schedule.settle(deadline + late);
      expect(s.status).toBe('ringing');
      expect(s.shouldRing).toBe(true);
      expect(s.overdueMs).toBe(late);
      expect(s.remainingMs).toBe(0);
    }
  });

  it('one millisecond past the grace window → completed, no alarm', () => {
    const { schedule } = setup();
    schedule.start(25 * MIN);
    const deadline = /** @type {number} */ (schedule.deadlineWall);
    const s = schedule.settle(deadline + GRACE_MS + 1);
    expect(s.status).toBe('completed');
    expect(s.shouldRing).toBe(false);
    expect(s.overdueMs).toBe(GRACE_MS + 1);
  });

  it('3 hours past expiry → completed with overdueMs, alarm silent', () => {
    const { port, clock, schedule } = setup();
    schedule.start(50 * MIN);
    const deadline = /** @type {number} */ (schedule.deadlineWall);

    // The laptop slept: the page comes back three hours after the deadline.
    clock.markGap();
    port.advance(50 * MIN + 3 * HOUR);
    const s = schedule.settle();

    expect(s.status).toBe('completed');
    expect(s.shouldRing).toBe(false);
    expect(s.overdueMs).toBe(3 * HOUR);
    expect(s.remainingMs).toBe(0);
    expect(s.totalMs).toBe(50 * MIN);
    expect(port.wall() - deadline).toBe(3 * HOUR);
  });

  it('an idle schedule settles to idle', () => {
    const { schedule } = setup();
    const s = schedule.settle();
    expect(s.status).toBe('idle');
    expect(s.shouldRing).toBe(false);
    expect(s.overdueMs).toBe(0);
  });

  it('settle() defaults to the clock’s wall time and never mutates', () => {
    const { port, schedule } = setup();
    schedule.start(MIN);
    port.advance(30_000);
    const a = schedule.settle();
    expect(a.status).toBe('running');
    expect(a.remainingMs).toBe(30_000);
    const b = schedule.settle();
    expect(b).toEqual(a);
    expect(schedule.status).toBe('running');
  });
});

describe('deadlineWall survives a background gap (restore support)', () => {
  it('recomputes the same remainder from wall time alone', () => {
    const { port, clock, schedule } = setup();
    schedule.start(50 * MIN);
    const deadline = /** @type {number} */ (schedule.deadlineWall);

    clock.markGap();
    port.advance(30 * MIN); // hidden tab / suspend
    clock.tick();

    // Recomputed from the deadline vs. tracked by the clock: same answer.
    expect(deadline - port.wall()).toBe(20 * MIN);
    expect(schedule.remainingMs).toBe(20 * MIN);
    expect(schedule.settle().remainingMs).toBe(20 * MIN);
  });

  it('zero-length timers expire immediately without arming a handle', () => {
    const { port, schedule } = setup();
    expect(schedule.start(0)).toBe(true);
    expect(schedule.status).toBe('expired');
    expect(schedule.remainingMs).toBe(0);
    expect(port.pendingTimerCount()).toBe(0);
  });

  it('rejects a bad clock argument loudly at construction time', () => {
    // @ts-expect-error deliberate misuse
    expect(() => createSchedule({})).toThrow(TypeError);
  });
});
