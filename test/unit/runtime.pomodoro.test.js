import { describe, it, expect, vi } from 'vitest';
import { createPomodoro, POMODORO_PRESETS, GRACE_MS } from '../../src/modes/pomodoro.js';
import { createFakeClock } from '../fakes/fakeClock.js';

const MIN = 60_000;

/**
 * Local stand-in for core/schedule.js (not written yet by the core agent at the
 * time these tests were authored). It implements the documented contract:
 * { start(totalMs), pause(), resume(), reset(), remainingMs, deadlineWall, settle(nowWall) }
 * and is driven by test/fakes/fakeClock.js.
 */
function createFakeSchedule(clock) {
  let deadline = null;
  let frozen = 0;
  let paused = false;
  const calls = [];
  return {
    calls,
    start(totalMs) {
      calls.push(['start', totalMs]);
      frozen = totalMs;
      deadline = clock.wall() + totalMs;
      paused = false;
    },
    pause() {
      calls.push(['pause']);
      frozen = Math.max(0, deadline - clock.wall());
      deadline = null;
      paused = true;
    },
    resume() {
      calls.push(['resume']);
      deadline = clock.wall() + frozen;
      paused = false;
    },
    reset() {
      calls.push(['reset']);
      deadline = null;
      frozen = 0;
      paused = false;
    },
    get remainingMs() {
      if (paused || deadline == null) return frozen;
      return Math.max(0, deadline - clock.wall());
    },
    get deadlineWall() {
      return deadline;
    },
    settle(nowWall) {
      if (deadline == null) return { expired: false, overdueMs: 0 };
      const overdueMs = Math.max(0, nowWall - deadline);
      return { expired: nowWall >= deadline, overdueMs };
    },
  };
}

function setup(config) {
  const clock = createFakeClock();
  const schedule = createFakeSchedule(clock);
  const pomo = createPomodoro(schedule, config);
  return { clock, schedule, pomo };
}

describe('pomodoro — configuration', () => {
  it('defaults to 50 / 10 / 30 with a long break after 3 focus completions', () => {
    const { pomo } = setup();
    expect(pomo.config.focusMs).toBe(50 * MIN);
    expect(pomo.config.shortBreakMs).toBe(10 * MIN);
    expect(pomo.config.longBreakMs).toBe(30 * MIN);
    expect(pomo.config.focusesPerCycle).toBe(3);
    expect(pomo.phase).toBe('focus');
    expect(pomo.plannedMs).toBe(50 * MIN);
  });

  it('offers the classic 25/5/15/4 preset', () => {
    const { pomo } = setup({ preset: 'classic' });
    expect(pomo.config).toMatchObject(POMODORO_PRESETS.classic);
    expect(pomo.plannedMs).toBe(25 * MIN);
  });

  it('every value is user-overridable, including on top of a preset', () => {
    const { pomo } = setup({ preset: 'classic', focusMinutes: 40, longBreakMs: 20 * MIN, focusesPerCycle: 2 });
    expect(pomo.config.focusMs).toBe(40 * MIN);
    expect(pomo.config.shortBreakMs).toBe(5 * MIN); // from the preset
    expect(pomo.config.longBreakMs).toBe(20 * MIN);
    expect(pomo.config.focusesPerCycle).toBe(2);
    pomo.setConfig({ focusMs: 10 * MIN });
    expect(pomo.config.focusMs).toBe(10 * MIN);
    expect(pomo.config.focusesPerCycle).toBe(2); // untouched keys survive
  });

  it('exposes phase identity as data, not as a boolean', () => {
    const { pomo } = setup();
    expect(pomo.phase).toBe('focus');
    expect(pomo.phaseToken).toBe('phase-focus');
    expect(pomo.phaseLabelKey).toBe('phase.focus');
    expect(pomo.isBreak).toBe(false);
    pomo.complete();
    expect(pomo.phase).toBe('short-break');
    expect(pomo.phaseToken).toBe('phase-short-break');
    expect(pomo.isBreak).toBe(true);
  });
});

describe('pomodoro — schedule composition (fake clock driven)', () => {
  it('start() runs the current phase duration on the injected schedule', () => {
    const { clock, schedule, pomo } = setup();
    pomo.start();
    expect(schedule.calls[0]).toEqual(['start', 50 * MIN]);
    clock.advance(30 * MIN);
    expect(schedule.remainingMs).toBe(20 * MIN);
    clock.advance(20 * MIN);
    expect(schedule.remainingMs).toBe(0);
  });

  it('records actualMs from the schedule when a phase is cut short', () => {
    const { clock, pomo } = setup();
    pomo.start();
    clock.advance(12 * MIN);
    const rec = pomo.skip();
    expect(rec.actualMs).toBe(12 * MIN);
    expect(rec.plannedMs).toBe(50 * MIN);
  });

  it('pause/resume delegate to the schedule', () => {
    const { clock, schedule, pomo } = setup();
    pomo.start();
    clock.advance(10 * MIN);
    pomo.pause();
    clock.advance(60 * MIN);
    expect(schedule.remainingMs).toBe(40 * MIN); // frozen while paused
    pomo.resume();
    clock.advance(5 * MIN);
    expect(schedule.remainingMs).toBe(35 * MIN);
  });
});

