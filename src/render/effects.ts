/**
 * v0.30 shared transient-effect + pickup drawing for BOTH renderers
 * (same deal as sprites.ts: one draw implementation, two adapters).
 * Everything arrives in world metres; the adapter supplies a
 * project() from world metres to its own screen pixels plus its
 * pixels-per-metre scale.
 */
import type { RenderEffect, RenderEntity } from '../core/renderer';
import type { Vec2 } from '../core/geo';

type Project = (p: Vec2) => { x: number; y: number };

function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Permanent explosion scorch marks: soft dark ellipses on the ground. */
export function drawScorches(
  ctx: CanvasRenderingContext2D,
  scorches: Vec2[],
  project: Project,
  ppm: number,
): void {
  for (const s of scorches) {
    const p = project(s);
    const r = 3.4 * ppm;
    const grad = ctx.createRadialGradient(p.x, p.y, r * 0.15, p.x, p.y, r);
    grad.addColorStop(0, 'rgba(12,10,10,0.55)');
    grad.addColorStop(0.7, 'rgba(12,10,10,0.32)');
    grad.addColorStop(1, 'rgba(12,10,10,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.82, hash(s.x, s.z) * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawEffects(
  ctx: CanvasRenderingContext2D,
  effects: RenderEffect[],
  project: Project,
  ppm: number,
  timeSec: number,
): void {
  for (const fx of effects) {
    const p = project(fx.pos);
    if (fx.kind === 'tracer') {
      if (!fx.to) continue;
      const t = project(fx.to);
      ctx.strokeStyle = `rgba(255,238,170,${(0.9 * (1 - fx.age01)).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.4, ppm * 0.05);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      continue;
    }
    if (fx.kind === 'muzzle') {
      const a = 1 - fx.age01;
      ctx.fillStyle = `rgba(255,214,90,${(0.9 * a).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.55 * ppm * (0.7 + 0.5 * a), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    if (fx.kind === 'splash') {
      const r = (fx.radiusM ?? 2) * ppm;
      ctx.strokeStyle = `rgba(190,225,255,${(0.75 * (1 - fx.age01)).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.5, ppm * 0.07);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * (0.35 + fx.age01 * 0.85), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(220,240,255,${(0.8 * (1 - fx.age01)).toFixed(3)})`;
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + hash(fx.pos.x, i) * 0.7;
        const d = r * (0.3 + fx.age01 * 0.9);
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d, ppm * 0.14, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    if (fx.kind === 'explosion') {
      const R = (fx.radiusM ?? 7) * ppm;
      const a = fx.age01;
      // Flash core.
      ctx.fillStyle = `rgba(255,150,40,${(0.75 * (1 - a)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 0.5 * (1 - a * 0.35), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,230,160,${(0.85 * (1 - a)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 0.26 * (1 - a * 0.3), 0, Math.PI * 2);
      ctx.fill();
      // Expanding shock ring.
      ctx.strokeStyle = `rgba(255,190,90,${(0.8 * (1 - a)).toFixed(3)})`;
      ctx.lineWidth = Math.max(2, ppm * 0.12 * (1 - a));
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * (0.3 + a * 1.05), 0, Math.PI * 2);
      ctx.stroke();
      // Smoke shoulder as it ages.
      if (a > 0.35) {
        ctx.fillStyle = `rgba(40,38,40,${(0.28 * (a - 0.35)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y - R * 0.12 * a, R * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      continue;
    }
    // fire
    const standing = fx.age01 < 0;
    const flick = standing
      ? 0.82 + 0.28 * Math.sin(timeSec * 13 + hash(fx.pos.x, fx.pos.z) * 20)
      : 1 - fx.age01 * 0.6;
    const R = (fx.radiusM ?? 1.6) * ppm * flick;
    const alpha = standing ? 0.92 : 1 - fx.age01;
    ctx.fillStyle = `rgba(232,90,20,${(0.55 * alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,160,30,${(0.75 * alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y - R * 0.18, R * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,226,140,${(0.9 * alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y - R * 0.3, R * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * A pickup: a chunky crate in the kind's colour with its glyph
 * stamped on top and a label tag underneath — readable at gameplay
 * framing (~2 m across at the 30 m on-foot camera).
 */
export function drawPickup(
  ctx: CanvasRenderingContext2D,
  e: RenderEntity,
  px: number,
  py: number,
  ppm: number,
  timeSec: number,
): void {
  const pulse = 1 + 0.05 * Math.sin(timeSec * 3.2 + px * 0.01);
  const s = 1.9 * ppm * pulse;
  // Ground shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(px, py + s * 0.42, s * 0.55, s * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // Crate.
  ctx.fillStyle = e.color;
  ctx.beginPath();
  ctx.roundRect(px - s / 2, py - s / 2, s, s, s * 0.14);
  ctx.fill();
  ctx.lineWidth = Math.max(2, ppm * 0.07);
  ctx.strokeStyle = 'rgba(10,10,14,0.85)';
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = Math.max(1.2, ppm * 0.045);
  ctx.beginPath();
  ctx.roundRect(px - s * 0.36, py - s * 0.36, s * 0.72, s * 0.72, s * 0.1);
  ctx.stroke();
  // Glyph.
  ctx.font = `${Math.round(s * 0.52)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(e.glyph ?? '?', px, py + s * 0.03);
  // Label tag.
  if (e.label) {
    ctx.font = `bold ${Math.max(9, Math.round(ppm * 0.42))}px sans-serif`;
    const w = ctx.measureText(e.label).width + 10;
    const ly = py + s * 0.62;
    ctx.fillStyle = 'rgba(10,12,16,0.78)';
    ctx.beginPath();
    ctx.roundRect(px - w / 2, ly, w, Math.max(13, ppm * 0.58), 4);
    ctx.fill();
    ctx.fillStyle = '#f5f2e8';
    ctx.fillText(e.label, px, ly + Math.max(7, ppm * 0.3));
  }
}
