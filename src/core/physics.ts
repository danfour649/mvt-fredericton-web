/**
 * Vehicle physics, core frame metres — v0.21: the actual GTA 1 model.
 *
 * The original GTA's handling came from Pat Kerr's 1996 weekend
 * prototype (Atari ST, later ported to C for DMA): ONE 2D rigid body +
 * FOUR approximate tyres. At each tyre we take the velocity at that
 * point (body velocity + angular velocity × offset), split it into
 * forward/sideways components relative to the tyre's heading, and apply
 * forces there: a lateral force opposing the sideways component (grip)
 * and longitudinal forces (engine, brake, rolling lock). Because the
 * forces act away from the centre of mass they create torque naturally
 * — that is what makes the car yaw, slide and recover like GTA instead
 * of like a velocity vector being lerped toward the nose (the v0.20
 * hack, whose measured 0–100 km/h was 16.6 s — see
 * tools/drive-metrics.md).
 *
 * Sources: Kerr, "2D Vehicles" (primary account), via Kočica, "The
 * weekend prototype that taught GTA how to drift" (Medium, Oct 2026);
 * Mike Dailly's corroborating account.
 *
 * On-foot movement stays a simple kinematic circle (moveCircle).
 */
import type { Vec2 } from './geo';
import { collideBuildings, collideBuildingsN, type WorldModel } from './world';

export function moveCircle(
  world: WorldModel,
  pos: Vec2,
  dx: number,
  dz: number,
  radius: number,
): { pos: Vec2; hitBuilding: boolean } {
  const next = { x: pos.x + dx, z: pos.z + dz };
  // Iteration 5: the collider set is buildings + bridge guardrails,
  // so a walker slides along a rail exactly like a wall.
  const pushed = collideBuildings(world.colliders, next, radius);
  if (pushed) return { pos: pushed, hitBuilding: true };
  return { pos: next, hitBuilding: false };
}

// --- car model ---------------------------------------------------------------

export interface CarState {
  pos: Vec2;
  /** Radians, 0 = +X (east), clockwise positive (z is south). */
  heading: number;
  /** Signed m/s along heading (HUD/logic speed). */
  speed: number;
  /** Actual velocity vector m/s — differs from heading*speed when sliding. */
  vel: Vec2;
  /** Angular velocity, rad/s, same sign convention as heading. */
  angVel: number;
  /** Current front-tyre steering angle, rad (+ = right). */
  steer: number;
  /** Slip angle: degrees between nose and velocity, signed. */
  slipAngle: number;
  /** Handling class — picks the parameter set below. */
  classId: CarClassId;
}

export interface CarInput {
  /** -1 (reverse/brake) .. 1 (accelerate). Analog values allowed. */
  throttle: number;
  /** -1 (left) .. 1 (right). Analog values allowed. */
  steer: number;
  /** Space: collapses rear grip and locks the rear tyres. */
  handbrake?: boolean;
}

export type CarClassId = 'standard' | 'fast' | 'police';

export interface CarClass {
  mass: number;
  /** Engine force at standstill, N (tapers linearly to 0 at topSpeed). */
  engineForce: number;
  /** m/s where engine force reaches zero. */
  topSpeed: number;
  /** Brake force total, N (all four tyres). */
  brakeForce: number;
  /** Reverse force total, N (driven tyres). */
  reverseForce: number;
  reverseMax: number;
  /** Lateral grip rates (1/s) — force = -vSide * rate * massPerTyre. */
  gripFront: number;
  gripRear: number;
  /** Lateral force saturation per tyre (accel units, m/s² per tyre
   *  share): real tyres plateau (tanh curve). The rear GRIP RATE is the
   *  lower one — the tail needs more slip to build its force, which is
   *  the visible GTA slide — while the rear CAP is higher so the car
   *  stays stable (no spin) at speed. */
  capFront: number;
  capRear: number;
  /** Steering lock at standstill, rad; fades with speed. */
  steerLock: number;
  /** How fast the steering angle chases the target, rad/s. */
  steerRate: number;
}

