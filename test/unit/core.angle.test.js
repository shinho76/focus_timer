import { describe, it, expect } from 'vitest';
import {
  DEG_PER_MINUTE,
  MAX_ACCUM,
  SNAP_COARSE,
  SNAP_DEFAULT,
  accumToMinutes,
  angleToAccum,
  isInDeadZone,
  minutesToAccum,
  pointToAngle,
  shortestArcDelta,
  snapMinutes,
} from '../../src/core/angle.js';

/**
 * Walk a drag: feed a sequence of absolute angles through angleToAccum the way
 * input/pointer.js will, and return the accumulated angle.
 * @param {number} startAccum
 * @param {number[]} angles absolute angles, first one is the pointerdown sample
 */
function drag(startAccum, angles) {
  let accum = startAccum;
  for (let i = 1; i < angles.length; i++) {
    accum = angleToAccum(accum, angles[i - 1], angles[i]);
  }
  return accum;
}

// 수용 기준 1 — 각도→분 변환 오차 0, 6° = 1분
describe('accumToMinutes / minutesToAccum (criterion 1: exact 6° = 1 min)', () => {
  it('converts every whole minute with zero error', () => {
    for (let m = 0; m <= 60; m++) {
      expect(accumToMinutes(m * DEG_PER_MINUTE)).toBe(m);
      expect(minutesToAccum(m)).toBe(m * DEG_PER_MINUTE);
    }
  });

  it('round-trips minutes → accum → minutes for all 61 values', () => {
    for (let m = 0; m <= 60; m++) {
      expect(accumToMinutes(minutesToAccum(m))).toBe(m);
    }
  });

  it('snaps to the nearest minute (1-minute snap is the default)', () => {
    expect(accumToMinutes(0)).toBe(0);
    expect(accumToMinutes(2.9)).toBe(0); // < half a minute
    expect(accumToMinutes(3.1)).toBe(1); // > half a minute
    expect(accumToMinutes(59)).toBe(10); // 59/6 = 9.83
    expect(accumToMinutes(DEG_PER_MINUTE * 25 + 1)).toBe(25);
  });

  it('clamps out-of-range input instead of wrapping', () => {
    expect(accumToMinutes(-30)).toBe(0);
    expect(accumToMinutes(720)).toBe(60);
    expect(minutesToAccum(-5)).toBe(0);
    expect(minutesToAccum(999)).toBe(MAX_ACCUM);
  });

  it('supports a 5-minute snap for Shift-drag via the snapStep argument', () => {
    expect(accumToMinutes(minutesToAccum(23), SNAP_COARSE)).toBe(25);
    expect(accumToMinutes(minutesToAccum(22), SNAP_COARSE)).toBe(20);
    expect(accumToMinutes(minutesToAccum(2), SNAP_COARSE)).toBe(0);
    expect(accumToMinutes(MAX_ACCUM, SNAP_COARSE)).toBe(60);
    // ...and the default is still 1-minute snap
    expect(accumToMinutes(minutesToAccum(23), SNAP_DEFAULT)).toBe(23);
    expect(accumToMinutes(minutesToAccum(23))).toBe(23);
  });

  it('snapMinutes helper matches the angle path (keyboard / ± buttons)', () => {
    expect(snapMinutes(23, SNAP_COARSE)).toBe(25);
    expect(snapMinutes(61)).toBe(60);
    expect(snapMinutes(-1)).toBe(0);
  });
});

// 수용 기준 2 — 0/60 경계에서 반대편으로 튀지 않는다 (양방향)
describe('angleToAccum at the 0/60 boundary (criterion 2)', () => {
  it('crosses 59 → 60 going clockwise and clamps, never wrapping to 0', () => {
    // 59 min = 354°. Absolute pointer angle happens to be 354° too.
    let accum = minutesToAccum(59);
    accum = angleToAccum(accum, 354, 0); // pointer crosses 12 o'clock: 354° → 0°
    expect(accum).toBe(MAX_ACCUM);
    expect(accumToMinutes(accum)).toBe(60); // NOT 0
  });

  it('keeps clamping at 60 while the pointer keeps going clockwise past 12', () => {
    let accum = minutesToAccum(59);
    const angles = [354, 0, 6, 30, 90];
    accum = drag(accum, angles);
    expect(accum).toBe(MAX_ACCUM);
    expect(accumToMinutes(accum)).toBe(60);
  });

  it('crosses 0 → below going counter-clockwise and clamps, never wrapping to 59', () => {
    // 1 min = 6°; drag backwards past 12 o'clock.
    let accum = minutesToAccum(1);
    accum = angleToAccum(accum, 6, 0); // -6° → 0
    expect(accum).toBe(0);
    expect(accumToMinutes(accum)).toBe(0);

    accum = angleToAccum(accum, 0, 354); // another -6° → clamped at 0
    expect(accum).toBe(0);
    expect(accumToMinutes(accum)).toBe(0); // NOT 59
  });

  it('never produces the opposite side for either boundary direction', () => {
    // Sweep the pointer clockwise a full turn from 0 and back again.
    const forward = drag(0, [0, 90, 180, 270, 0, 90]);
    expect(accumToMinutes(forward)).toBe(60);
    const backward = drag(0, [0, 270, 180, 90, 0, 270]);
    expect(accumToMinutes(backward)).toBe(0);
  });

  it('normalises every step to the shortest arc', () => {
    expect(shortestArcDelta(-354)).toBe(6);
    expect(shortestArcDelta(354)).toBe(-6);
    expect(shortestArcDelta(180)).toBe(180);
    expect(shortestArcDelta(-180)).toBe(180);
    expect(shortestArcDelta(0)).toBe(0);
  });
});

