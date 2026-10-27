/**
 * Follow drive — pure seams for the FOLLOW tap-to-drive scheme (PR
 * preview, not yet a numbered release).
 *
 * The finger-follow pattern (Ketchapp's Finger Driver and its kin):
 * instead of holding a stick, you point at the world and the car
 * goes there. This module is the whole control law — main.ts only
 * converts taps to world points, feeds the driven car's state in,
 * and merges the returned CarInput-shaped output with the keyboard /
 * gamepad exactly like the other schemes' outputs.
 *
 * Driving model: pure pursuit (steer at a lookahead point on the
 * line to the target, lookahead grows with speed) + an arrive
 * profile. Iteration 3 (Daniel: "car need to go faster") throws out
 * the old 41 km/h cruise cap: the cruise target is now the car's
 * OWN top speed, held until the braking curve genuinely bites.
 * The curve is the constant-deceleration braking profile
 * v = √(2·a·d) at a = BRAKE_PROFILE_A — below the car's real
 * full-brake capability (~11.6 m/s² for the standard class), so
 * the throttle P-loop always has the authority to track it —
 * blended with a shallow linear governor over the last metres so
 * the stop lands ON the point. Within ARRIVE_RADIUS_M the answer
 * is 'arrived' with zero input — main.ts clears the target on
 * that signal, exactly like Finger Driver's finger lifting at
 * the destination.
 *
 * Reverse: a target in the rear cone (within REAR_CONE_RAD of dead
 * astern) and no farther than REVERSE_MAX_DIST_M is backed into —
 * the pursuit runs off the car's tail with inverted steering — while
 * a far target behind loops around forward like a human making a
 * three-point turn the long way. The R indication needs nothing
 * special: it reads off the car's signed speed, which goes negative
 * all by itself.
 */

import type { Vec2 } from '../core/geo';

/** Distance at which the car is declared ON the point (m). */
export const FOLLOW_ARRIVE_RADIUS_M = 2.2;
/** On-foot arrive distance (m) — walking stops this close. */
export const FOLLOW_WALK_ARRIVE_M = 0.9;
/** Tap-the-car stop: a tap this close to the car just stops it (m). */
export const FOLLOW_STOP_TAP_M = 3.5;
/** Rear targets farther than this are looped to, not reversed to (m). */
export const FOLLOW_REVERSE_MAX_DIST_M = 25;
/** |bearing error| beyond this counts as "astern" (rad, ≈135°). */
export const FOLLOW_REAR_CONE_RAD = 2.35;

/** Fallback cruise cap when the caller doesn't pass the car's own
 *  top speed — mirrors CAR_CLASSES.standard.topSpeed (the class the
 *  player starts in). main.ts always passes the real per-class cap. */
export const FOLLOW_DEFAULT_TOP_MPS = 42.5;
const BRAKE_PROFILE_A = 9.0; // m/s² — see the header braking curve
const TERMINAL_SLOPE = 0.9; // last-metres governor: vDes ≤ slope·d + base
const TERMINAL_BASE = 0.8;
const REVERSE_CRUISE_MPS = 5.0;
const STEER_GAIN = 2.0; // full lock at ~0.5 rad of pursuit error
const THROTTLE_GAIN = 0.7; // P-loop on desired-minus-actual speed
const TURN_CAP_ERR_RAD = 2.2; // target this far off the nose…
const TURN_CAP_MPS = 5.0; // …caps desired speed to a tight-turn pace

export interface FollowCarPose {
  pos: Vec2;
  /** Radians, 0 = +X (east), clockwise positive (z is south). */
  heading: number;
  /** Signed m/s along heading (negative = rolling backwards). */
  speed: number;
  /** The driven car's class top speed (m/s) — the cruise target.
   *  Omitted → FOLLOW_DEFAULT_TOP_MPS. */
  topSpeedMps?: number;
}

export type FollowMode = 'forward' | 'reverse' | 'arrived';

