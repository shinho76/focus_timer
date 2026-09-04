import { describe, it, expect, vi } from 'vitest';
import { createFakeClock } from '../fakes/fakeClock.js';
import { FORBIDDEN, STATES, TRANSITIONS, createMachine, nextState } from '../../src/core/machine.js';
import { createClock } from '../../src/core/clock.js';
import { createSchedule } from '../../src/core/schedule.js';

const MIN = 60_000;

/**
 * Drive a machine into a given state through legal transitions only.
 * @param {string} target
 */
function machineIn(target) {
  const m = createMachine('idle');
  switch (target) {
    case 'idle':
      break;
    case 'setting':
      m.send('dialdown');
      break;
    case 'running':
      m.send('start');
      break;
    case 'paused':
      m.send('start');
      m.send('pause');
      break;
    case 'ringing':
      m.send('start');
      m.send('expire');
      break;
    case 'destroyed':
      m.send('destroy');
      break;
    default:
      throw new Error(`unknown state ${target}`);
  }
  expect(m.state).toBe(target);
  return m;
}

describe('TRANSITIONS is a data table (spec §2.2)', () => {
  it('covers all five states plus the destroyed sink and is frozen', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATES].sort());
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    for (const s of STATES) expect(Object.isFrozen(TRANSITIONS[s])).toBe(true);
  });

  it('only ever points at declared states', () => {
    for (const s of STATES) {
      for (const to of Object.values(TRANSITIONS[s])) {
        expect(STATES).toContain(to);
      }
    }
  });

  it('encodes the happy path of spec §2.2', () => {
    expect(nextState('idle', 'dialdown')).toBe('setting');
    expect(nextState('setting', 'dialup')).toBe('running');
    expect(nextState('setting', 'dialcancel')).toBe('idle');
    expect(nextState('running', 'pause')).toBe('paused');
    expect(nextState('running', 'expire')).toBe('ringing');
    expect(nextState('running', 'reset')).toBe('idle');
    expect(nextState('running', 'clockrewind')).toBe('running');
    expect(nextState('paused', 'resume')).toBe('running');
    expect(nextState('ringing', 'acknowledge')).toBe('idle');
    expect(nextState('ringing', 'remoteack')).toBe('idle');
  });
});

// 수용 기준 18 — 금지 전이 7종 전부 no-op, 예외 0
describe('the 7 forbidden transitions are silent no-ops (criterion 18)', () => {
  it('lists exactly the seven forbidden transitions of spec §2.2', () => {
    expect(FORBIDDEN).toHaveLength(7);
  });

  it('1. idle → pause', () => {
    const m = machineIn('idle');
    expect(() => m.send('pause')).not.toThrow();
    expect(m.send('pause')).toBe(false);
    expect(m.state).toBe('idle');
  });

  it('2. idle → resume', () => {
    const m = machineIn('idle');
    expect(() => m.send('resume')).not.toThrow();
    expect(m.send('resume')).toBe(false);
    expect(m.state).toBe('idle');
  });

  it('3. running → start (the double-start bug)', () => {
    const m = machineIn('running');
    expect(() => m.send('start')).not.toThrow();
    expect(m.send('start')).toBe(false);
    expect(m.state).toBe('running');
  });

  it('4. paused → pause', () => {
    const m = machineIn('paused');
    expect(() => m.send('pause')).not.toThrow();
    expect(m.send('pause')).toBe(false);
    expect(m.state).toBe('paused');
  });

  it('5. running → resume', () => {
    const m = machineIn('running');
    expect(() => m.send('resume')).not.toThrow();
    expect(m.send('resume')).toBe(false);
    expect(m.state).toBe('running');
  });

  it('6. dial manipulation while running (also paused / ringing) — spec §3.4', () => {
    for (const state of ['running', 'paused', 'ringing']) {
      const m = machineIn(state);
      for (const ev of ['dialdown', 'dialup', 'dialcancel']) {
        expect(() => m.send(ev)).not.toThrow();
        expect(m.send(ev)).toBe(false);
        expect(m.state).toBe(state);
      }
    }
  });

  it('7. every event after destroy', () => {
    const m = machineIn('destroyed');
    const everyEvent = new Set();
    for (const s of STATES) for (const e of Object.keys(TRANSITIONS[s])) everyEvent.add(e);
    everyEvent.add('nonsense');
    for (const ev of everyEvent) {
      expect(() => m.send(ev)).not.toThrow();
      expect(m.send(ev)).toBe(false);
      expect(m.state).toBe('destroyed');
    }
    expect(m.isDestroyed).toBe(true);
  });

  it('the full forbidden table drives no transition and emits no statechange', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const { from, event } of FORBIDDEN) {
      const m = machineIn(from);
      let changes = 0;
      m.on('statechange', () => changes++);
      expect(() => m.send(event)).not.toThrow();
      expect(m.state).toBe(from);
      expect(changes).toBe(0);
      expect(m.can(event)).toBe(false);
    }
    expect(errorSpy).not.toHaveBeenCalled(); // 콘솔 에러 0
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('unknown events in any state are no-ops too', () => {
    for (const s of STATES) {
      const m = machineIn(s);
      expect(m.send('☃')).toBe(false);
      expect(m.send('')).toBe(false);
      expect(m.send(undefined)).toBe(false);
      expect(m.state).toBe(s);
    }
  });
});

