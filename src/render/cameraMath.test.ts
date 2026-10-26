/**
 * Camera mapping tests (v0.23): core view-width ↔ MapLibre zoom must
 * round-trip, and the GTA-1 framing targets must land at sane zooms.
 */
import { describe, expect, it } from 'vitest';
import { zoomForViewWidth, viewWidthForZoom, pixelsPerMetre } from './cameraMath';

const LAT = 45.96315; // City Hall, Fredericton (the core origin)

describe('cameraMath', () => {
  it('round-trips view width ↔ zoom', () => {
    for (const w of [50, 76, 130]) {
      const z = zoomForViewWidth(w, 1280, LAT);
      expect(viewWidthForZoom(z, 1280, LAT)).toBeCloseTo(w, 6);
    }
  });

  it('on-foot framing (50 m across 1280 px) is a tight street-level zoom', () => {
    const z = zoomForViewWidth(50, 1280, LAT);
    expect(z).toBeGreaterThan(19.8);
    expect(z).toBeLessThan(21.2);
  });

  it('uses the 512-px-tile Mercator constant (MapLibre GL, not OSM)', () => {
    // At the equator, zoom 0: one 512-px tile spans the whole world
    // circumference → 40075016.686 / 512 ≈ 78271.5 m/px.
    expect(viewWidthForZoom(0, 512, 0)).toBeCloseTo(40075016.686, 0);
  });

  it('top-speed framing (130 m) stays at/below the on-foot zoom', () => {
    expect(zoomForViewWidth(130, 1280, LAT)).toBeLessThan(zoomForViewWidth(50, 1280, LAT));
  });

  it('portrait phones get the same metres-across, lower zoom number', () => {
    expect(zoomForViewWidth(50, 390, LAT)).toBeLessThan(zoomForViewWidth(50, 1280, LAT));
    // Same physical scale: px-per-metre at that zoom matches width/m.
    const z = zoomForViewWidth(50, 390, LAT);
    expect(pixelsPerMetre(z, LAT)).toBeCloseTo(390 / 50, 4);
  });

  it('a 4.4 m car at on-foot framing is a healthy slice of a 1280 frame', () => {
    const ppm = pixelsPerMetre(zoomForViewWidth(50, 1280, LAT), LAT);
    const carPct = ((4.4 * ppm) / 1280) * 100;
    expect(carPct).toBeGreaterThan(8);
    expect(carPct).toBeLessThan(10);
  });
});
