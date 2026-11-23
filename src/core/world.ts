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

/**
 * A bridge span (FOLLOW iteration 5): a maximal run of one road
 * lying over open water, extended a few metres onto each bank.
 * Derived generically at load — any road-over-water geometry in
 * the dataset becomes a railed deck, no hand-authored bridge list.
 * In the real extract this is the Westmorland Street Bridge
 * complex (main span + its ramps).
 */
export interface BridgeSpan {
  road: Road;
  roadName: string;
  /** Deck centreline, bank to bank (core metres). */
  centerline: Vec2[];
  /** Centreline length, m. */
  lengthM: number;
  widthM: number;
  /** The two rail ribbons as collision polygons (Building-shaped
   *  entries also land in WorldModel.barriers). */
  rails: Vec2[][];
  /** Rail centre-lines (what the renderers draw the beam along). */
  railLines: Vec2[][];
  /** Post positions along both rails (renderer dressing). */
  posts: Vec2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface WorldModel {
  buildings: Building[];
  roads: Road[];
  water: WaterBody[];
  /** Iteration 5: derived bridge spans over the water. */
  bridges: BridgeSpan[];
  /** Iteration 5: guardrail ribbons as Building-shaped static
   *  obstacles (the renderers never see these — they draw rails
   *  from `bridges`; only the collision path does). */
  barriers: Building[];
  /** Everything the collision path tests against: buildings +
   *  barriers, precomputed so physics never allocates per substep. */
  colliders: Building[];
  /** Stage 1 backport: uniform spatial grid over `colliders`, built
   *  once at load. The collision hot path (car physics at 180 Hz)
   *  tests only the colliders near the circle instead of scanning
   *  the whole city — with the expanded Stage 1 dataset (11k+
   *  buildings) the full scan is no longer affordable. Candidate
   *  order is the original `colliders` order, so results are
   *  identical to the brute-force scan (pinned by spatial tests). */
  colliderGrid: ColliderGrid;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Uniform grid over a collider set: each collider's index is filed
 *  in every cell its bbox overlaps. */
export interface ColliderGrid {
  cellM: number;
  cells: Map<string, number[]>;
}

/** Grid cell size, metres. City blocks here run ~80-100 m; 64 m
 *  keeps a query circle (r <= ~3 m) inside 1-4 cells while a giant
 *  footprint (max ~200 m) still spans only a handful. */
export const COLLIDER_CELL_M = 64;

export function buildColliderGrid(colliders: Building[]): ColliderGrid {
  const cells = new Map<string, number[]>();
  const c = COLLIDER_CELL_M;
  colliders.forEach((b, i) => {
    const x0 = Math.floor(b.minX / c), x1 = Math.floor(b.maxX / c);
    const z0 = Math.floor(b.minZ / c), z1 = Math.floor(b.maxZ / c);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = `${x},${z}`;
        const arr = cells.get(key);
        if (arr) arr.push(i);
        else cells.set(key, [i]);
      }
    }
  });
  return { cellM: c, cells };
}

/** The colliders that could touch the circle at `pos` with radius
 *  `r`: those filed in the cells the circle's bbox overlaps, in
 *  original `colliders` order (the brute-force result depends on
 *  that order, so the grid preserves it exactly). */
export function colliderCandidates(
  grid: ColliderGrid,
  colliders: Building[],
  pos: Vec2,
  r: number,
): Building[] {
  const c = grid.cellM;
  const x0 = Math.floor((pos.x - r) / c), x1 = Math.floor((pos.x + r) / c);
  const z0 = Math.floor((pos.z - r) / c), z1 = Math.floor((pos.z + r) / c);
  const idx = new Set<number>();
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const arr = grid.cells.get(`${x},${z}`);
      if (arr) for (const i of arr) idx.add(i);
    }
  }
  return [...idx].sort((a, b) => a - b).map((i) => colliders[i]);
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
      // GeoNB's -1 sentinel means "no posted limit", not a speed:
      // clamp any non-positive raw value to 0 (the "none posted"
      // marker cruiseFor already defaults from) so the sentinel can
      // never leak into speed maths as a negative limit.
      speedKmh: Math.max(0, num(f.properties.Speed_Restrictions_Both, 0)),
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
  // Iteration 5: bridge decks + guardrails, derived from the
  // roads × water geometry just parsed (see deriveBridges).
  const partial: WorldModel = {
    buildings, roads, water,
    bridges: [], barriers: [], colliders: buildings,
    colliderGrid: buildColliderGrid(buildings), bounds,
  };
  const { bridges, barriers } = deriveBridges(partial);
  partial.bridges = bridges;
  partial.barriers = barriers;
  partial.colliders = barriers.length ? [...buildings, ...barriers] : buildings;
  partial.colliderGrid = buildColliderGrid(partial.colliders);
  return partial;
}

