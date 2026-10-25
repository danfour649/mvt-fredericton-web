import { describe, it, expect } from 'vitest';
import {
  ORIGIN_LAT,
  ORIGIN_LON,
  GRID_ROTATION_DEG,
  M_LAT,
  M_LON,
  project,
  unproject,
  mvtGridToLocal,
  mvtGridToLngLat,
  lngLatToMvtGrid,
} from './geo';

describe('metres per degree (osm_import.py constants at City Hall)', () => {
  it('matches the desktop values', () => {
    expect(M_LAT).toBeCloseTo(111151.74, 1);
    expect(M_LON).toBeCloseTo(77445.39, 1);
    expect(GRID_ROTATION_DEG).toBe(-35.936);
  });
});

describe('project/unproject', () => {
  it('origin projects to (0,0) and back', () => {
    const p = project(ORIGIN_LON, ORIGIN_LAT);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(0, 9);
    const ll = unproject(0, 0);
    expect(ll.lng).toBeCloseTo(ORIGIN_LON, 9);
    expect(ll.lat).toBeCloseTo(ORIGIN_LAT, 9);
  });

  it('round-trips points around Fredericton', () => {
    const spots: Array<[number, number]> = [
      [-66.6428, 45.96315], // City Hall
      [-66.6431, 45.9636], // downtown
      [-66.6285, 45.9789], // northside
      [-66.645, 45.9445], // UNB
      [-66.66, 45.96],
    ];
    for (const [lng, lat] of spots) {
      const p = project(lng, lat);
      const back = unproject(p.x, p.z);
      expect(back.lng).toBeCloseTo(lng, 9);
      expect(back.lat).toBeCloseTo(lat, 9);
    }
  });

  it('east is +X and south is +Z', () => {
    const east = project(ORIGIN_LON + 0.001, ORIGIN_LAT);
    expect(east.x).toBeGreaterThan(0);
    expect(east.z).toBeCloseTo(0, 6);
    const south = project(ORIGIN_LON, ORIGIN_LAT - 0.001);
    expect(south.z).toBeGreaterThan(0);
    expect(south.x).toBeCloseTo(0, 6);
  });
});

describe('mvtGridToLngLat (desktop grid -> real world)', () => {
  it('(0, ~27) lands on Queen St near City Hall (~45.9629, -66.6428)', () => {
    const ll = mvtGridToLngLat(0, 27);
    // Exact result of the specified formula; Queen St, ~25 m SW of City Hall.
    expect(ll.lat).toBeCloseTo(45.963, 3);
    expect(ll.lng).toBeCloseTo(-66.643, 3);
    expect(Math.abs(ll.lat - 45.9629)).toBeLessThan(0.0005);
    expect(Math.abs(ll.lng - -66.6428)).toBeLessThan(0.0005);
  });

  it('desktop spawn [0.5, 27.8] lands beside City Hall', () => {
    const ll = mvtGridToLngLat(0.5, 27.8);
    expect(ll.lat).toBeCloseTo(45.9629, 3);
    expect(ll.lng).toBeCloseTo(-66.643, 3);
  });

  it('round-trips through lngLatToMvtGrid for mission positions', () => {
    const gridPoints: Array<[number, number]> = [
      [0.5, 27.8], // spawn
      [-4, 26], // errand start
      [8.8, 28], // errand pickup
      [48, 28], // errand dropoff
      [-50, 33], // cap_wheels start
      [-58, 32], // cap_wheels drop
      [612, 49],
      [-1100, 2400],
    ];
    for (const [x, z] of gridPoints) {
      const ll = mvtGridToLngLat(x, z);
      const back = lngLatToMvtGrid(ll.lng, ll.lat);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.z).toBeCloseTo(z, 6);
    }
  });

  it('mvtGridToLocal is the rotation half of the conversion', () => {
    // Local result must equal projecting the lng/lat result.
    const local = mvtGridToLocal(48, 28);
    const ll = mvtGridToLngLat(48, 28);
    const projected = project(ll.lng, ll.lat);
    expect(local.x).toBeCloseTo(projected.x, 6);
    expect(local.z).toBeCloseTo(projected.z, 6);
  });
});