export interface FollowCarOutput {
  /** -1..1, same convention as CarInput.throttle. */
  throttle: number;
  /** -1..1, same convention as CarInput.steer (+ = right). */
  steer: number;
  mode: FollowMode;
  /** Live distance to the target (m) — HUD/readout/diagnostics. */
  distM: number;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/**
 * One control step for the driven car toward `target` (core metres).
 * Stateless: gear choice (forward vs reverse) is a pure function of
 * pose + target, and the arrive profile makes both gears converge
 * without latching or a limit cycle (proven by the sim tests in
 * followDrive.test.ts, which drive the REAL stepCar physics).
 */
export function followCarInput(car: FollowCarPose, target: Vec2): FollowCarOutput {
  const dx = target.x - car.pos.x;
  const dz = target.z - car.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= FOLLOW_ARRIVE_RADIUS_M) {
    return { throttle: 0, steer: 0, mode: 'arrived', distM: dist };
  }
  const bearing = Math.atan2(dz, dx);
  const err = wrapAngle(bearing - car.heading);

  if (Math.abs(err) > FOLLOW_REAR_CONE_RAD && dist <= FOLLOW_REVERSE_MAX_DIST_M) {
    // Back in: pursue with the tail. The pursuit point sits on the
    // ray from the car's REAR toward the target; steering inverts
    // because a backwards car yaws opposite to the same wheel angle.
    const look = clamp(2 + Math.abs(car.speed) * 0.5, 2.5, 8);
    const back = {
      x: car.pos.x - Math.cos(car.heading) * look,
      z: car.pos.z - Math.sin(car.heading) * look,
    };
    const errRear = wrapAngle(Math.atan2(target.z - back.z, target.x - back.x) - (car.heading + Math.PI));
    const vDes = Math.min(REVERSE_CRUISE_MPS, 0.9 + dist * 0.45);
    return {
      throttle: clamp((-vDes - car.speed) * THROTTLE_GAIN, -1, 1),
      steer: clamp(-errRear * STEER_GAIN, -1, 1),
      mode: 'reverse',
      distM: dist,
    };
  }

  // Forward pure pursuit: aim at a point `look` metres along the
  // line to the target (the target itself when closer than that).
  // Iteration 3 tightened the lookahead (was 2.5 + 0.6·v, cap 16)
  // for a snappier line now that cruise is the car's real top speed.
  const look = clamp(2 + Math.abs(car.speed) * 0.45, 2.5, 13);
  const px = dist <= look ? target.x : car.pos.x + (dx / dist) * look;
  const pz = dist <= look ? target.z : car.pos.z + (dz / dist) * look;
  const errP = wrapAngle(Math.atan2(pz - car.pos.z, px - car.pos.x) - car.heading);
  // Full speed until the braking curve bites (see header), with the
  // terminal governor taking the last metres gently.
  const vCruise = car.topSpeedMps ?? FOLLOW_DEFAULT_TOP_MPS;
  let vDes = Math.min(
    vCruise,
    Math.sqrt(2 * BRAKE_PROFILE_A * Math.max(0, dist - 0.5)),
    TERMINAL_SLOPE * dist + TERMINAL_BASE,
  );
  if (Math.abs(errP) > TURN_CAP_ERR_RAD) vDes = Math.min(vDes, TURN_CAP_MPS);
  return {
    throttle: clamp((vDes - car.speed) * THROTTLE_GAIN, -1, 1),
    steer: clamp(errP * STEER_GAIN, -1, 1),
    mode: 'forward',
    distM: dist,
  };
}

export interface FollowWalkOutput {
  /** Unit-ish move vector for Game.moveInput (zero when arrived). */
  move: Vec2;
  arrived: boolean;
  distM: number;
}

/** On-foot twin: walk straight at the target, stop on arrival. */
export function followWalkInput(playerPos: Vec2, target: Vec2): FollowWalkOutput {
  const dx = target.x - playerPos.x;
  const dz = target.z - playerPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= FOLLOW_WALK_ARRIVE_M) {
    return { move: { x: 0, z: 0 }, arrived: true, distM: dist };
  }
  // Ease off inside the last 2 m so the stop lands on the point,
  // not past it (the core scales walk speed by input magnitude).
  const m = Math.min(1, dist / 2);
  return { move: { x: (dx / dist) * m, z: (dz / dist) * m }, arrived: false, distM: dist };
}