describe('pomodoro — the two auto-advance toggles are independent', () => {
  it('defaults: focus->break auto-starts ON, break->focus auto-starts OFF', () => {
    const { schedule, pomo } = setup();
    expect(pomo.autoStart).toEqual({ break: true, focus: false });

    pomo.start();
    const afterFocus = pomo.complete();
    expect(afterFocus.next).toMatchObject({ phase: 'short-break', autoStarted: true });
    expect(pomo.isStarted).toBe(true);
    expect(schedule.calls.at(-1)).toEqual(['start', 10 * MIN]);

    const afterBreak = pomo.complete();
    expect(afterBreak.next).toMatchObject({ phase: 'focus', autoStarted: false });
    expect(pomo.phase).toBe('focus');
    expect(pomo.isStarted).toBe(false);
    expect(schedule.calls.at(-1)).toEqual(['reset']);
  });

  it('break auto-start OFF alone does not affect focus auto-start', () => {
    const { pomo } = setup({ autoStartBreak: false, autoStartFocus: true });
    pomo.start();
    expect(pomo.complete().next).toMatchObject({ phase: 'short-break', autoStarted: false });
    expect(pomo.isStarted).toBe(false);
    expect(pomo.complete().next).toMatchObject({ phase: 'focus', autoStarted: true });
    expect(pomo.isStarted).toBe(true);
  });

  it('both ON and both OFF behave as configured', () => {
    const both = setup({ autoStartBreak: true, autoStartFocus: true }).pomo;
    both.start();
    expect(both.complete().next.autoStarted).toBe(true);
    expect(both.complete().next.autoStarted).toBe(true);

    const none = setup({ autoStartBreak: false, autoStartFocus: false }).pomo;
    none.start();
    expect(none.complete().next.autoStarted).toBe(false);
    expect(none.complete().next.autoStarted).toBe(false);
  });
});

describe('pomodoro — skip', () => {
  it('records skipped:true without incrementing the completed-focus counter', () => {
    const { pomo } = setup();
    pomo.start();
    const rec = pomo.skip();
    expect(rec.skipped).toBe(true);
    expect(rec.phase).toBe('focus');
    expect(pomo.completedFocus).toBe(0);
    expect(pomo.cycleIndex).toBe(0);
    // A skipped focus does not earn a long break either.
    expect(pomo.phase).toBe('short-break');
  });

  it('skipping a break returns to focus and is logged as skipped', () => {
    const { pomo } = setup();
    pomo.start();
    pomo.complete(); // focus 1 done -> short break
    expect(pomo.completedFocus).toBe(1);
    const rec = pomo.skip();
    expect(rec).toMatchObject({ phase: 'short-break', skipped: true });
    expect(pomo.phase).toBe('focus');
    expect(pomo.completedFocus).toBe(1);
  });

  it('three skipped focuses never reach a long break', () => {
    const { pomo } = setup();
    for (let i = 0; i < 3; i++) {
      pomo.start();
      pomo.skip(); // focus skipped
      pomo.skip(); // break skipped
    }
    expect(pomo.completedFocus).toBe(0);
    expect(pomo.cycleIndex).toBe(0);
    expect(pomo.phase).toBe('focus');
  });
});

