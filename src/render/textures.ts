/**
 * Procedural ground/roof textures (v0.23) — SHARED by both adapters.
 *
 * v0.22's world was 100 % flat vector fills; GTA 1 has texture on
 * every surface (gravel roofs, slab sidewalks, grainy asphalt). This
 * module generates small tileable RGBA textures ONCE at load from a
 * seeded value-noise field — pure math, no DOM, deterministic, so it
 * is unit-testable headlessly. Adapters wrap the pixels their own way:
 *
 * - Canvas (Route C): an offscreen canvas + `CanvasPattern`, with the
 *   pattern transform scaled so features stay at true WORLD size at
 *   any zoom (see CanvasRenderer).
 * - MapLibre (Route A): `map.addImage` + `fill-pattern` /
 *   `line-pattern`. GL patterns are SCREEN-space — they cannot hold
 *   world scale across zooms — so the image resolution is chosen so
 *   the features land at world size near the middle of the game's
 *   (now very tight) zoom range. Fine grain is scale-tolerant; the
 *   pavement slab grid is the visible compromise (see README).
 *
 * `tileM` is the world size one texture tile represents; `nominalPpm`
 * is the px-per-metre the bitmap is authored at.
 */

export type TextureKind =
  | 'asphalt'
  | 'pavement'
  | 'roof1'
  | 'roof2'
  | 'roof3'
  | 'roofgrid'
  | 'grass'
  | 'water';

export interface TextureImage {
  kind: TextureKind;
  /** Square bitmap edge, px. */
  size: number;
  /** RGBA pixels, row-major. */
  data: Uint8ClampedArray;
  /** World metres covered by one tile. */
  tileM: number;
  /** Authored px-per-metre (size / tileM). */
  nominalPpm: number;
}

/** Integer lattice hash → [0,1). Deterministic across platforms. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 974634211) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Tileable value noise: lattice period `cells` across the tile, so the
 * field wraps seamlessly. Sampled in pixel space.
 */