// --- bridge guardrails (FOLLOW iteration 5) --------------------------------
// Daniel, phone-testing the preview: "almost impossible to cross
// the bridge" — the decks were open, so any slide (and the follow
// controller's corner-cutting line) put the car in the river. The
// fix is physical, not a driving aid: derive every deck from the
// data and stand a rail along both edges, colliding exactly like a
// building wall.

/** Shortest over-water run that counts as a deck, m. Shorter dips
 *  (a path vertex kissing the shoreline polygon) get no rails. */
export const BRIDGE_MIN_RUN_M = 8;
/** Rails continue this far past the waterline onto each bank, m —
 *  a car already sliding as it reaches the deck meets the rail
 *  before the edge, not at it. */
export const BRIDGE_APPROACH_M = 4;
/** Rail centre-line sits this far inside the deck edge, m. */
export const RAIL_INSET_M = 0.45;
/** Rail ribbon thickness, m. */
export const RAIL_THICKNESS_M = 0.4;
/** Post spacing along the rails, m (renderer dressing). */
export const RAIL_POST_EVERY_M = 4;

/** Per-point normals along a polyline (averaged segment direction). */
function pathNormals(path: Vec2[]): Vec2[] {
  const normals: Vec2[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    normals.push({ x: -dz, z: dx });
  }
  return normals;
}

/** A polyline offset sideways by `d` metres (either sign). */
function offsetPathLocal(path: Vec2[], d: number): Vec2[] {
  const normals = pathNormals(path);
  return path.map((p, i) => ({ x: p.x + normals[i].x * d, z: p.z + normals[i].z * d }));
}

/** Ribbon polygon around a polyline: ±halfW on both sides. */
function ribbonLocal(path: Vec2[], halfW: number): Vec2[] {
  if (path.length < 2) return [];
  const left = offsetPathLocal(path, halfW);
  const right = offsetPathLocal(path, -halfW);
  return [...left, ...right.reverse()];
}

/** Distance from a point to a road's centreline path (m). */
function roadPointDist(road: Road, p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < road.path.length - 1; i++) {
    const a = road.path[i];
    const b = road.path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
    if (d < best) best = d;
  }
  return best;
}

type RoadBB = Map<Road, { minX: number; maxX: number; minZ: number; maxZ: number }>;

function roadBBoxes(roads: Road[]): RoadBB {
  const out: RoadBB = new Map();
  for (const r of roads) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const q of r.path) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z);
    }
    out.set(r, { minX, maxX, minZ, maxZ });
  }
  return out;
}

/**
 * True when `p` lies inside the carriageway of any road other
 * than `self` (bbox-rejected per road, so derivation stays fast
 * on the full extract). A 0.3 m margin keeps rails clear of the
 * neighbouring asphalt edge, not just its centre half-width.
 */
function insideOtherCarriageway(world: WorldModel, bb: RoadBB, self: Road, p: Vec2): boolean {
  for (const r of world.roads) {
    if (r === self) continue;
    const half = r.widthM / 2 + 0.3;
    const b = bb.get(r)!;
    if (p.x < b.minX - half || p.x > b.maxX + half || p.z < b.minZ - half || p.z > b.maxZ + half) continue;
    if (roadPointDist(r, p) <= half) return true;
  }
  return false;
}

/**
 * Every bridge deck in the world: for each road, sample its length
 * at 1 m and collect the maximal over-water runs of at least
 * BRIDGE_MIN_RUN_M. Each run, extended onto the banks, becomes a
 * span with a rail ribbon on each side. Deterministic for a given
 * world; empty when the world has no water or no crossings.
 */
