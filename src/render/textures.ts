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
  // v0.28 art pass: GTA 1 is BOLD — deep blue-grey slate roads…
  asphalt: { size: 128, tileM: 4, base: [52, 58, 72] },
  // …warm light stone slabs (tile = 3 m = 2×2 slabs of 1.5 m, gta1-c).
  pavement: { size: 128, tileM: 3, base: [188, 177, 152] },
  // Roof grain variants: warm gravel, slate gravel, brown gravel.
  roof1: { size: 128, tileM: 6, base: [112, 92, 76] },
  roof2: { size: 128, tileM: 6, base: [86, 90, 98] },
  roof3: { size: 128, tileM: 6, base: [120, 98, 80] },
  // Window-grid roof (the refs' signature — gta1-c's gridded mass).
  // Drawn structurally in generateTexture; base is the mortar tone.
  roofgrid: { size: 128, tileM: 9, base: [146, 130, 110] },
  // Deep green, recessive — the city sits ON it, not in it.
  grass: { size: 128, tileM: 8, base: [50, 82, 36] },
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

/** Generate one texture. Same (kind, seed) → identical bytes, always. */
export function generateTexture(kind: TextureKind, seed = SEEDS[kind]): TextureImage {
  const spec = SPECS[kind];
  const { size, base } = spec;
  const data = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Fine per-pixel grain (high frequency, low amplitude — seams
      // at tile edges are invisible at this contrast).
      const grain = (hash2(x, y, seed) - 0.5) * 2;
      let f = 1;

      if (kind === 'roofgrid') {
        // Window grid at GTA frequency: 4×4 cells per 9 m tile (2.25 m
        // pitch); each cell is a dark glass pane in a stone frame, with
        // a per-cell tint and the odd lit window. Written as absolute
        // RGB — this kind is structure, not a shaded base.
        const cell = size / 4;
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        const lx = x % cell;
        const ly = y % cell;
        const tint = hash2(cx, cy, seed + 11);
        const lit = hash2(cx, cy, seed + 12) > 0.86;
        const inPane = lx >= 5 && lx < cell - 5 && ly >= 4 && ly < cell - 7;
        let r: number, g: number, b: number;
        if (inPane) {
          // Glass: deep blue-grey, lighter toward the pane's top edge.
          const glare = 1 + (1 - ly / cell) * 0.25 + grain * 0.05;
          if (lit) {
            r = 208 * glare; g = 164 * glare; b = 92 * glare;
          } else {
            const t = 0.85 + tint * 0.35;
            r = 44 * t * glare; g = 62 * t * glare; b = 82 * t * glare;
          }
        } else {
          // Stone frame/mortar between panes.
          const ff = (0.92 + tint * 0.14) * (1 + grain * 0.05);
          r = base[0] * ff; g = base[1] * ff; b = base[2] * ff;
          if (lx < 1.5 || ly < 1.5) { r *= 0.62; g *= 0.62; b *= 0.62; } // cell seam
        }
        data[i] = Math.max(0, Math.min(255, Math.round(r)));
        data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
        data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
        data[i + 3] = 255;
        continue;
      }

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
export function textureToCanvas(tex: TextureImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = tex.size;
  c.height = tex.size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for texture');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(tex.data), tex.size, tex.size), 0, 0);
  return c;
}
