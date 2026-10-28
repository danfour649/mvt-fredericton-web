/**
 * Drive-metrics harness (v0.21): scripted, deterministic drive tests on
 * an empty world with fixed dt and synthetic inputs. These measure the
 * GTA-1 feel targets — top speed, launch, turn slip/radius, handbrake
 * behaviour, coast/brake distances, standstill pivot — and assert
 * ballparks. The measured table is printed (vitest shows it) and kept
 * in tools/drive-metrics.md.
 */
import { describe, it, expect } from 'vitest';
import { loadWorld, type WorldModel, type Building } from './world';
import { makeCar, stepCar, type CarInput, type CarState } from './physics';

const DT = 1 / 60;
const emptyWorld: WorldModel = loadWorld({ buildings: { features: [] }, roads: { features: [] } });

function freshCar(speed = 0, classId?: string): CarState {
  const car = makeCar({ x: 0, z: 0 }, 0, (classId as CarState['classId']) ?? 'standard');
  car.speed = speed;
  car.vel = { x: speed, z: 0 };
  return car;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Angle between the velocity vector and the nose, degrees (0 = no slip). */
export function slipDeg(car: CarState): number {
  const v = Math.hypot(car.vel.x, car.vel.z);
  if (v < 0.5) return 0;
  const velAng = Math.atan2(car.vel.z, car.vel.x);
  return Math.abs((wrapAngle(velAng - car.heading) * 180) / Math.PI);
}

function fwdSpeed(car: CarState): number {
  return car.vel.x * Math.cos(car.heading) + car.vel.z * Math.sin(car.heading);
}

interface RunResult {
  car: CarState;
  /** seconds, unwrapped total yaw, samples per 0.1 s */
  t: number;
  yawTotal: number;
}

function run(car: CarState, input: CarInput, seconds: number, onStep?: (car: CarState, t: number) => void): RunResult {
  let prevHeading = car.heading;
  let yawTotal = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const r = stepCar(emptyWorld, car, input, DT);
    car = r.car;
    yawTotal += wrapAngle(car.heading - prevHeading);
    prevHeading = car.heading;
    onStep?.(car, (i + 1) * DT);
  }
  return { car, t: seconds, yawTotal };
}

// --- metric probes -----------------------------------------------------------

function accelMetrics(classId?: string) {
  const car = freshCar(0, classId);
  let top = 0;
  let t100 = -1;
  run(car, { throttle: 1, steer: 0 }, 25, (c, t) => {
    top = Math.max(top, Math.hypot(c.vel.x, c.vel.z));
    if (t100 < 0 && fwdSpeed(c) >= 27.78) t100 = t;
  });
  return { topKmh: top * 3.6, t100 };
}

function turnMetrics(speedKmh: number) {
  const v = speedKmh / 3.6;
  const car = freshCar(v);
  let slipSum = 0, slipN = 0, yawSum = 0, speedSum = 0;
  let prev = car.heading;
  run(car, { throttle: 0.55, steer: 1 }, 1.6, (c, t) => {
    if (t >= 0.9) {
      slipSum += slipDeg(c);
      slipN++;
      yawSum += wrapAngle(c.heading - prev);
      speedSum += Math.hypot(c.vel.x, c.vel.z);
    }
    prev = c.heading;
  });
  const window = 0.7;
  const yawRate = yawSum / window;
  const vAvg = speedSum / slipN;
  return {
    slipDeg: slipSum / slipN,
    radiusM: yawRate > 0.05 ? vAvg / yawRate : Infinity,
    yawRateDeg: (yawRate * 180) / Math.PI,
  };
}