describe('statechange notifications', () => {
  it('reports from/to/event/payload once per accepted transition', () => {
    const m = createMachine('idle');
    /** @type {any[]} */
    const seen = [];
    const off = m.on('statechange', (c) => seen.push(c));
    m.send('dialdown');
    m.send('dialup', { minutes: 25 });
    expect(seen).toEqual([
      { from: 'idle', to: 'setting', event: 'dialdown', payload: undefined },
      { from: 'setting', to: 'running', event: 'dialup', payload: { minutes: 25 } },
    ]);
    off();
    m.send('pause');
    expect(seen).toHaveLength(2);
    expect(m.state).toBe('paused');
  });

  it('does not notify for a same-state transition (running → running)', () => {
    const m = machineIn('running');
    let changes = 0;
    m.on('statechange', () => changes++);
    expect(m.send('clockrewind')).toBe(true); // accepted…
    expect(changes).toBe(0); // …but the state did not change
    expect(m.state).toBe('running');
  });

  it('a throwing listener cannot break the machine', () => {
    const m = createMachine('idle');
    m.on('statechange', () => {
      throw new Error('listener blew up');
    });
    expect(() => m.send('start')).not.toThrow();
    expect(m.state).toBe('running');
  });

  it('an invalid initialState falls back to idle', () => {
    expect(createMachine('bogus').state).toBe('idle');
    expect(createMachine().state).toBe('idle');
    expect(createMachine('paused').state).toBe('paused');
  });
});

// 수용 기준 17 — START 5회 연타 → 내부 핸들 1개, 60초당 감소 60±1초
describe('START pressed 5 times rapidly (criterion 17)', () => {
  /** Wire the machine to a real schedule the way index.js will. */
  function wire(totalMs) {
    const port = createFakeClock();
    const clock = createClock(port);
    const schedule = createSchedule(clock);
    const machine = createMachine('idle');
    let startCalls = 0;
    machine.on('statechange', ({ to, event }) => {
      if (to === 'running' && (event === 'start' || event === 'dialup')) {
        startCalls++;
        schedule.start(totalMs);
      }
    });
    return { port, clock, schedule, machine, starts: () => startCalls };
  }

  it('creates exactly ONE schedule handle, not five', () => {
    const { port, schedule, machine, starts } = wire(25 * MIN);
    for (let i = 0; i < 5; i++) machine.send('start');

    expect(machine.state).toBe('running');
    expect(starts()).toBe(1); // only the first send was accepted
    expect(schedule.handleCount).toBe(1);
    expect(port.pendingTimerCount()).toBe(1); // exactly one live timer
  });

  it('still counts down at 1× speed: 60s of real time removes 60±1s', () => {
    const { port, schedule, machine } = wire(25 * MIN);
    for (let i = 0; i < 5; i++) machine.send('start');
    const before = schedule.remainingMs;

    for (let i = 0; i < 60; i++) port.advance(1000); // 60 seconds

    const elapsed = before - schedule.remainingMs;
    expect(elapsed).toBeGreaterThanOrEqual(59_000);
    expect(elapsed).toBeLessThanOrEqual(61_000);
    expect(port.pendingTimerCount()).toBe(1); // never accumulated handles
  });

  it('start() straight on the schedule is also guarded while running', () => {
    const { port, schedule } = wire(25 * MIN);
    expect(schedule.start(25 * MIN)).toBe(true);
    for (let i = 0; i < 5; i++) expect(schedule.start(5 * MIN)).toBe(false);
    expect(schedule.totalMs).toBe(25 * MIN); // not overwritten by the 5-min spam
    expect(schedule.handleCount).toBe(1);
    expect(port.pendingTimerCount()).toBe(1);
  });
});
