/**
 * Route A renderer: MapLibre GL over the maps-of-nb data stack.
 *
 * Static layers come from two sources:
 *  - 'nbtiles': the full-city PMTiles archive (public/fredericton.pmtiles,
 *    baked by maps-of-nb from GeoNB services) as faint context outside the
 *    playable downtown dataset — same pmtiles-protocol pattern as
 *    maps-of-nb/web/src/main.ts.
 *  - 'game-buildings' / 'game-roads': the downtown world, unprojected back
 *    to lon/lat from the core's local-metre model, flat vector style —
 *    dark ground, road ribbons, buildings shaded by LiDAR height.
 *    NO satellite imagery.
 *
 * Dynamic entities are one GeoJSON source rebuilt per frame from core
 * metres (cars as rotated rectangle polygons, the player as a point,
 * markers as metre-accurate circle polygons). This adapter is the only
 * place (besides load/convert boundaries) that talks lon/lat.
 */
import * as maplibregl from 'maplibre-gl';
import type { Feature } from 'geojson';
import { Protocol, PMTiles } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { unproject, type Vec2 } from '../../core/geo';
import type { WorldModel } from '../../core/world';
import type { Renderer, RenderFrame } from '../../core/renderer';

const TILES_URL = '/fredericton.pmtiles';

let protocolRegistered = false;
function ensureProtocol(): void {
  if (protocolRegistered) return;
  const proto = new Protocol();
  maplibregl.addProtocol('pmtiles', proto.tile);
  // Pre-register the archive so range requests warm up early (maps-of-nb pattern).
  proto.add(new PMTiles(TILES_URL));
  protocolRegistered = true;
}

function ll(p: Vec2): [number, number] {
  const { lng, lat } = unproject(p.x, p.z);
  return [lng, lat];
}

function rectPolygon(pos: Vec2, heading: number, len: number, wid: number): [number, number][] {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const corners: Vec2[] = [
    { x: len / 2, z: -wid / 2 },
    { x: len / 2, z: wid / 2 },
    { x: -len / 2, z: wid / 2 },
    { x: -len / 2, z: -wid / 2 },
  ].map((o) => ({ x: pos.x + o.x * c - o.z * s, z: pos.z + o.x * s + o.z * c }));
  const ring = corners.map(ll);
  ring.push(ring[0]);
  return ring;
}

function circlePolygon(pos: Vec2, radius: number, steps = 28): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push(ll({ x: pos.x + Math.cos(a) * radius, z: pos.z + Math.sin(a) * radius }));
  }
  return ring;
}