function handbrakeMetrics() {
  const v0 = 80 / 3.6;
  const car = freshCar(v0);
  let peakSlip = 0;
  let t180 = -1;
  let speedAt180 = -1;
  let yaw = 0;
  let prev = car.heading;
  run(car, { throttle: 0, steer: 1, handbrake: true }, 2.5, (c, t) => {
    peakSlip = Math.max(peakSlip, slipDeg(c));
    yaw += wrapAngle(c.heading - prev);
    prev = c.heading;
    if (t180 < 0 && Math.abs(yaw) >= Math.PI) {
      t180 = t;
      speedAt180 = Math.hypot(c.vel.x, c.vel.z);
    }
  });
  // Release everything: the car must settle, not keep spinning.
  const after = run(car, { throttle: 0, steer: 0 }, 1.6);
  return {
    peakSlip,
    t180,
    speedShedPct: t180 > 0 ? (1 - speedAt180 / v0) * 100 : -1,
    slipAfterRelease: slipDeg(after.car),
    spinAfterReleaseDeg: (Math.abs(after.yawTotal) * 180) / Math.PI,
  };
}

function coastMetrics() {
  const car = freshCar(100 / 3.6);
  let t = -1;
  run(car, { throttle: 0, steer: 0 }, 14, (c, tt) => {
    if (t < 0 && Math.hypot(c.vel.x, c.vel.z) < 0.3) t = tt;
  });
  return { stopT: t };
}

function brakeMetrics() {
  const car = freshCar(100 / 3.6);
  let t = -1;
  run(car, { throttle: -1, steer: 0 }, 6, (c, tt) => {
    if (t < 0 && Math.hypot(c.vel.x, c.vel.z) < 0.3) t = tt;
  });
  return { stopT: t };
}

function pivotMetrics() {
  const car = freshCar(0);
  const r = run(car, { throttle: 0.45, steer: 1 }, 2);
  return {
    yawDeg: (Math.abs(r.yawTotal) * 180) / Math.PI,
    distM: Math.hypot(r.car.pos.x, r.car.pos.z),
  };
}

export function measureAll() {
  return {
    standard: accelMetrics(),
    fast: accelMetrics('fast'),
    police: accelMetrics('police'),
    turn50: turnMetrics(50),
    turn100: turnMetrics(100),
    handbrake: handbrakeMetrics(),
    coast: coastMetrics(),
    brake: brakeMetrics(),
    pivot: pivotMetrics(),
  };
}

