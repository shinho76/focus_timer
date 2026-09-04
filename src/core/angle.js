/**
 * core/angle.js — pure dial angle math (spec §3.2).
 *
 * Geometry: 0 minutes at 12 o'clock, clockwise, 60 min = 360°, 1 min = 6°.
 *
 * The whole point of this module is that a drag is integrated as an *unwrapped
 * accumulated angle*, never read as an absolute angle. Absolute angles wrap at
 * the 0/60 boundary and make the value teleport to the opposite side
 * (59 → 0 / 0 → 59). Per-frame deltas normalised to the shortest arc (±180°)
 * and clamped to [0, 360] cannot do that.
 *
 * No DOM, no browser API, no time. Everything here is a pure function.
 */

/** Degrees per minute (6° = 1 min). @type {number} */
export const DEG_PER_MINUTE = 6;

/** Maximum accumulated angle = one full revolution = 60 minutes. @type {number} */
export const MAX_ACCUM = 360;

/** Maximum settable minutes. @type {number} */
export const MAX_MINUTES = 60;

/** Default snap step in minutes (spec §11 criterion 1: 1-minute snap). @type {number} */
export const SNAP_DEFAULT = 1;

/** Coarse snap step in minutes, used while Shift is held (dev plan Phase 1). @type {number} */
export const SNAP_COARSE = 5;

/**
 * Radius ratio below which pointer movement must be ignored: angle is
 * numerically unstable near the centre (spec §3.2 "중심 근처 각도 노이즈").
 * @type {number}
 */
export const MIN_RADIUS_RATIO = 0.2;

/**
 * Clamp a number into [min, max]. Non-finite input yields `min`.
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return v < min ? min : v > max ? max : v;
}

/**
 * Normalise an angle difference to the shortest arc, i.e. into (-180, 180].
 * @param {number} deltaDeg raw difference of two angles in degrees
 * @returns {number} equivalent difference in (-180, 180]
 */
export function shortestArcDelta(deltaDeg) {
  if (!Number.isFinite(deltaDeg)) return 0;
  let d = deltaDeg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/**
 * Convert a pointer offset from the dial centre into a dial angle.
 * 0° = 12 o'clock, increasing clockwise, result in [0, 360).
 *
 * Callers may use any *consistent* angle convention with {@link angleToAccum}
 * (a constant offset cancels out in the per-frame delta); this helper exists so
 * that input/ does not have to re-derive the trigonometry.
 *
 * @param {number} dx pointer x minus centre x (screen coords, x grows right)
 * @param {number} dy pointer y minus centre y (screen coords, y grows *down*)
 * @returns {number} angle in degrees, [0, 360), 0 at 12 o'clock, clockwise
 */
export function pointToAngle(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * True when a pointer offset is too close to the dial centre to yield a
 * trustworthy angle. Input code must ignore the move entirely in that case —
 * it must NOT feed the noisy angle into {@link angleToAccum}, otherwise a
 * jittering finger at the centre produces spurious minute jumps.
 *
 * @param {number} dx pointer x minus centre x
 * @param {number} dy pointer y minus centre y
 * @param {number} radius dial radius in the same units as dx/dy
 * @param {number} [minRatio=MIN_RADIUS_RATIO] dead-zone radius as a ratio of `radius`
 * @returns {boolean} true → discard this pointer sample
 */
export function isInDeadZone(dx, dy, radius, minRatio = MIN_RADIUS_RATIO) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return true;
  if (!Number.isFinite(radius) || radius <= 0) return true;
  return Math.hypot(dx, dy) < radius * minRatio;
}

/**
 * Integrate one drag frame into the unwrapped accumulated angle (spec §3.2).
 *
 * The delta between the previous and the new absolute angle is normalised to
 * the shortest arc and added to the accumulator, which is then clamped to
 * [0, 360]. Clamping (rather than wrapping) is what guarantees acceptance
 * criterion 2: dragging past 60 min sticks at 60 and dragging below 0 sticks
 * at 0 — the value never jumps to the opposite side of the dial.
 *
 * @param {number} prevAccum previously accumulated angle in [0, 360]
 * @param {number} prevAngleDeg absolute angle of the previous pointer sample, degrees
 * @param {number} newAngleDeg absolute angle of the current pointer sample, degrees
 * @returns {number} new accumulated angle, clamped to [0, 360]
 */
export function angleToAccum(prevAccum, prevAngleDeg, newAngleDeg) {
  const base = clamp(prevAccum, 0, MAX_ACCUM);
  if (!Number.isFinite(prevAngleDeg) || !Number.isFinite(newAngleDeg)) return base;
  const d = shortestArcDelta(newAngleDeg - prevAngleDeg);
  return clamp(base + d, 0, MAX_ACCUM);
}

/**
 * Convert an accumulated angle to whole minutes (6° = 1 min), snapped.
 *
 * @param {number} accum accumulated angle in [0, 360]
 * @param {number} [snapStep=SNAP_DEFAULT] snap granularity in minutes.
 *   Pass {@link SNAP_DEFAULT} (1) normally and {@link SNAP_COARSE} (5) while
 *   Shift is held — that is the whole Shift-snap API: one extra argument, so
 *   input/ can do `accumToMinutes(accum, e.shiftKey ? SNAP_COARSE : SNAP_DEFAULT)`.
 * @returns {number} integer minutes in [0, 60], a multiple of `snapStep`
 */
export function accumToMinutes(accum, snapStep = SNAP_DEFAULT) {
  const a = clamp(accum, 0, MAX_ACCUM);
  const step = Number.isFinite(snapStep) && snapStep > 0 ? snapStep : SNAP_DEFAULT;
  const raw = a / DEG_PER_MINUTE;
  const snapped = Math.round(raw / step) * step;
  return clamp(Math.round(snapped), 0, MAX_MINUTES);
}

/**
 * Convert minutes back to an accumulated angle (inverse of
 * {@link accumToMinutes} at 1-minute snap).
 *
 * @param {number} min minutes; clamped to [0, 60]
 * @returns {number} accumulated angle in [0, 360]
 */
export function minutesToAccum(min) {
  return clamp(min, 0, MAX_MINUTES) * DEG_PER_MINUTE;
}

/**
 * Snap a minute value to a step, clamped to [0, 60]. Handy for the keyboard
 * and ± buttons (spec §3.3) which work in minutes, not angles.
 *
 * @param {number} min
 * @param {number} [step=SNAP_DEFAULT]
 * @returns {number}
 */
export function snapMinutes(min, step = SNAP_DEFAULT) {
  const s = Number.isFinite(step) && step > 0 ? step : SNAP_DEFAULT;
  const v = clamp(min, 0, MAX_MINUTES);
  return clamp(Math.round(Math.round(v / s) * s), 0, MAX_MINUTES);
}