describe('pomodoro — cycle boundary (criterion 22)', () => {
  it('focus 1 and 2 -> short break, focus 3 -> long break, then cycleIndex resets to 0', () => {
    const { clock, pomo } = setup();
    const phases = [];
    pomo.on('phasechange', (e) => phases.push([e.from, e.to, e.cycleIndex]));

    // focus 1
    pomo.start();
    clock.advance(50 * MIN);
    expect(pomo.complete().next.phase).toBe('short-break');
    expect(pomo.cycleIndex).toBe(1);
    clock.advance(10 * MIN);
    pomo.complete(); // break 1 -> focus (not auto-started)

    // focus 2
    pomo.start();
    clock.advance(50 * MIN);
    expect(pomo.complete().next.phase).toBe('short-break');
    expect(pomo.cycleIndex).toBe(2);
    clock.advance(10 * MIN);
    pomo.complete();

    // focus 3 -> LONG break
    pomo.start();
    clock.advance(50 * MIN);
    const third = pomo.complete();
    expect(third.next.phase).toBe('long-break');
    expect(third.next.plannedMs).toBe(30 * MIN);
    expect(pomo.phase).toBe('long-break');
    expect(pomo.cycleIndex).toBe(3);

    // long break ends -> cycleIndex resets
    clock.advance(30 * MIN);
    const afterLong = pomo.complete();
    expect(afterLong.phase).toBe('long-break');
    expect(pomo.cycleIndex).toBe(0);
    expect(pomo.phase).toBe('focus');
    expect(pomo.completedFocus).toBe(3);

    expect(phases.map(([from, to]) => `${from}>${to}`)).toEqual([
      'focus>short-break',
      'short-break>focus',
      'focus>short-break',
      'short-break>focus',
      'focus>long-break',
      'long-break>focus',
    ]);
  });

  it('honours a custom focusesPerCycle', () => {
    const { pomo } = setup({ preset: 'classic' }); // 4 per cycle
    for (let i = 1; i <= 3; i++) {
      pomo.start();
      expect(pomo.complete().next.phase).toBe('short-break');
      pomo.complete();
    }
    pomo.start();
    expect(pomo.complete().next.phase).toBe('long-break');
  });

  it('nextPhase previews the boundary without mutating state', () => {
    const { pomo } = setup({ focusesPerCycle: 1 });
    expect(pomo.nextPhase).toBe('long-break');
    expect(pomo.cycleIndex).toBe(0);
    expect(pomo.phase).toBe('focus');
  });

  it('reset() returns to focus with cycleIndex 0', () => {
    const { pomo } = setup();
    pomo.start();
    pomo.complete();
    pomo.reset();
    expect(pomo.phase).toBe('focus');
    expect(pomo.cycleIndex).toBe(0);
    expect(pomo.completedFocus).toBe(1); // history is kept by default
  });
});

describe('pomodoro — long absence (spec §4.4, criterion 13)', () => {
  it('suppresses auto-start when the expiry is older than the 90s grace', () => {
    const { clock, pomo } = setup();
    pomo.start();
    clock.advance(50 * MIN + 3 * 60 * MIN); // came back 3 hours later
    const rec = pomo.complete({ overdueMs: 3 * 60 * MIN });
    expect(rec.overdue).toBe(true);
    expect(rec.next).toMatchObject({ phase: 'short-break', autoStarted: false });
    expect(pomo.isStarted).toBe(false); // no alarm-triggering auto-run
  });

  it('still auto-starts inside the grace window', () => {
    const { pomo } = setup();
    pomo.start();
    const rec = pomo.complete({ overdueMs: GRACE_MS });
    expect(rec.overdue).toBe(false);
    expect(rec.next.autoStarted).toBe(true);
  });

  it('one complete() call advances exactly one phase — never a chain', () => {
    const { clock, pomo } = setup();
    const completions = [];
    pomo.on('complete', (e) => completions.push(e.phase));
    pomo.start();
    clock.advance(8 * 60 * MIN); // 8 hours of sleep: many phases "would" have elapsed
    pomo.complete({ overdueMs: 8 * 60 * MIN - 50 * MIN });
    expect(completions).toEqual(['focus']);
    expect(pomo.completedFocus).toBe(1);
    expect(pomo.cycleIndex).toBe(1);
  });
});

describe('pomodoro — events and persistence', () => {
  it('emits complete / phasechange / phasestart with the data the view needs', () => {
    const { pomo } = setup();
    const onComplete = vi.fn();
    const onPhaseChange = vi.fn();
    const onPhaseStart = vi.fn();
    pomo.on('complete', onComplete);
    pomo.on('phasechange', onPhaseChange);
    pomo.on('phasestart', onPhaseStart);

    pomo.start();
    pomo.complete();
    expect(onPhaseStart).toHaveBeenCalledTimes(2); // manual start + auto break
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      phase: 'focus',
      plannedMs: 50 * MIN,
      skipped: false,
      cycleIndex: 1,
    });
    expect(onPhaseChange.mock.calls[0][0]).toMatchObject({
      from: 'focus',
      to: 'short-break',
      token: 'phase-short-break',
      autoStarted: true,
    });
  });

  it('unsubscribes listeners and survives a throwing subscriber', () => {
    const { pomo } = setup();
    const good = vi.fn();
    const off = pomo.on('complete', () => {
      throw new Error('boom');
    });
    pomo.on('complete', good);
    expect(() => pomo.complete()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    off();
    pomo.complete();
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('snapshot / restore round-trips the §7.1 cycle fields', () => {
    const { pomo } = setup();
    pomo.start();
    pomo.complete();
    const snap = pomo.snapshot();
    expect(snap).toEqual({ phase: 'short-break', cycleIndex: 1, completedFocus: 1 });

    const fresh = setup().pomo;
    fresh.restore(snap);
    expect(fresh.phase).toBe('short-break');
    expect(fresh.cycleIndex).toBe(1);
    expect(fresh.completedFocus).toBe(1);
    expect(fresh.isStarted).toBe(false);
    expect(fresh.plannedMs).toBe(10 * MIN);
  });
});