/**
 * Screen (client px) → world (core metres), using the frame camera.
 * The camera in this game is a pure translation: no rotation in
 * either adapter (MapLibre bearing 0, canvas axis-aligned), centre =
 * frame camera, scale = viewWidthM across the viewport WIDTH.
 */
export function screenToWorld(
  px: number,
  py: number,
  viewportW: number,
  viewportH: number,
  camera: Vec2,
  viewWidthM: number,
): Vec2 {
  const mPerPx = viewWidthM / Math.max(1, viewportW);
  return {
    x: camera.x + (px - viewportW / 2) * mPerPx,
    z: camera.z + (py - viewportH / 2) * mPerPx,
  };
}

/** World (core metres) → screen (client px); inverse of screenToWorld. */
export function worldToScreen(
  p: Vec2,
  viewportW: number,
  viewportH: number,
  camera: Vec2,
  viewWidthM: number,
): { x: number; y: number } {
  const mPerPx = viewWidthM / Math.max(1, viewportW);
  return {
    x: viewportW / 2 + (p.x - camera.x) / mPerPx,
    y: viewportH / 2 + (p.z - camera.z) / mPerPx,
  };
}

// --- iteration 2: the gesture vocabulary ----------------------------------
// FOLLOW has NO on-screen controls, so taps carry every action.
// These are the pure decision seams main.ts wires to real pointer
// events; keeping them here makes the disambiguation rules unit
// testable instead of folklore in a 1000-line wiring file.

/** Two taps closer than this in time AND space read as one double-tap. */
export const FOLLOW_DOUBLE_TAP_MS = 320;
export const FOLLOW_DOUBLE_TAP_PX = 56;
/** How long the double-tap handbrake pulse is held (ms). */
export const FOLLOW_DRIFT_PULSE_MS = 500;
/** |speed| below this (m/s) a double-tap means "get out", not "drift". */
export const FOLLOW_EXIT_MAX_SPEED_MPS = 0.6;
/** Walking this close to a tap-target car auto-enters it (m). The
 *  core's own enter radius is 4 m; trigger a touch inside it so the
 *  entry lands while the player is still visibly walking up. */
export const FOLLOW_CAR_ENTER_M = 3.4;

export interface TapStamp {
  tMs: number;
  x: number;
  y: number;
}

/** Is this tap the second half of a double-tap? */
export function isDoubleTap(
  prev: TapStamp | null,
  tMs: number,
  x: number,
  y: number,
): boolean {
  if (!prev) return false;
  if (tMs - prev.tMs > FOLLOW_DOUBLE_TAP_MS) return false;
  return Math.hypot(x - prev.x, y - prev.y) <= FOLLOW_DOUBLE_TAP_PX;
}

/** A screen-space tap candidate: centre + generous radius, px. */
export interface ScreenHit {
  x: number;
  y: number;
  r: number;
}

/**
 * Pick what a tap MEANT from the entities under/near it. Each
 * candidate is scored by distance as a fraction of its own radius
 * (a tap 20 px from a ped's centre beats one 20 px from a car's
 * edge, because the ped's radius is smaller) and only scores ≤ 1
 * count as hits at all. Null = the tap hit bare ground — in FOLLOW
 * that's a walk/drive target, which is exactly the precedence the
 * scheme teaches: entities first, ground second.
 */
export function nearestScreenHit<T extends ScreenHit>(
  hits: readonly T[],
  px: number,
  py: number,
): T | null {
  let best: T | null = null;
  let bestScore = Infinity;
  for (const h of hits) {
    const score = Math.hypot(px - h.x, py - h.y) / Math.max(1, h.r);
    if (score <= 1 && score < bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

export type CarTapIntent = 'enter-now' | 'walk-enter' | 'fire';

/**
 * A tap on a car is ambiguous — steal it or shoot it? The player's
 * hands answer: next to the car, entry always wins (that's what
 * standing at a car MEANS); with fists out, entry wins at any range
 * (fists can't hurt a car anyway); with a gun out and the car beyond
 * arm's reach, the tap is a shot.
 */
export function carTapIntent(armed: boolean, distToCarM: number): CarTapIntent {
  if (distToCarM <= 4) return 'enter-now'; // the core's enter radius
  return armed ? 'fire' : 'walk-enter';
}