describe('drive metrics — GTA 1 feel targets', () => {
  const m = measureAll();
  console.log(
    [
      '\n=== DRIVE METRICS ===',
      `standard: top ${m.standard.topKmh.toFixed(0)} km/h · 0–100 ${m.standard.t100.toFixed(2)} s`,
      `fast:     top ${m.fast.topKmh.toFixed(0)} km/h · 0–100 ${m.fast.t100.toFixed(2)} s`,
      `police:   top ${m.police.topKmh.toFixed(0)} km/h · 0–100 ${m.police.t100.toFixed(2)} s`,
      `turn 50:  slip ${m.turn50.slipDeg.toFixed(1)}° · radius ${m.turn50.radiusM.toFixed(0)} m · yaw ${m.turn50.yawRateDeg.toFixed(0)}°/s`,
      `turn 100: slip ${m.turn100.slipDeg.toFixed(1)}° · radius ${m.turn100.radiusM.toFixed(0)} m · yaw ${m.turn100.yawRateDeg.toFixed(0)}°/s`,
      `hbrake:   peak slip ${m.handbrake.peakSlip.toFixed(0)}° · 180° in ${m.handbrake.t180.toFixed(2)} s · shed ${m.handbrake.speedShedPct.toFixed(0)}% · slip after release ${m.handbrake.slipAfterRelease.toFixed(1)}° · extra spin ${m.handbrake.spinAfterReleaseDeg.toFixed(0)}°`,
      `coast:    100→0 in ${m.coast.stopT.toFixed(2)} s`,
      `brake:    100→0 in ${m.brake.stopT.toFixed(2)} s`,
      `pivot:    yaw ${m.pivot.yawDeg.toFixed(0)}° in 2 s · travelled ${m.pivot.distM.toFixed(1)} m`,
      '=====================\n',
    ].join('\n'),
  );

  // Iteration 3 pace (Follow PR, Daniel's direction): these bands
  // SUPERSEDE the v0.21 targets (top 110–120, 0–100 ~4–6 s →
  // measured 113 / 5.57). Standard now targets ~130–140 km/h and
  // 0–100 toward ~4.5 s; see tools/drive-metrics.md addendum.
  it('standard car: top speed ≈130–140 km/h, 0–100 in ~4.5 s', () => {
    expect(m.standard.topKmh).toBeGreaterThanOrEqual(128);
    expect(m.standard.topKmh).toBeLessThanOrEqual(142);
    expect(m.standard.t100).toBeGreaterThanOrEqual(4.0);
    expect(m.standard.t100).toBeLessThanOrEqual(5.0);
  });

  it('fast and police classes are quicker than standard', () => {
    expect(m.fast.topKmh).toBeGreaterThan(m.standard.topKmh + 10);
    expect(m.fast.t100).toBeLessThan(m.standard.t100);
    expect(m.police.topKmh).toBeGreaterThan(m.standard.topKmh + 5);
    expect(m.police.t100).toBeLessThan(m.standard.t100);
  });

  it('full lock at 50 km/h slips ≥8° without spinning; radius grows ~2.5–4× by 100 km/h', () => {
    expect(m.turn50.slipDeg).toBeGreaterThanOrEqual(8);
    expect(m.turn50.slipDeg).toBeLessThanOrEqual(45);
    expect(m.turn50.radiusM).toBeGreaterThan(6);
    expect(m.turn50.radiusM).toBeLessThan(40);
    const ratio = m.turn100.radiusM / m.turn50.radiusM;
    expect(ratio).toBeGreaterThanOrEqual(2.2);
    expect(ratio).toBeLessThanOrEqual(4.6);
  });

  it('handbrake at 80 km/h: ≥35° peak slip, ~180° within 2.5 s shedding ≥50% speed, then recovers', () => {
    expect(m.handbrake.peakSlip).toBeGreaterThanOrEqual(35);
    expect(m.handbrake.t180).toBeGreaterThan(0);
    expect(m.handbrake.t180).toBeLessThanOrEqual(2.5);
    expect(m.handbrake.speedShedPct).toBeGreaterThanOrEqual(50);
    expect(m.handbrake.slipAfterRelease).toBeLessThanOrEqual(14);
    expect(m.handbrake.spinAfterReleaseDeg).toBeLessThanOrEqual(80);
  });

  it('coast from 100 km/h rolls out over ~6–10 s; full brake stops in ~2–2.5 s', () => {
    expect(m.coast.stopT).toBeGreaterThanOrEqual(5.5);
    expect(m.coast.stopT).toBeLessThanOrEqual(10.5);
    expect(m.brake.stopT).toBeGreaterThanOrEqual(1.7);
    expect(m.brake.stopT).toBeLessThanOrEqual(2.8);
  });

  it('standstill full lock with light throttle pivot-turns (yaw, small travel)', () => {
    expect(m.pivot.yawDeg).toBeGreaterThanOrEqual(35);
    expect(m.pivot.distM).toBeLessThan(14);
  });
});

// --- v0.29: reverse authority + wall slide + unstick -------------------------
//
// Daniel's v0.28 report: "maybe I just don't know how to reverse" and
// "too easy to drive into a building and get stuck". The investigation
// (temporary probe, measured on the v0.28 code) found:
//  - reverse existed in the core (28 km/h cap) but took 3.2 s to reach
//    −25 km/h — slow enough to read as broken, and nothing taught it;
//  - the building response multiplied the WHOLE velocity by 0.3 per
//    180 Hz substep on any contact, so one frame of wall contact cost
//    ~97% of speed (a 30 km/h glance stopped dead), and a nose-in car
//    reversing in an arc kept re-losing its escape velocity — the
//    wedge. A two-wall corner pocket NEVER freed with either lock.
// The fix: slide response (only the into-wall velocity component is
// removed, with time-scaled scrape friction + a glance-weighted nose
// deflection toward wall-parallel) and stronger reverse. These tests
// pin the new behaviour.

