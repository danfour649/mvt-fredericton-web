/**
 * Route A renderer: MapLibre GL over the maps-of-nb data stack.
 * MapLibre draws the STATIC world; everything that moves — player,
 * cars, cops, peds, markers — is drawn from generated sprites
 * (src/render/sprites.ts) on a canvas overlay synced to the map camera
 * each frame.
 *
 * v0.23 visual rebuild (against GTA 1 reference frames):
 * - Camera framed by view WIDTH in metres (core), GTA-1 tight:
 *   zoom derived via render/cameraMath.ts.
 * - Zero flat fills: ground, pavement, roofs and asphalt carry
 *   procedural textures (render/textures.ts) as GL fill/line
 *   patterns. CAVEAT: GL patterns are screen-space, so texture
 *   features hold world scale only near the authored nominal ppm —
 *   the pavement slab grid breathes a little with zoom (the Canvas
 *   adapter holds true world scale via pattern transforms).
 * - Buildings have mass: SE drop shadows, parapet rim, textured
 *   roofs with per-piece shade steps (v0.22 segmentation) and
 *   deterministic roof clutter (render/dressing.ts).
 * - Street dressing: kerbs, yellow centre dashes, zebra crosswalks
 *   at junctions, street trees with shadows.
 * - Palette (render/palette.ts): brick/slate/concrete/tar — the
 *   candy set is gone.
 * - v0.28: the Saint John River joins the game data (core world.water,
 *   NBHN hydrography) — bold blue fill-pattern + pale bank + dark
 *   waterline, under the pavement; palette re-saturated toward the
 *   GTA 1 refs. Iteration 4: buildings are OBLIQUE boxes (shared
 *   render/oblique.ts) — roofs offset screen-north, window grids
 *   on the exposed south WALLS, grain roofs (grid = skylight glass
 *   on giant slabs only); violet asphalt with wheel-track polish
 *   bands, pale sage slab pavement, acid grass, bigger trees.
 *
 * Static sources: 'nbtiles' PMTiles (full-city context) + game
 * GeoJSON sources derived from the core world at init. This adapter
 * is the only place (besides load/convert boundaries) that talks
 * lon/lat.
 */
import * as maplibregl from 'maplibre-gl';
import type { Feature } from 'geojson';
import { Protocol, PMTiles } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { unproject, type Vec2 } from '../../core/geo';
import type { WorldModel } from '../../core/world';
import { buildRoadGraph } from '../../core/routing';
import type { Renderer, RenderFrame, RenderMarker } from '../../core/renderer';
import { carSprite, personSprite, drawSprite, drawAnchorRing, walkFrame, hairFor, PLAYER_HAIR } from '../sprites';
import { drawScorches, drawEffects, drawPickup } from '../effects';
import { SkidTracks, ribbonPolygon, expandedPolygon } from '../groundwork';
import { segmentRoof, shadeHex, polygonArea } from '../segment';
import { generateAllTextures, generateWallTexture, hexToRgb, type TextureKind, type TextureImage } from '../textures';
import { WALL_COLORS, roofVariant, GROUND_BASE, CONTEXT_BUILDING, ROAD_CASING, ROAD_KERB, ROAD_POLISH, CENTRE_LINE, WATER_BANK, WATER_EDGE, RAIL_BEAM, RAIL_POST } from '../palette';
import { shadowRing, roofClutter, crosswalkStripes, scatterTrees, TREE_FILLS } from '../dressing';
import { extrudeM, offsetRing } from '../oblique';
import { zoomForViewWidth } from '../cameraMath';

const TILES_URL = '/fredericton.pmtiles';
const LAT0 = 45.96315; // City Hall — the core frame's origin latitude

const TEX_NAMES: Record<TextureKind, string> = {
  asphalt: 'tex-asphalt',
  pavement: 'tex-pavement',
  roof1: 'tex-roof1',
  roof2: 'tex-roof2',
  roof3: 'tex-roof3',
  roofgrid: 'tex-roofgrid',
  grass: 'tex-grass',
  water: 'tex-water',
};

