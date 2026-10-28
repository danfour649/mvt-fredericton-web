/**
 * Oblique projection tests (iteration 4): deterministic visual
 * heights, the extrusion caps (never past the footprint's own depth,
 * never past the global cap), and the north offset itself.
 */
import { describe, expect, it } from 'vitest';
import { visualHeightM, extrudeM, offsetRing, MAX_EXTRUDE_M } from './oblique';
import type { Building } from '../core/world';

function building(w: number, d: number, heightM: number): Building {
  const polygon = [
    { x: 0, z: 0 },
    { x: w, z: 0 },
    { x: w, z: d },
    { x: 0, z: d },
  ];
  return {
    polygon,
    heightM,
    center: { x: w / 2, z: d / 2 },
    minX: 0,
    maxX: w,
    minZ: 0,
    maxZ: d,
  };
}

describe('visualHeightM', () => {
  it('uses the real GeoNB height when present', () => {
    expect(visualHeightM(building(20, 15, 12))).toBe(12);
    expect(visualHeightM(building(20, 15, 28.3))).toBe(24); // clamped
  });

  it('derives a plausible mass from area when height is missing', () => {
    const shed = visualHeightM(building(4, 3, 0)); // 12 m²
    const slab = visualHeightM(building(60, 30, 0)); // 1800 m²
    expect(shed).toBeGreaterThan(3);
    expect(shed).toBeLessThan(4);
    expect(slab).toBe(9); // derived-height cap
    expect(slab).toBeGreaterThan(shed);
  });
});

describe('extrudeM', () => {
  it('scales with height at the oblique factor', () => {
    expect(extrudeM(building(30, 30, 10))).toBeCloseTo(5, 6);
  });

  it('never exceeds the global cap, however tall the building', () => {
    expect(extrudeM(building(80, 80, 24))).toBe(MAX_EXTRUDE_M);
  });

  it('never extrudes past the footprint depth (hole stays inside)', () => {
    const thin = building(40, 4, 20); // 4 m deep, nominally tall
    expect(extrudeM(thin)).toBeLessThanOrEqual(3);
    expect(extrudeM(thin)).toBeGreaterThan(0);
  });

  it('always extrudes at least a parapet lip', () => {
    expect(extrudeM(building(3, 3, 0))).toBeGreaterThanOrEqual(0.8);
  });
});

describe('offsetRing', () => {
  it('shifts north only (x untouched, z reduced)', () => {
    const out = offsetRing([{ x: 5, z: 7 }, { x: -2, z: 3 }], 4);
    expect(out).toEqual([{ x: 5, z: 3 }, { x: -2, z: -1 }]);
  });
});
