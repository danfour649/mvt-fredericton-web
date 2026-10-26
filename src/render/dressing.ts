/**
 * Street & roof dressing (v0.23) — SHARED derived geometry for both
 * adapters, computed once at load from the world model. Pure data,
 * deterministic (seeded), no DOM — unit-testable headlessly.
 *
 * - BUILDING SHADOWS: every footprint offset ~1.6 m south-east as a
 *   translucent dark underlay — the cheapest possible "buildings have
 *   mass" cue, straight from the GTA 1 frames.
 * - ROOF CLUTTER: AC boxes, vents and skylight strips placed per roof
 *   piece (post-v0.22 segmentation), seeded by building index so the
 *   city is stable between loads.
 * - CROSSWALKS: zebra stripes across road ends at junction nodes,
 *   reusing the v0.21 routing graph (core/routing.ts) for positions.
 * - STREET TREES: seeded scatter along roadside sidewalks (never on
 *   roads, buildings or water — since v0.28 the Saint John River IS in
 *   the core model, and riverbank candidates are rejected against it),
 *   canopy blobs + shadows.
 */
import type { Vec2 } from '../core/geo';
import { pointInPolygon, pointInWater, type WorldModel } from '../core/world';
import type { RoadGraph } from '../core/routing';
import { principalBox, type RoofPiece } from './segment';

/** Small deterministic PRNG (same family as the core's). */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shadow offset, metres: east + south = screen south-east (north-up). */
export const SHADOW_OFFSET: Vec2 = { x: 1.6, z: 1.6 };

export function shadowRing(ring: Vec2[]): Vec2[] {
  return ring.map((p) => ({ x: p.x + SHADOW_OFFSET.x, z: p.z + SHADOW_OFFSET.z }));
}

// --- roof clutter -----------------------------------------------------------

export interface ClutterItem {
  ring: Vec2[];
  /** Flat fill (adapters draw these untextured; they're small). */
  fill: string;
  kind: 'ac' | 'vent' | 'skylight';
}

const CLUTTER_FILLS: Record<ClutterItem['kind'], string[]> = {
  ac: ['#4c463f', '#5a5348', '#453f38'],
  vent: ['#6a6156', '#575046'],
  skylight: ['#7e8a94', '#6d7a86'],
};

/**
 * Deterministic clutter for one roof piece. Items are small rects
 * aligned to the piece's principal axis, placed inside the inset roof
 * region (0.84 shrink toward the piece centre, matching the adapters'
 * inset roofs, with extra margin), and centre-checked against the
 * piece polygon so nothing hangs off an L-shaped roof.
 */
export function roofClutter(piece: RoofPiece, buildingIndex: number): ClutterItem[] {
  if (piece.area < 55) return [];
  const rng = mulberry(0xC0FFEE + buildingIndex * 131 + Math.round(piece.center.x * 7 + piece.center.z * 13));
  const box = principalBox(piece.ring);
  const n = Math.min(6, 1 + Math.floor(piece.area / 130) + (rng() < 0.5 ? 1 : 0));
  const items: ClutterItem[] = [];
  const insetRing = piece.ring.map((p) => ({
    x: piece.center.x + (p.x - piece.center.x) * 0.8,
    z: piece.center.z + (p.z - piece.center.z) * 0.8,
  }));
  for (let k = 0; k < n; k++) {
    const kind: ClutterItem['kind'] = k === 0 && piece.area > 160 ? 'skylight' : rng() < 0.62 ? 'ac' : 'vent';
    const lenM = kind === 'skylight' ? 2.6 + rng() * 2.4 : 1.1 + rng() * 1.6;
    const widM = kind === 'skylight' ? 1.1 + rng() * 0.7 : 0.9 + rng() * 1.1;
    // Jittered grid slot along the principal axes, around the centre.
    const fu = (rng() * 2 - 1) * 0.62;
    const fv = (rng() * 2 - 1) * 0.55;
    const c: Vec2 = {
      x: piece.center.x + box.u.x * fu * (box.long / 2) + box.v.x * fv * (box.short / 2),
      z: piece.center.z + box.u.z * fu * (box.long / 2) + box.v.z * fv * (box.short / 2),
    };
    if (!pointInPolygon(c, insetRing)) continue;
    const hu = { x: box.u.x * (lenM / 2), z: box.u.z * (lenM / 2) };
    const hv = { x: box.v.x * (widM / 2), z: box.v.z * (widM / 2) };
    const ring: Vec2[] = [
      { x: c.x - hu.x - hv.x, z: c.z - hu.z - hv.z },
      { x: c.x + hu.x - hv.x, z: c.z + hu.z - hv.z },
      { x: c.x + hu.x + hv.x, z: c.z + hu.z + hv.z },
      { x: c.x - hu.x + hv.x, z: c.z - hu.z + hv.z },
    ];
    const fills = CLUTTER_FILLS[kind];
    items.push({ ring, fill: fills[Math.floor(rng() * fills.length)], kind });
  }
  return items;
}

// --- crosswalks -------------------------------------------------------------

const STRIPE_W = 0.55; // stripe width across the road, m
const STRIPE_PITCH = 1.05;
const BAND_DEPTH = 2.3; // crosswalk band depth along the road, m

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

/**
 * Zebra stripes at junction nodes. A node qualifies when ≥2 DISTINCT
 * roads meet there (mid-block segment splits of one road don't get a
 * crossing). For each incident road end, one band is laid across the
 * road just clear of the junction centre.
 */
