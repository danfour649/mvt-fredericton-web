/**
 * v0.25 audit: the full v0.21 haptics event table, asserted against a
 * navigator.vibrate stub. (In the browser rig, the tick / payphone /
 * enter-car patterns are additionally verified live — see
 * docs/AUDIT-v025.md Part A scenario s9.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Haptics } from './haptics';

describe('audit: haptics event table (v0.21 patterns)', () => {
  let calls: (number | number[])[];
  let nowMs = 1000;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal('navigator', {
      vibrate: (p: number | number[]) => {
        calls.push(p);
        return true;
      },
    });
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('every event fires its exact pattern', () => {
    const h = new Haptics(() => true);
    expect(h.supported).toBe(true);
    h.tick();
    h.enterCar();
    h.payphone();
    h.missionComplete();
    h.busted();
    h.wasted();
    expect(calls).toEqual([12, 20, [25, 40, 25], [40, 60, 40], [90, 60, 90, 60, 180], [200, 80, 200]]);
  });

  it('collision scales 15–80 ms and throttles to ≥120 ms apart', () => {
    const h = new Haptics(() => true);
    h.collision(0);
    h.collision(1); // same instant: throttled away
    expect(calls).toEqual([15]);
    nowMs += 200;
    h.collision(1);
    expect(calls).toEqual([15, 80]);
    nowMs += 200;
    h.collision(0.5);
    expect(calls).toEqual([15, 80, 48]); // 15 + 0.5×65 = 47.5 → 48
  });

  it('disabled setting silences everything; cancel still stops a pattern', () => {
    const off = new Haptics(() => false);
    off.tick();
    off.busted();
    expect(calls).toEqual([]);
    const on = new Haptics(() => true);
    on.cancel();
    expect(calls).toEqual([0]);
  });
});