/** Line-width factor: world metres → screen px at zoom stops. */
function widthStops(factor: number): unknown {
  // ppm(18) ≈ 4.82, ppm(22) ≈ 77.15 at LAT0 (512-px-tile Mercator);
  // base-2 exponential interpolation = exact between the stops.
  return [
    'interpolate', ['exponential', 2], ['zoom'],
    18, ['*', ['get', 'widthM'], 4.82 * factor],
    22, ['*', ['get', 'widthM'], 77.15 * factor],
  ];
}

/** Fixed-metre line width (no widthM property involved). */
function fixedWidthStops(metres: number): unknown {
  return [
    'interpolate', ['exponential', 2], ['zoom'],
    18, metres * 4.82,
    22, metres * 77.15,
  ];
}

/** Registered GL image name for a wall colour's window-grid texture. */
function wallTexName(colorIdx: number): string {
  return `tex-wall-${colorIdx}`;
}

/**
 * Iteration 4: wheel-track polish bands (the footage's lighter
 * violet arcs). One GL line layer per band: 'line-offset' places it
 * on a lane centre (±factor × road width), the fixed ~1.7 m width
 * comes from fixedWidthStops. 2-lane roads carry their centres at
 * ±¼ width; 3+ lane roads at ±⅛ and ±⅜.
 */
function polishLayers(): any[] {
  const mk = (id: string, sign: 1 | -1, factor: number, filter: unknown): unknown => ({
    id,
    type: 'line',
    source: 'game-roads',
    filter,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROAD_POLISH,
      'line-opacity': 0.20,
      'line-width': fixedWidthStops(1.7),
      'line-offset': [
        'interpolate', ['exponential', 2], ['zoom'],
        18, ['*', ['get', 'widthM'], 4.82 * factor * sign],
        22, ['*', ['get', 'widthM'], 77.15 * factor * sign],
      ],
    },
  });
  const two = ['==', ['get', 'lanes'], 2];
  const multi = ['>=', ['get', 'lanes'], 3];
  return [
    mk('roads-polish-2a', 1, 0.25, two),
    mk('roads-polish-2b', -1, 0.25, two),
    mk('roads-polish-ma', 1, 0.125, multi),
    mk('roads-polish-mb', -1, 0.125, multi),
    mk('roads-polish-mc', 1, 0.375, multi),
    mk('roads-polish-md', -1, 0.375, multi),
  ];
}

/** Iteration 4: one fill-pattern layer per wall colour (GL patterns
 *  are layer-level, so the wall grid needs a layer per colour). */
function wallLayers(): any[] {
  return WALL_COLORS.map((_, i) => ({
    id: `walls-${i}`,
    type: 'fill',
    source: 'game-walls',
    filter: ['==', ['get', 'wall'], i],
    paint: { 'fill-pattern': wallTexName(i) },
  }));
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

/**
 * Tile a texture image `repeat`× per side for GL registration. GL
 * fill-patterns render larger than authored at this game's zooms
 * (pattern scale snaps with the tile pyramid), so ground/pavement
 * images are registered pre-shrunk 2× — features land nearer world
 * scale. The Canvas adapter doesn't need this (true world scaling).
 */
function tiledImageData(tex: TextureImage, repeat: number): { width: number; height: number; data: Uint8Array } {
  if (repeat === 1) return { width: tex.size, height: tex.size, data: new Uint8Array(tex.data) };
  const size = tex.size * repeat;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = ((y % tex.size) * tex.size + (x % tex.size)) * 4;
      const di = (y * size + x) * 4;
      data[di] = tex.data[si];
      data[di + 1] = tex.data[si + 1];
      data[di + 2] = tex.data[si + 2];
      data[di + 3] = tex.data[si + 3];
    }
  }
  return { width: size, height: size, data };
}

