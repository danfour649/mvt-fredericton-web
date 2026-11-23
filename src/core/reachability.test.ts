/**
 * Reachability regression (Daniel, 2026-11-23: "mission points that
 * are impossible to reach"). The authored George Street Drop
 * payphone + pickup sat sealed inside a building block 36 m from the
 * nearest road, and two other points were embedded in building
 * collision. These tests pin the sanitizeMissions guard: after
 * sanitizing, every payphone and step point in the game must be a
 * place a player can actually stand — no building collision, no open
 * water, near a road, with a free spot inside its own interact
 * radius that can escape to a road (not a sealed pocket).
 */
import { describe, expect, it } from 'vitest';
import downtownRaw from '../../public/data/downtown.json?raw';
import { loadWorld, collideWorld, nearestRoadPoint, pointInWater } from './world';
import { MISSIONS, sanitizeMissions, standablePoint } from './missions';
import { dist, type Vec2 } from './geo';

const world = loadWorld(JSON.parse(downtownRaw));

function free(p: Vec2): boolean {
  if (collideWorld(world, p, 0.55)) return false;
  if (pointInWater(world, p)) {
    const nr = nearestRoadPoint(world, p);
    if (!nr || dist(p, nr.pos) > 6) return false;
  }
  return true;
}

function escapeOk(spot: Vec2): boolean {
  const HALF = 45;
  const seen = new Set<string>();
  const stack: [number, number][] = [[Math.round(spot.x), Math.round(spot.z)]];
  seen.add(`${stack[0][0]},${stack[0][1]}`);
  let steps = 0;
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (++steps > 20000) return true;
    const nr = nearestRoadPoint(world, { x: i, z: j });
    if (nr && dist({ x: i, z: j }, nr.pos) < 3) return true;
    if (Math.abs(i - spot.x) >= HALF - 1 || Math.abs(j - spot.z) >= HALF - 1) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = `${i + di},${j + dj}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (free({ x: i + di, z: j + dj })) stack.push([i + di, j + dj]);
    }
  }
  return false;
}

function reachableWithin(p: Vec2, radius: number): boolean {
  for (let d = 0; d <= radius; d += 0.75) {
    const n = Math.max(1, Math.floor((2 * Math.PI * d) / 0.75));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI;
      const s = { x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d };
      if (free(s) && escapeOk(s)) return true;
    }
  }
  return false;
}

describe('mission point reachability', () => {
  const sanitized = sanitizeMissions(world);
  const points: { name: string; pos: Vec2; radius: number }[] = [];
  for (const m of sanitized) {
    points.push({ name: `${m.id} payphone`, pos: m.startPos, radius: 7 });
    for (const s of m.steps) {
      if (s.pos) points.push({ name: `${m.id}:${s.id}`, pos: s.pos, radius: s.radius ?? 6 });
    }
  }

  it('sanitized points are standable and near a road', () => {
    for (const pt of points) {
      expect(free(pt.pos), `${pt.name} at ${pt.pos.x},${pt.pos.z} is inside collision/water`).toBe(true);
      const nr = nearestRoadPoint(world, pt.pos);
      expect(nr && dist(pt.pos, nr.pos), `${pt.name} is far from any road`).toBeLessThanOrEqual(15);
    }
  });

  it('every point has a reachable free spot inside its interact radius', () => {
    for (const pt of points) {
      expect(reachableWithin(pt.pos, pt.radius), `${pt.name} has no reachable spot within ${pt.radius} m`).toBe(true);
    }
  });

  it('standablePoint rescues the authored George Street Drop payphone spot', () => {
    const raw = MISSIONS.find((m) => m.id === 'george_street_drop')!;
    // The authored spot was the reported bug: colliding, 36 m from a road.
    const fixed = standablePoint(world, raw.startPos);
    expect(free(fixed)).toBe(true);
    expect(reachableWithin(fixed, 7)).toBe(true);
    expect(dist(fixed, raw.startPos)).toBeGreaterThan(5); // it really had to move
    expect(dist(fixed, raw.startPos)).toBeLessThan(80); // …but stays in the neighbourhood
  });

  it('standablePoint leaves already-good points untouched', () => {
    const errand = MISSIONS.find((m) => m.id === 'queen_street_errand')!;
    expect(standablePoint(world, errand.startPos)).toEqual(errand.startPos);
    expect(standablePoint(world, errand.steps[0].pos!)).toEqual(errand.steps[0].pos);
  });
});
