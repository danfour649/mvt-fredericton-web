/**
 * Pedestrians: walkers who follow road-offset paths (the sidewalk, such
 * as it is) near the player, flee fast/close cars, and go down when a car
 * connects. Same road-following trick as traffic.ts, at walking pace.
 */
import type { Vec2 } from './geo';
import { pointAlongRoad, type Road, type WorldModel } from './world';

export type PedState = 'walk' | 'flee' | 'down';

export interface Ped {
  id: string;
  pos: Vec2;
  heading: number;
  color: string;
  state: PedState;
  road: Road;
  distAlong: number;
  dir: 1 | -1;
  speed: number;
  /** Sidewalk offset direction relative to road direction. */
  side: 1 | -1;
  fleeDir: Vec2;
  fleeT: number;
  downT: number;
  /** v0.29: cumulative metres walked — the walk-cycle phase source
   *  (distance-driven, so feet step in sync with the ground). */
  walkM: number;
  /** v0.30: set-piece group id (the Gouranga procession) — the game
   *  tracks group members going down together for the bonus. */
  group?: string;
}

/** v0.30: put a ped on the ground for `seconds` (fists, gunfire,
 *  explosions — the game routes all non-car downs through here). */
export function forceDown(ped: Ped, seconds: number): void {
  ped.state = 'down';
  ped.downT = seconds;
}

const PED_COLORS = ['#d35450', '#5b8dd9', '#58b368', '#e8c547', '#9d7bd8', '#e07a5f', '#4fb8ac', '#c0c6ce'];
const WALK_SPEED = 1.4;

function placeOnPath(ped: Ped): void {
  const { pos, heading } = pointAlongRoad(ped.road, ped.distAlong);
  const travel = ped.dir === 1 ? heading : heading + Math.PI;
  const off = ped.road.widthM / 2 + 1.1;
  ped.pos = {
    x: pos.x + Math.cos(travel + (Math.PI / 2) * ped.side) * off,
    z: pos.z + Math.sin(travel + (Math.PI / 2) * ped.side) * off,
  };
  ped.heading = travel;
}

export function spawnPeds(
  world: WorldModel,
  around: Vec2,
  count: number,
  rng: () => number,
): Ped[] {
  const roads = world.roads.filter(
    (r) => r.lengthM > 50 && Math.hypot(r.path[0].x - around.x, r.path[0].z - around.z) < 420,
  );
  const peds: Ped[] = [];
  if (!roads.length) return peds;
  for (let i = 0; i < count; i++) {
    const road = roads[Math.floor(rng() * roads.length)];
    const ped: Ped = {
      id: `ped-${i}`,
      pos: { x: 0, z: 0 },
      heading: 0,
      color: PED_COLORS[i % PED_COLORS.length],
      state: 'walk',
      road,
      distAlong: road.lengthM * (0.1 + 0.8 * rng()),
      dir: rng() > 0.5 ? 1 : -1,
      speed: WALK_SPEED * (0.8 + 0.4 * rng()),
      side: rng() > 0.5 ? 1 : -1,
      fleeDir: { x: 0, z: 0 },
      fleeT: 0,
      downT: 0,
      walkM: 0,
    };
    placeOnPath(ped);
    peds.push(ped);
  }
  return peds;
}

/**
 * v0.25: re-anchor a ped onto a (usually different) road — the
 * pedestrian bubble's recycle step. State resets to a plain walk:
 * a ped being recycled is by definition far from the player, so any
 * flee/down state it carried is stale. Placement goes through the
 * same path placer as spawning, so recycled peds are indistinguishable
 * from fresh ones (and still flee — updatePed is untouched).
 */
export function reanchorPed(ped: Ped, road: Road, rng: () => number): void {
  ped.road = road;
  ped.distAlong = road.lengthM * (0.1 + 0.8 * rng());
  ped.dir = rng() > 0.5 ? 1 : -1;
  ped.side = rng() > 0.5 ? 1 : -1;
  ped.state = 'walk';
  ped.fleeT = 0;
  ped.downT = 0;
  placeOnPath(ped);
}

export interface PedThreat {
  pos: Vec2;
  speed: number;
}