export class MapLibreRenderer implements Renderer {
  readonly name = 'maplibre';
  private map: maplibregl.Map;
  private ready = false;
  private pending: RenderFrame | null = null;

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
          'game-roads': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          entities: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } },
          {
            id: 'ctx-buildings', type: 'fill', source: 'nbtiles', 'source-layer': 'buildings',
            paint: { 'fill-color': '#161d29', 'fill-opacity': 0.9 },
          },
          {
            id: 'ctx-roads', type: 'line', source: 'nbtiles', 'source-layer': 'roads',
            paint: { 'line-color': '#1e2735', 'line-width': 3 },
          },
          {
            id: 'roads-casing', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#05070a',
              'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 15, ['*', ['get', 'widthM'], 0.9], 19, ['*', ['get', 'widthM'], 3.4]],
            },
          },
          {
            id: 'roads-fill', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#39435c',
              'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 15, ['*', ['get', 'widthM'], 0.72], 19, ['*', ['get', 'widthM'], 2.8]],
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
            paint: { 'text-color': '#8fa3bf', 'text-halo-color': 'rgba(8,10,14,0.9)', 'text-halo-width': 1.2 },
          },
          {
            id: 'buildings-fill', type: 'fill', source: 'game-buildings',
            paint: {
              'fill-color': [
                'interpolate', ['linear'], ['get', 'heightM'],
                0, '#2b3a55', 8, '#4d5f83', 18, '#7d6a4f', 30, '#8a5638',
              ],
              'fill-opacity': 0.95,
            },
          },
          {
            id: 'buildings-outline', type: 'line', source: 'game-buildings',
            paint: { 'line-color': '#0a0d12', 'line-width': 0.7 },
          },
          {
            id: 'marker-fill', type: 'fill', source: 'entities',
            filter: ['==', ['get', 'role'], 'marker'],
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3 },
          },
          {
            id: 'marker-line', type: 'line', source: 'entities',
            filter: ['==', ['get', 'role'], 'marker'],
            paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
          },
          {
            id: 'car-fill', type: 'fill', source: 'entities',
            filter: ['==', ['get', 'role'], 'car'],
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1 },
          },
          {
            id: 'car-outline', type: 'line', source: 'entities',
            filter: ['==', ['get', 'role'], 'car'],
            paint: { 'line-color': '#05070a', 'line-width': 1 },
          },
          {
            id: 'player-dot', type: 'circle', source: 'entities',
            filter: ['==', ['get', 'role'], 'player'],
            paint: {
              'circle-radius': 7,
              'circle-color': ['get', 'color'],
              'circle-stroke-color': '#0a0d12',
              'circle-stroke-width': 2,
            },
          },
        ],
      },
      center: ll({ x: 0, z: 0 }),
      zoom: 17,
      pitch: 0,
      bearing: 0,
      attributionControl: { compact: true },
      interactive: false, // the game owns the camera
    });
  }

  async init(world: WorldModel): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.map.loaded()) resolve();
      else this.map.on('load', () => resolve());
    });
    const buildings: Feature[] = world.buildings.map((b) => ({
      type: 'Feature',
      properties: { heightM: Math.round(b.heightM * 10) / 10 },
      geometry: {
        type: 'Polygon',
        coordinates: [[...b.polygon.map(ll), ll(b.polygon[0])]],
      },
    }));
    const roads: Feature[] = world.roads.map((r) => ({
      type: 'Feature',
      properties: { name: r.name, widthM: r.widthM },
      geometry: { type: 'LineString', coordinates: r.path.map(ll) },
    }));
    (this.map.getSource('game-buildings') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection', features: buildings,
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

  sync(frame: RenderFrame): void {
    if (!this.ready) {
      this.pending = frame;
      return;
    }
    const features: Feature[] = [];
    for (const m of frame.markers) {
      features.push({
        type: 'Feature',
        properties: { role: 'marker', color: m.kind === 'objective' ? '#ffd23f' : '#3fd68f' },
        geometry: { type: 'Polygon', coordinates: [circlePolygon(m.pos, m.radius)] },
      });
    }
    for (const e of frame.entities) {
      if (e.kind === 'player') {
        features.push({
          type: 'Feature',
          properties: { role: 'player', color: e.color },
          geometry: { type: 'Point', coordinates: ll(e.pos) },
        });
      } else {
        features.push({
          type: 'Feature',
          properties: { role: 'car', color: e.color },
          geometry: { type: 'Polygon', coordinates: [rectPolygon(e.pos, e.heading, 4.4, 1.9)] },
        });
      }
    }
    (this.map.getSource('entities') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection', features,
    });
    // Translate "metres across the viewport height" to a MapLibre zoom.
    const heightPx = this.map.getCanvas().clientHeight || 800;
    const mPerPx = frame.viewHeightM / heightPx;
    const mPerPxAtZ0 = 156543.03392 * Math.cos((45.96315 * Math.PI) / 180);
    const zoom = Math.max(13, Math.min(19.5, Math.log2(mPerPxAtZ0 / mPerPx)));
    const center = ll(frame.camera);
    const cur = this.map.getCenter();
    if (Math.abs(cur.lng - center[0]) > 1e-7 || Math.abs(cur.lat - center[1]) > 1e-7 || Math.abs(this.map.getZoom() - zoom) > 0.01) {
      this.map.jumpTo({ center, zoom });
    }
  }

  dispose(): void {
    this.map.remove();
  }
}
