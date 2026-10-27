/**
 * World model: the downtown dataset (lon/lat GeoJSON, as produced by
 * tools/build_downtown.py from GeoNB services) projected once at load into
 * core-frame local metres. After this module, nothing in the core ever
 * touches lon/lat again.
 *
 * No DOM, no fetch in here — callers hand in the parsed JSON.
 */
import { project, type Vec2 } from './geo';

export interface Building {
  /** Outer ring only, core metres, not explicitly closed. */
  polygon: Vec2[];
  heightM: number;
  center: Vec2;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Road {
  path: Vec2[];
  name: string;
  lanes: number;
  /** km/h, 0 when GeoNB gives none. */
  speedKmh: number;
  /** GeoNB Dir_of_Traffic_Flow, e.g. "Same Direction" / "Opposite Direction". */
  dirFlow: string;
  widthM: number;
  /** Cumulative segment lengths + total, for traffic movement. */
  segLens: number[];
  lengthM: number;
}

/**
 * A water body (v0.28): the Saint John River, from GeoNB's NBHN
 * hydrography (NBHN "Water Bodies"). Before v0.28 the dataset had NO
 * open water at all — the PMTiles "wetlands" layer is the regulated
 * marsh/bog inventory, not the river channel — so the riverfront
 * rendered as lawn. Rings are [outer, ...holes] in core metres.
 */
export interface WaterBody {
  rings: Vec2[][];
  name: string;
  /** Outer area minus holes, m². */
  areaM2: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface WorldModel {
  buildings: Building[];
  roads: Road[];
  water: WaterBody[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

interface DowntownDoc {
  buildings: { features: GeoFeature[] };
  roads: { features: GeoFeature[] };
  water?: { features: GeoFeature[] };
}

interface GeoFeature {
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function loadWorld(doc: unknown): WorldModel {
  const d = doc as DowntownDoc;
  const buildings: Building[] = [];
  for (const f of d.buildings?.features ?? []) {
    if (f.geometry.type !== 'Polygon') continue;
    const rings = f.geometry.coordinates as number[][][];
    const outer = rings[0];
    if (!outer || outer.length < 4) continue;
    const polygon = outer.slice(0, -1).map(([lng, lat]) => project(lng, lat));
    if (polygon.length < 3) continue;
    const minG = num(f.properties.min_g_elev, 0);
    const maxB = num(f.properties.max_b_elev, minG);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let cx = 0, cz = 0;
    for (const p of polygon) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      cx += p.x; cz += p.z;
    }
    buildings.push({
      polygon,
      heightM: Math.max(0, maxB - minG),
      center: { x: cx / polygon.length, z: cz / polygon.length },
      minX, maxX, minZ, maxZ,
    });
  }

  const roads: Road[] = [];
  for (const f of d.roads?.features ?? []) {
    if (f.geometry.type !== 'LineString') continue;
    const coords = f.geometry.coordinates as number[][];
    if (coords.length < 2) continue;
    const path = coords.map(([lng, lat]) => project(lng, lat));
    const segLens: number[] = [];
    let lengthM = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const l = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
      segLens.push(l);
      lengthM += l;
    }
    if (lengthM < 4) continue;
    const lanes = Math.max(1, num(f.properties.Number_Of_Lanes, 2));
    roads.push({
      path,
      name: String(f.properties.Formatted_Street_Name ?? f.properties.Route_Name_English_1 ?? ''),
      lanes,
      speedKmh: num(f.properties.Speed_Restrictions_Both, 0),
      dirFlow: String(f.properties.Dir_of_Traffic_Flow ?? ''),
      widthM: 3.6 * lanes + 2,
      segLens,
      lengthM,
    });
  }

  const water: WaterBody[] = [];
  const ringArea = (ring: Vec2[]): number => {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      a += p.x * q.z - q.x * p.z;
    }
    return a / 2;
  };
  for (const f of d.water?.features ?? []) {
    const polys: number[][][][] =
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates as number[][][]]
        : f.geometry.type === 'MultiPolygon'
          ? (f.geometry.coordinates as number[][][][])
          : [];
    for (const poly of polys) {
      const rings: Vec2[][] = [];
      for (const ring of poly) {
        if (!ring || ring.length < 4) continue;
        const pts = ring.slice(0, -1).map(([lng, lat]) => project(lng, lat));
        if (pts.length >= 3) rings.push(pts);
      }
      if (!rings.length) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of rings[0]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const areaM2 = Math.max(
        0,
        Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0),
      );
      water.push({
        rings,
        name: String(f.properties.NAME1 ?? ''),
        areaM2,
        minX, maxX, minZ, maxZ,
      });
    }
  }

  let bounds = { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity };
  if (buildings.length) {
    bounds = {
      minX: Math.min(...buildings.map((b) => b.minX)),
      maxX: Math.max(...buildings.map((b) => b.maxX)),
      minZ: Math.min(...buildings.map((b) => b.minZ)),
      maxZ: Math.max(...buildings.map((b) => b.maxZ)),
    };
  }
  return { buildings, roads, water, bounds };
}

