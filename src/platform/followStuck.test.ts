/**
 * Regression (Daniel, 2026-11-23): "the character still gets stuck
 * against walls trying to reach a mission endpoint." He was on the
 * George Street Drop dropoff: the endpoint was standable (PR #21),
 * he was ~40 m away — but a building stood between, and near
 * targets were never routed (routing only kicked in past 120 m),
 * so the walker pure-pursued the straight line, ground against
 * the wall, and the stuck ladder gave up.
 *
 * Proof, on the real dataset with production wiring: pick the
 * George dropoff as target and a start across a building from it
 * (found by a deterministic scan, asserted obstructed), then walk
 * the plan with moveCircle at walk speed. The plan must be ROUTED
 * and the walker must arrive inside the mission's interact radius.
 */
import { describe, expect, it } from 'vitest';
import downtownRaw from '../../public/data/downtown.json?raw';
import { loadWorld, collideWorld, nearestRoadPoint } from '../core/world';
import { buildRoadGraph, legObstructed } from '../core/routing';
import { dist, type Vec2 } from '../core/geo';
import { moveCircle } from '../core/physics';
import { sanitizeMissions, MISSIONS } from '../core/missions';
import { planFollowPoints, RouteFollower, followWalkInput } from './followDrive';

const DT = 1 / 60;
const world = loadWorld(JSON.parse(downtownRaw));
const graph = buildRoadGraph(world);

function standable(p: Vec2): boolean {
  return !collideWorld(world, { ...p }, 0.55);
}

describe('on-foot follow across a building (George Street dropoff)', () => {
  const george = sanitizeMissions(world).find((m) => m.id === 'george_street_drop')!;
  const target = george.steps[1].pos!; // the dropoff, radius 7
  const radius = george.steps[1].radius ?? 7;

  // Deterministic scan: a standable start 20–70 m from the target
  // whose straight leg to it is obstructed by a building.
  function findStart(): Vec2 {
    for (let d = 20; d <= 70; d += 2) {
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * 2 * Math.PI;
        const p = { x: target.x + Math.cos(a) * d, z: target.z + Math.sin(a) * d };
        if (standable(p) && legObstructed(world, p, target)) return p;
      }
    }
    throw new Error('no obstructed start found around the George dropoff');
  }

  it('the straight leg really is obstructed, and the plan routes around', () => {
    const from = findStart();
    expect(legObstructed(world, from, target)).toBe(true);
    const plan = planFollowPoints(graph, world, from, target);
    expect(plan.routed).toBe(true);
    expect(plan.points.length).toBeGreaterThan(1);
  });

  it('the walker arrives inside the interact radius instead of grinding the wall', () => {
    const from = findStart();
    const plan = planFollowPoints(graph, world, from, target);
    const follower = new RouteFollower(plan.points, {
      routed: plan.routed,
      replan: (f) => planFollowPoints(graph, world, f, target).points,
      skipMinM: 5, skipPerSpeedM: 0.55, skipMaxM: 10,
    });
    let pos: Vec2 = { ...from };
    let last = { ...pos };
    let arrivedAt: number | null = null;
    for (let i = 0; i < 240 / DT; i++) {
      const t = (i + 1) * DT;
      if (dist(pos, target) <= radius) { arrivedAt = t; break; }
      const speedMag = Math.hypot((pos.x - last.x) / DT, (pos.z - last.z) / DT);
      const step = follower.update(pos, speedMag, DT);
      if (!step) break;
      let mx = 0, mz = 0;
      if (!step.isFinal) {
        const d = dist(pos, step.aim);
        if (d > 1e-6) { mx = (step.aim.x - pos.x) / d; mz = (step.aim.z - pos.z) / d; }
      } else {
        const w = followWalkInput(pos, step.aim);
        mx = w.move.x; mz = w.move.z;
      }
      last = { ...pos };
      pos = moveCircle(world, pos, mx * 5.4 * DT, mz * 5.4 * DT, 0.55).pos;
    }
    expect(follower.gaveUp).toBe(false);
    expect(arrivedAt).not.toBeNull();
    expect(dist(pos, target)).toBeLessThanOrEqual(radius);
  }, 60_000);

  it('routable final legs: no sanitized mission point is a wall-grind from its own road', () => {
    // Every sanitized point must be enterable from its nearest road
    // without crossing a building — the final leg of any route.
    for (const m of sanitizeMissions(world)) {
      const pts: Vec2[] = [m.startPos, ...m.steps.filter((s) => s.pos).map((s) => s.pos!)];
      for (const p of pts) {
        const snap = nearestRoadPoint(world, p)!;
        expect(legObstructed(world, snap.pos, p), `${m.id} point ${p.x},${p.z}`).toBe(false);
      }
    }
    void MISSIONS;
  });
});
