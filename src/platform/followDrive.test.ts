/**
 * Follow-drive tests: the pursuit contract plus closed-loop settle
 * proofs against the REAL car physics (stepCar on an empty world,
 * fixed 60 Hz). The sim mirrors production wiring in main.ts: the
 * controller's steer passes through shapeSteer, and the target is
 * CLEARED the first frame the controller reports 'arrived' — after
 * that the car coasts on zero input, so "settle" is where it
 * physically comes to rest, not where the controller stopped
 * caring. Settle bar: rest ≤3 m from the tapped point.
 */
import { describe, expect, it } from 'vitest';
import { loadWorld, type WorldModel } from '../core/world';
import { makeCar, stepCar, type CarState } from '../core/physics';
import type { Vec2 } from '../core/geo';
import { shapeSteer } from './stickMath';
import {
  followCarInput,
  followWalkInput,
  screenToWorld,
  worldToScreen,
  FOLLOW_ARRIVE_RADIUS_M,
} from './followDrive';

const DT = 1 / 60;
const emptyWorld: WorldModel = loadWorld({ buildings: { features: [] }, roads: { features: [] } });

interface SimResult {
  restDist: number;
  restPos: Vec2;
  settleAtSec: number | null; // first t inside 3 m that stays inside
  minSpeed: number;
  maxSpeed: number;
  sawReverse: boolean;
  overshootX: number; // farthest travel past the target along +X
}

function simFollow(start: Vec2, heading: number, speed: number, target: Vec2, seconds: number): SimResult {
  let car: CarState = makeCar(start, heading, 'standard');
  car.speed = speed;
  car.vel = { x: Math.cos(heading) * speed, z: Math.sin(heading) * speed };
  let tgt: Vec2 | null = { ...target };
  let settleAtSec: number | null = null;
  let insideSince: number | null = null;
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let sawReverse = false;
  let maxX = -Infinity;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const t = (i + 1) * DT;
    let throttle = 0;
    let steer = 0;
    if (tgt) {
      const out = followCarInput({ pos: car.pos, heading: car.heading, speed: car.speed }, tgt);
      if (out.mode === 'arrived') {
        tgt = null; // production: arrival clears the target
      } else {
        if (out.mode === 'reverse') sawReverse = true;
        throttle = out.throttle;
        steer = shapeSteer(out.steer);
      }
    }
    car = stepCar(emptyWorld, car, { throttle, steer }, DT).car;
    minSpeed = Math.min(minSpeed, car.speed);
    maxSpeed = Math.max(maxSpeed, car.speed);
    maxX = Math.max(maxX, car.pos.x);
    const d = Math.hypot(target.x - car.pos.x, target.z - car.pos.z);
    if (d <= 3) {
      if (insideSince === null) insideSince = t;
      settleAtSec = settleAtSec ?? insideSince;
    } else {
      insideSince = null;
      settleAtSec = null;
    }
  }
  return {
    restDist: Math.hypot(target.x - car.pos.x, target.z - car.pos.z),
    restPos: { ...car.pos },
    settleAtSec,
    minSpeed,
    maxSpeed,
    sawReverse,
    overshootX: maxX - target.x,
  };
}

describe('followCarInput — contract', () => {
  const car = { pos: { x: 0, z: 0 }, heading: 0, speed: 0 };

  it('reports arrived inside the radius, with zero input', () => {
    const out = followCarInput(car, { x: FOLLOW_ARRIVE_RADIUS_M - 0.1, z: 0 });
    expect(out.mode).toBe('arrived');
    expect(out.throttle).toBe(0);
    expect(out.steer).toBe(0);
  });

  it('drives forward toward a point ahead', () => {
    const out = followCarInput(car, { x: 30, z: 0 });
    expect(out.mode).toBe('forward');
    expect(out.throttle).toBeGreaterThan(0);
    expect(Math.abs(out.steer)).toBeLessThan(0.05);
  });

  it('reverses toward a near point astern', () => {
    const out = followCarInput(car, { x: -12, z: 0 });
    expect(out.mode).toBe('reverse');
    expect(out.throttle).toBeLessThan(0);
  });

  it('loops forward (no reverse) toward a far point astern', () => {
    const out = followCarInput(car, { x: -60, z: 0 });
    expect(out.mode).toBe('forward');
  });

  it('output stays inside CarInput ranges', () => {
    for (const tgt of [{ x: 5, z: 40 }, { x: -20, z: -20 }, { x: 3, z: -3 }, { x: -24, z: 6 }]) {
      const out = followCarInput({ pos: { x: 0, z: 0 }, heading: 1.1, speed: 8 }, tgt);
      expect(Math.abs(out.throttle)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.steer)).toBeLessThanOrEqual(1);
    }
  });
});

