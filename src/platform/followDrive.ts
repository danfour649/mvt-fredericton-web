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
import { dist } from '../core/geo';
import { findRoute, routableDestination, type RoadGraph } from '../core/routing';
import type { WorldModel } from '../core/world';

/** Distance at which the car is declared ON the point (m). */
export const FOLLOW_ARRIVE_RADIUS_M = 2.2;
/** On-foot arrive distance (m) — walking stops this close. */
export const FOLLOW_WALK_ARRIVE_M = 0.9;
/** On foot with more route than this ahead (m), the walker breaks
 *  into a jog — a cross-town map pick at stroll pace is a quarter
 *  hour of thumb-watching (the Stage 1 city is ~5.7 km across).
 *  The multiplier scales the core's walk speed (5.4 → ~9.5 m/s);
 *  main.ts applies it through Game.walkSpeedMul ONLY while a far
 *  follow target is live on foot — ordinary walking never jogs. */
export const FOLLOW_JOG_MIN_REMAINING_M = 250;
export const FOLLOW_JOG_MUL = 1.75;
/** On foot, a POINT pick with more route than this ahead (m) is
 *  not walked at all: the player ZIPS — placed at the route's end
 *  the moment the finger lifts, and the camera dive (the arrival
 *  zoom return) lands them at street level inside ~2 s, so the
 *  whole trip reads in under 5 s however far the tap was. Daniel's
 *  bar after the jog still felt slow. Entity picks (a car to
 *  steal, a payphone) are never zipped — you walk up to things;
 *  you zip to PLACES. */
export const FOLLOW_ZIP_MIN_REMAINING_M = 250;
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

export interface FollowCarOpts {
  /** Iteration 5: routed driving suppresses the reverse gear for
   *  intermediate waypoints (a waypoint behind the car mid-route
   *  is a loop-around, never a back-up). Default true (the final
   *  target keeps the tap-behind-to-reverse behaviour). */
  allowReverse?: boolean;
  /** Iteration 5: this aim point is a pass-through waypoint, not
   *  the destination — no braking curve, no arrive, cruise speed
   *  is held until the point is reached/skipped. */
  through?: boolean;
  /** Corner speed for THIS aim (m/s at the point itself), from
   *  the RouteFollower's look at the bend ahead. Through travel
   *  brakes on a curve toward it — arriving at a 90° ramp hairpin
   *  at full 137 km/h cruise ends on the guardrail, as the first
   *  cross-river routed sim proved. */
  cornerMps?: number | null;
}

/** Braking deceleration (m/s²) for corner approaches on routed
 *  travel — firm, under the car's real full-brake capability. */
const CORNER_BRAKE_A = 6.5;

/**
 * One control step for the driven car toward `target` (core metres).
 * Stateless: gear choice (forward vs reverse) is a pure function of
 * pose + target, and the arrive profile makes both gears converge
 * without latching or a limit cycle (proven by the sim tests in
 * followDrive.test.ts, which drive the REAL stepCar physics).
 */