export function deriveBridges(world: WorldModel): { bridges: BridgeSpan[]; barriers: Building[] } {
  const bridges: BridgeSpan[] = [];
  const barriers: Building[] = [];
  if (!world.water.length) return { bridges, barriers };
  const bb = roadBBoxes(world.roads);
  for (const road of world.roads) {
    // Over-water runs along this road (distAlong intervals).
    const runs: Array<[number, number]> = [];
    let runStart = -1;
    const steps = Math.floor(road.lengthM);
    for (let d = 0; d <= steps; d++) {
      const inW = pointInWater(world, pointAlongRoad(road, d).pos);
      if (inW && runStart < 0) runStart = d;
      if (!inW && runStart >= 0) {
        runs.push([runStart, d]);
        runStart = -1;
      }
    }
    if (runStart >= 0) runs.push([runStart, steps]);
    for (const [d0, d1] of runs) {
      if (d1 - d0 < BRIDGE_MIN_RUN_M) continue;
      const a = Math.max(0, d0 - BRIDGE_APPROACH_M);
      const b = Math.min(road.lengthM, d1 + BRIDGE_APPROACH_M);
      // Centreline: the road's own vertices inside the span, plus
      // interpolated points so no leg exceeds ~2 m (rail ribbons
      // hug curves instead of chord-cutting them).
      const centerline: Vec2[] = [];
      const SAMPLE = 2;
      const n = Math.max(1, Math.ceil((b - a) / SAMPLE));
      for (let i = 0; i <= n; i++) {
        centerline.push(pointAlongRoad(road, a + ((b - a) * i) / n).pos);
      }
      const railOff = road.widthM / 2 - RAIL_INSET_M;
      const rails: Vec2[][] = [];
      const railLines: Vec2[][] = [];
      const posts: Vec2[] = [];
      for (const side of [1, -1] as const) {
        const line = offsetPathLocal(centerline, side * railOff);
        // Trim: a rail point that falls inside ANOTHER road's
        // carriageway cannot stand — junction mouths stay open
        // and braided ramps never wall each other off (the first
        // routed bridge crossing wedged a car exactly there).
        // Kept points form runs; each run becomes its own ribbon.
        const kept = line.map((p) => !insideOtherCarriageway(world, bb, road, p));
        let runStart = -1;
        const flush = (endExclusive: number): void => {
          if (runStart < 0) return;
          const runPts = line.slice(runStart, endExclusive);
          runStart = -1;
          if (runPts.length < 2) return;
          railLines.push(runPts);
          rails.push(ribbonLocal(runPts, RAIL_THICKNESS_M / 2));
          // Posts every ~RAIL_POST_EVERY_M along the run (the
          // centreline is sampled at ~2 m, so step in indices).
          const stepIdx = Math.max(1, Math.round(RAIL_POST_EVERY_M / 2));
          for (let i = 1; i < runPts.length - 1; i += stepIdx) posts.push(runPts[i]);
        };
        kept.forEach((k, i) => {
          if (k && runStart < 0) runStart = i;
          if (!k) flush(i);
        });
        flush(line.length);
      }
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of centerline) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const span: BridgeSpan = {
        road,
        roadName: road.name,
        centerline,
        lengthM: b - a,
        widthM: road.widthM,
        rails,
        railLines,
        posts,
        minX, maxX, minZ, maxZ,
      };
      bridges.push(span);
      rails.forEach((poly, k) => {
        let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
        let cx = 0, cz = 0;
        for (const p of poly) {
          bMinX = Math.min(bMinX, p.x); bMaxX = Math.max(bMaxX, p.x);
          bMinZ = Math.min(bMinZ, p.z); bMaxZ = Math.max(bMaxZ, p.z);
          cx += p.x; cz += p.z;
        }
        barriers.push({
          polygon: poly,
          heightM: 1.1,
          center: { x: cx / poly.length, z: cz / poly.length },
          minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ,
        });
        void k;
      });
    }
  }
  return { bridges, barriers };
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
  return collideList(buildings, pos, r);
}

/**
 * Grid-accelerated collision against a whole world: identical
 * result to `collideBuildingsN(world.colliders, pos, r)` (the grid
 * returns a superset of the colliders the brute-force bbox reject
 * would pass, in the same order), but only tests the handful of
 * colliders near the circle. This is the physics hot path.
 */
export function collideWorldN(world: WorldModel, pos: Vec2, r: number): CollisionHit | null {
  return collideList(colliderCandidates(world.colliderGrid, world.colliders, pos, r), pos, r);
}

/** `collideWorldN` without the normal, for circle movers. */
export function collideWorld(world: WorldModel, pos: Vec2, r: number): Vec2 | null {
  const hit = collideWorldN(world, pos, r);
  return hit ? hit.pos : null;
}

function collideList(buildings: Building[], pos: Vec2, r: number): CollisionHit | null {
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