// 수용 기준 2 — 한 바퀴 초과 드래그
describe('angleToAccum past a full revolution (criterion 2)', () => {
  it('clamps at 360° after more than one revolution, no 59→0 teleport', () => {
    const angles = [0];
    for (let i = 1; i <= 40; i++) angles.push((i * 45) % 360); // 5 full turns
    const accum = drag(0, angles);
    expect(accum).toBe(MAX_ACCUM);
    expect(accumToMinutes(accum)).toBe(60);
  });

  it('is monotonic while the drag keeps going one way — no mid-drag flip', () => {
    let accum = 0;
    let prev = 0;
    let last = 0;
    for (let i = 1; i <= 60; i++) {
      const a = (i * 30) % 360; // 5 full turns in 30° steps
      accum = angleToAccum(accum, prev, a);
      expect(accum).toBeGreaterThanOrEqual(last);
      last = accum;
      prev = a;
    }
    expect(accum).toBe(MAX_ACCUM);
  });

  it('comes back down correctly after being clamped at the top', () => {
    let accum = drag(0, [0, 90, 180, 270, 0, 90, 180]); // clamped at 360
    expect(accum).toBe(MAX_ACCUM);
    // now drag back by 90°: 360 → 270 = 45 min, not something derived from the
    // absolute angle (which would say 180° = 30 min)
    accum = angleToAccum(accum, 180, 90);
    expect(accum).toBe(270);
    expect(accumToMinutes(accum)).toBe(45);
  });
});

// 수용 기준 1·2 — 중심 근처 각도 노이즈
describe('near-centre noise (spec §3.2 dead zone)', () => {
  it('flags samples inside 20% of the radius so they are discarded', () => {
    const radius = 100;
    expect(isInDeadZone(0, 0, radius)).toBe(true);
    expect(isInDeadZone(5, -5, radius)).toBe(true); // r ≈ 7 < 20
    expect(isInDeadZone(19, 0, radius)).toBe(true);
    expect(isInDeadZone(21, 0, radius)).toBe(false);
    expect(isInDeadZone(0, 80, radius)).toBe(false);
  });

  it('leaves the accumulated value untouched when noisy samples are skipped', () => {
    const radius = 100;
    let accum = minutesToAccum(25);
    const before = accum;
    let prevAngle = pointToAngle(0, -60); // a good sample out at the rim: 0°

    // A finger resting near the centre reports wildly swinging angles.
    const noisy = [
      [1, 1],
      [-1, 2],
      [2, -1],
      [-2, -2],
      [0, 3],
    ];
    for (const [dx, dy] of noisy) {
      if (isInDeadZone(dx, dy, radius)) continue; // input/ drops the sample
      const a = pointToAngle(dx, dy);
      accum = angleToAccum(accum, prevAngle, a);
      prevAngle = a;
    }
    expect(accum).toBe(before);
    expect(accumToMinutes(accum)).toBe(25);
  });

  it('a zero-movement sample is a no-op even outside the dead zone', () => {
    const accum = angleToAccum(minutesToAccum(25), 137.5, 137.5);
    expect(accum).toBe(minutesToAccum(25));
  });
});

describe('pointToAngle geometry (0 at 12 o’clock, clockwise)', () => {
  it('maps the four cardinal directions', () => {
    expect(pointToAngle(0, -50)).toBeCloseTo(0, 10); // up = 12 o'clock = 0 min
    expect(pointToAngle(50, 0)).toBeCloseTo(90, 10); // right = 15 min
    expect(pointToAngle(0, 50)).toBeCloseTo(180, 10); // down = 30 min
    expect(pointToAngle(-50, 0)).toBeCloseTo(270, 10); // left = 45 min
  });

  it('always returns [0, 360)', () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      const a = pointToAngle(Math.sin(rad) * 40, -Math.cos(rad) * 40);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(360);
    }
  });
});

describe('defensive input handling (no exceptions, criterion 39)', () => {
  it('returns the previous accumulator for non-finite angles', () => {
    expect(angleToAccum(120, NaN, 90)).toBe(120);
    expect(angleToAccum(120, 90, undefined)).toBe(120);
    // A corrupt accumulator recovers to 0; a valid delta still applies on top.
    expect(angleToAccum(NaN, 0, 90)).toBe(90);
    expect(angleToAccum(NaN, NaN, NaN)).toBe(0);
  });
});