function valueNoise(px: number, py: number, size: number, cells: number, seed: number): number {
  const gx = (px / size) * cells;
  const gy = (py / size) * cells;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = smooth(gx - x0);
  const fy = smooth(gy - y0);
  const wrap = (v: number) => ((v % cells) + cells) % cells;
  const a = hash2(wrap(x0), wrap(y0), seed);
  const b = hash2(wrap(x0 + 1), wrap(y0), seed);
  const c = hash2(wrap(x0), wrap(y0 + 1), seed);
  const d = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

type RGB = [number, number, number];

const SPECS: Record<TextureKind, { size: number; tileM: number; base: RGB }> = {
  // Iteration-4 pass (Daniel's GTA 1 gameplay footage is the spec):
  // the asphalt reads VIOLET-blue in the footage, not slate grey.
  asphalt: { size: 128, tileM: 4, base: [74, 79, 118] },
  // …pale GREENISH-grey slabs with dark grout (footage: the dominant
  // ground texture). Tile = 4 m = 2×2 slabs of 2 m.
  pavement: { size: 128, tileM: 4, base: [193, 199, 172] },
  // Roof grain variants: warm gravel, slate gravel, brown gravel.
  roof1: { size: 128, tileM: 6, base: [112, 92, 76] },
  roof2: { size: 128, tileM: 6, base: [86, 90, 98] },
  roof3: { size: 128, tileM: 6, base: [120, 98, 80] },
  // Window-grid texture — since iteration 4 this belongs on WALLS
  // (see generateWallTexture); as a roof it survives only as the
  // glass skylight mass of the very largest footprints.
  roofgrid: { size: 128, tileM: 9, base: [146, 130, 110] },
  // Bright ACID green with noise (the footage's lawns) — flipped
  // from v0.28's deep recessive green.
  grass: { size: 128, tileM: 8, base: [102, 163, 42] },
  // Bold flat GTA blue — lighter than asphalt, unmistakably water.
  water: { size: 128, tileM: 10, base: [36, 106, 176] },
};

const SEEDS: Record<TextureKind, number> = {
  asphalt: 101,
  pavement: 202,
  roof1: 303,
  roof2: 404,
  roof3: 505,
  roofgrid: 808,
  grass: 606,
  water: 707,
};

function shadePx(out: Uint8ClampedArray, i: number, base: RGB, f: number): void {
  out[i] = Math.max(0, Math.min(255, Math.round(base[0] * f)));
  out[i + 1] = Math.max(0, Math.min(255, Math.round(base[1] * f)));
  out[i + 2] = Math.max(0, Math.min(255, Math.round(base[2] * f)));
  out[i + 3] = 255;
}

/** '#rrggbb' → [r, g, b]. */
export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface WindowGridOpts {
  cellsX: number;
  cellsY: number;
  /** Pane margins inside a cell, px (cell = size / cells per axis). */
  insetX: number;
  insetTop: number;
  insetBottom: number;
  /** hash2 above this → the window is lit. */
  litAbove: number;
  /** Dark floor-slab line at each row's foot (walls only). */
  floorBand: boolean;
}

/**
 * The window grid, painted structurally: dark glass panes (some lit)
 * in a frame of `base` tone. Shared by the roofgrid texture (4×4,
 * the surviving skylight mass) and the iteration-4 WALL texture
 * (4×5 — GTA 1's grids live on the walls, per Daniel's footage).
 */
function paintWindowGrid(size: number, base: RGB, seed: number, o: WindowGridOpts): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const cellX = size / o.cellsX;
  const cellY = size / o.cellsY;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const grain = (hash2(x, y, seed) - 0.5) * 2;
      const cx = Math.floor(x / cellX);
      const cy = Math.floor(y / cellY);
      const lx = x % cellX;
      const ly = y % cellY;
      const tint = hash2(cx, cy, seed + 11);
      const lit = hash2(cx, cy, seed + 12) > o.litAbove;
      const inPane = lx >= o.insetX && lx < cellX - o.insetX && ly >= o.insetTop && ly < cellY - o.insetBottom;
      let r: number, g: number, b: number;
      if (inPane) {
        // Glass: deep blue-grey, lighter toward the pane's top edge.
        const glare = 1 + (1 - ly / cellY) * 0.25 + grain * 0.05;
        if (lit) {
          r = 208 * glare; g = 164 * glare; b = 92 * glare;
        } else {
          const t = 0.85 + tint * 0.35;
          r = 44 * t * glare; g = 62 * t * glare; b = 82 * t * glare;
        }
      } else {
        // Frame/mortar between panes, in the surface's own tone.
        const ff = (0.92 + tint * 0.14) * (1 + grain * 0.05);
        r = base[0] * ff; g = base[1] * ff; b = base[2] * ff;
        if (lx < 1.5 || ly < 1.5) { r *= 0.62; g *= 0.62; b *= 0.62; } // cell seam
        if (o.floorBand && ly >= cellY - 2) { r *= 0.66; g *= 0.66; b *= 0.66; } // floor slab
      }
      data[i] = Math.max(0, Math.min(255, Math.round(r)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[i + 3] = 255;
    }
  }
  return data;
}

/** A generated wall texture (per building colour — not a TextureKind). */
export interface WallTexture {
  size: number;
  data: Uint8ClampedArray;
  /** World metres covered by one tile (4 window bays × 5 floors). */
  tileM: number;
  nominalPpm: number;
}

/**
 * The iteration-4 wall surface for one wall colour: the window grid
 * framed in the building's own tone, so a brick building's wall is
 * brick-with-windows, a teal wall teal-with-windows (the footage's
 * facades are exactly this). One tile = 9 m wide × 9 m of wall.
 */
export function generateWallTexture(base: RGB, seed = 1717): WallTexture {
  const size = 128;
  const data = paintWindowGrid(size, base, seed, {
    cellsX: 4,
    cellsY: 5,
    insetX: 4,
    insetTop: 3,
    insetBottom: 5,
    litAbove: 0.9,
    floorBand: true,
  });
  return { size, data, tileM: 9, nominalPpm: size / 9 };
}

