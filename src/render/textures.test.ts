/**
 * Procedural texture tests (v0.23): determinism (same seed → identical
 * bytes), tileability of the pavement slab grid, and "zero flat fills"
 * — every texture must actually vary, with means in the gritty range.
 */
import { describe, expect, it } from 'vitest';
import { generateTexture, generateAllTextures, type TextureKind } from './textures';

function checksum(data: Uint8ClampedArray): number {
  let h = 0;
  for (let i = 0; i < data.length; i += 7) h = (Math.imul(h ^ data[i], 2654435761) >>> 0) % 1000000007;
  return h;
}

function channelStats(data: Uint8ClampedArray): { mean: number; min: number; max: number } {
  let sum = 0;
  let min = 255;
  let max = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    sum += v;
    min = Math.min(min, v);
    max = Math.max(max, v);
    n++;
  }
  return { mean: sum / n, min, max };
}

const KINDS: TextureKind[] = ['asphalt', 'pavement', 'roof1', 'roof2', 'roof3', 'grass', 'water'];

describe('generateTexture', () => {
  it('is deterministic for every kind', () => {
    for (const k of KINDS) {
      const a = generateTexture(k);
      const b = generateTexture(k);
      expect(checksum(a.data)).toBe(checksum(b.data));
      expect(a.size).toBe(b.size);
      expect(a.tileM).toBeGreaterThan(0);
    }
  });

  it('differs between seeds', () => {
    const a = generateTexture('grass', 1);
    const b = generateTexture('grass', 2);
    expect(checksum(a.data)).not.toBe(checksum(b.data));
  });

  it('is never a flat fill (every surface has grain)', () => {
    for (const k of KINDS) {
      const { min, max } = channelStats(generateTexture(k).data);
      expect(max - min, k).toBeGreaterThan(18);
    }
  });

  it('keeps grit ranges: dark asphalt, pale pavement, mid roofs, dark grass', () => {
    expect(channelStats(generateTexture('asphalt').data).mean).toBeLessThan(85);
    expect(channelStats(generateTexture('pavement').data).mean).toBeGreaterThan(130);
    for (const k of ['roof1', 'roof2', 'roof3'] as const) {
      const m = channelStats(generateTexture(k).data).mean;
      expect(m).toBeGreaterThan(60);
      expect(m).toBeLessThan(140);
    }
    const g = channelStats(generateTexture('grass').data);
    expect(g.mean).toBeGreaterThan(45);
    expect(g.mean).toBeLessThan(110);
  });

  it('pavement slab grid tiles: seams land on both tile edges', () => {
    const t = generateTexture('pavement');
    const px = (x: number, y: number) => t.data[(y * t.size + x) * 4];
    const mid = px(32, 32); // inside a slab
    // Left edge column and the column just inside the right edge are
    // both grout seams (slab = size/2, seams wrap).
    expect(px(0, 32)).toBeLessThan(mid * 0.75);
    expect(px(t.size - 1, 32)).toBeLessThan(mid * 0.75);
    expect(px(32, 0)).toBeLessThan(mid * 0.75);
    expect(px(32, t.size - 1)).toBeLessThan(mid * 0.75);
  });

  it('roof variants are visibly distinct from each other', () => {
    const sums = (['roof1', 'roof2', 'roof3'] as const).map((k) => checksum(generateTexture(k).data));
    expect(new Set(sums).size).toBe(3);
  });

  it('generateAllTextures returns the full set', () => {
    const all = generateAllTextures();
    expect(Object.keys(all).sort()).toEqual([...KINDS].sort());
  });
});
