/**
 * Route C renderer: plain Canvas 2D, zero map libraries.
 *
 * Implements the exact same core Renderer interface as the MapLibre
 * adapter and draws the exact same core world (local metres in, pixels
 * out) with the same generated sprites (src/render/sprites.ts), which
 * is the proof that Route C stays open: swap the adapter in src/main.ts
 * (`?renderer=canvas`) and the identical simulation runs with no
 * PMTiles, no MapLibre, no network tiles.
 *
 * v0.23: same visual rebuild as Route A — GTA-1 width framing,
 * procedural textures on every surface (here the CanvasPattern
 * transform is rescaled every frame, so texture features hold TRUE
 * world size at any zoom — the one place Route C beats GL patterns),
 * building shadows/parapets/clutter, kerbs, crosswalks, trees, and
 * the shared grit palette (src/render/palette.ts).
 *
 * v0.28: the Saint John River (core world.water) drawn between the
 * grass and the pavement, bold blue with bank lines; palette
 * re-saturated, same as Route A.
 *
 * Iteration 4: buildings drawn as OBLIQUE boxes (shared
 * render/oblique.ts) — footprint = wall base, window-grid pattern
 * clipped to the exposed south wall band, parapet + grain roofs on
 * the north-offset roof plane, painter-sorted north → south;
 * violet asphalt with per-lane wheel-track polish bands, pale sage
 * slab pavement, acid grass — identical read to Route A.
 */
import type { Vec2 } from '../../core/geo';
import type { WorldModel } from '../../core/world';
import { buildRoadGraph } from '../../core/routing';
import type { Renderer, RenderFrame } from '../../core/renderer';
import { carSprite, personSprite, drawSprite, drawAnchorRing, walkFrame, hairFor, PLAYER_HAIR } from '../sprites';
import { drawScorches, drawEffects, drawPickup } from '../effects';
import { SkidTracks, expandedPolygon, offsetPath, laneCentreOffsets } from '../groundwork';
import { segmentRoof, shadeHex, polygonArea, type RoofPiece } from '../segment';
import { generateAllTextures, generateWallTexture, hexToRgb, textureToCanvas, type TextureImage, type TextureKind, type WallTexture } from '../textures';
import { WALL_COLORS, roofVariant, ROAD_CASING, ROAD_KERB, ROAD_POLISH, CENTRE_LINE, WATER_BANK, WATER_EDGE, RAIL_BEAM, RAIL_POST } from '../palette';
import { extrudeM, offsetRing } from '../oblique';
import { shadowRing, roofClutter, crosswalkStripes, scatterTrees, TREE_FILLS, type ClutterItem, type TreeSpot } from '../dressing';

const MARKER_BG: Record<string, string> = {
  payphone: '#1faa55',
  objective: '#f5b301',
  respray: '#2266cc',
  exit: '#e0342b',
  chopshop: '#8a5a1d',
  vehicle: '#7a3ea1',
};

const ROOF_KINDS: TextureKind[] = ['roof1', 'roof2', 'roof3', 'roofgrid'];