export function crosswalkStripes(graph: RoadGraph): Vec2[][] {
  const stripes: Vec2[][] = [];
  const placedAt: Vec2[] = [];
  graph.nodes.forEach((node) => {
    const roads = new Set(node.edges.map((e) => e.road));
    if (roads.size < 2) return;
    if (placedAt.some((p) => Math.hypot(p.x - node.pos.x, p.z - node.pos.z) < 10)) return;
    placedAt.push(node.pos);
    for (const edge of node.edges) {
      const path = edge.road.path;
      const end = edge.atStart ? path[0] : path[path.length - 1];
      const next = edge.atStart ? path[1] : path[path.length - 2];
      let dx = end.x - next.x;
      let dz = end.z - next.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      // Band centre sits BAND_DEPTH/2 + 1.1 m out from the junction.
      const bc: Vec2 = {
        x: node.pos.x + dx * (BAND_DEPTH / 2 + 1.1),
        z: node.pos.z + dz * (BAND_DEPTH / 2 + 1.1),
      };
      const side = { x: -dz, z: dx };
      const halfW = (edge.road.widthM * 0.92) / 2;
      for (let o = -halfW + STRIPE_W / 2; o < halfW - 0.2; o += STRIPE_PITCH) {
        const c: Vec2 = { x: bc.x + side.x * o, z: bc.z + side.z * o };
        const hu = { x: dx * (BAND_DEPTH / 2), z: dz * (BAND_DEPTH / 2) };
        const hv = { x: side.x * (STRIPE_W / 2), z: side.z * (STRIPE_W / 2) };
        stripes.push([
          { x: c.x - hu.x - hv.x, z: c.z - hu.z - hv.z },
          { x: c.x + hu.x - hv.x, z: c.z + hu.z - hv.z },
          { x: c.x + hu.x + hv.x, z: c.z + hu.z + hv.z },
          { x: c.x - hu.x + hv.x, z: c.z - hu.z + hv.z },
        ]);
      }
    }
  });
  return stripes;
}

// --- street trees -----------------------------------------------------------

export interface TreeSpot {
  pos: Vec2;
  /** Canopy radius, m. */
  r: number;
  /** Canopy blob outline (radially jittered 10-gon), world metres. */
  ring: Vec2[];
  shadow: Vec2[];
  variant: 0 | 1 | 2;
}

export const TREE_FILLS = ['#33512a', '#3d5c2f', '#2c4526'];

function blobRing(c: Vec2, r: number, rng: () => number): Vec2[] {
  const ring: Vec2[] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.82 + rng() * 0.36);
    ring.push({ x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr });
  }
  return ring;
}

function insideAnyBuilding(world: WorldModel, p: Vec2, margin: number): boolean {
  for (const b of world.buildings) {
    if (p.x < b.minX - margin || p.x > b.maxX + margin || p.z < b.minZ - margin || p.z > b.maxZ + margin) continue;
    if (pointInPolygon(p, b.polygon)) return true;
    // Near the wall counts too (expanded by the margin via edge dist).
    for (let i = 0, j = b.polygon.length - 1; i < b.polygon.length; j = i++) {
      if (distToSegment(p, b.polygon[j], b.polygon[i]) < margin) return true;
    }
  }
  return false;
}

/**
 * Seeded roadside tree scatter: candidates march along both sidewalks
 * of 2+ lane roads every ~16 m; a candidate survives if it's off every
 * road surface, out of every building (with margin), and not crowding
 * another tree. Capped for draw cost.
 */
export function scatterTrees(world: WorldModel, target = 240): TreeSpot[] {
  const rng = mulberry(0x7EEE5);
  const trees: TreeSpot[] = [];
  const roads = world.roads.filter((r) => r.lanes >= 2 && r.lengthM > 25);
  // Shuffle road order deterministically so the cap doesn't bias downtown.
  const order = roads.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const ri of order) {
    if (trees.length >= target) break;
    const road = roads[ri];
    for (let d = 8; d < road.lengthM - 6 && trees.length < target; d += 15 + rng() * 7) {
      for (const sideSign of [1, -1] as const) {
        if (rng() > 0.42) continue;
        // Point at distance d along the road + its heading.
        let remaining = d;
        let pos: Vec2 | null = null;
        let heading = 0;
        for (let i = 0; i < road.segLens.length; i++) {
          const a = road.path[i];
          const b = road.path[i + 1];
          if (remaining <= road.segLens[i] || i === road.segLens.length - 1) {
            const t = road.segLens[i] > 0 ? remaining / road.segLens[i] : 0;
            pos = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
            heading = Math.atan2(b.z - a.z, b.x - a.x);
            break;
          }
          remaining -= road.segLens[i];
        }
        if (!pos) continue;
        const off = road.widthM / 2 + 2.1 + rng() * 0.9;
        const cand: Vec2 = {
          x: pos.x + Math.cos(heading + Math.PI / 2) * off * sideSign + (rng() - 0.5) * 1.6,
          z: pos.z + Math.sin(heading + Math.PI / 2) * off * sideSign + (rng() - 0.5) * 1.6,
        };
        if (insideAnyBuilding(world, cand, 1.1)) continue;
        if (pointInWater(world, cand)) continue;
        let onRoad = false;
        for (const r2 of world.roads) {
          for (let i = 0; i < r2.path.length - 1 && !onRoad; i++) {
            if (distToSegment(cand, r2.path[i], r2.path[i + 1]) < r2.widthM / 2 + 0.9) onRoad = true;
          }
          if (onRoad) break;
        }
        if (onRoad) continue;
        if (trees.some((t) => Math.hypot(t.pos.x - cand.x, t.pos.z - cand.z) < 5.5)) continue;
        const r = 1.5 + rng() * 0.9;
        const ring = blobRing(cand, r, rng);
        trees.push({
          pos: cand,
          r,
          ring,
          shadow: shadowRing(ring),
          variant: Math.floor(rng() * 3) as 0 | 1 | 2,
        });
      }
    }
  }
  return trees;
}