/** Is `p` on open water? (outer ring, minus holes/islands) */
export function pointInWater(world: WorldModel, p: Vec2): boolean {
  for (const w of world.water) {
    if (p.x < w.minX || p.x > w.maxX || p.z < w.minZ || p.z > w.maxZ) continue;
    if (!pointInPolygon(p, w.rings[0])) continue;
    if (w.rings.slice(1).some((h) => pointInPolygon(p, h))) continue;
    return true;
  }
  return false;
}

/** Point at distance `d` metres along a road (clamped to the ends). */
export function pointAlongRoad(road: Road, d: number): { pos: Vec2; heading: number } {
  let remaining = Math.max(0, Math.min(d, road.lengthM));
  for (let i = 0; i < road.segLens.length; i++) {
    const a = road.path[i];
    const b = road.path[i + 1];
    const len = road.segLens[i];
    if (remaining <= len || i === road.segLens.length - 1) {
      const t = len > 0 ? remaining / len : 0;
      return {
        pos: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t },
        heading: Math.atan2(b.z - a.z, b.x - a.x),
      };
    }
    remaining -= len;
  }
  const last = road.path[road.path.length - 1];
  return { pos: { ...last }, heading: 0 };
}

/** Closest point on any road centreline to `p` (for snapping POIs). */
export function nearestRoadPoint(
  world: WorldModel,
  p: Vec2,
): { pos: Vec2; heading: number; road: Road } | null {
  let best: { pos: Vec2; heading: number; road: Road } | null = null;
  let bestD = Infinity;
  for (const road of world.roads) {
    for (let i = 0; i < road.path.length - 1; i++) {
      const a = road.path[i];
      const b = road.path[i + 1];
      const c = closestPointOnSegment(p, a, b);
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = { pos: c, heading: Math.atan2(b.z - a.z, b.x - a.x), road };
      }
    }
  }
  return best;
}

/** Exact point-in-polygon (outer ring). */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
  return { x: a.x + abx * t, z: a.z + abz * t };
}

export interface CollisionHit {
  /** Pushed-out position (circle resting against the wall). */
  pos: Vec2;
  /** Outward wall normal at the contact (unit, points away from the building). */
  normal: Vec2;
}

/**
 * Circle-vs-building collision: if the circle at `pos` with radius `r`
 * overlaps a building polygon, return the pushed-out position; else null.
 * Cheap bbox reject first, then exact edge distance / containment.
 */
export function collideBuildings(buildings: Building[], pos: Vec2, r: number): Vec2 | null {
  const hit = collideBuildingsN(buildings, pos, r);
  return hit ? hit.pos : null;
}

/**
 * Same collision as collideBuildings, but also reports the outward
 * normal of the DEEPEST contact. v0.29: the car physics needs the
 * normal to SLIDE along walls (project out the into-wall velocity)
 * instead of annihilating all velocity on contact — the old response
 * multiplied the whole velocity by 0.3 per substep, so a glancing
 * touch glued the car to the wall and a nose-in car whose reverse
 * arc clipped the wall lost its escape velocity every substep.
 */
export function collideBuildingsN(buildings: Building[], pos: Vec2, r: number): CollisionHit | null {
  let result: Vec2 | null = null;
  let resultNormal: Vec2 = { x: 1, z: 0 };
  let resultDepth = -1;
  for (const b of buildings) {
    if (pos.x < b.minX - r || pos.x > b.maxX + r || pos.z < b.minZ - r || pos.z > b.maxZ + r) {
      continue;
    }
    const cur: Vec2 = result ?? pos;
    let best: Vec2 | null = null;
    let bestDist = Infinity;
    for (let i = 0, j = b.polygon.length - 1; i < b.polygon.length; j = i++) {
      const c = closestPointOnSegment(cur, b.polygon[j], b.polygon[i]);
      const d = Math.hypot(cur.x - c.x, cur.z - c.z);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (!best) continue;
    const inside = pointInPolygon(cur, b.polygon);
    if (!inside && bestDist >= r) continue;
    if (bestDist < 1e-6) {
      result = { x: best.x + r, z: best.z };
      if (r > resultDepth) {
        resultDepth = r;
        resultNormal = { x: 1, z: 0 };
      }
    } else if (inside) {
      // Step from the centre toward the nearest edge point and a full
      // radius past it, ending just outside the wall. The outward
      // normal is that same centre→edge direction.
      const ux = (best.x - cur.x) / bestDist;
      const uz = (best.z - cur.z) / bestDist;
      result = { x: best.x + ux * r, z: best.z + uz * r };
      const depth = bestDist + r;
      if (depth > resultDepth) {
        resultDepth = depth;
        resultNormal = { x: ux, z: uz };
      }
    } else {
      // Outside but overlapping: push directly away from the wall.
      const ux = (cur.x - best.x) / bestDist;
      const uz = (cur.z - best.z) / bestDist;
      result = { x: cur.x + ux * (r - bestDist), z: cur.z + uz * (r - bestDist) };
      const depth = r - bestDist;
      if (depth > resultDepth) {
        resultDepth = depth;
        resultNormal = { x: ux, z: uz };
      }
    }
  }
  return result ? { pos: result, normal: resultNormal } : null;
}