export function followCarInput(car: FollowCarPose, target: Vec2, opts?: FollowCarOpts): FollowCarOutput {
  const dx = target.x - car.pos.x;
  const dz = target.z - car.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= FOLLOW_ARRIVE_RADIUS_M && !opts?.through) {
    return { throttle: 0, steer: 0, mode: 'arrived', distM: dist };
  }
  const bearing = Math.atan2(dz, dx);
  const err = wrapAngle(bearing - car.heading);

  if (
    opts?.allowReverse !== false &&
    Math.abs(err) > FOLLOW_REAR_CONE_RAD && dist <= FOLLOW_REVERSE_MAX_DIST_M
  ) {
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
  const px = dist <= look || dist < 1e-6 ? target.x : car.pos.x + (dx / dist) * look;
  const pz = dist <= look || dist < 1e-6 ? target.z : car.pos.z + (dz / dist) * look;
  const errP = wrapAngle(Math.atan2(pz - car.pos.z, px - car.pos.x) - car.heading);
  // Full speed until the braking curve bites (see header), with the
  // terminal governor taking the last metres gently. A pass-through
  // waypoint (through) skips the curve entirely: cruise is the
  // target and only the tight-turn cap slows the car.
  const vCruise = car.topSpeedMps ?? FOLLOW_DEFAULT_TOP_MPS;
  let vDes = opts?.through
    ? vCruise
    : Math.min(
        vCruise,
        Math.sqrt(2 * BRAKE_PROFILE_A * Math.max(0, dist - 0.5)),
        TERMINAL_SLOPE * dist + TERMINAL_BASE,
      );
  if (opts?.through && opts?.cornerMps != null) {
    // Brake on a curve to BE at corner speed when the aim point
    // is reached: v² = corner² + 2·a·d.
    const c = opts.cornerMps;
    vDes = Math.min(vDes, Math.sqrt(c * c + 2 * CORNER_BRAKE_A * dist));
  }
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

// --- iteration 5: long-range targets route over the road graph -----------
// A tap across the map (the zoomed-out pick) used to pure-pursue a
// straight line and demolish itself on the first building. Now any
// target beyond FOLLOW_ROUTE_MIN_M is planned over the junction
// graph (core/routing.ts findRoute): the car drives its own street
// to a junction, crosses town on centrelines — over the bridge, on
// its new guardrails — and only the final leg is a free pursuit.

/** Targets farther than this (m) are planned over the road graph. */
export const FOLLOW_ROUTE_MIN_M = 120;

export interface FollowPlan {
  /** Pursuit waypoints; the last is always the exact target. */
  points: Vec2[];
  /** True when the points came from the road graph (vs a direct
   *  single-point plan for a near tap or an unroutable far one). */
  routed: boolean;
}

/**
 * Plan a follow target: near → the point itself; far → the road
 * route, falling back to the point itself when no route exists.
 */
export function planFollowPoints(
  graph: RoadGraph,
  world: WorldModel,
  from: Vec2,
  to: Vec2,
): FollowPlan {
  if (dist(from, to) > FOLLOW_ROUTE_MIN_M) {
    const route = findRoute(graph, world, from, to);
    if (route && route.length) return { points: route, routed: true };
  }
  // Near tap (or unroutable far one): the point itself — unless no
  // mover can stand there (a tap inside a house, in the river), in
  // which case the road snap in front of it is the destination.
  return { points: [routableDestination(world, to)], routed: false };
}

export interface RouteFollowerOpts {
  routed: boolean;
  /** Re-plan from a new position (same final target). Used once
   *  per route when progress stalls; null result = keep going. */
  replan?: (from: Vec2) => Vec2[] | null;
  /** Waypoint skip radius: min + per-speed, capped at max (m). */
  skipMinM?: number;
  skipPerSpeedM?: number;
  skipMaxM?: number;
  /** Seconds without ≥0.75 m of progress toward the aim point
   *  before the stuck ladder steps (replan → advance → give up). */
  stuckAfterS?: number;
}

export interface RouteStep {
  aim: Vec2;
  isFinal: boolean;
  /** Speed the mover should carry AT the aim point (m/s), from
   *  the bend to the NEXT point — null on straights and on the
   *  final leg (the arrive profile owns that one). */
  cornerMps: number | null;
}

/** Bends up to this angle (rad) at a waypoint are taken at cruise. */
const CORNER_FREE_RAD = 0.3;
/** Corner speed law beyond that: cap = max(MIN, BASE − SLOPE·θ).
 *  θ=1.0 → 14 m/s, θ=π/2 → ~8 m/s, hairpins → the floor. */
const CORNER_BASE_MPS = 24;
const CORNER_SLOPE_MPS = 10;
const CORNER_MIN_MPS = 6.5;

/**
 * Stateful waypoint walker for one follow plan. main.ts feeds it
 * the mover's pose each frame; it answers the current aim point,
 * advancing when a waypoint is reached (skip radius grows with
 * speed so a fast car doesn't have to thread every junction
 * centre) and climbing the stuck ladder when the mover stops
 * making progress: re-plan ONCE, then skip the offending waypoint,
 * then give up (update returns null) rather than grind forever.
 * Arrival itself is NOT decided here — the final point is judged
 * by followCarInput/followWalkInput exactly as before.
 */
export class RouteFollower {
  points: Vec2[];
  idx = 0;
  gaveUp = false;
  readonly routed: boolean;
  private readonly replanFn?: (from: Vec2) => Vec2[] | null;
  private readonly skipMinM: number;
  private readonly skipPerSpeedM: number;
  private readonly skipMaxM: number;
  private readonly stuckAfterS: number;
  private bestDist = Infinity;
  private stuckT = 0;
  private replanned = false;
  private lastPos: Vec2 | null = null;
  private movedWindowM = 0;

  constructor(points: Vec2[], opts: RouteFollowerOpts) {
    this.points = points;
    this.routed = opts.routed;
    this.replanFn = opts.replan;
    this.skipMinM = opts.skipMinM ?? 7;
    this.skipPerSpeedM = opts.skipPerSpeedM ?? 0.35;
    this.skipMaxM = opts.skipMaxM ?? 16;
    this.stuckAfterS = opts.stuckAfterS ?? 4;
  }

  get finalPos(): Vec2 {
    return this.points[this.points.length - 1];
  }

  /** Route distance still ahead of `pos` (m): to the current aim,
   *  then along every remaining leg. The on-foot jog rule reads it. */
  remainingM(pos: Vec2): number {
    if (this.gaveUp || this.idx >= this.points.length) return 0;
    let d = dist(pos, this.points[this.idx]);
    for (let i = this.idx; i < this.points.length - 1; i++) {
      d += dist(this.points[i], this.points[i + 1]);
    }
    return d;
  }

  get currentAim(): Vec2 | null {
    return this.gaveUp || this.idx >= this.points.length ? null : this.points[this.idx];
  }

  get isFinalAim(): boolean {
    return this.idx === this.points.length - 1;
  }

  private resetProgress(): void {
    this.bestDist = Infinity;
    this.stuckT = 0;
    this.movedWindowM = 0;
  }

  /** Corner speed at points[idx] given the approach from `pos`. */
  private cornerFor(pos: Vec2, idx: number): number | null {
    if (idx >= this.points.length - 1) return null;
    const aim = this.points[idx];
    const next = this.points[idx + 1];
    const inx = aim.x - pos.x;
    const inz = aim.z - pos.z;
    const outx = next.x - aim.x;
    const outz = next.z - aim.z;
    const il = Math.hypot(inx, inz);
    const ol = Math.hypot(outx, outz);
    if (il < 1e-6 || ol < 1e-6) return null;
    const cos = clamp((inx * outx + inz * outz) / (il * ol), -1, 1);
    const theta = Math.acos(cos);
    if (theta <= CORNER_FREE_RAD) return null;
    return Math.max(CORNER_MIN_MPS, CORNER_BASE_MPS - CORNER_SLOPE_MPS * theta);
  }

  /**
   * Advance the route for this frame. Returns the aim point, or
   * null when the route is exhausted (gave up on the final leg —
   * the caller clears the target and the mover stops).
   */
  update(pos: Vec2, speedMps: number, dt: number): RouteStep | null {
    if (this.gaveUp || !this.points.length) return null;
    if (this.lastPos) this.movedWindowM += dist(pos, this.lastPos);
    this.lastPos = { ...pos };
    const skipR = clamp(
      this.skipMinM + Math.abs(speedMps) * this.skipPerSpeedM,
      this.skipMinM,
      this.skipMaxM,
    );
    while (this.idx < this.points.length - 1 && dist(pos, this.points[this.idx]) <= skipR) {
      this.idx++;
      this.resetProgress();
    }
    const aim = this.points[this.idx];
    const d = dist(pos, aim);
    if (d < this.bestDist - 0.75) {
      this.bestDist = d;
      this.stuckT = 0;
      this.movedWindowM = 0;
    } else {
      this.stuckT += Math.max(0, dt);
    }
    if (this.stuckT >= this.stuckAfterS) {
      if (!this.replanned && this.replanFn) {
        this.replanned = true;
        this.resetProgress();
        const fresh = this.replanFn(pos);
        if (fresh && fresh.length) {
          this.points = fresh;
          this.idx = 0;
          return { aim: this.points[0], isFinal: this.points.length === 1, cornerMps: this.cornerFor(pos, 0) };
        }
      } else if (this.replanned && this.movedWindowM < 1.5) {
        // Re-planned already and the mover has barely moved in a
        // whole stuck window: it is physically wedged. Advancing
        // the aim down the route would only fake progress (the
        // first cross-river sim ground against a rail for 130 s
        // while the ladder "advanced") — stop honestly instead.
        this.gaveUp = true;
        return null;
      } else if (this.idx < this.points.length - 1) {
        this.idx++;
        this.resetProgress();
        return {
          aim: this.points[this.idx],
          isFinal: this.idx === this.points.length - 1,
          cornerMps: this.cornerFor(pos, this.idx),
        };
      } else {
        this.gaveUp = true;
        return null;
      }
    }
    return {
      aim,
      isFinal: this.idx === this.points.length - 1,
      cornerMps: this.cornerFor(pos, this.idx),
    };
  }
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

export type CarTapIntent = 'enter-now' | 'walk-enter';

/**
 * A tap on a car ALWAYS means get in: next to the car entry is
 * instant (the core's 4 m enter radius); farther off, walk over.
 * Iteration 5 tried "with a gun out, a far car tap shoots it" —
 * Daniel's verdict from real play: pick up a machine gun once and
 * you can never tap-to-steal again. Shooting a car moved to the
 * HOLD (carHoldToFire below), where the scheme keeps its triggers.
 */
export function carTapIntent(distToCarM: number): CarTapIntent {
  return distToCarM <= 4 ? 'enter-now' : 'walk-enter';
}

/** Holding a press on a car this long (ms) with a gun out turns
 *  the press into fire at that car. A plain tap never fires. */
export const FOLLOW_CAR_HOLD_FIRE_MS = 300;

/** Is this press on a car a shot yet? (Armed, and held long enough.) */
export function carHoldToFire(armed: boolean, heldMs: number): boolean {
  return armed && heldMs >= FOLLOW_CAR_HOLD_FIRE_MS;
}
