/**
 * Shared ground/feedback geometry for both render adapters (v0.21):
 *
 * - PAVED BLOCKS (addition A): v0.20 drew buildings straight onto the
 *   flat grass-green background — downtown read as lawns with boxes.
 *   Now each road gets a pavement ribbon (asphalt + sidewalk margin)
 *   and each building an expanded pavement apron, so built-up blocks
 *   read as city; green remains only where there is genuinely open
 *   ground, and the PMTiles wetlands stay blue.
 * - SKID MARKS: rear-tyre tracks laid while a car is actually sliding
 *   (|slip| high or handbrake), fading over ~7 s.
 */
import type { Vec2 } from '../core/geo';
import type { RenderEntity } from '../core/renderer';

export const PAVEMENT_RIBBON = '#b3afa4';
export const PAVEMENT_APRON = '#a39e92';

/** Polygon offset OUT from a polyline by halfW on both sides (ribbon). */
export function ribbonPolygon(path: Vec2[], halfW: number): Vec2[] {
  const n = path.length;
  if (n < 2) return [];
  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    normals.push({ x: -dz, z: dx });
  }
  const left = path.map((p, i) => ({ x: p.x + normals[i].x * halfW, z: p.z + normals[i].z * halfW }));
  const right = path.map((p, i) => ({ x: p.x - normals[i].x * halfW, z: p.z - normals[i].z * halfW }));
  return [...left, ...right.reverse()];
}

/** Polygon pushed out from its centroid by `margin` metres per vertex. */
export function expandedPolygon(poly: Vec2[], center: Vec2, margin: number): Vec2[] {
  return poly.map((p) => {
    const dx = p.x - center.x;
    const dz = p.z - center.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: p.x + (dx / len) * margin, z: p.z + (dz / len) * margin };
  });
}

interface SkidSeg {
  a: Vec2;
  b: Vec2;
  born: number;
}

const SKID_LIFE = 7;
const SKID_MAX = 1400;

/** Rear-tyre skid marks, shared by both adapters. */
export class SkidTracks {
  private segs: SkidSeg[] = [];
  private last = new Map<string, Vec2>();

  update(entities: RenderEntity[], now: number): void {
    this.segs = this.segs.filter((s) => now - s.born < SKID_LIFE);
    const seen = new Set<string>();
    for (const e of entities) {
      if (e.kind === 'ped' || e.kind === 'player') continue;
      const sliding = (Math.abs(e.slip ?? 0) > 13 || !!e.handbrake) && (e.speedMps ?? 0) > 4;
      const fwd = { x: Math.cos(e.heading), z: Math.sin(e.heading) };
      const right = { x: -fwd.z, z: fwd.x };
      const rear = { x: e.pos.x - fwd.x * 1.42, z: e.pos.z - fwd.z * 1.42 };
      for (const side of [-1, 1] as const) {
        const wheel = { x: rear.x + right.x * 0.78 * side, z: rear.z + right.z * 0.78 * side };
        const key = `${e.id}:${side}`;
        seen.add(key);
        const prev = this.last.get(key);
        if (sliding && prev) {
          const d = Math.hypot(wheel.x - prev.x, wheel.z - prev.z);
          if (d > 0.05 && d < 4) {
            this.segs.push({ a: prev, b: { ...wheel }, born: now });
            if (this.segs.length > SKID_MAX) this.segs.splice(0, this.segs.length - SKID_MAX);
          }
        }
        this.last.set(key, wheel);
      }
    }
    for (const k of [...this.last.keys()]) {
      if (!seen.has(k)) this.last.delete(k);
    }
  }

  /** Draw with the adapter's projector; widthPx = pixels per 0.3 m tyre. */
  draw(
    ctx: CanvasRenderingContext2D,
    project: (p: Vec2) => { x: number; y: number },
    widthPx: number,
    now: number,
  ): void {
    if (this.segs.length === 0) return;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, widthPx);
    for (const s of this.segs) {
      const age = (now - s.born) / SKID_LIFE;
      ctx.strokeStyle = `rgba(28,26,24,${0.42 * (1 - age)})`;
      const a = project(s.a);
      const b = project(s.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  get count(): number {
    return this.segs.length;
  }
}
