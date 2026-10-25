/**
 * Route C renderer (stub-plus): plain Canvas 2D, zero map libraries.
 *
 * It implements the exact same core Renderer interface as the MapLibre
 * adapter and draws the exact same core world (local metres in, pixels
 * out), which is the proof that Route C stays open: swap the adapter in
 * src/main.ts (`?renderer=canvas`) and the identical simulation runs with
 * no PMTiles, no MapLibre, no network tiles — a fully standalone build is
 * then "just" bundling downtown.json and polishing this draw.
 *
 * What it does in v0: dark ground, road ribbons, height-shaded building
 * polygons, mission markers with labels, cars as rotated rectangles, the
 * player as a dot. No labels on roads, no culling beyond a bounds check —
 * good enough to play the same game, deliberately not polished.
 */
import type { WorldModel } from '../../core/world';
import type { Renderer, RenderFrame } from '../../core/renderer';

function heightShade(heightM: number): string {
  if (heightM >= 30) return '#8a5638';
  if (heightM >= 18) return '#7d6a4f';
  if (heightM >= 8) return '#4d5f83';
  return '#2b3a55';
}

export class CanvasRenderer implements Renderer {
  readonly name = 'canvas';
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: WorldModel | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
  }

  init(world: WorldModel): void {
    this.world = world;
  }

  sync(frame: RenderFrame): void {
    if (!this.world) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = h / frame.viewHeightM; // px per metre
    const sx = (x: number) => w / 2 + (x - frame.camera.x) * scale;
    const sy = (z: number) => h / 2 + (z - frame.camera.z) * scale;
    const viewM = { x: (w / scale) / 2 + 60, z: (h / scale) / 2 + 60 };
    const near = (x: number, z: number) =>
      Math.abs(x - frame.camera.x) < viewM.x && Math.abs(z - frame.camera.z) < viewM.z;

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    // Roads.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of this.world.roads) {
      if (!near(r.path[0].x, r.path[0].z) && !near(r.path[r.path.length - 1].x, r.path[r.path.length - 1].z)) continue;
      ctx.strokeStyle = '#39435c';
      ctx.lineWidth = Math.max(1.5, r.widthM * 0.72 * scale);
      ctx.beginPath();
      r.path.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
      ctx.stroke();
    }
    // Buildings.
    for (const b of this.world.buildings) {
      if (!near(b.center.x, b.center.z)) continue;
      ctx.fillStyle = heightShade(b.heightM);
      ctx.strokeStyle = '#0a0d12';
      ctx.lineWidth = 1;
      ctx.beginPath();
      b.polygon.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Markers.
    for (const m of frame.markers) {
      ctx.strokeStyle = m.kind === 'objective' ? '#ffd23f' : '#3fd68f';
      ctx.fillStyle = m.kind === 'objective' ? 'rgba(255,210,63,0.25)' : 'rgba(63,214,143,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx(m.pos.x), sy(m.pos.z), m.radius * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e8eef7';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(m.label, sx(m.pos.x), sy(m.pos.z) - m.radius * scale - 4);
    }
    // Entities.
    for (const e of frame.entities) {
      if (e.kind === 'player') {
        ctx.fillStyle = e.color;
        ctx.strokeStyle = '#0a0d12';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx(e.pos.x), sy(e.pos.z), Math.max(3, 0.55 * scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(sx(e.pos.x), sy(e.pos.z));
        ctx.rotate(e.heading);
        ctx.fillStyle = e.color;
        ctx.strokeStyle = '#05070a';
        ctx.lineWidth = 1;
        const len = 4.4 * scale;
        const wid = 1.9 * scale;
        ctx.fillRect(-len / 2, -wid / 2, len, wid);
        ctx.strokeRect(-len / 2, -wid / 2, len, wid);
        ctx.restore();
      }
    }
  }

  dispose(): void {
    this.canvas.remove();
  }
}