function wallWorld(): WorldModel {
  const polygon = [
    { x: 10, z: -40 }, { x: 16, z: -40 }, { x: 16, z: 40 }, { x: 10, z: 40 },
  ];
  const b: Building = {
    polygon, heightM: 10, center: { x: 13, z: 0 },
    minX: 10, maxX: 16, minZ: -40, maxZ: 40,
  };
  return { buildings: [b], roads: [], water: [], bridges: [], barriers: [], colliders: [b], bounds: { minX: -1e3, maxX: 1e3, minZ: -1e3, maxZ: 1e3 } };
}

function runWorld(world: WorldModel, car: CarState, input: CarInput, seconds: number, onStep?: (c: CarState, t: number) => void): CarState {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    car = stepCar(world, car, input, DT).car;
    onStep?.(car, (i + 1) * DT);
  }
  return car;
}

describe('v0.29 — reverse authority', () => {
  it('reverse from standstill: ≥30 km/h top, −25 km/h within 2.6 s', () => {
    let car = makeCar({ x: 0, z: 0 }, 0);
    let top = 0;
    let t25 = -1;
    car = runWorld(emptyWorld, car, { throttle: -1, steer: 0 }, 5, (c, t) => {
      top = Math.min(top, fwdSpeed(c));
      if (t25 < 0 && fwdSpeed(c) <= -25 / 3.6) t25 = t;
    });
    expect(-top * 3.6).toBeGreaterThanOrEqual(30);
    expect(t25).toBeGreaterThan(0);
    expect(t25).toBeLessThanOrEqual(2.6);
  });

  it('half-throttle reverse (a partial stick pull) still reaches ≥25 km/h', () => {
    let car = makeCar({ x: 0, z: 0 }, 0);
    let top = 0;
    car = runWorld(emptyWorld, car, { throttle: -0.5, steer: 0 }, 6, (c) => {
      top = Math.min(top, fwdSpeed(c));
    });
    expect(-top * 3.6).toBeGreaterThanOrEqual(25);
  });

  it('holding BRK from 50 km/h brakes first, then reverses', () => {
    let car = freshCar(50 / 3.6);
    let tStop = -1;
    let tRev = -1;
    car = runWorld(emptyWorld, car, { throttle: -1, steer: 0 }, 5, (c, t) => {
      if (tStop < 0 && Math.abs(fwdSpeed(c)) < 0.3) tStop = t;
      if (tRev < 0 && fwdSpeed(c) <= -15 / 3.6) tRev = t;
    });
    expect(tStop).toBeGreaterThan(0);
    expect(tStop).toBeLessThanOrEqual(1.8);
    expect(tRev).toBeGreaterThan(tStop);
    expect(tRev).toBeLessThanOrEqual(3.2);
  });
});

