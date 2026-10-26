import { describe, expect, it } from 'vitest';
import { shapeSteer, stickDeflection, STICK_R } from './stickMath';

describe('shapeSteer (v0.27 steer response curve)', () => {
  it('is exact at the endpoints and centre', () => {
    expect(shapeSteer(0)).toBe(0);
    expect(shapeSteer(1)).toBe(1);
    expect(shapeSteer(-1)).toBe(-1);
  });

  it('amplifies the mid-range where a thumb roll lives', () => {
    // A 24 px roll at the old R=48 gave 0.5; shaped it must beat 0.6.
    expect(shapeSteer(0.5)).toBeGreaterThan(0.6);
    expect(shapeSteer(0.5)).toBeCloseTo(0.616, 2);
    expect(shapeSteer(0.75)).toBeCloseTo(0.818, 2);
    expect(shapeSteer(-0.5)).toBeCloseTo(-shapeSteer(0.5), 10);
  });

  it('is monotonic and clamps beyond ±1', () => {
    let prev = -Infinity;
    for (let s = -1; s <= 1.001; s += 0.05) {
      const v = shapeSteer(s);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(shapeSteer(2)).toBe(1);
    expect(shapeSteer(-2)).toBe(-1);
  });
});

describe('stickDeflection (v0.27: R=32, deadzone 0.04, origin chase)', () => {
  it('a 24 px thumb-roll now commands 0.75 before shaping', () => {
    const d = stickDeflection(120, 620, 96, 620);
    expect(d.dx).toBeCloseTo(-0.75, 5);
    expect(d.dy).toBe(0);
    // …and after the merge curve the wheel sees ~0.82 of full lock.
    expect(shapeSteer(d.dx)).toBeCloseTo(-0.818, 2);
  });

  it('deadzone swallows sub-0.04 jitter but nothing at 0.05', () => {
    expect(stickDeflection(0, 0, 1, 0).dx).toBe(0); // 1/32 ≈ 0.031
    expect(stickDeflection(0, 0, 1.6, 0).dx).toBeCloseTo(0.05, 5);
  });

  it('origin chases a pointer beyond the rim, direction preserved', () => {
    const d = stickDeflection(0, 0, STICK_R * 3, 0);
    expect(Math.hypot(d.dx, d.dy)).toBeCloseTo(1, 5);
    expect(d.dx).toBeCloseTo(1, 5);
    expect(d.ox).toBeCloseTo(STICK_R * 2, 5); // origin slid 2R along +x
    // A later small move measures from the CHASED origin (2R = 64):
    // pointer 8 px left of it reads −0.25, not a fresh full deflection.
    const d2 = stickDeflection(d.ox, d.oy, STICK_R * 2 - 8, 0);
    expect(d2.dx).toBeCloseTo(-0.25, 5);
  });

  it('diagonal chase keeps the direction and unit length', () => {
    const d = stickDeflection(0, 0, 90, 90); // len ≈ 3.98 R
    expect(Math.hypot(d.dx, d.dy)).toBeCloseTo(1, 5);
    expect(d.dx).toBeCloseTo(d.dy, 5);
    expect(d.ox).toBeCloseTo(d.oy, 5);
    expect(d.ox).toBeGreaterThan(0);
  });

  it('inside the radius the origin never moves', () => {
    const d = stickDeflection(50, 60, 50 + 16, 60);
    expect(d.ox).toBe(50);
    expect(d.oy).toBe(60);
    expect(d.dx).toBeCloseTo(0.5, 5);
  });
});
