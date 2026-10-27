/**
 * Pure-helper tests for the person sprites (v0.29): the walk-cycle
 * frame picker and the ped hair hash. The canvas drawing itself needs
 * a DOM, but the frame/timing logic — the part that can regress —
 * is pure and pinned here.
 */
import { describe, it, expect } from 'vitest';
import { walkFrame, hairFor, HAIR_COLORS } from './sprites';

describe('walkFrame — distance-driven walk cycle', () => {
  it('standing still is always the neutral stance, whatever the phase', () => {
    expect(walkFrame(0, false)).toBe(0);
    expect(walkFrame(0.37, false)).toBe(0);
    expect(walkFrame(0.99, false)).toBe(0);
  });

  it('moving cycles stride-A → passing → stride-B → passing', () => {
    expect(walkFrame(0.05, true)).toBe(1);
    expect(walkFrame(0.3, true)).toBe(2);
    expect(walkFrame(0.55, true)).toBe(3);
    expect(walkFrame(0.8, true)).toBe(2);
  });

  it('the two stride frames are opposites (feet alternate)', () => {
    // Frames 1 and 3 are the two contact poses, half a cycle apart.
    expect(walkFrame(0.05, true)).not.toBe(walkFrame(0.55, true));
  });

  it('phase wraps cleanly (negative and >1 phases behave)', () => {
    expect(walkFrame(1.05, true)).toBe(walkFrame(0.05, true));
    expect(walkFrame(-0.95, true)).toBe(walkFrame(0.05, true));
    expect(walkFrame(7.3, true)).toBe(walkFrame(0.3, true));
  });
});

describe('hairFor — deterministic ped hair', () => {
  it('always returns a palette colour', () => {
    for (const id of ['ped-0', 'ped-1', 'ped-7', 'ped-19', 'player', 'x']) {
      expect(HAIR_COLORS).toContain(hairFor(id));
    }
  });

  it('is stable per id and spreads across the palette', () => {
    expect(hairFor('ped-3')).toBe(hairFor('ped-3'));
    const seen = new Set(Array.from({ length: 20 }, (_, i) => hairFor(`ped-${i}`)));
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});