/**
 * Advance one ped. `threat` is the player's car when driving (undefined
 * on foot — walkers ignore a walking player). Returns 'downed' on the
 * tick a car connects with this ped.
 */
export function updatePed(ped: Ped, dt: number, threat?: PedThreat): 'downed' | null {
  if (ped.state === 'down') {
    ped.downT -= dt;
    if (ped.downT <= 0) {
      // Get up somewhere along the same road, GTA-forgiving.
      ped.state = 'walk';
      ped.distAlong = Math.max(2, Math.min(ped.road.lengthM - 2, ped.distAlong + 25 * ped.dir));
      placeOnPath(ped);
    }
    return null;
  }

  if (threat) {
    const d = Math.hypot(threat.pos.x - ped.pos.x, threat.pos.z - ped.pos.z);
    if (Math.abs(threat.speed) > 2.2 && d < 1.8) {
      ped.state = 'down';
      ped.downT = 6;
      return 'downed';
    }
    if (ped.state !== 'flee' && Math.abs(threat.speed) > 3.5 && d < 11) {
      ped.state = 'flee';
      ped.fleeT = 1.1;
      const away = { x: ped.pos.x - threat.pos.x, z: ped.pos.z - threat.pos.z };
      const len = Math.hypot(away.x, away.z) || 1;
      ped.fleeDir = { x: away.x / len, z: away.z / len };
    }
  }

  if (ped.state === 'flee') {
    ped.fleeT -= dt;
    ped.walkM += 4.4 * dt;
    ped.pos = {
      x: ped.pos.x + ped.fleeDir.x * 4.4 * dt,
      z: ped.pos.z + ped.fleeDir.z * 4.4 * dt,
    };
    ped.heading = Math.atan2(ped.fleeDir.z, ped.fleeDir.x);
    if (ped.fleeT <= 0) {
      ped.state = 'walk';
      // Re-anchor onto the path so fleeing doesn't strand them in a wall.
      placeOnPath(ped);
    }
    return null;
  }

  // Walk the path, ping-ponging like traffic.
  ped.walkM += ped.speed * dt;
  ped.distAlong += ped.dir * ped.speed * dt;
  if (ped.distAlong >= ped.road.lengthM - 2) {
    ped.distAlong = ped.road.lengthM - 2;
    ped.dir = ped.dir === 1 ? -1 : 1;
  } else if (ped.distAlong <= 2) {
    ped.distAlong = 2;
    ped.dir = ped.dir === 1 ? -1 : 1;
  }
  placeOnPath(ped);
  return null;
}

/**
 * v0.30: a procession line (the Gouranga set piece) — `count` walkers
 * on ONE road, same direction and side, spaced ~1.3 m apart along the
 * path so they read as a line crossing the city, not a crowd.
 */
export function spawnProcession(
  road: Road,
  count: number,
  rng: () => number,
  group: string,
  idBase: string,
): Ped[] {
  const dir: 1 | -1 = rng() > 0.5 ? 1 : -1;
  const side: 1 | -1 = rng() > 0.5 ? 1 : -1;
  const start = road.lengthM * (0.25 + 0.4 * rng());
  const peds: Ped[] = [];
  for (let i = 0; i < count; i++) {
    const ped: Ped = {
      id: `${idBase}-${i}`,
      pos: { x: 0, z: 0 },
      heading: 0,
      color: '#e8862e', // saffron
      state: 'walk',
      road,
      distAlong: Math.max(3, Math.min(road.lengthM - 3, start + (i - count / 2) * 1.35 * dir)),
      dir,
      speed: WALK_SPEED,
      side,
      fleeDir: { x: 0, z: 0 },
      fleeT: 0,
      downT: 0,
      walkM: 0,
      group,
    };
    placeOnPath(ped);
    peds.push(ped);
  }
  return peds;
}

/** Harmless on-foot bump: shove the ped a little, no state change. */
export function nudgePed(ped: Ped, from: Vec2): void {
  if (ped.state === 'down') return;
  const away = { x: ped.pos.x - from.x, z: ped.pos.z - from.z };
  const len = Math.hypot(away.x, away.z) || 1;
  ped.pos = { x: ped.pos.x + (away.x / len) * 0.5, z: ped.pos.z + (away.z / len) * 0.5 };
}