describe('v0.29 — wall slide, not wall glue', () => {
  it('a 13°-off-plane glance keeps ≥60% of its speed and slides ≥6 m along the wall', () => {
    const w = wallWorld();
    let car = makeCar({ x: 5, z: 20 }, -1.35);
    car.vel = { x: Math.cos(-1.35) * 30 / 3.6, z: Math.sin(-1.35) * 30 / 3.6 };
    car.speed = 30 / 3.6;
    let contactT = -1;
    let preSpeed = 0;
    let speedAfter = -1;
    let zAtContact = 0;
    let zAfter = 0;
    car = runWorld(w, car, { throttle: 0.4, steer: 0 }, 5, (c, t) => {
      if (contactT < 0) preSpeed = Math.hypot(c.vel.x, c.vel.z);
      if (contactT < 0 && c.pos.x >= 8.39) {
        contactT = t;
        zAtContact = c.pos.z;
      }
      if (contactT > 0 && speedAfter < 0 && t >= contactT + 1) {
        speedAfter = Math.hypot(c.vel.x, c.vel.z);
        zAfter = c.pos.z;
      }
    });
    expect(contactT).toBeGreaterThan(0);
    expect(speedAfter).toBeGreaterThanOrEqual(preSpeed * 0.6);
    expect(Math.abs(zAfter - zAtContact)).toBeGreaterThanOrEqual(6);
  });

  it('a 24°-off-normal oblique crash still stops hard (no slide-through)', () => {
    const w = wallWorld();
    let car = makeCar({ x: 0, z: 0 }, -0.42);
    car.vel = { x: Math.cos(-0.42) * 30 / 3.6, z: Math.sin(-0.42) * 30 / 3.6 };
    car.speed = 30 / 3.6;
    let contactT = -1;
    let speedAfter = -1;
    car = runWorld(w, car, { throttle: 0, steer: 0 }, 4, (c, t) => {
      if (contactT < 0 && c.pos.x >= 8.39) contactT = t;
      if (contactT > 0 && speedAfter < 0 && t >= contactT + 1) {
        speedAfter = Math.hypot(c.vel.x, c.vel.z);
      }
    });
    expect(contactT).toBeGreaterThan(0);
    expect(speedAfter * 3.6).toBeLessThanOrEqual(2);
    // And it never entered the building.
    expect(car.pos.x).toBeLessThanOrEqual(8.41);
  });
});

describe('v0.29 — unstick: nose-in extraction', () => {
  it('head-on nose-in: straight reverse clears 1.9 m within 1.5 s', () => {
    const w = wallWorld();
    let car = makeCar({ x: 8.4, z: 0 }, 0);
    let freeT = -1;
    car = runWorld(w, car, { throttle: -1, steer: 0 }, 3, (c, t) => {
      if (freeT < 0 && c.pos.x < 6.5) freeT = t;
    });
    expect(freeT).toBeGreaterThan(0);
    expect(freeT).toBeLessThanOrEqual(1.5);
  });

  // The extraction, as a human does it: hold reverse at full lock.
  // The backing arc swings the nose around; once the nose points
  // AWAY from the wall (cos(heading) < −0.2) the car is by then
  // already metres clear of the face and travelling — extracted.
  // (Measured crossings: 1.9–3.75 s across both starts × both locks,
  // clearing the face by 5.4–16.8 m at 23–28 km/h in reverse.)
  function extract(w: WorldModel, start: CarState, steer: number): { t: number; clearOfFace: number; revKmh: number } {
    let car = start;
    const steps = Math.round(6 / DT);
    for (let i = 0; i < steps; i++) {
      car = stepCar(w, car, { throttle: -1, steer }, DT).car;
      if (Math.cos(car.heading) < -0.2) {
        return {
          t: (i + 1) * DT,
          clearOfFace: 10 - car.pos.x,
          revKmh: -fwdSpeed(car) * 3.6,
        };
      }
    }
    return { t: -1, clearOfFace: 10 - car.pos.x, revKmh: -fwdSpeed(car) * 3.6 };
  }

  it('45° nose-in frees with EITHER full lock, reversing only', () => {
    const w = wallWorld();
    for (const steer of [-1, 1]) {
      const r = extract(w, makeCar({ x: 8.4, z: 0 }, Math.PI / 4), steer);
      expect(r.t).toBeGreaterThan(0);
      expect(r.t).toBeLessThanOrEqual(5);
      expect(r.clearOfFace).toBeGreaterThanOrEqual(3);
      expect(r.revKmh).toBeGreaterThanOrEqual(15);
    }
  });

  it('head-on nose-in frees with full lock too, reversing only', () => {
    const w = wallWorld();
    for (const steer of [-1, 1]) {
      const r = extract(w, makeCar({ x: 8.4, z: 0 }, 0), steer);
      expect(r.t).toBeGreaterThan(0);
      expect(r.t).toBeLessThanOrEqual(5);
      expect(r.clearOfFace).toBeGreaterThanOrEqual(3);
      expect(r.revKmh).toBeGreaterThanOrEqual(15);
    }
  });
});
