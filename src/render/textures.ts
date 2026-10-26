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
  // Dark blue-grey asphalt, GTA-dark (the refs' roads are near-slate).
  asphalt: { size: 128, tileM: 4, base: [62, 65, 75] },
  // Pale stone slabs: tile = 3 m = 2×2 slabs of 1.5 m (gta1-c).
  pavement: { size: 128, tileM: 3, base: [172, 163, 141] },
  // Roof variants: tar, dark gravel, warm gravel.
  roof1: { size: 128, tileM: 6, base: [106, 96, 86] },
  roof2: { size: 128, tileM: 6, base: [92, 88, 82] },
  roof3: { size: 128, tileM: 6, base: [114, 100, 84] },
  // Mottled dark grass — the lime is dead.
  grass: { size: 128, tileM: 8, base: [74, 102, 55] },
  water: { size: 128, tileM: 10, base: [43, 92, 118] },
};

const SEEDS: Record<TextureKind, number> = {
  asphalt: 101,
  pavement: 202,
  roof1: 303,
  roof2: 404,
  roof3: 505,
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
        if (ex < 1.5 || ey < 1.5) f *= 0.55;
        else if (ex < 3 || ey < 3) f *= 0.82; // bevel catch-light edge
      } else if (kind === 'roof1' || kind === 'roof2' || kind === 'roof3') {
        f = 1 + grain * 0.09 + (valueNoise(x, y, size, 5, seed + 1) - 0.5) * 0.14;
        // Weather staining: broad darker blotches.
        const blotch = valueNoise(x, y, size, 2, seed + 5);
        if (blotch > 0.62) f *= 0.86;
      } else if (kind === 'grass') {
        f =
          1 +
          grain * 0.08 +
          (valueNoise(x, y, size, 4, seed + 1) - 0.5) * 0.26 +
          (valueNoise(x, y, size, 11, seed + 2) - 0.5) * 0.12;
        if (valueNoise(x, y, size, 3, seed + 6) > 0.68) f *= 0.8; // worn patches
      } else {
        // water — flat-ISH by design, but still mottled, never a fill.
        f = 1 + grain * 0.1 + (valueNoise(x, y, size, 5, seed + 1) - 0.5) * 0.34;
      }
      shadePx(data, i, base, f);
    }
  }
  return { kind, size, data, tileM: spec.tileM, nominalPpm: size / spec.tileM };
}

/** Generate the full set (7 small bitmaps, once at load). */
export function generateAllTextures(): Record<TextureKind, TextureImage> {
  const kinds: TextureKind[] = ['asphalt', 'pavement', 'roof1', 'roof2', 'roof3', 'grass', 'water'];
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
