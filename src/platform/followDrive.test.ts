/**
 * Follow-drive tests: the pursuit contract plus closed-loop settle
 * proofs against the REAL car physics (stepCar on an empty world,
 * fixed 60 Hz). The sim mirrors production wiring in main.ts: the
 * controller's steer passes through shapeSteer, the pose carries
 * the class top speed (the iteration-3 cruise target), and the
 * target is CLEARED the first frame the controller reports
 * 'arrived' — after that the car coasts on zero input, so "settle"
 * is where it physically comes to rest, not where the controller
 * stopped caring. Settle bar: rest ≤2.5 m from the tapped point
 * (iteration 3, tightened from 3 m — the braking-curve arrive
 * profile parks forward taps within ~0.1 m in these sims; the
 * reverse cases, whose law didn't change, sit at ~1.4 m).
 */
import { describe, expect, it } from 'vitest';
import { loadWorld, pointInWater, nearestRoadPoint, type WorldModel } from '../core/world';
import { buildRoadGraph } from '../core/routing';
import { unproject } from '../core/geo';
import { CAR_CLASSES, makeCar, stepCar, type CarState } from '../core/physics';
import type { Vec2 } from '../core/geo';
import { shapeSteer } from './stickMath';
import downtownRaw from '../../public/data/downtown.json?raw';
import {
  followCarInput,
  followWalkInput,
  screenToWorld,
  worldToScreen,
  isDoubleTap,
  nearestScreenHit,
  carTapIntent,
  planFollowPoints,
  RouteFollower,
  FOLLOW_ARRIVE_RADIUS_M,
  FOLLOW_DOUBLE_TAP_MS,
  FOLLOW_DOUBLE_TAP_PX,
  type TapStamp,
} from './followDrive';

const DT = 1 / 60;
const emptyWorld: WorldModel = loadWorld({ buildings: { features: [] }, roads: { features: [] } });

