/**
 * Giant-roof segmentation (v0.22) — SHARED by both render adapters so
 * Route A (MapLibre) and Route C (canvas) treat buildings identically.
 *
 * Why: the scale audit against GTA 1 (cube = 4.5 m = one car length)
 * showed our car (4.4 m) and streets (2-lane = 9.2 m) already match,
 * but real GeoNB footprints include giants GTA 1's hand-built city
 * never had — median building long side is 20 m, the max is 197 m
 * (the slab south of Queen St). The geometry is TRUE and stays true;
 * only the roof treatment changes: a giant's roof is subdivided along
 * its principal axis (min-area bounding box) into GTA-scale segments
 * of ~15–24 m, each with its own inset roof and a subtle shade step,
 * so the slab reads as a row of attached building masses — which is
 * what these buildings (malls, strip plazas) actually are.
 *
 * Derived geometry only: computed once at load from the world model.
 * The source data file is never modified.
 */
import type { Vec2 } from '../core/geo';

/** Long side (m) above which a footprint is segmented. */
export const SEGMENT_LONG_M = 35;
/** Area (m²) above which even a sub-35 m squarish slab is segmented. */
export const SEGMENT_AREA_M2 = 1100;
/** Target segment length (m) along the principal axis. */
export const SEGMENT_TARGET_M = 20;

export interface RoofPiece {
  /** Sub-polygon in core metres, not explicitly closed. */
  ring: Vec2[];
  /** Vertex-average centre (for the inset roof). */
  center: Vec2;
  area: number;
  /** Lightness delta for shadeHex(): 0 = base colour untouched. */
  shade: number;
  segmented: boolean;
}

/** Deterministic per-segment shade steps (adjacent entries always differ). */
const SHADE_STEPS = [-0.05, 0.04, -0.02, 0.06, -0.04, 0.015];

export function polygonArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

function centroid(ring: Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const p of ring) {
    x += p.x;
    z += p.z;
  }
  return { x: x / ring.length, z: z / ring.length };
}

/** Monotone-chain convex hull (core x/z plane). */
function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export interface PrincipalBox {
  /** Unit vector along the long side. */
  u: Vec2;
  /** Unit vector along the short side. */
  v: Vec2;
  long: number;
  short: number;
}

/**
 * Min-area bounding box via rotating calipers over the convex hull.
 * Returns the box axes; `u` is aligned with the LONG side so segments
 * slice across the building's short dimension (like attached units in
 * a strip plaza share party walls perpendicular to the frontage).
 */
export function principalBox(ring: Vec2[]): PrincipalBox {
  const hull = convexHull(ring);
  let best: PrincipalBox & { area: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    let ex = b.x - a.x;
    let ez = b.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 1e-9) continue;
    ex /= len;
    ez /= len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of ring) {
      const pu = p.x * ex + p.z * ez;
      const pv = p.x * -ez + p.z * ex;
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (!best || area < best.area) {
      // Orient u along the longer side of this candidate box.
      const longIsU = w >= h;
      best = {
        u: longIsU ? { x: ex, z: ez } : { x: -ez, z: ex },
        v: longIsU ? { x: -ez, z: ex } : { x: ex, z: ez },
        long: Math.max(w, h),
        short: Math.min(w, h),
        area,
      };
    }
  }
  if (!best) {
    return { u: { x: 1, z: 0 }, v: { x: 0, z: 1 }, long: 0, short: 0 };
  }
  return best;
}

/** Sutherland–Hodgman clip: keep the part of `ring` with a <= dot(p,u) <= b. */
function clipBand(ring: Vec2[], u: Vec2, a: number, b: number): Vec2[] {
  const clip = (poly: Vec2[], bound: number, keepAbove: boolean): Vec2[] => {
    if (poly.length === 0) return poly;
    const out: Vec2[] = [];
    const t = (p: Vec2) => p.x * u.x + p.z * u.z;
    const inside = (p: Vec2) => (keepAbove ? t(p) >= bound - 1e-9 : t(p) <= bound + 1e-9);
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const prev = poly[(i + poly.length - 1) % poly.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn !== prevIn) {
        const tp = t(prev);
        const tc = t(cur);
        const s = (bound - tp) / (tc - tp || 1e-12);
        out.push({ x: prev.x + (cur.x - prev.x) * s, z: prev.z + (cur.z - prev.z) * s });
      }
      if (curIn) out.push(cur);
    }
    return out;
  };
  return clip(clip(ring, a, true), b, false);
}

/**
 * Split a footprint into roof pieces. Buildings at/below the GTA
 * scale thresholds come back as a single piece, ring untouched,
 * shade 0 — pixel-identical to pre-v0.22 rendering. Giants are sliced
 * into bands along their principal axis; each band is the true
 * footprint clipped to that band (true outline preserved in union).
 */
export function segmentRoof(ring: Vec2[], seed = 0): RoofPiece[] {
  const area = Math.abs(polygonArea(ring));
  const box = principalBox(ring);
  const giant = box.long > SEGMENT_LONG_M || area > SEGMENT_AREA_M2;
  if (!giant || ring.length < 3) {
    return [{ ring, center: centroid(ring), area, shade: 0, segmented: false }];
  }
  const n = Math.max(2, Math.round(box.long / SEGMENT_TARGET_M));
  const t0 = Math.min(...ring.map((p) => p.x * box.u.x + p.z * box.u.z));
  const step = box.long / n;
  const pieces: RoofPiece[] = [];
  for (let k = 0; k < n; k++) {
    const sub = clipBand(ring, box.u, t0 + k * step, t0 + (k + 1) * step);
    if (sub.length < 3) continue;
    const subArea = Math.abs(polygonArea(sub));
    if (subArea < 1) continue;
    pieces.push({
      ring: sub,
      center: centroid(sub),
      area: subArea,
      shade: SHADE_STEPS[(seed + k) % SHADE_STEPS.length],
      segmented: true,
    });
  }
  if (pieces.length < 2) {
    return [{ ring, center: centroid(ring), area, shade: 0, segmented: false }];
  }
  return pieces;
}

/** Scale a #rrggbb colour's channels by (1 + delta), clamped. */
export function shadeHex(hex: string, delta: number): string {
  if (delta === 0) return hex;
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 + delta))));
  const r = ch((n >> 16) & 0xff);
  const g = ch((n >> 8) & 0xff);
  const b = ch(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