function polyFeature(ring: Vec2[], properties: Record<string, unknown>): Feature {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: [[...ring.map(ll), ll(ring[0])]] },
  };
}

const MARKER_STYLES: Record<RenderMarker['kind'], { bg: string; fg: string }> = {
  payphone: { bg: '#1faa55', fg: '#ffffff' },
  objective: { bg: '#f5b301', fg: '#20180a' },
  respray: { bg: '#2266cc', fg: '#ffffff' },
  exit: { bg: '#e0342b', fg: '#ffffff' },
  chopshop: { bg: '#8a5a1d', fg: '#ffffff' },
  vehicle: { bg: '#7a3ea1', fg: '#ffffff' },
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
          'game-ground': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-water': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-buildings': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-walls': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-parapets': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-rooflines': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-outlines': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-pavement': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-shadows': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-roofs': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-clutter': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-crosswalks': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-trees': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-roads': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          'game-rails': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': GROUND_BASE } },
          {
            id: 'ground-pattern', type: 'fill', source: 'game-ground',
            paint: { 'fill-pattern': TEX_NAMES.grass },
          },
          {
            // v0.28: the Saint John River (game data, NBHN) — bold flat
            // blue over the grass, under everything built. Bank = pale
            // halo line + darker waterline stroke (widthStops on the
            // features' widthM = 1).
            id: 'water-fill', type: 'fill', source: 'game-water',
            paint: { 'fill-pattern': TEX_NAMES.water },
          },
          {
            id: 'water-bank', type: 'line', source: 'game-water',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': WATER_BANK, 'line-width': widthStops(2.6) as never },
          },
          {
            id: 'water-edge', type: 'line', source: 'game-water',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': WATER_EDGE, 'line-width': widthStops(1.1) as never },
          },
          {
            id: 'ctx-wetlands', type: 'fill', source: 'nbtiles', 'source-layer': 'wetlands',
            paint: { 'fill-pattern': TEX_NAMES.water, 'fill-opacity': 0.9 },
          },
          {
            id: 'ctx-buildings', type: 'fill', source: 'nbtiles', 'source-layer': 'buildings',
            paint: { 'fill-color': CONTEXT_BUILDING, 'fill-opacity': 0.85 },
          },
          {
            id: 'ctx-roads', type: 'line', source: 'nbtiles', 'source-layer': 'roads',
            paint: { 'line-color': '#9a978c', 'line-width': 3 },
          },
          {
            id: 'pavement-aprons', type: 'fill', source: 'game-pavement',
            filter: ['==', ['get', 'kind'], 'apron'],
            paint: { 'fill-pattern': TEX_NAMES.pavement },
          },
          {
            id: 'pavement-ribbons', type: 'fill', source: 'game-pavement',
            filter: ['==', ['get', 'kind'], 'ribbon'],
            paint: { 'fill-pattern': TEX_NAMES.pavement },
          },
          {
            id: 'building-shadows', type: 'fill', source: 'game-shadows',
            paint: { 'fill-color': '#0e0e12', 'fill-opacity': 0.34 },
          },
          {
            id: 'roads-casing', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ROAD_CASING, 'line-width': widthStops(1.0) as never },
          },
          {
            id: 'roads-kerb', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ROAD_KERB, 'line-width': widthStops(0.93) as never },
          },
          {
            id: 'roads-fill', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-pattern': TEX_NAMES.asphalt, 'line-width': widthStops(0.84) as never },
          },
          // Iteration 4: wheel-track polish bands on the lane
          // centres (built by polishLayers() — one layer per band).
          ...polishLayers(),
          {
            id: 'roads-centre', type: 'line', source: 'game-roads',
            layout: { 'line-cap': 'butt', 'line-join': 'round' },
            paint: {
              'line-color': CENTRE_LINE,
              'line-opacity': 0.9,
              'line-width': ['interpolate', ['linear'], ['zoom'], 19, 1.6, 22, 4.6],
              'line-dasharray': [2.4, 2.2],
            },
          },
          {
            // Iteration 5: bridge guardrails over the road stack —
            // dark posts, light steel beam along both deck edges,
            // from the same derived geometry that collides.
            id: 'rails-posts', type: 'fill', source: 'game-rails',
            filter: ['==', ['get', 'kind'], 'post'],
            paint: { 'fill-color': RAIL_POST, 'fill-opacity': 0.95 },
          },
          {
            id: 'rails-beam', type: 'line', source: 'game-rails',
            filter: ['==', ['get', 'kind'], 'beam'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': RAIL_BEAM, 'line-width': fixedWidthStops(0.38) as never },
          },
          {
            id: 'crosswalks', type: 'fill', source: 'game-crosswalks',
            paint: { 'fill-color': '#e8e6da', 'fill-opacity': 0.5 },
          },
          {
            id: 'tree-shadows', type: 'fill', source: 'game-trees',
            filter: ['==', ['get', 'kind'], 'shadow'],
            paint: { 'fill-color': '#0e0e12', 'fill-opacity': 0.3 },
          },
          {
            id: 'tree-canopy', type: 'fill', source: 'game-trees',
            filter: ['==', ['get', 'kind'], 'canopy'],
            paint: { 'fill-color': ['get', 'fill'] as never, 'fill-opacity': 0.95 },
          },
          {
            // Iteration 4 (oblique boxes): the footprint itself is
            // the WALL's base tone — the window-grid band layers sit
            // on it, the offset parapet/roof stack above that.
            id: 'buildings-fill', type: 'fill', source: 'game-buildings',
            paint: { 'fill-color': ['get', 'fill'] as never, 'fill-opacity': 1 },
          },
          // The exposed south walls: window grid per wall colour.
          ...wallLayers(),
          {
            // Parapet pieces on the OFFSET (roof) plane.
            id: 'parapets-fill', type: 'fill', source: 'game-parapets',
            paint: { 'fill-color': ['get', 'fill'] as never, 'fill-opacity': 1 },
          },
          {
            id: 'roofs-0', type: 'fill', source: 'game-roofs',
            filter: ['==', ['get', 'var'], 0],
            paint: { 'fill-pattern': TEX_NAMES.roof1 },
          },
          {
            id: 'roofs-1', type: 'fill', source: 'game-roofs',
            filter: ['==', ['get', 'var'], 1],
            paint: { 'fill-pattern': TEX_NAMES.roof2 },
          },
          {
            id: 'roofs-2', type: 'fill', source: 'game-roofs',
            filter: ['==', ['get', 'var'], 2],
            paint: { 'fill-pattern': TEX_NAMES.roof3 },
          },
          {
            // Iteration 4: the grid texture survives on roofs only
            // as skylight glass for giant footprints (variant 3).
            id: 'roofs-3', type: 'fill', source: 'game-roofs',
            filter: ['==', ['get', 'var'], 3],
            paint: { 'fill-pattern': TEX_NAMES.roofgrid },
          },
          {
            // v0.22 segment shade steps, applied over the roof texture.
            id: 'roofs-shade', type: 'fill', source: 'game-roofs',
            filter: ['!=', ['get', 'shade'], 0],
            paint: {
              'fill-color': ['case', ['>', ['get', 'shade'], 0], '#ffffff', '#000000'] as never,
              'fill-opacity': ['abs', ['get', 'shade']] as never,
            },
          },
          {
            // Parapet rim: the inset roof's light catching edge.
            id: 'roofs-rim', type: 'line', source: 'game-roofs',
            paint: { 'line-color': 'rgba(242,236,222,0.7)', 'line-width': 1.1 },
          },
          {
            // The offset silhouette: the roofline where the roof
            // plane meets the top of the wall.
            id: 'rooflines', type: 'line', source: 'game-rooflines',
            paint: { 'line-color': 'rgba(29,23,18,0.85)', 'line-width': 1.2 },
          },
          {
            id: 'clutter', type: 'fill', source: 'game-clutter',
            paint: { 'fill-color': ['get', 'fill'] as never, 'fill-opacity': 0.95 },
          },
          {
            // Segment seams: toned outline around each piece of a
            // segmented giant (on the roof plane now); the true
            // outer outline draws over it.
            id: 'buildings-seams', type: 'line', source: 'game-parapets',
            filter: ['==', ['get', 'segmented'], 1],
            paint: { 'line-color': ['get', 'seam'] as never, 'line-width': 0.7 },
          },
          {
            id: 'buildings-outline', type: 'line', source: 'game-outlines',
            paint: { 'line-color': '#1d1712', 'line-width': 1.5 },
          },
          {
            // Labels thinned for the tight v0.23 zoom: later minzoom,
            // wider repeat spacing — streets name themselves without
            // carpeting the frame.
            id: 'roads-label', type: 'symbol', source: 'game-roads', minzoom: 19.3,
            layout: {
              'symbol-placement': 'line',
              'symbol-spacing': 480,
              'text-field': ['get', 'name'],
              'text-size': 11,
              'text-font': ['Noto Sans Regular'],
            },
            paint: { 'text-color': '#2e2a24', 'text-halo-color': 'rgba(240,236,224,0.85)', 'text-halo-width': 1.2 },
          },
        ],
      },
      center: ll({ x: 0, z: 0 }),
      zoom: 20,
      pitch: 0,
      bearing: 0,
      maxZoom: 22.5,
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
    // Register the procedural textures as GL pattern images (once).
    // Grass + pavement are pre-shrunk 2× (see tiledImageData).
    const textures = generateAllTextures();
    for (const kind of Object.keys(textures) as TextureKind[]) {
      const tex = textures[kind];
      if (!this.map.hasImage(TEX_NAMES[kind])) {
        const repeat = kind === 'grass' || kind === 'pavement' ? 2 : 1;
        this.map.addImage(TEX_NAMES[kind], tiledImageData(tex, repeat));
      }
    }

    // Ground: one big grass-textured quad over the extract + margin.
    const M = 700;
    const ground: Feature[] = [
      polyFeature(
        [
          { x: world.bounds.minX - M, z: world.bounds.minZ - M },
          { x: world.bounds.maxX + M, z: world.bounds.minZ - M },
          { x: world.bounds.maxX + M, z: world.bounds.maxZ + M },
          { x: world.bounds.minX - M, z: world.bounds.maxZ + M },
        ],
        {},
      ),
    ];

    // Water (v0.28): core rings → GeoJSON polygons (holes preserved).
    const waterFeatures: Feature[] = world.water.map((w) => ({
      type: 'Feature',
      properties: { widthM: 1 },
      geometry: {
        type: 'Polygon',
        coordinates: w.rings.map((ring) => [...ring.map(ll), ll(ring[0])]),
      },
    }));

    // Iteration 4: register the per-colour wall-grid images (the
    // grids live on the walls now — one texture per wall colour).
    WALL_COLORS.forEach((c, i) => {
      if (!this.map.hasImage(wallTexName(i))) {
        const t = generateWallTexture(hexToRgb(c));
        this.map.addImage(wallTexName(i), { width: t.size, height: t.size, data: new Uint8Array(t.data) });
      }
    });

    const buildings: Feature[] = [];
    const walls: Feature[] = [];
    const parapets: Feature[] = [];
    const rooflines: Feature[] = [];
    const outlines: Feature[] = [];
    const roofs: Feature[] = [];
    const shadows: Feature[] = [];
    const clutter: Feature[] = [];
    // Painter order within each source: north → south, so nearer
    // oblique masses overlap farther ones where their roofs reach.
    const order = world.buildings
      .map((_, i) => i)
      .sort((a, b2) => world.buildings[a].center.z - world.buildings[b2].center.z);
    for (const i of order) {
      const b = world.buildings[i];
      const colorIdx = (i * 7 + Math.floor(b.heightM)) % WALL_COLORS.length;
      const base = WALL_COLORS[colorIdx];
      const variant = roofVariant(i, b.heightM, Math.abs(polygonArea(b.polygon)));
      const ex = extrudeM(b);
      const roofRing = offsetRing(b.polygon, ex);
      outlines.push(polyFeature(b.polygon, {}));
      shadows.push(polyFeature(shadowRing(b.polygon), {}));
      rooflines.push(polyFeature(roofRing, {}));
      // The footprint: the wall's base tone.
      buildings.push(polyFeature(b.polygon, { fill: shadeHex(base, -0.08) }));
      // The wall band: footprint with the offset footprint as a
      // hole — what remains is the exposed south wall.
      walls.push({
        type: 'Feature',
        properties: { wall: colorIdx },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [...b.polygon.map(ll), ll(b.polygon[0])],
            [...roofRing.map(ll), ll(roofRing[0])],
          ],
        },
      });
      // v0.22: giant roofs segment into GTA-scale pieces (segment.ts);
      // normal buildings come back as one piece, shade 0 = unchanged.
      // Iteration 4: the pieces ride the OFFSET (roof) plane.
      for (const piece of segmentRoof(b.polygon, i)) {
        parapets.push(
          polyFeature(offsetRing(piece.ring, ex), {
            fill: shadeHex(base, piece.shade),
            seam: shadeHex(base, piece.shade - 0.22),
            segmented: piece.segmented ? 1 : 0,
          }),
        );
        // Inset "roof" per piece (parapet band = wall colour showing
        // between piece edge and roof), textured + shade-stepped.
        if (piece.area > 42) {
          const cOff = { x: piece.center.x, z: piece.center.z - ex };
          const inset = offsetRing(piece.ring, ex).map((p) => ({
            x: cOff.x + (p.x - cOff.x) * 0.84,
            z: cOff.z + (p.z - cOff.z) * 0.84,
          }));
          roofs.push(polyFeature(inset, { var: variant, shade: piece.shade }));
          // v0.23: deterministic rooftop clutter on the inset roof
          // (iteration 4: riding the roof plane with everything else).
          for (const item of roofClutter(piece, i)) {
            clutter.push(polyFeature(offsetRing(item.ring, ex), { fill: item.fill }));
          }
        }
      }
    }
    const roads: Feature[] = world.roads.map((r) => ({
      type: 'Feature',
      properties: { name: r.name, widthM: r.widthM, lanes: r.lanes },
      geometry: { type: 'LineString', coordinates: r.path.map(ll) },
    }));
    // Pavement ribbons under roads (sidewalk margin) + aprons under
    // buildings (v0.21), now slab-textured (v0.23).
    const pavement: Feature[] = [];
    for (const r of world.roads) {
      const ring = ribbonPolygon(r.path, r.widthM / 2 + 3.5);
      if (ring.length >= 3) pavement.push(polyFeature(ring, { kind: 'ribbon' }));
    }
    for (const b of world.buildings) {
      pavement.push(polyFeature(expandedPolygon(b.polygon, b.center, 2.4), { kind: 'apron' }));
    }
    // Crosswalks at junctions (v0.23, routing graph positions).
    const crosswalks: Feature[] = crosswalkStripes(buildRoadGraph(world)).map((s) => polyFeature(s, {}));
    // Bridge guardrails (iteration 5): beam lines + post squares,
    // from world.bridges — the same geometry the collision path
    // uses, so the drawn rail is the rail that holds.
    const rails: Feature[] = [];
    for (const br of world.bridges) {
      for (const line of br.railLines) {
        rails.push({
          type: 'Feature',
          properties: { kind: 'beam' },
          geometry: { type: 'LineString', coordinates: line.map(ll) },
        });
      }
      for (const p of br.posts) {
        const h = 0.19;
        rails.push(polyFeature(
          [
            { x: p.x - h, z: p.z - h }, { x: p.x + h, z: p.z - h },
            { x: p.x + h, z: p.z + h }, { x: p.x - h, z: p.z + h },
          ],
          { kind: 'post' },
        ));
      }
    }
    // Street trees + their shadows (v0.23).
    const trees: Feature[] = [];
    for (const t of scatterTrees(world)) {
      trees.push(polyFeature(t.shadow, { kind: 'shadow' }));
      trees.push(polyFeature(t.ring, { kind: 'canopy', fill: TREE_FILLS[t.variant] }));
    }

    const set = (id: string, features: Feature[]): void => {
      (this.map.getSource(id) as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features,
      });
    };
    set('game-ground', ground);
    set('game-water', waterFeatures);
    set('game-pavement', pavement);
    set('game-shadows', shadows);
    set('game-buildings', buildings);
    set('game-walls', walls);
    set('game-parapets', parapets);
    set('game-rooflines', rooflines);
    set('game-outlines', outlines);
    set('game-roofs', roofs);
    set('game-clutter', clutter);
    set('game-crosswalks', crosswalks);
    set('game-trees', trees);
    set('game-roads', roads);
    set('game-rails', rails);
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
    // Floor is 0.05, not 0.2: at the boot cinematic's space altitude
    // the true scale is ~0.15–0.25 px/m, and a 0.2 floor would draw
    // sprites up to a third too big through the descent. Gameplay
    // scales (3–13 px/m) never come near either floor.
    return Math.max(0.05, Math.hypot(b.x - a.x, b.y - a.y) / 4);
  }

  sync(frame: RenderFrame): void {
    if (!this.ready) {
      this.pending = frame;
      return;
    }
    // Camera: core view WIDTH (metres) → MapLibre zoom at this
    // viewport size (render/cameraMath.ts, unit-tested). The floor
    // is 11, not the old 17: gameplay framing never goes below
    // ~17.3 anyway, and the boot cinematic starts at "space"
    // altitude (the whole extract, ~2–4 km across, zoom ≈ 12–13)
    // — the game's own GeoJSON layers draw the city at any zoom.
    const widthPx = this.map.getCanvas().clientWidth || 1280;
    const zoom = Math.max(11, Math.min(22.4, zoomForViewWidth(frame.viewWidthM, widthPx, LAT0)));
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

    // v0.30: explosion scorch marks, under everything dynamic.
    drawScorches(ctx, frame.scorches, (p) => this.projectPx(p), this.ppmAt(frame.camera));

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
        if (e.anchor) drawAnchorRing(ctx, p.x, p.y, ppm, t);
        drawSprite(
          ctx,
          personSprite(e.color, {
            player: true,
            frame: walkFrame(e.walkPhase ?? 0, (e.speedMps ?? 0) > 0.25),
            hair: PLAYER_HAIR,
          }),
          p.x, p.y, ppm, e.heading, 13,
        );
      } else if (e.kind === 'ped') {
        drawSprite(
          ctx,
          personSprite(e.color, {
            down: e.down,
            frame: walkFrame(e.walkPhase ?? 0, (e.speedMps ?? 0) > 0.25),
            hair: hairFor(e.id),
          }),
          p.x, p.y, ppm, e.heading, 10,
        );
      } else if (e.kind === 'pickup') {
        drawPickup(ctx, e, p.x, p.y, ppm, t);
      } else if (e.kind === 'car-cop') {
        drawSprite(ctx, carSprite(e.color, { police: true, lightPhase }), p.x, p.y, ppm, e.heading);
      } else {
        drawSprite(ctx, carSprite(e.color, { wrecked: e.wrecked, reverseLights: !!e.reversing, body: e.bodyType }), p.x, p.y, ppm, e.heading);
      }
    }

    // v0.30: transient effects over the entities.
    drawEffects(ctx, frame.effects, (p) => this.projectPx(p), this.ppmAt(frame.camera), t);

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
