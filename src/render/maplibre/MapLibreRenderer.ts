/**
 * Route A renderer: MapLibre GL over the maps-of-nb data stack — but in
 * v0.20 MapLibre only draws the STATIC world (bright GTA-1 palette:
 * green ground, light asphalt with dark casing and centre dashes,
 * saturated buildings with dark outlines and inset roofs). Everything
 * that moves — player, cars, cops, peds, markers — is drawn from
 * generated sprites (src/render/sprites.ts) on a canvas overlay synced
 * to the map camera each frame.
 *
 * Why: the v0 approach (GeoJSON circle for the player, metre-radius
 * polygon rings for markers, one rebuilt GeoJSON source per frame) is
 * literally what made the game "a dot with a ring around it and a
 * massive overlay". Sprites give exact metre sizing, real car/person
 * shapes with rotation, and screen-pixel markers; the overlay is one
 * 2D canvas redraw per frame, no GeoJSON churn.
 *
 * Static sources: 'nbtiles' PMTiles (full-city context, maps-of-nb
 * pattern) + 'game-buildings'/'game-roofs'/'game-roads' from the core
 * world unprojected back to lon/lat. This adapter is the only place
 * (besides load/convert boundaries) that talks lon/lat.
 */
import * as maplibregl from 'maplibre-gl';
import type { Feature } from 'geojson';
import { Protocol, PMTiles } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { unproject, type Vec2 } from '../../core/geo';
import type { WorldModel } from '../../core/world';
import type { Renderer, RenderFrame, RenderMarker } from '../../core/renderer';
import { carSprite, personSprite, drawSprite } from '../sprites';
import { SkidTracks, ribbonPolygon, expandedPolygon } from '../groundwork';

const TILES_URL = '/fredericton.pmtiles';

const BUILDING_COLORS = ['#e07a5f', '#f2cc8f', '#81b29a', '#e8c547', '#db5461', '#7fa6d9', '#c97b4a', '#9d7bd8'];
const ROOF_COLORS = ['#eda88f', '#f7ddad', '#a5cbb6', '#f2d673', '#e87f89', '#a7c2e6', '#da9c6d', '#bda3e6'];

function colorMatch(prop: string, palette: string[]): unknown[] {
  const expr: unknown[] = ['match', ['get', prop]];
  palette.forEach((c, i) => expr.push(i, c));
  expr.push('#cccccc');
  return expr;
}

let protocolRegistered = false;
function ensureProtocol(): void {
  if (protocolRegistered) return;
  const proto = new Protocol();
  maplibregl.addProtocol('pmtiles', proto.tile);
  proto.add(new PMTiles(TILES_URL));
  protocolRegistered = true;
}

function ll(p: Vec2): [number, number] {
  const { lng, lat } = unproject(p.x, p.z);
  return [lng, lat];
}

const MARKER_STYLES: Record<RenderMarker['kind'], { bg: string; fg: string }> = {
  payphone: { bg: '#1faa55', fg: '#ffffff' },
  objective: { bg: '#f5b301', fg: '#20180a' },
  respray: { bg: '#2266cc', fg: '#ffffff' },
  exit: { bg: '#e0342b', fg: '#ffffff' },
};

export class MapLibreRenderer implements Renderer {
  readonly name = 'maplibre';
  private map: maplibregl.Map;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ready = false;
  private pending: RenderFrame | null = null;
  private skids = new SkidTracks();

