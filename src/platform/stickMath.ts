/**
 * Stick math — pure seams for the touch stick (v0.27).
 *
 * Why this exists: v0.25's rig proved the steering *chain* was correct
 * for synthetic points teleported to full deflection, and Daniel still
 * couldn't drive. The v0.27 rig measured what a real thumb produces —
 * a ROLL whose contact centroid travels ~24 px, not a 48+ px slide.
 * With the old linear mapping at STICK_R 48 that roll commanded
 * steerIn 0.50 → 53% of the wheel angle (0.141 rad vs 0.264 rad
 * measured at ~50 km/h). Three changes, all in this module:
 *
 *  - STICK_R 48 → 32: less travel to full lock.
 *  - shapeSteer(): |s|^0.7 response in the merge — endpoints 0 and ±1
 *    are unchanged (full-lock behaviour and the v0.21 drive metrics
 *    are untouched), mid-range is amplified: 0.5 → 0.62, 0.75 → 0.82.
 *  - Origin chase: a floating stick's origin follows the thumb once
 *    deflection saturates, so a roll that runs out of radius keeps
 *    authority instead of pinning at the rim.
 *
 * Deadzone drops 0.07 → 0.04 (at R 32 that's ~1.3 px — below the
 * noise floor of a resting thumb, above sensor jitter).
 */

export const STICK_R = 32;
export const STICK_DEADZONE = 0.04;

/** Response curve for the merged steer value. Monotonic, odd, and
 *  exact at 0 and ±1 so full-lock and centred behaviour never move. */
export function shapeSteer(s: number): number {
  const c = Math.max(-1, Math.min(1, s));
  return Math.sign(c) * Math.pow(Math.abs(c), 0.7);
}

export interface Deflection {
  /** Origin after any chase (px, client coords). */
  ox: number;
  oy: number;
  /** Normalized deflection, each axis deadzoned; length ≤ 1. */
  dx: number;
  dy: number;
}

/**
 * Deflection of a pointer at (x, y) from a stick origin (ox, oy).
 * If the pointer is beyond the radius, the origin chases it so the
 * deflection sits exactly on the rim (direction preserved).
 */
export function stickDeflection(
  ox: number,
  oy: number,
  x: number,
  y: number,
  radius: number = STICK_R,
  deadzone: number = STICK_DEADZONE,
): Deflection {
  let dx = (x - ox) / radius;
  let dy = (y - oy) / radius;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    const excessPx = (len - 1) * radius;
    ox += (dx / len) * excessPx;
    oy += (dy / len) * excessPx;
    dx /= len;
    dy /= len;
  }
  return {
    ox,
    oy,
    dx: Math.abs(dx) < deadzone ? 0 : dx,
    dy: Math.abs(dy) < deadzone ? 0 : dy,
  };
}