interface SimResult {
  restDist: number;
  restPos: Vec2;
  settleAtSec: number | null; // first t inside 2.5 m that stays inside
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
      const out = followCarInput(
        {
          pos: car.pos, heading: car.heading, speed: car.speed,
          topSpeedMps: CAR_CLASSES[car.classId ?? 'standard'].topSpeed,
        },
        tgt,
      );
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
    if (d <= 2.5) {
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
    expect(r.restDist).toBeLessThanOrEqual(2.5);
    expect(r.sawReverse).toBe(false);
  });

  it('settles on a point 30 m to the side', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: 0, z: 30 }, 25);
    expect(r.restDist).toBeLessThanOrEqual(2.5);
  });

  it('reverses into a point 12 m behind and settles', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: -12, z: 0 }, 20);
    expect(r.sawReverse).toBe(true);
    expect(r.minSpeed).toBeLessThan(-1.5); // it truly rolled backwards
    expect(r.restDist).toBeLessThanOrEqual(2.5);
  });

  it('reverses into a diagonal point behind (21 m, in the rear cone)', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: -15, z: 15 }, 25);
    expect(r.sawReverse).toBe(true);
    expect(r.restDist).toBeLessThanOrEqual(2.5);
  });

  it('loops forward to a point 60 m behind — never reverses — and settles', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: -60, z: 0 }, 45);
    expect(r.minSpeed).toBeGreaterThan(-1); // reverse never engaged
    expect(r.restDist).toBeLessThanOrEqual(2.5);
  });

  it('catches a point 25 m ahead while already rolling at 15 m/s, no big overshoot', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 15, { x: 25, z: 0 }, 20);
    expect(r.restDist).toBeLessThanOrEqual(2.5);
    expect(r.overshootX).toBeLessThan(6);
  });

  it('100 m dash: full-performance cruise, ~40% quicker than the old capped controller', () => {
    // Before/after, same rig, old physics + old controller measured
    // 2026-10-27: arrive 11.22 s, peak 41 km/h (the 11.5 m/s cruise
    // cap), rest 1.32 m. Iteration 3 (cruise = the class top speed,
    // braking-curve arrive): arrive 6.55 s, peak 93 km/h, rest
    // 0.09 m. Bounds carry headroom over the measured values.
    let car: CarState = makeCar({ x: 0, z: 0 }, 0, 'standard');
    const target = { x: 100, z: 0 };
    let tgt: Vec2 | null = { ...target };
    let arriveT: number | null = null;
    let peak = 0;
    for (let i = 0; i < Math.round(20 / DT); i++) {
      const t = (i + 1) * DT;
      let throttle = 0;
      let steer = 0;
      if (tgt) {
        const out = followCarInput(
          {
            pos: car.pos, heading: car.heading, speed: car.speed,
            topSpeedMps: CAR_CLASSES.standard.topSpeed,
          },
          tgt,
        );
        if (out.mode === 'arrived') {
          tgt = null;
          arriveT = arriveT ?? t;
        } else {
          throttle = out.throttle;
          steer = shapeSteer(out.steer);
        }
      }
      car = stepCar(emptyWorld, car, { throttle, steer }, DT).car;
      peak = Math.max(peak, Math.abs(car.speed));
    }
    expect(arriveT).not.toBeNull();
    expect(arriveT!).toBeLessThanOrEqual(7.5);
    expect(peak * 3.6).toBeGreaterThanOrEqual(85); // it really opens up
    expect(Math.hypot(target.x - car.pos.x, target.z - car.pos.z)).toBeLessThanOrEqual(2.5);
  });

  it('no limit cycle: after arrival the resting car stays put on zero input', () => {
    const r = simFollow({ x: 0, z: 0 }, 0, 0, { x: 20, z: 6 }, 30);
    expect(r.settleAtSec).not.toBeNull();
    expect(r.restDist).toBeLessThanOrEqual(2.5);
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

describe('isDoubleTap — the in-car action key', () => {
  const first: TapStamp = { tMs: 1000, x: 200, y: 400 };

  it('a quick second tap nearby is a double-tap', () => {
    expect(isDoubleTap(first, 1000 + FOLLOW_DOUBLE_TAP_MS - 20, 214, 388)).toBe(true);
  });

  it('the first tap ever is never a double-tap', () => {
    expect(isDoubleTap(null, 1000, 200, 400)).toBe(false);
  });

  it('a slow second tap is just a tap', () => {
    expect(isDoubleTap(first, 1000 + FOLLOW_DOUBLE_TAP_MS + 40, 200, 400)).toBe(false);
  });

  it('a quick tap somewhere else is just a tap (retarget, not an action)', () => {
    expect(isDoubleTap(first, 1100, 200 + FOLLOW_DOUBLE_TAP_PX + 30, 400)).toBe(false);
  });
});

describe('nearestScreenHit — tap precedence (entities over ground)', () => {
  const ped = { kind: 'ped' as const, x: 100, y: 100, r: 38 };
  const car = { kind: 'car' as const, x: 150, y: 100, r: 60 };

  it('returns null when the tap lands on bare ground', () => {
    expect(nearestScreenHit([ped, car], 300, 300)).toBeNull();
    expect(nearestScreenHit([], 100, 100)).toBeNull();
  });

  it('hits the entity under the tap', () => {
    expect(nearestScreenHit([ped, car], 104, 96)?.kind).toBe('ped');
    expect(nearestScreenHit([ped, car], 168, 100)?.kind).toBe('car');
  });

  it('scores by fraction of radius: a centred ped beats an edged car', () => {
    // 20 px from the ped's centre (0.53 of its radius) vs 30 px
    // from the car's centre (0.5 of its radius) — the car wins on
    // fraction; move the tap 4 px closer to the ped and it wins.
    expect(nearestScreenHit([ped, car], 120, 100)?.kind).toBe('car');
    expect(nearestScreenHit([ped, car], 116, 100)?.kind).toBe('ped');
  });

  it('a tap just outside every radius is ground, not a near miss', () => {
    expect(nearestScreenHit([ped], 100 + 39, 100)).toBeNull();
  });
});

describe('carTapIntent — steal it or shoot it', () => {
  it('next to the car, entry always wins (even armed)', () => {
    expect(carTapIntent(true, 3.9)).toBe('enter-now');
    expect(carTapIntent(false, 1)).toBe('enter-now');
  });

  it('with fists out, a car tap at any range means get in', () => {
    expect(carTapIntent(false, 30)).toBe('walk-enter');
  });

  it('with a gun out, a far car tap is a shot', () => {
    expect(carTapIntent(true, 12)).toBe('fire');
    expect(carTapIntent(true, 4.1)).toBe('fire');
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

describe('iteration 5 — through waypoints and corner speeds', () => {
  const pose = { pos: { x: 0, z: 0 }, heading: 0, speed: 30, topSpeedMps: CAR_CLASSES.standard.topSpeed };

  it('through mode holds cruise toward a waypoint 40 m ahead; arrive mode brakes for it', () => {
    const through = followCarInput(pose, { x: 40, z: 0 }, { through: true });
    expect(through.throttle).toBe(1); // still accelerating to 42.5
    expect(through.mode).toBe('forward');
    const arrive = followCarInput(pose, { x: 40, z: 0 });
    expect(arrive.throttle).toBeLessThan(0); // braking curve: vDes ≈ 26.6 < 30
  });

  it('a corner speed caps the through approach on a braking curve', () => {
    const capped = followCarInput(pose, { x: 40, z: 0 }, { through: true, cornerMps: 8 });
    // vDes = sqrt(8² + 2·6.5·40) ≈ 24.2 < 30 → braking.
    expect(capped.throttle).toBeLessThan(0);
    const free = followCarInput(pose, { x: 40, z: 0 }, { through: true, cornerMps: null });
    expect(free.throttle).toBe(1);
  });

  it('through mode never reports arrived, even on the point', () => {
    const out = followCarInput({ ...pose, speed: 5 }, { x: 1, z: 0 }, { through: true });
    expect(out.mode).toBe('forward');
  });

  it('allowReverse:false turns a near astern aim into a forward loop', () => {
    const astern = { x: -12, z: 0 };
    expect(followCarInput({ ...pose, speed: 0 }, astern).mode).toBe('reverse');
    expect(followCarInput({ ...pose, speed: 0 }, astern, { allowReverse: false }).mode).toBe('forward');
  });
});

describe('iteration 5 — RouteFollower', () => {
  it('skips waypoints inside the radius and lands on the final point', () => {
    const f = new RouteFollower([{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }], { routed: true });
    let step = f.update({ x: 0, z: 0 }, 0, DT);
    expect(step!.aim).toEqual({ x: 50, z: 0 });
    expect(step!.isFinal).toBe(false);
    step = f.update({ x: 46, z: 0 }, 0, DT); // within skipMin (7) of (50,0)
    expect(step!.aim).toEqual({ x: 100, z: 0 });
    expect(step!.isFinal).toBe(true);
  });

  it('reports a corner speed at a bent waypoint and none on a straight', () => {
    const bent = new RouteFollower([{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 50, z: 50 }], { routed: true });
    bent.update({ x: 0, z: 0 }, 5, DT); // advance onto the (50,0) aim
    const s1 = bent.update({ x: 10, z: 0 }, 5, DT);
    expect(s1!.aim).toEqual({ x: 50, z: 0 });
    expect(s1!.cornerMps).not.toBeNull();
    expect(s1!.cornerMps!).toBeGreaterThan(6);
    expect(s1!.cornerMps!).toBeLessThan(11); // 90° bend ≈ 8.3 m/s
    const straight = new RouteFollower([{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }], { routed: true });
    straight.update({ x: 0, z: 0 }, 5, DT);
    expect(straight.update({ x: 10, z: 0 }, 5, DT)!.cornerMps).toBeNull();
  });

  it('stuck ladder: re-plans once, then gives up when the mover truly cannot move', () => {
    let replans = 0;
    const f = new RouteFollower([{ x: 10, z: 0 }, { x: 30, z: 0 }, { x: 60, z: 0 }], {
      routed: true,
      stuckAfterS: 1,
      replan: (from) => {
        replans++;
        return [{ ...from }, { x: 30, z: 0 }, { x: 60, z: 0 }];
      },
    });
    const pos = { x: 10, z: 0 }; // wedged: never moves, never gains on the aim
    let out = f.update(pos, 0, 0.5);
    for (let i = 0; i < 12 && out; i++) out = f.update(pos, 0, 0.5);
    expect(replans).toBe(1);
    expect(f.gaveUp).toBe(true);
    expect(out).toBeNull();
  });

  it('stuck ladder without a re-plan function advances one waypoint instead', () => {
    const f = new RouteFollower([{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 60, z: 0 }], {
      routed: true,
      stuckAfterS: 1,
    });
    f.update({ x: 0, z: 0 }, 0, 0.5); // settles aim on (30,0)
    let step = f.update({ x: 0, z: 0 }, 0, 0.5);
    step = f.update({ x: 0, z: 0 }, 0, 0.5); // stuck window fires
    expect(f.gaveUp).toBe(false);
    expect(step!.aim).toEqual({ x: 60, z: 0 });
  });
});

describe('iteration 5 — planFollowPoints', () => {
  const line = (name: string, pts: Array<[number, number]>) => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: pts.map(([x, z]) => {
        const ll = unproject(x, z);
        return [ll.lng, ll.lat] as [number, number];
      }),
    },
    properties: { Formatted_Street_Name: name, Speed_Restrictions_Both: 50, Number_Of_Lanes: 2 },
  });
  const toyWorld = () =>
    loadWorld({
      buildings: { features: [] },
      roads: {
        features: [
          line('A St', [[-300, 0], [0, 0]]),
          line('B St', [[0, 0], [0, 300]]),
          line('Far St', [[600, 600], [720, 600]]),
        ],
      },
    });

  it('near taps stay a direct single point', () => {
    const world = toyWorld();
    const plan = planFollowPoints(buildRoadGraph(world), world, { x: -100, z: 0 }, { x: -60, z: 0 });
    expect(plan.routed).toBe(false);
    expect(plan.points).toEqual([{ x: -60, z: 0 }]);
  });

  it('far taps route over the graph and end exactly on the tap', () => {
    const world = toyWorld();
    const plan = planFollowPoints(buildRoadGraph(world), world, { x: -280, z: 0 }, { x: 0, z: 280 });
    expect(plan.routed).toBe(true);
    expect(plan.points.length).toBeGreaterThan(3);
    const last = plan.points[plan.points.length - 1];
    expect(last).toEqual({ x: 0, z: 280 });
  });

  it('unroutable far taps fall back to direct pursuit of the point', () => {
    const world = toyWorld();
    const plan = planFollowPoints(buildRoadGraph(world), world, { x: -280, z: 0 }, { x: 660, z: 600 });
    expect(plan.routed).toBe(false);
    expect(plan.points).toEqual([{ x: 660, z: 600 }]);
  });
});

describe('iteration 5 — REAL proofs on the downtown extract', () => {
  const world = loadWorld(JSON.parse(downtownRaw));
  const graph = buildRoadGraph(world);

  /** The game's own drowning predicate (core/game.ts inDeepWater):
   *  in the water AND off every road surface, samples included. */
  const onRoadSurface = (p: Vec2): boolean => {
    const n = nearestRoadPoint(world, p);
    return !!n && Math.hypot(p.x - n.pos.x, p.z - n.pos.z) <= n.road.widthM / 2 + 1.0;
  };
  const inDeepWater = (p: Vec2): boolean => {
    if (!pointInWater(world, p) || onRoadSurface(p)) return false;
    for (const [dx, dz] of [[2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2]] as const) {
      const s = { x: p.x + dx, z: p.z + dz };
      if (!pointInWater(world, s) || onRoadSurface(s)) return false;
    }
    return true;
  };
  const distToPolyline = (p: Vec2, linePts: Vec2[]): number => {
    let best = Infinity;
    for (let i = 0; i < linePts.length - 1; i++) {
      const a = linePts[i];
      const b = linePts[i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
      best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t)));
    }
    return best;
  };

  it('guardrail proof: a car driven at the main-span rail at speed stays on the deck, zero water contact', () => {
    const span = world.bridges.reduce((a, b) => (a.lengthM > b.lengthM ? a : b));
    const midI = Math.floor(span.centerline.length / 2);
    const mid = span.centerline[midI];
    const nxt = span.centerline[midI + 1];
    const heading = Math.atan2(nxt.z - mid.z, nxt.x - mid.x);
    let car: CarState = makeCar(mid, heading, 'standard');
    car = { ...car, speed: 22 }; // 79 km/h, mid-river
    expect(pointInWater(world, car.pos)).toBe(true); // it really is over the river
    const railOff = span.widthM / 2 - 0.45;
    let maxLat = 0;
    let everDeep = false;
    let alongM = 0;
    let lastPos = { ...car.pos };
    // Full throttle, wheel held toward the rail: the car arcs in,
    // meets the rail and must slide along it — never through it.
    for (let i = 0; i < 10 / DT; i++) {
      car = stepCar(world, car, { throttle: 1, steer: 0.4 }, DT).car;
      maxLat = Math.max(maxLat, distToPolyline(car.pos, span.centerline));
      if (inDeepWater(car.pos)) everDeep = true;
      alongM += Math.hypot(car.pos.x - lastPos.x, car.pos.z - lastPos.z);
      lastPos = { ...car.pos };
    }
    expect(everDeep).toBe(false);
    // It genuinely reached the rail (not a timid centreline drive)…
    expect(maxLat).toBeGreaterThan(span.widthM / 2 - 3);
    // …and the car's centre never crossed the rail's outer face
    // (rail centreline + half thickness + the car-circle radius).
    expect(maxLat).toBeLessThanOrEqual(railOff + 0.2 + 1.6 + 0.05);
    // It slid along the deck instead of stopping dead or crossing.
    expect(alongM).toBeGreaterThan(40);
  });

  it('cross-river proof: a far-bank map pick routes over the bridge and arrives (23.4 s / 631 m in the reference run)', () => {
    const from = { x: -60, z: -290 }; // south bank, Westmorland bridge approach
    const to = { x: 100, z: -890 }; // north bank
    const snap = nearestRoadPoint(world, from)!;
    let car: CarState = makeCar(snap.pos, snap.heading, 'standard');
    const plan = planFollowPoints(graph, world, car.pos, to);
    expect(plan.routed).toBe(true);
    // Production wiring (main.ts ensureFollowRoute): default car
    // skip radii, replan-to-same-target callback, corner speeds on
    // through legs, reverse only on the final leg.
    const follower = new RouteFollower(plan.points, {
      routed: plan.routed,
      replan: (f) => planFollowPoints(graph, world, f, to).points,
    });
    let arrivedAt: number | null = null;
    let travelM = 0;
    let everDeep = false;
    let lastPos = { ...car.pos };
    for (let i = 0; i < 120 / DT; i++) {
      const t = (i + 1) * DT;
      const step = follower.update(car.pos, Math.abs(car.speed), DT);
      if (!step) break;
      const out = followCarInput(
        { pos: car.pos, heading: car.heading, speed: car.speed, topSpeedMps: CAR_CLASSES.standard.topSpeed },
        step.aim,
        { allowReverse: step.isFinal, through: !step.isFinal, cornerMps: step.cornerMps },
      );
      if (step.isFinal && out.mode === 'arrived') {
        arrivedAt = t;
        break;
      }
      car = stepCar(world, car, { throttle: out.throttle, steer: shapeSteer(out.steer) }, DT).car;
      travelM += Math.hypot(car.pos.x - lastPos.x, car.pos.z - lastPos.z);
      lastPos = { ...car.pos };
      if (inDeepWater(car.pos)) everDeep = true;
    }
    expect(follower.gaveUp).toBe(false);
    expect(everDeep).toBe(false);
    expect(arrivedAt).not.toBeNull();
    expect(arrivedAt!).toBeLessThan(60); // reference run: 23.4 game-seconds
    expect(travelM).toBeGreaterThan(500);
    expect(travelM).toBeLessThan(800); // reference run: 631 m driven
    expect(Math.hypot(to.x - car.pos.x, to.z - car.pos.z)).toBeLessThanOrEqual(2.5);
  }, 120_000);
});
