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
    };
    placeOnPath(ped);
    peds.push(ped);
  }
  return peds;
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

/** Harmless on-foot bump: shove the ped a little, no state change. */
export function nudgePed(ped: Ped, from: Vec2): void {
  if (ped.state === 'down') return;
  const away = { x: ped.pos.x - from.x, z: ped.pos.z - from.z };
  const len = Math.hypot(away.x, away.z) || 1;
  ped.pos = { x: ped.pos.x + (away.x / len) * 0.5, z: ped.pos.z + (away.z / len) * 0.5 };
}
