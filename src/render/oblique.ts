/**
 * Oblique building projection (iteration 4) — SHARED geometry for
 * both render adapters, so Route A and Route C extrude identically.
 *
 * Daniel's GTA 1 gameplay footage is the spec: GTA 1's city is NOT
 * flat top-down. Every building is an oblique box — the roof plane
 * sits offset UP-SCREEN (north) from the footprint, and the band of
 * footprint the offset roof leaves uncovered on the south side is
 * the building's WALL, carrying the window grid. (v0.28 put the
 * window grids on the roofs — the footage shows roofs comparatively
 * plain and the grids on the walls.)
 *
 * This module is drawing geometry ONLY: the core keeps colliding
 * with the true footprints, and nothing here moves a footprint.
 * The wall band never leaves the footprint (band = footprint minus
 * the offset footprint); the roof's northward overhang is capped so
 * it stays a parapet's reach, not a street-swallowing slab.
 */
import type { Vec2 } from '../core/geo';
import type { Building } from '../core/world';
import { polygonArea } from './segment';

/** Screen-north offset (m) per metre of visual building height. */
export const OBLIQUE_K = 0.5;
/** Hard cap on the roof's northward offset, metres. */
export const MAX_EXTRUDE_M = 9;

/**
 * The height the DRAWING uses. GeoNB gives many buildings a real
 * height (roof elevation − ground elevation); where that's missing
 * or implausibly flat, derive a plausible mass from the footprint
 * area so sheds stay sheds and slabs read tall.
 */
export function visualHeightM(b: Building): number {
  if (b.heightM >= 3.5) return Math.min(24, b.heightM);
  const area = Math.abs(polygonArea(b.polygon));
  return Math.min(9, 3.4 + area / 170);
}

/**
 * Roof offset in metres (north). Also capped by the footprint's own
 * depth: a thin building can't extrude past its own back wall, which
 * keeps the wall-band hole inside the footprint for the polygon
 * subtraction both adapters draw.
 */
export function extrudeM(b: Building): number {
  const depth = Math.max(1, b.maxZ - b.minZ);
  return Math.max(0.8, Math.min(MAX_EXTRUDE_M, visualHeightM(b) * OBLIQUE_K, depth * 0.75));
}

/** A ring shifted screen-north by `dz` metres (the roof plane). */
export function offsetRing(ring: Vec2[], dz: number): Vec2[] {
  return ring.map((p) => ({ x: p.x, z: p.z - dz }));
}
