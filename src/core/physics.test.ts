/**
 * Drive-metrics harness (v0.21): scripted, deterministic drive tests on
 * an empty world with fixed dt and synthetic inputs. These measure the
 * GTA-1 feel targets — top speed, launch, turn slip/radius, handbrake
 * behaviour, coast/brake distances, standstill pivot — and assert
 * ballparks. The measured table is printed (vitest shows it) and kept
 * in tools/drive-metrics.md.
 */
import { describe, it, expect } from 'vitest';
import { loadWorld, type WorldModel } from './world';
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

  it('standard car: top speed ≈110–120 km/h, 0–100 in ~4–6 s', () => {
    expect(m.standard.topKmh).toBeGreaterThanOrEqual(108);
    expect(m.standard.topKmh).toBeLessThanOrEqual(122);
    expect(m.standard.t100).toBeGreaterThanOrEqual(3.8);
    expect(m.standard.t100).toBeLessThanOrEqual(6.2);
  });

  it('fast and police classes are quicker than standard', () => {
    expect(m.fast.topKmh).toBeGreaterThan(m.standard.topKmh + 10);
    expect(m.fast.t100).toBeLessThan(m.standard.t100);
    expect(m.police.topKmh).toBeGreaterThan(m.standard.topKmh + 5);
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