/** Generate one texture. Same (kind, seed) → identical bytes, always. */
export function generateTexture(kind: TextureKind, seed = SEEDS[kind]): TextureImage {
  const spec = SPECS[kind];
  const { size, base } = spec;

  if (kind === 'roofgrid') {
    // Window grid at GTA frequency: 4×4 cells per 9 m tile (2.25 m
    // pitch) — panes in a stone frame, the odd one lit. Painted by
    // the shared structural painter (walls use the same grid, 4×5).
    const data = paintWindowGrid(size, base, seed, {
      cellsX: 4,
      cellsY: 4,
      insetX: 5,
      insetTop: 4,
      insetBottom: 7,
      litAbove: 0.86,
      floorBand: false,
    });
    return { kind, size, data, tileM: spec.tileM, nominalPpm: size / spec.tileM };
  }

  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Fine per-pixel grain (high frequency, low amplitude — seams
      // at tile edges are invisible at this contrast).
      const grain = (hash2(x, y, seed) - 0.5) * 2;
      let f = 1;

      if (kind === 'asphalt') {
        f = 1 + grain * 0.07 + (valueNoise(x, y, size, 6, seed + 1) - 0.5) * 0.1;
        if (hash2(x, y, seed + 2) > 0.9965) f += 0.35; // sparse pale speckle
        if (hash2(x, y, seed + 3) < 0.002) f -= 0.3; // tar spots
      } else if (kind === 'pavement') {
        const slab = size / 2; // 1.5 m slabs
        const sx = Math.floor(x / slab);
        const sy = Math.floor(y / slab);
        const slabTint = 0.94 + hash2(sx, sy, seed + 4) * 0.12;
        f = slabTint * (1 + grain * 0.045 + (valueNoise(x, y, size, 8, seed + 1) - 0.5) * 0.07);
        // Dark grout seams on slab borders (wrap-aligned: slab = size/2).
        const ex = Math.min(x % slab, slab - 1 - (x % slab));
        const ey = Math.min(y % slab, slab - 1 - (y % slab));
        if (ex < 1.5 || ey < 1.5) f *= 0.42;
        else if (ex < 3 || ey < 3) f *= 0.78; // bevel catch-light edge
      } else if (kind === 'roof1' || kind === 'roof2' || kind === 'roof3') {
        f = 1 + grain * 0.09 + (valueNoise(x, y, size, 5, seed + 1) - 0.5) * 0.14;
        // Weather staining: broad darker blotches.
        const blotch = valueNoise(x, y, size, 2, seed + 5);
        if (blotch > 0.62) f *= 0.86;
      } else if (kind === 'grass') {
        f =
          1 +
          grain * 0.13 +
          (valueNoise(x, y, size, 4, seed + 1) - 0.5) * 0.15 +
          (valueNoise(x, y, size, 11, seed + 2) - 0.5) * 0.11;
        // Worn patches as a SMOOTH multiplier — the first cut used a
        // hard threshold and tiled into leopard spots.
        const blotch = valueNoise(x, y, size, 5, seed + 6);
        f *= 0.95 + (blotch - 0.5) * 0.14;
      } else {
        // water — BOLD flat GTA blue (v0.28): the mottling is a whisper
        // (±8 %) so the river reads as one flat mass of colour; sparse
        // glints keep it from being a literal flat fill.
        f = 1 + grain * 0.04 + (valueNoise(x, y, size, 5, seed + 1) - 0.5) * 0.12;
        if (hash2(x, y, seed + 2) > 0.997) f += 0.55; // sun glints
        if (hash2(x, y, seed + 3) < 0.002) f -= 0.22; // deep patches
      }
      shadePx(data, i, base, f);
    }
  }
  return { kind, size, data, tileM: spec.tileM, nominalPpm: size / spec.tileM };
}

/** Generate the full set (8 small bitmaps, once at load). */
export function generateAllTextures(): Record<TextureKind, TextureImage> {
  const kinds: TextureKind[] = ['asphalt', 'pavement', 'roof1', 'roof2', 'roof3', 'roofgrid', 'grass', 'water'];
  const out = {} as Record<TextureKind, TextureImage>;
  for (const k of kinds) out[k] = generateTexture(k);
  return out;
}

/** DOM wrapper: bitmap → offscreen canvas (adapters only). */
export function textureToCanvas(tex: { size: number; data: Uint8ClampedArray }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = tex.size;
  c.height = tex.size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for texture');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(tex.data), tex.size, tex.size), 0, 0);
  return c;
}