export const CAR_CLASSES: Record<CarClassId, CarClass> = {
  // Follow-PR iteration 3 (Daniel, after phone-testing v0.32):
  // "car need to go faster, and it needs to be even more gta1."
  // The Kerr tyre model is untouched — only the class pace params
  // moved. The pace comes mostly from the higher topSpeed caps:
  // the linear engine taper reaches much further, so the car keeps
  // pulling hard at city speeds instead of running out of breath
  // at ~100 km/h. Standard measures ~136 km/h / ~4.4 s 0–100
  // (was 113 / 5.57); fast and police are rescaled to keep their
  // order (fast still fastest; police quicker than standard to
  // 100 and faster at the top end). Measured figures:
  // physics.test.ts metric block + tools/drive-metrics.md addendum.
  standard: {
    mass: 1150, engineForce: 12200, topSpeed: 42.5, brakeForce: 13300,
    // v0.29: reverse gets real authority — it is the only way out of
    // a nose-in. Was 5200 N / 8.5 m/s: 3.2 s to reach −25 km/h and a
    // 28 km/h cap read as "reverse is broken" on a real device.
    reverseForce: 7200, reverseMax: 9.5, gripFront: 12.5, gripRear: 5.8,
    capFront: 26, capRear: 30,
    steerLock: 0.60, steerRate: 9,
  },
  fast: {
    mass: 1050, engineForce: 13500, topSpeed: 50, brakeForce: 13900,
    reverseForce: 7600, reverseMax: 10.5, gripFront: 13, gripRear: 8.5,
    capFront: 28, capRear: 32,
    steerLock: 0.58, steerRate: 9.5,
  },
  police: {
    mass: 1250, engineForce: 13500, topSpeed: 47.5, brakeForce: 15600,
    reverseForce: 7800, reverseMax: 10, gripFront: 14.5, gripRear: 11,
    capFront: 30, capRear: 34,
    steerLock: 0.62, steerRate: 10,
  },
};

/** Kept for older imports: the standard car's top speed, m/s. */
export const CAR_MAX_SPEED = CAR_CLASSES.standard.topSpeed;

/** Coast/engine-braking when off the throttle: constant decel (m/s² at
 *  the body) plus a speed-proportional term. Tuned so 100→0 takes
 *  ~7–9 s — GTA rolls, it doesn't glide forever or hit a wall. */
const COAST_CONST = 2.0;
const COAST_PROP = 0.088;
/** Aero drag coefficient (force = -v*|v|*c), minor at city speeds. */
const AERO = 0.9;

const AXLE_F = 1.42; // front axle offset from centre, m
const AXLE_R = 1.42; // rear axle offset, m
const HALF_TRACK = 0.78; // tyre lateral offset, m
const COLLISION_RADIUS = 1.6;

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Perpendicular (rotate +90° in the x/z plane): east (1,0) -> south (0,1). */
function perp(v: Vec2): Vec2 {
  return { x: -v.z, z: v.x };
}

function rot(v: Vec2, a: number): Vec2 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}

export function makeCar(pos: Vec2, heading: number, classId: CarClassId = 'standard'): CarState {
  return {
    pos: { ...pos }, heading, speed: 0, vel: { x: 0, z: 0 },
    angVel: 0, steer: 0, slipAngle: 0, classId,
  };
}

