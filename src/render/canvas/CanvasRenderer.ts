/**
 * Route C renderer: plain Canvas 2D, zero map libraries.
 *
 * Implements the exact same core Renderer interface as the MapLibre
 * adapter and draws the exact same core world (local metres in, pixels
 * out) with the same bright GTA-1 palette and the same generated
 * sprites (src/render/sprites.ts), which is the proof that Route C
 * stays open: swap the adapter in src/main.ts (`?renderer=canvas`) and
 * the identical simulation runs with no PMTiles, no MapLibre, no
 * network tiles.
 */
import type { WorldModel } from '../../core/world';
import type { Renderer, RenderFrame } from '../../core/renderer';
import { carSprite, personSprite, drawSprite } from '../sprites';
import { SkidTracks, expandedPolygon, PAVEMENT_RIBBON, PAVEMENT_APRON } from '../groundwork';

const BUILDING_COLORS = ['#e07a5f', '#f2cc8f', '#81b29a', '#e8c547', '#db5461', '#7fa6d9', '#c97b4a', '#9d7bd8'];
const ROOF_COLORS = ['#eda88f', '#f7ddad', '#a5cbb6', '#f2d673', '#e87f89', '#a7c2e6', '#da9c6d', '#bda3e6'];

const MARKER_BG: Record<string, string> = {
  payphone: '#1faa55',
  objective: '#f5b301',
  respray: '#2266cc',
  exit: '#e0342b',
};

export class CanvasRenderer implements Renderer {
  readonly name = 'canvas';
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: WorldModel | null = null;
  private skids = new SkidTracks();

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
    const viewM = { x: w / scale / 2 + 60, z: h / scale / 2 + 60 };
    const near = (x: number, z: number) =>
      Math.abs(x - frame.camera.x) < viewM.x && Math.abs(z - frame.camera.z) < viewM.z;

    ctx.fillStyle = '#79b657';
    ctx.fillRect(0, 0, w, h);
    if (frame.impact > 0.02) {
      const m = frame.impact * 7;
      ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
    }

    // v0.21 paved blocks: building aprons + road pavement ribbons
    // (sidewalk margin) under the road paint, so blocks read as city.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const b of this.world.buildings) {
      if (!near(b.center.x, b.center.z)) continue;
      const ring = expandedPolygon(b.polygon, b.center, 2.4);
      ctx.beginPath();
      ring.forEach((p, j) => (j === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
      ctx.closePath();
      ctx.fillStyle = PAVEMENT_APRON;
      ctx.fill();
    }
    for (const r of this.world.roads) {
      if (!near(r.path[0].x, r.path[0].z) && !near(r.path[r.path.length - 1].x, r.path[r.path.length - 1].z)) continue;
      ctx.beginPath();
      r.path.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
      ctx.strokeStyle = PAVEMENT_RIBBON;
      ctx.lineWidth = Math.max(2, (r.widthM + 7) * scale);
      ctx.stroke();
    }

    // Roads: dark casing, light asphalt, dashed centre line.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of [0, 1, 2] as const) {
      for (const r of this.world.roads) {
        if (!near(r.path[0].x, r.path[0].z) && !near(r.path[r.path.length - 1].x, r.path[r.path.length - 1].z)) continue;
        ctx.beginPath();
        r.path.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
        if (pass === 0) {
          ctx.strokeStyle = '#676c70';
          ctx.lineWidth = Math.max(1.5, r.widthM * 0.98 * scale);
        } else if (pass === 1) {
          ctx.strokeStyle = '#ccd0d4';
          ctx.lineWidth = Math.max(1.2, r.widthM * 0.8 * scale);
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = Math.max(0.6, 0.22 * scale);
          ctx.setLineDash([2.2 * scale, 3 * scale]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Buildings + inset roofs.
    this.world.buildings.forEach((b, i) => {
      if (!near(b.center.x, b.center.z)) return;
      const idx = (i * 7 + Math.floor(b.heightM)) % BUILDING_COLORS.length;
      ctx.beginPath();
      b.polygon.forEach((p, j) => (j === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
      ctx.closePath();
      ctx.fillStyle = BUILDING_COLORS[idx];
      ctx.fill();
      ctx.strokeStyle = '#38302c';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      b.polygon.forEach((p, j) => {
        const ix = b.center.x + (p.x - b.center.x) * 0.84;
        const iz = b.center.z + (p.z - b.center.z) * 0.84;
        if (j === 0) ctx.moveTo(sx(ix), sy(iz));
        else ctx.lineTo(sx(ix), sy(iz));
      });
      ctx.closePath();
      ctx.fillStyle = ROOF_COLORS[idx];
      ctx.fill();
    });

    const t = frame.timeSec;
    const lightPhase = (Math.floor(t * 2.6) % 2) as 0 | 1;

    // Skid marks under the cars.
    this.skids.update(frame.entities, t);
    this.skids.draw(ctx, (p) => ({ x: sx(p.x), y: sy(p.z) }), 0.3 * scale, t);

    // Entities via shared sprites.
    const ordered = [...frame.entities].sort((a, b) => {
      const rank = (k: string) => (k === 'ped' ? 0 : k === 'player' ? 2 : 1);
      return rank(a.kind) - rank(b.kind);
    });
    for (const e of ordered) {
      if (!near(e.pos.x, e.pos.z)) continue;
      const px = sx(e.pos.x);
      const py = sy(e.pos.z);
      if (e.kind === 'player') drawSprite(ctx, personSprite(e.color, { player: true }), px, py, scale, e.heading, 13);
      else if (e.kind === 'ped') drawSprite(ctx, personSprite(e.color, { down: e.down }), px, py, scale, e.heading, 10);
      else if (e.kind === 'car-cop') drawSprite(ctx, carSprite(e.color, { police: true, lightPhase }), px, py, scale, e.heading);
      else drawSprite(ctx, carSprite(e.color, { wrecked: e.wrecked }), px, py, scale, e.heading);
    }

    // Markers: screen-pixel badges.
    for (const m of frame.markers) {
      if (!near(m.pos.x, m.pos.z)) continue;
      const px = sx(m.pos.x);
      const py = sy(m.pos.z);
      const y = py - 26 + (m.kind === 'objective' ? Math.sin(t * 5) * 2.5 : 0);
      if (m.kind === 'payphone') {
        ctx.beginPath();
        ctx.arc(px, py, 15 + 5 * Math.sin(t * 4), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(31,170,85,0.7)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (m.kind === 'objective' || m.kind === 'exit') {
        ctx.beginPath();
        ctx.arc(px, py, m.radius * scale, 0, Math.PI * 2);
        ctx.fillStyle = m.kind === 'exit' ? 'rgba(224,52,43,0.13)' : 'rgba(245,179,1,0.13)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.roundRect(px - 11, y - 11, 22, 22, 6);
      ctx.fillStyle = MARKER_BG[m.kind];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
      ctx.fillStyle = m.kind === 'objective' ? '#20180a' : '#ffffff';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.icon, px, y + 0.5);
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(m.label, px, y - 19);
      ctx.shadowBlur = 0;
    }
  }

  dispose(): void {
    this.canvas.remove();
  }
}
