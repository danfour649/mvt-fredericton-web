/**
 * Giant-roof segmentation tests (v0.22): a giant footprint splits into
 * GTA-scale pieces that exactly tile the true outline; a small
 * building passes through untouched.
 */
import { describe, it, expect } from 'vitest';
import downtownRaw from '../../public/data/downtown.json?raw';
import { segmentRoof, principalBox, polygonArea, shadeHex, SEGMENT_LONG_M } from './segment';
import { loadWorld } from '../core/world';
import type { Vec2 } from '../core/geo';

function rect(cx: number, cz: number, w: number, h: number, rotDeg = 0): Vec2[] {
  const r = (rotDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    { x: -w / 2, z: -h / 2 },
    { x: w / 2, z: -h / 2 },
    { x: w / 2, z: h / 2 },
    { x: -w / 2, z: h / 2 },
  ].map((p) => ({ x: cx + p.x * c - p.z * s, z: cz + p.x * s + p.z * c }));
}

describe('segmentRoof', () => {
  it('splits a 100 m slab into ~20 m segments that tile the outline', () => {
    const ring = rect(0, 0, 100, 20);
    const pieces = segmentRoof(ring, 0);
    expect(pieces.length).toBe(5);
    expect(pieces.every((p) => p.segmented)).toBe(true);
    const total = pieces.reduce((acc, p) => acc + p.area, 0);
    expect(Math.abs(total - Math.abs(polygonArea(ring)))).toBeLessThan(0.5);
    // Every piece vertex stays inside the true outline (the rect).
    for (const p of pieces) {
      for (const v of p.ring) {
        expect(Math.abs(v.x)).toBeLessThanOrEqual(50 + 1e-6);
        expect(Math.abs(v.z)).toBeLessThanOrEqual(10 + 1e-6);
      }
      // Segment length along the long axis is in the GTA band.
      const box = principalBox(p.ring);
      expect(box.long).toBeGreaterThanOrEqual(14);
      expect(box.long).toBeLessThanOrEqual(26);
    }
    // Adjacent segments get different shades.
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i].shade).not.toBe(pieces[i - 1].shade);
    }
  });

  it('leaves a small building completely unchanged', () => {
    const ring = rect(5, 5, 12, 9);
    const pieces = segmentRoof(ring, 3);
    expect(pieces.length).toBe(1);
    expect(pieces[0].segmented).toBe(false);
    expect(pieces[0].ring).toBe(ring);
    expect(pieces[0].shade).toBe(0);
  });

  it('segments along the principal axis of a rotated slab', () => {
    const ring = rect(0, 0, 84, 18, 40);
    const pieces = segmentRoof(ring, 1);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    const total = pieces.reduce((acc, p) => acc + p.area, 0);
    expect(Math.abs(total - Math.abs(polygonArea(ring)))).toBeLessThan(0.5);
    // All piece vertices inside the rotated footprint: project into
    // the rect's own frame.
    const r = (40 * Math.PI) / 180;
    for (const p of pieces) {
      for (const v of p.ring) {
        const lx = v.x * Math.cos(r) + v.z * Math.sin(r);
        const lz = -v.x * Math.sin(r) + v.z * Math.cos(r);
        expect(Math.abs(lx)).toBeLessThanOrEqual(42 + 1e-6);
        expect(Math.abs(lz)).toBeLessThanOrEqual(9 + 1e-6);
      }
    }
  });

  it('catches a squarish high-area slab under the long-side threshold', () => {
    const ring = rect(0, 0, 34, 34); // long 34 < 35, area 1156 > 1100
    const box = principalBox(ring);
    expect(box.long).toBeLessThanOrEqual(SEGMENT_LONG_M);
    const pieces = segmentRoof(ring, 0);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
  });
});

describe('shadeHex', () => {
  it('is identity at 0 and shifts lightness with the delta', () => {
    expect(shadeHex('#9d7bd8', 0)).toBe('#9d7bd8');
    const up = shadeHex('#404040', 0.06);
    const down = shadeHex('#404040', -0.05);
    expect(parseInt(up.slice(1), 16)).toBeGreaterThan(0x404040);
    expect(parseInt(down.slice(1), 16)).toBeLessThan(0x404040);
  });
});

describe('real downtown dataset', () => {
  it('segments the giants and only the giants', () => {
    const doc = JSON.parse(downtownRaw);
    const world = loadWorld(doc);
    let segmentedCount = 0;
    let pieceTotal = 0;
    let maxPieces = 0;
    for (let i = 0; i < world.buildings.length; i++) {
      const pieces = segmentRoof(world.buildings[i].polygon, i);
      pieceTotal += pieces.length;
      if (pieces[0].segmented) {
        segmentedCount++;
        maxPieces = Math.max(maxPieces, pieces.length);
        // Pieces must tile the true footprint.
        const total = pieces.reduce((acc, p) => acc + p.area, 0);
        expect(Math.abs(total - Math.abs(polygonArea(world.buildings[i].polygon)))).toBeLessThan(1);
      }
    }
    console.log(
      `segmentation: ${segmentedCount}/${world.buildings.length} buildings segmented, ` +
        `${pieceTotal} roof pieces total, biggest building -> ${maxPieces} pieces`,
    );
    expect(segmentedCount).toBeGreaterThan(20);
    expect(segmentedCount).toBeLessThan(world.buildings.length * 0.5);
    expect(maxPieces).toBeGreaterThanOrEqual(8); // the ~197 m slab
  });
});