export class CanvasRenderer implements Renderer {
  readonly name = 'canvas';
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: WorldModel | null = null;
  /** v0.22 roof pieces per building, derived once at init (segment.ts). */
  private pieces: RoofPiece[][] = [];
  /** v0.23 roof clutter per building (parallel to pieces' building). */
  private clutter: ClutterItem[][] = [];
  private crosswalks: Vec2[][] = [];
  private trees: TreeSpot[] = [];
  private textures: Record<TextureKind, TextureImage> | null = null;
  private patterns = new Map<TextureKind, CanvasPattern>();
  /** Iteration 4: building indices in painter order (north → south)
   *  for the oblique boxes, and one wall-grid pattern per wall
   *  colour (the grids live on the walls now). */
  private buildingOrder: number[] = [];
  private wallTexes: WallTexture[] = [];
  private wallPatterns: CanvasPattern[] = [];
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
    this.pieces = world.buildings.map((b, i) => segmentRoof(b.polygon, i));
    this.clutter = world.buildings.map((_b, i) =>
      this.pieces[i].flatMap((piece) => (piece.area > 42 ? roofClutter(piece, i) : [])),
    );
    this.crosswalks = crosswalkStripes(buildRoadGraph(world));
    this.trees = scatterTrees(world);
    this.buildingOrder = world.buildings
      .map((_, i) => i)
      .sort((a, b2) => world.buildings[a].center.z - world.buildings[b2].center.z);
    this.textures = generateAllTextures();
    for (const kind of Object.keys(this.textures) as TextureKind[]) {
      const pat = this.ctx.createPattern(textureToCanvas(this.textures[kind]), 'repeat');
      if (pat) this.patterns.set(kind, pat);
    }
    // Wall grids, one per wall colour, framed in that colour.
    this.wallTexes = WALL_COLORS.map((c) => generateWallTexture(hexToRgb(c)));
    this.wallPatterns = this.wallTexes.map((t) => {
      const pat = this.ctx.createPattern(textureToCanvas(t), 'repeat');
      return pat as CanvasPattern;
    });
  }

  /**
   * Point a texture's pattern at true world scale for this frame:
   * the pattern matrix scales authored px → screen px at the current
   * zoom and phase-anchors tiling to the world origin, so a 2 m
   * pavement slab is 2 m at every zoom and never swims.
   */
  private aimPattern(pat: CanvasPattern, nominalPpm: number, scale: number, cam: Vec2, w: number, h: number): void {
    if (typeof pat.setTransform !== 'function') return;
    const s = scale / nominalPpm;
    const e = w / 2 - cam.x * scale;
    const f = h / 2 - cam.z * scale;
    try {
      pat.setTransform(new DOMMatrix([s, 0, 0, s, e, f]));
    } catch {
      /* older engines: unscaled pattern still renders */
    }
  }

  private pattern(kind: TextureKind, scale: number, cam: Vec2, w: number, h: number): CanvasPattern | string {
    const pat = this.patterns.get(kind);
    const tex = this.textures?.[kind];
    if (!pat || !tex) return '#888';
    this.aimPattern(pat, tex.nominalPpm, scale, cam, w, h);
    return pat;
  }

  private wallPattern(colorIdx: number, scale: number, cam: Vec2, w: number, h: number): CanvasPattern | string {
    const pat = this.wallPatterns[colorIdx];
    const tex = this.wallTexes[colorIdx];
    if (!pat || !tex) return '#888';
    this.aimPattern(pat, tex.nominalPpm, scale, cam, w, h);
    return pat;
  }

  sync(frame: RenderFrame): void {
    if (!this.world || !this.textures) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = w / frame.viewWidthM; // px per metre (v0.23: width-framed)
    const sx = (x: number) => w / 2 + (x - frame.camera.x) * scale;
    const sy = (z: number) => h / 2 + (z - frame.camera.z) * scale;
    const viewM = { x: frame.viewWidthM / 2 + 60, z: h / scale / 2 + 60 };
    const near = (x: number, z: number) =>
      Math.abs(x - frame.camera.x) < viewM.x && Math.abs(z - frame.camera.z) < viewM.z;
    const tracePath = (ring: Vec2[]): void => {
      ring.forEach((p, j) => (j === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
      ctx.closePath();
    };
    const trace = (ring: Vec2[]): void => {
      ctx.beginPath();
      tracePath(ring);
    };

    // Ground: mottled grass texture (world-scaled).
    ctx.fillStyle = this.pattern('grass', scale, frame.camera, w, h);
    ctx.fillRect(0, 0, w, h);
    if (frame.impact > 0.02) {
      const m = frame.impact * 7;
      ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
    }

    // Water (v0.28): the Saint John River — bold blue over the grass,
    // under the pavement; pale bank halo + dark waterline on every
    // ring (island shores included).
    const waterPat = this.pattern('water', scale, frame.camera, w, h);
    for (const wb of this.world.water) {
      if (wb.maxX < frame.camera.x - viewM.x || wb.minX > frame.camera.x + viewM.x ||
          wb.maxZ < frame.camera.z - viewM.z || wb.minZ > frame.camera.z + viewM.z) continue;
      ctx.beginPath();
      for (const ring of wb.rings) {
        ring.forEach((p, j) => (j === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
        ctx.closePath();
      }
      ctx.fillStyle = waterPat;
      ctx.fill('evenodd');
      ctx.lineJoin = 'round';
      ctx.strokeStyle = WATER_BANK;
      ctx.lineWidth = Math.max(1, 2.4 * scale);
      ctx.stroke();
      ctx.strokeStyle = WATER_EDGE;
      ctx.lineWidth = Math.max(0.6, 1.0 * scale);
      ctx.stroke();
    }

    // Paved blocks: building aprons + road pavement ribbons in the
    // GTA slab texture (v0.21 geometry, v0.23 surface).
    const pave = this.pattern('pavement', scale, frame.camera, w, h);
    ctx.fillStyle = pave;
    for (const b of this.world.buildings) {
      if (!near(b.center.x, b.center.z)) continue;
      trace(expandedPolygon(b.polygon, b.center, 2.4));
      ctx.fill();
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const r of this.world.roads) {
      if (!near(r.path[0].x, r.path[0].z) && !near(r.path[r.path.length - 1].x, r.path[r.path.length - 1].z)) continue;
      ctx.beginPath();
      r.path.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
      ctx.strokeStyle = pave;
      ctx.lineWidth = Math.max(2, (r.widthM + 7) * scale);
      ctx.stroke();
    }

    // Roads: dark casing, pale kerb edge lines, textured asphalt,
    // wheel-track polish bands along each lane's line of travel
    // (iteration 4 — the footage's lighter violet arcs), yellow dash.
    const asphalt = this.pattern('asphalt', scale, frame.camera, w, h);
    for (const pass of [0, 1, 2, 3, 4] as const) {
      for (const r of this.world.roads) {
        if (!near(r.path[0].x, r.path[0].z) && !near(r.path[r.path.length - 1].x, r.path[r.path.length - 1].z)) continue;
        if (pass === 3) {
          // Polish: one subtle band per lane centre, offset from the
          // centreline — through a corner the bands arc with the road.
          if (r.lanes < 2) continue;
          ctx.strokeStyle = ROAD_POLISH;
          ctx.globalAlpha = 0.20;
          ctx.lineWidth = Math.max(0.8, 1.7 * scale);
          for (const off of laneCentreOffsets(r.widthM, r.lanes)) {
            const pts = offsetPath(r.path, off);
            ctx.beginPath();
            pts.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          continue;
        }
        ctx.beginPath();
        r.path.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
        if (pass === 0) {
          ctx.strokeStyle = ROAD_CASING;
          ctx.lineWidth = Math.max(1.5, r.widthM * scale);
        } else if (pass === 1) {
          ctx.strokeStyle = ROAD_KERB;
          ctx.lineWidth = Math.max(1.3, r.widthM * 0.93 * scale);
        } else if (pass === 2) {
          ctx.strokeStyle = asphalt;
          ctx.lineWidth = Math.max(1.1, r.widthM * 0.84 * scale);
        } else {
          ctx.strokeStyle = CENTRE_LINE;
          ctx.globalAlpha = 0.9;
          ctx.lineWidth = Math.max(0.6, 0.3 * scale);
          ctx.setLineDash([2.6 * scale, 2.4 * scale]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Crosswalks at junctions.
    ctx.fillStyle = 'rgba(232,230,218,0.5)';
    for (const s of this.crosswalks) {
      const cx = s[0].x;
      const cz = s[0].z;
      if (!near(cx, cz)) continue;
      trace(s);
      ctx.fill();
    }

    // Bridge guardrails (iteration 5): a dark shadow line under a
    // light steel beam, posts standing on it every ~4 m — drawn
    // from the same derived geometry that collides (world.bridges),
    // so what you see is exactly what holds the car on the deck.
    for (const br of this.world.bridges) {
      if (
        br.maxX < frame.camera.x - viewM.x || br.minX > frame.camera.x + viewM.x ||
        br.maxZ < frame.camera.z - viewM.z || br.minZ > frame.camera.z + viewM.z
      ) continue;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const line of br.railLines) {
        ctx.beginPath();
        line.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.z)) : ctx.lineTo(sx(p.x), sy(p.z))));
        ctx.strokeStyle = RAIL_POST;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1.2, 0.55 * scale);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = RAIL_BEAM;
        ctx.lineWidth = Math.max(1, 0.34 * scale);
        ctx.stroke();
      }
      const postPx = Math.max(1.4, 0.34 * scale);
      ctx.fillStyle = RAIL_POST;
      for (const p of br.posts) {
        ctx.fillRect(sx(p.x) - postPx / 2, sy(p.z) - postPx / 2, postPx, postPx);
      }
    }

    // Trees: SE shadow blob, then canopy.
    for (const t of this.trees) {
      if (!near(t.pos.x, t.pos.z)) continue;
      trace(t.shadow);
      ctx.fillStyle = 'rgba(14,14,18,0.3)';
      ctx.fill();
      trace(t.ring);
      ctx.fillStyle = TREE_FILLS[t.variant];
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Building drop shadows (over the ground/roads they fall on).
    ctx.fillStyle = 'rgba(14,14,18,0.34)';
    for (const b of this.world.buildings) {
      if (!near(b.center.x, b.center.z)) continue;
      trace(shadowRing(b.polygon));
      ctx.fill();
    }

    // Buildings as OBLIQUE BOXES (iteration 4 — the footage's
    // signature look), painted north → south so nearer masses
    // overlap farther ones correctly:
    //  1. footprint filled with the wall tone (the wall's base);
    //  2. the WALL: window-grid pattern clipped to the band the
    //     north-offset roof leaves uncovered on the footprint's
    //     south side (footprint minus offset footprint, even-odd);
    //  3. parapet pieces ON the offset (roof) plane;
    //  4. textured inset roofs on that plane (grain now — the grid
    //     moved to the walls; skylight glass only on giant slabs);
    //  5. clutter riding the roof plane, roofline + footprint lines.
    // Collision never sees any of this — footprints are untouched.
    for (const i of this.buildingOrder) {
      const b = this.world.buildings[i];
      if (!near(b.center.x, b.center.z)) continue;
      const idx = (i * 7 + Math.floor(b.heightM)) % WALL_COLORS.length;
      const base = WALL_COLORS[idx];
      const ex = extrudeM(b);
      const roofRing = offsetRing(b.polygon, ex);
      const roofKind = ROOF_KINDS[roofVariant(i, b.heightM, Math.abs(polygonArea(b.polygon)))];
      const pieces = this.pieces[i];

      trace(b.polygon);
      ctx.fillStyle = shadeHex(base, -0.08);
      ctx.fill();

      // The wall band. A real clip (not a drawn ring): pattern fills
      // a screen rect over the building's extent, the clip keeps
      // only footprint-minus-roof — the exposed south wall.
      ctx.save();
      ctx.beginPath();
      tracePath(b.polygon);
      tracePath(roofRing);
      ctx.clip('evenodd');
      ctx.fillStyle = this.wallPattern(idx, scale, frame.camera, w, h);
      ctx.fillRect(
        sx(b.minX) - 2,
        sy(b.minZ) - 2,
        (b.maxX - b.minX) * scale + 4,
        (b.maxZ - b.minZ) * scale + 4,
      );
      ctx.restore();

      const roofPieces = pieces.map((piece) => ({
        piece,
        ring: offsetRing(piece.ring, ex),
        center: { x: piece.center.x, z: piece.center.z - ex },
      }));
      for (const rp of roofPieces) {
        trace(rp.ring);
        ctx.fillStyle = shadeHex(base, rp.piece.shade);
        ctx.fill();
        if (rp.piece.segmented) {
          ctx.strokeStyle = shadeHex(base, rp.piece.shade - 0.22);
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      for (const rp of roofPieces) {
        if (rp.piece.area <= 42) continue;
        const inset = rp.ring.map((p) => ({
          x: rp.center.x + (p.x - rp.center.x) * 0.84,
          z: rp.center.z + (p.z - rp.center.z) * 0.84,
        }));
        trace(inset);
        ctx.fillStyle = this.pattern(roofKind, scale, frame.camera, w, h);
        ctx.fill();
        if (rp.piece.shade !== 0) {
          ctx.fillStyle =
            rp.piece.shade > 0 ? `rgba(255,255,255,${rp.piece.shade})` : `rgba(0,0,0,${-rp.piece.shade})`;
          ctx.fill();
        }
        ctx.strokeStyle = 'rgba(242,236,222,0.7)';
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
      ctx.fillStyle = '#000'; // reset before clutter fills set their own
      for (const item of this.clutter[i]) {
        trace(offsetRing(item.ring, ex));
        ctx.fillStyle = item.fill;
        ctx.globalAlpha = 0.95;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Roofline (the offset silhouette) + the true footprint line.
      trace(roofRing);
      ctx.strokeStyle = 'rgba(29,23,18,0.85)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      trace(b.polygon);
      ctx.strokeStyle = '#1d1712';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    const t = frame.timeSec;
    const lightPhase = (Math.floor(t * 2.6) % 2) as 0 | 1;

    // v0.30: explosion scorch marks, under everything dynamic.
    drawScorches(ctx, frame.scorches, (p) => ({ x: sx(p.x), y: sy(p.z) }), scale);

    // Skid marks under the cars.
    this.skids.update(frame.entities, t);
    this.skids.draw(ctx, (p) => ({ x: sx(p.x), y: sy(p.z) }), 0.3 * scale, t);

    // Entities via shared sprites (with v0.23 drop shadows).
    const ordered = [...frame.entities].sort((a, b) => {
      const rank = (k: string) => (k === 'ped' ? 0 : k === 'player' ? 2 : 1);
      return rank(a.kind) - rank(b.kind);
    });
    for (const e of ordered) {
      if (!near(e.pos.x, e.pos.z)) continue;
      const px = sx(e.pos.x);
      const py = sy(e.pos.z);
      if (e.kind === 'player') {
        if (e.anchor) drawAnchorRing(ctx, px, py, scale, t);
        drawSprite(
          ctx,
          personSprite(e.color, {
            player: true,
            frame: walkFrame(e.walkPhase ?? 0, (e.speedMps ?? 0) > 0.25),
            hair: PLAYER_HAIR,
          }),
          px, py, scale, e.heading, 13,
        );
      }
      else if (e.kind === 'ped') {
        drawSprite(
          ctx,
          personSprite(e.color, {
            down: e.down,
            frame: walkFrame(e.walkPhase ?? 0, (e.speedMps ?? 0) > 0.25),
            hair: hairFor(e.id),
          }),
          px, py, scale, e.heading, 10,
        );
      }
      else if (e.kind === 'pickup') drawPickup(ctx, e, px, py, scale, t);
      else if (e.kind === 'car-cop') drawSprite(ctx, carSprite(e.color, { police: true, lightPhase }), px, py, scale, e.heading);
      else drawSprite(ctx, carSprite(e.color, { wrecked: e.wrecked, reverseLights: !!e.reversing, body: e.bodyType }), px, py, scale, e.heading);
    }

    // v0.30: transient effects over the entities.
    drawEffects(ctx, frame.effects, (p) => ({ x: sx(p.x), y: sy(p.z) }), scale, t);

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