export function stepCar(
  world: WorldModel,
  car: CarState,
  input: CarInput,
  dt: number,
): { car: CarState; hitBuilding: boolean; impactSpeed: number } {
  const cls = CAR_CLASSES[car.classId ?? 'standard'] ?? CAR_CLASSES.standard;
  const mass = cls.mass;
  const mTyre = mass / 4;
  // Moment of inertia of the rectangle, with a fudge factor GTA-style.
  const inertia = (mass * (4.4 * 4.4 + 1.9 * 1.9)) / 12 * 0.95;

  let pos = { ...car.pos };
  let vel = { ...(car.vel ?? { x: 0, z: 0 }) };
  let heading = car.heading;
  let angVel = car.angVel ?? 0;
  let steer = car.steer ?? 0;

  let hitBuilding = false;
  let impactSpeed = 0;

  // Substep for stability: the tyre forces are stiff.
  const sub = Math.max(1, Math.ceil(dt / (1 / 180)));
  const h = dt / sub;

  for (let s = 0; s < sub; s++) {
    const fwd = { x: Math.cos(heading), z: Math.sin(heading) };
    const right = perp(fwd);
    const vFwdBody = vel.x * fwd.x + vel.z * fwd.z;

    // --- steering: target lock fades with speed, angle chases it.
    // Speed-sensitive lock, exponential fade (GTA: full lock is a
    // low-speed thing; at 100 km/h the same stick gives a wide arc).
    const lockNow = cls.steerLock * Math.exp(-Math.abs(vFwdBody) / 19) * (input.handbrake ? 1.45 : 1);
    const target = Math.max(-1, Math.min(1, input.steer)) * lockNow;
    const maxDelta = cls.steerRate * h;
    steer += Math.max(-maxDelta, Math.min(maxDelta, target - steer));

    let fx = 0;
    let fz = 0;
    let torque = 0;

    const throttle = Math.max(-1, Math.min(1, input.throttle));

    // --- four tyres.
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const lx = front ? AXLE_F : -AXLE_R;
      const lz = i % 2 === 0 ? -HALF_TRACK : HALF_TRACK;
      const off = {
        x: fwd.x * lx + right.x * lz,
        z: fwd.z * lx + right.z * lz,
      };
      // Velocity at the tyre contact point.
      const rotVel = perp(off);
      const pvx = vel.x + angVel * rotVel.x;
      const pvz = vel.z + angVel * rotVel.z;
      // Tyre frame (front tyres are steered).
      const tFwd = front ? rot(fwd, steer) : fwd;
      const tSide = perp(tFwd);
      const vSide = pvx * tSide.x + pvz * tSide.z;
      const vFwd = pvx * tFwd.x + pvz * tFwd.z;

      // Lateral grip — the Kerr force. Handbrake collapses the rear.
      let grip = front ? cls.gripFront : cls.gripRear;
      if (input.handbrake) grip *= front ? 0.55 : 0.06;
      const cap = mTyre * (front ? cls.capFront : cls.capRear) * (input.handbrake ? (front ? 1 : 0.6) : 1);
      const fSideLin = -vSide * grip * mTyre;
      const fSide = cap * Math.tanh(fSideLin / cap);

      // Longitudinal forces.
      let fLong = 0;
      const driven = !front; // rear-wheel drive, like the era
      if (throttle > 0 && driven) {
        const taper = Math.max(0, 1 - Math.max(0, vFwdBody) / cls.topSpeed);
        fLong += (cls.engineForce / 2) * throttle * (vFwdBody < 0 ? 1 : taper);
      } else if (throttle < 0) {
        if (vFwdBody > 0.4) {
          // Braking at every tyre.
          fLong += (cls.brakeForce / 4) * throttle * (vFwd / Math.max(0.4, vFwdBody));
        } else if (driven) {
          const taper = Math.max(0, 1 - Math.abs(Math.min(0, vFwdBody)) / cls.reverseMax);
          fLong += (cls.reverseForce / 2) * throttle * taper;
        }
      }
      if (input.handbrake && !front) {
        // Locked rear wheels drag hard along the tyre's forward axis.
        fLong += -vFwd * mTyre * 1.5;
      }

      const Fx = tSide.x * fSide + tFwd.x * fLong;
      const Fz = tSide.z * fSide + tFwd.z * fLong;
      fx += Fx;
      fz += Fz;
      torque += off.x * Fz - off.z * Fx;
    }

    // --- body-level drag: aero always; coast/engine-braking off throttle.
    const spd = Math.hypot(vel.x, vel.z);
    if (spd > 0.01) {
      fx += -AERO * spd * vel.x;
      fz += -AERO * spd * vel.z;
      if (throttle === 0 && !input.handbrake) {
        const coast = mass * (COAST_CONST + COAST_PROP * spd);
        fx += (-vel.x / spd) * coast;
        fz += (-vel.z / spd) * coast;
      }
    }
    // Rolling stillness: kill creep jitter at rest with no input.
    if (throttle === 0 && !input.handbrake && spd < 0.25) {
      vel = { x: 0, z: 0 };
      angVel *= 0.8;
    }

    // --- integrate the rigid body.
    vel = { x: vel.x + (fx / mass) * h, z: vel.z + (fz / mass) * h };
    angVel += (torque / inertia) * h;
    angVel *= Math.exp(-(input.handbrake ? 0.14 : 0.35) * h);
    // Safety clamps.
    const spd2 = Math.hypot(vel.x, vel.z);
    if (spd2 > 62) {
      vel = { x: (vel.x / spd2) * 62, z: (vel.z / spd2) * 62 };
    }
    angVel = Math.max(-4.5, Math.min(4.5, angVel));
    heading = wrapAngle(heading + angVel * h);

    // --- move + collide (per substep so fast slides can't tunnel).
    // v0.29 SLIDE response: the old code multiplied the WHOLE velocity
    // by 0.3 per substep on any contact — at 180 Hz substeps one frame
    // of grazing a wall cost 97% of your speed (measured: a 30 km/h
    // glance stopped dead in <1 s), and sustained contact while
    // reversing out of a nose-in kept re-killing the escape velocity,
    // which is exactly how Daniel got wedged. Now only the INTO-WALL
    // component dies; the tangential component survives (minus a
    // scrape friction), so cars deflect along walls GTA-style and a
    // reversing arc that clips the wall keeps its backward motion.
    // impactSpeed is the into-wall component — a scrape is no longer
    // scored (or damaged) like a head-on.
    const attempted = { x: pos.x + vel.x * h, z: pos.z + vel.z * h };
    // Iteration 5: buildings + bridge guardrails — a car at any
    // speed or angle meets the rail and slides along the deck
    // instead of leaving it (the v0.29 slide response below does
    // the rest: only the into-rail velocity component dies).
    const hit = collideBuildingsN(world.colliders, attempted, COLLISION_RADIUS);
    if (hit) {
      hitBuilding = true;
      pos = hit.pos;
      const vn = vel.x * hit.normal.x + vel.z * hit.normal.z;
      if (vn < 0) {
        impactSpeed = Math.max(impactSpeed, -vn);
        const preSpeed = Math.hypot(vel.x, vel.z);
        // Tangential remainder, with scrape friction. The friction
        // MUST be time-scaled: contact re-triggers every substep
        // while the engine pushes into the wall, so a flat per-hit
        // factor compounds at 180 Hz and glues the car (0.94^180 ≈ 0).
        // exp(−0.6·h) ≈ 45% speed shed over a full second of grinding
        // contact, ~6% for a 0.1 s graze.
        const scrape = Math.exp(-0.6 * h);
        const tx = (vel.x - hit.normal.x * vn) * scrape;
        const tz = (vel.z - hit.normal.z * vn) * scrape;
        vel = { x: tx, z: tz };
        // Deflection: a real nose pivots on the wall — the car yaws
        // toward wall-parallel, which a circle collider can't produce
        // on its own (and without it the tyres' lateral grip kills
        // the surviving tangential velocity within a few frames: the
        // projection alone still stopped a 30 km/h glance dead).
        // Swing scales with the glancing fraction, so a head-on
        // (tangential ≈ 0) gets no swing and a pure graze gets the
        // full swing toward the direction of travel along the wall.
        const vt = Math.hypot(tx, tz);
        if (preSpeed > 2 && vt > 0.5) {
          const glance = Math.min(1, vt / preSpeed);
          const tangentAng = Math.atan2(tz, tx);
          const dh = wrapAngle(tangentAng - heading);
          heading = wrapAngle(heading + dh * 0.55 * glance);
        }
      }
      angVel *= 0.6;
    } else {
      pos = attempted;
    }
  }

  const fwd = { x: Math.cos(heading), z: Math.sin(heading) };
  const speed = vel.x * fwd.x + vel.z * fwd.z;
  const vSideBody = vel.x * -fwd.z + vel.z * fwd.x;
  const slipAngle = Math.hypot(vel.x, vel.z) > 0.5
    ? (Math.atan2(vSideBody, speed) * 180) / Math.PI
    : 0;

  return {
    car: {
      pos, heading, speed, vel,
      angVel, steer, slipAngle,
      classId: car.classId ?? 'standard',
    },
    hitBuilding,
    impactSpeed,
  };
}
