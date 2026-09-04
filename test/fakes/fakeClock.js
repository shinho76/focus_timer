/**
 * Fake clock port: { wall(), mono(), setTimeout(fn, ms), clearTimeout(id) }
 * advance(ms) moves both wall and mono together and fires expired timers in
 * registration order. advanceWallOnly / advanceMonoOnly simulate a clock
 * skew between the two (system clock change vs. suspend/resume drift).
 */
export function createFakeClock({ wallStart = 1_700_000_000_000, monoStart = 0 } = {}) {
  let wall = wallStart;
  let mono = monoStart;
  let nextId = 1;
  const timers = new Map(); // id -> { dueMono, fn, order }
  let order = 0;

  function fireDue() {
    const due = [...timers.entries()]
      .filter(([, t]) => t.dueMono <= mono)
      .sort((a, b) => a[1].order - b[1].order);
    for (const [id, t] of due) {
      timers.delete(id);
      t.fn();
    }
  }

  return {
    wall: () => wall,
    mono: () => mono,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { dueMono: mono + ms, fn, order: order++ });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    /** Advance both wall and mono by ms (normal elapsed time). */
    advance(ms) {
      wall += ms;
      mono += ms;
      fireDue();
    },
    /** Move only the wall clock (simulates system clock change, no real time passing). */
    advanceWallOnly(ms) {
      wall += ms;
    },
    /** Move only the mono clock (simulates suspend where wall is frozen/unavailable). */
    advanceMonoOnly(ms) {
      mono += ms;
      fireDue();
    },
    /** Rewind the wall clock (simulates NTP/manual clock rewind). */
    rewindWall(ms) {
      wall -= ms;
    },
    pendingTimerCount: () => timers.size,
  };
}