  constructor(container: HTMLElement) {
    ensureProtocol();
    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          nbtiles: { type: 'vector', url: 'pmtiles://' + TILES_URL },
          'game-buildings': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-pavement': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-roofs': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-roads': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#79b657' } },
          {
            id: 'ctx-wetlands', type: 'fill', source: 'nbtiles', 'source-layer': 'wetlands',
            paint: { 'fill-color': '#4fb3d9', 'fill-opacity': 0.75 },
          },
          {
            id: 'ctx-buildings', type: 'fill', source: 'nbtiles', 'source-layer': 'buildings',
            paint: { 'fill-color': '#a8a49a', 'fill-opacity': 0.85 },
          },
          {
            id: 'ctx-roads', type: 'line', source: 'nbtiles', 'source-layer': 'roads',
            paint: { 'line-color': '#b9bcb4', 'line-width': 3 },
          },
          {
            id: 'pavement-aprons', type: 'fill', source: 'game-pavement',
            filter: ['==', ['get', 'kind'], 'apron'],
            paint: { 'fill-color': '#a39e92', 'fill-opacity': 1 },
          },
          {
            id: 'pavement-ribbons', type: 'fill', source: 'game-pavement',
            filter: ['==', ['get', 'kind'], 'ribbon'],
            paint: { 'fill-color': '#b3afa4', 'fill-opacity': 1 },
          },
          {
            id: 'roads-casing', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#676c70',
              'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 15, ['*', ['get', 'widthM'], 0.95], 19, ['*', ['get', 'widthM'], 3.6]],
            },
          },
          {
            id: 'roads-fill', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#ccd0d4',
              'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 15, ['*', ['get', 'widthM'], 0.78], 19, ['*', ['get', 'widthM'], 3.0]],
            },
          },
          {
            id: 'roads-centre', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: {
              'line-color': '#ffffff',
              'line-opacity': 0.5,
              'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.7, 19, 2],
              'line-dasharray': [2, 3],
            },
          },
          {
            id: 'roads-label', type: 'symbol', source: 'game-roads', minzoom: 16,
            layout: {
              'symbol-placement': 'line',
              'text-field': ['get', 'name'],
              'text-size': 10,
              'text-font': ['Noto Sans Regular'],
            },
            paint: { 'text-color': '#3c4147', 'text-halo-color': 'rgba(255,255,255,0.85)', 'text-halo-width': 1.2 },
          },
          {
            id: 'buildings-fill', type: 'fill', source: 'game-buildings',
            paint: { 'fill-color': colorMatch('colorIdx', BUILDING_COLORS) as never, 'fill-opacity': 1 },
          },
          {
            id: 'roofs-fill', type: 'fill', source: 'game-roofs',
            paint: { 'fill-color': colorMatch('colorIdx', ROOF_COLORS) as never, 'fill-opacity': 1 },
          },
          {
            id: 'buildings-outline', type: 'line', source: 'game-buildings',
            paint: { 'line-color': '#38302c', 'line-width': 0.9 },
          },
        ],
      },
      center: ll({ x: 0, z: 0 }),
      zoom: 17,
      pitch: 0,
      bearing: 0,
      // No MapLibre attribution widget: the game's corner credit line
      // carries the GeoNB/OSM attribution (the widget also collided
      // with the help line in screenshots).
      attributionControl: false,
      interactive: false, // the game owns the camera
    });
    // Sprite overlay, pinned over the map canvas.
    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    this.map.getCanvasContainer().appendChild(this.overlay);
    const ctx = this.overlay.getContext('2d');
    if (!ctx) throw new Error('overlay 2d context unavailable');
    this.ctx = ctx;
  }

  async init(world: WorldModel): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.map.loaded()) resolve();
      else this.map.on('load', () => resolve());
    });
    const buildings: Feature[] = [];
    const roofs: Feature[] = [];
    world.buildings.forEach((b, i) => {
      const colorIdx = (i * 7 + Math.floor(b.heightM)) % BUILDING_COLORS.length;
      buildings.push({
        type: 'Feature',
        properties: { colorIdx },
        geometry: { type: 'Polygon', coordinates: [[...b.polygon.map(ll), ll(b.polygon[0])]] },
      });
      // Inset "roof": polygon shrunk toward its centroid — fakes height.
      const area = Math.abs(b.polygon.reduce((acc, p, j) => {
        const q = b.polygon[(j + 1) % b.polygon.length];
        return acc + (p.x * q.z - q.x * p.z);
      }, 0)) / 2;
      if (area > 42) {
        const inset = b.polygon.map((p) => ({
          x: b.center.x + (p.x - b.center.x) * 0.84,
          z: b.center.z + (p.z - b.center.z) * 0.84,
        }));
        roofs.push({
          type: 'Feature',
          properties: { colorIdx },
          geometry: { type: 'Polygon', coordinates: [[...inset.map(ll), ll(inset[0])]] },
        });
      }
    });
    const roads: Feature[] = world.roads.map((r) => ({
      type: 'Feature',
      properties: { name: r.name, widthM: r.widthM },
      geometry: { type: 'LineString', coordinates: r.path.map(ll) },
    }));
    // v0.21 paved blocks: pavement ribbons under roads (sidewalk
    // margin) + aprons under buildings, so blocks read as city.
    const pavement: Feature[] = [];
    for (const r of world.roads) {
      const ring = ribbonPolygon(r.path, r.widthM / 2 + 3.5);
      if (ring.length >= 3) {
        pavement.push({
          type: 'Feature', properties: { kind: 'ribbon' },
          geometry: { type: 'Polygon', coordinates: [[...ring.map(ll), ll(ring[0])]] },
        });
      }
    }
    for (const b of world.buildings) {
      const ring = expandedPolygon(b.polygon, b.center, 2.4);
      pavement.push({
        type: 'Feature', properties: { kind: 'apron' },
        geometry: { type: 'Polygon', coordinates: [[...ring.map(ll), ll(ring[0])]] },
      });
    }
    (this.map.getSource('game-pavement') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection', features: pavement,
    });
    (this.map.getSource('game-buildings') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection', features: buildings,
    });
    (this.map.getSource('game-roofs') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection', features: roofs,
    });
    (this.map.getSource('game-roads') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection', features: roads,
    });
    this.ready = true;
    if (this.pending) {
      this.sync(this.pending);
      this.pending = null;
    }
  }

  private projectPx(p: Vec2): { x: number; y: number } {
    const pt = this.map.project(ll(p));
    return { x: pt.x, y: pt.y };
  }

  /** Pixels per metre at a world position (from the live projection). */
  private ppmAt(p: Vec2): number {
    const a = this.projectPx(p);
    const b = this.projectPx({ x: p.x + 4, z: p.z });
    return Math.max(0.2, Math.hypot(b.x - a.x, b.y - a.y) / 4);
  }

  sync(frame: RenderFrame): void {
    if (!this.ready) {
      this.pending = frame;
      return;
    }
    // Camera first (translation of core view height to MapLibre zoom).
    const heightPx = this.map.getCanvas().clientHeight || 800;
    const mPerPx = frame.viewHeightM / heightPx;
    const mPerPxAtZ0 = 156543.03392 * Math.cos((45.96315 * Math.PI) / 180);
    const zoom = Math.max(13, Math.min(19.8, Math.log2(mPerPxAtZ0 / mPerPx)));
    const center = ll(frame.camera);
    const cur = this.map.getCenter();
    if (Math.abs(cur.lng - center[0]) > 1e-7 || Math.abs(cur.lat - center[1]) > 1e-7 || Math.abs(this.map.getZoom() - zoom) > 0.01) {
      this.map.jumpTo({ center, zoom });
    }
    // Impact shake: transform the whole canvas container (map + the
    // sprite overlay riding inside it) so the world judders together.
    const cc = this.map.getCanvasContainer();
    if (frame.impact > 0.02) {
      const m = frame.impact * 7;
      cc.style.transform = `translate(${(Math.random() * 2 - 1) * m}px, ${(Math.random() * 2 - 1) * m}px)`;
    } else if (cc.style.transform) {
      cc.style.transform = '';
    }
    this.drawOverlay(frame);
  }

  private drawOverlay(frame: RenderFrame): void {
    const canvas = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = frame.timeSec;
    const lightPhase = (Math.floor(t * 2.6) % 2) as 0 | 1;

    // Ground trigger zones for objectives only (faint, honest radius).
    for (const m of frame.markers) {
      if (m.kind !== 'objective' && m.kind !== 'exit') continue;
      const p = this.projectPx(m.pos);
      const rPx = m.radius * this.ppmAt(m.pos);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rPx, 0, Math.PI * 2);
      ctx.fillStyle = m.kind === 'exit' ? 'rgba(224,52,43,0.13)' : 'rgba(245,179,1,0.13)';
      ctx.fill();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = m.kind === 'exit' ? 'rgba(224,52,43,0.75)' : 'rgba(245,179,1,0.75)';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Skid marks (under the cars that made them).
    this.skids.update(frame.entities, t);
    this.skids.draw(ctx, (p) => this.projectPx(p), 0.3 * this.ppmAt(frame.camera), t);

    // Entities: peds under cars, player on top.
    const ordered = [...frame.entities].sort((a, b) => {
      const rank = (k: string) => (k === 'ped' ? 0 : k === 'player' ? 2 : 1);
      return rank(a.kind) - rank(b.kind);
    });
    for (const e of ordered) {
      const p = this.projectPx(e.pos);
      if (p.x < -60 || p.y < -60 || p.x > w + 60 || p.y > h + 60) continue;
      const ppm = this.ppmAt(e.pos);
      if (e.kind === 'player') {
        drawSprite(ctx, personSprite(e.color, { player: true }), p.x, p.y, ppm, e.heading, 13);
      } else if (e.kind === 'ped') {
        drawSprite(ctx, personSprite(e.color, { down: e.down }), p.x, p.y, ppm, e.heading, 10);
      } else if (e.kind === 'car-cop') {
        drawSprite(ctx, carSprite(e.color, { police: true, lightPhase }), p.x, p.y, ppm, e.heading);
      } else {
        drawSprite(ctx, carSprite(e.color, { wrecked: e.wrecked }), p.x, p.y, ppm, e.heading);
      }
    }

    // Markers: SCREEN-pixel badges with pulse — never metre rings.
    for (const m of frame.markers) {
      const p = this.projectPx(m.pos);
      if (p.x < -40 || p.y < -40 || p.x > w + 40 || p.y > h + 40) continue;
      const style = MARKER_STYLES[m.kind];
      const bob = m.kind === 'objective' ? Math.sin(t * 5) * 2.5 : 0;
      const y = p.y - 26 + bob;
      if (m.kind === 'payphone') {
        const pulse = 15 + 5 * Math.sin(t * 4);
        ctx.beginPath();
        ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(31,170,85,${0.55 + 0.3 * Math.sin(t * 4)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // Badge.
      ctx.beginPath();
      ctx.roundRect(p.x - 11, y - 11, 22, 22, 6);
      ctx.fillStyle = style.bg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
      ctx.fillStyle = style.fg;
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.icon, p.x, y + 0.5);
      // Label.
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(m.label, p.x, y - 19);
      ctx.shadowBlur = 0;
    }
  }

  dispose(): void {
    this.overlay.remove();
    this.map.remove();
  }
}