describe('followCarInput — closed-loop settle (real physics)', () => {
  it('settles on a point 40 m ahead', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: 40, z: 0 }, 20);
    expect(r.restDist).toBeLessThanOrEqual(3);
    expect(r.sawReverse).toBe(false);
  });

  it('settles on a point 30 m to the side', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: 0, z: 30 }, 25);
    expect(r.restDist).toBeLessThanOrEqual(3);
  });

  it('reverses into a point 12 m behind and settles', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: -12, z: 0 }, 20);
    expect(r.sawReverse).toBe(true);
    expect(r.minSpeed).toBeLessThan(-1.5); // it truly rolled backwards
    expect(r.restDist).toBeLessThanOrEqual(3);
  });

  it('reverses into a diagonal point behind (21 m, in the rear cone)', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: -15, z: 15 }, 25);
    expect(r.sawReverse).toBe(true);
    expect(r.restDist).toBeLessThanOrEqual(3);
  });

  it('loops forward to a point 60 m behind — never reverses — and settles', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: -60, z: 0 }, 45);
    expect(r.minSpeed).toBeGreaterThan(-1); // reverse never engaged
    expect(r.restDist).toBeLessThanOrEqual(3);
  });

  it('catches a point 25 m ahead while already rolling at 15 m/s, no big overshoot', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 15, { x: 25, z: 0 }, 20);
    expect(r.restDist).toBeLessThanOrEqual(3);
    expect(r.overshootX).toBeLessThan(6);
  });

  it('no limit cycle: after arrival the resting car stays put on zero input', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: 20, z: 6 }, 30);
    expect(r.settleAtSec).not.toBeNull();
    expect(r.restDist).toBeLessThanOrEqual(3);
  });
});

describe('followWalkInput', () => {
  it('walks toward the target with a unit-ish vector', () => {
    const out = followWalkInput({ x: 0, z: 0 }, { x: 10, z: 0 });
    expect(out.arrived).toBe(false);
    expect(out.move.x).toBeCloseTo(1, 5);
    expect(out.move.z).toBeCloseTo(0, 5);
  });

  it('eases off inside the last 2 m and stops at the arrive radius', () => {
    const near = followWalkInput({ x: 0, z: 0 }, { x: 1.4, z: 0 });
    expect(near.arrived).toBe(false);
    expect(Math.hypot(near.move.x, near.move.z)).toBeCloseTo(0.7, 5);
    const there = followWalkInput({ x: 0, z: 0 }, { x: 0.5, z: 0 });
    expect(there.arrived).toBe(true);
    expect(there.move).toEqual({ x: 0, z: 0 });
  });
});

describe('screen ↔ world conversion', () => {
  const cam = { x: 100, z: -40 };
  const W = 390;
  const H = 844;
  const VW = 54;

  it('maps the screen centre to the camera centre', () => {
    expect(screenToWorld(W / 2, H / 2, W, H, cam, VW)).toEqual(cam);
  });

  it('maps screen-right to world-east and screen-down to world-south', () => {
    const p = screenToWorld(W / 2 + 39, H / 2 + 39, W, H, cam, VW);
    expect(p.x).toBeCloseTo(cam.x + 39 * (VW / W), 6);
    expect(p.z).toBeCloseTo(cam.z + 39 * (VW / W), 6);
  });

  it('round-trips world → screen → world', () => {
    const world = { x: 83.4, z: -12.9 };
    const s = worldToScreen(world, W, H, cam, VW);
    const back = screenToWorld(s.x, s.y, W, H, cam, VW);
    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.z).toBeCloseTo(world.z, 6);
  });
});
