import { describe, it, expect } from 'vitest';
import { loadWorld, collideBuildings, pointInPolygon } from './world';
import { project, unproject } from './geo';

function squareFeature(cx: number, cz: number, half: number, heightM = 9) {
  // Build a GeoJSON polygon from core-metre corners via unproject.
  const corners: Array<[number, number]> = [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
    [cx - half, cz - half],
  ].map(([x, z]) => {
    const ll = unproject(x, z);
    return [ll.lng, ll.lat] as [number, number];
  });
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [corners] },
    properties: { min_g_elev: 10, max_b_elev: 10 + heightM },
  };
}

describe('loadWorld', () => {
  it('projects buildings to local metres and derives heightM', () => {
    const world = loadWorld({
      buildings: { features: [squareFeature(100, 50, 10, 12)] },
      roads: {
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                (() => { const l = unproject(0, 0); return [l.lng, l.lat]; })(),
                (() => { const l = unproject(100, 0); return [l.lng, l.lat]; })(),
              ],
            },
            properties: {
              Number_Of_Lanes: 2,
              Formatted_Street_Name: 'QUEEN Street',
              Speed_Restrictions_Both: 50,
              Dir_of_Traffic_Flow: 'Same Direction',
            },
          },
        ],
      },
    });
    expect(world.buildings).toHaveLength(1);
    expect(world.buildings[0].heightM).toBeCloseTo(12, 0);
    expect(world.buildings[0].center.x).toBeCloseTo(100, 0);
    expect(world.buildings[0].center.z).toBeCloseTo(50, 0);
    expect(world.roads).toHaveLength(1);
    expect(world.roads[0].lengthM).toBeCloseTo(100, 0);
    expect(world.roads[0].name).toBe('QUEEN Street');
  });
});

describe('collision', () => {
  const world = loadWorld({
    buildings: { features: [squareFeature(0, 0, 10)] }, // 20x20 m at origin
    roads: { features: [] },
  });
  const b = world.buildings;

  it('pointInPolygon works', () => {
    expect(pointInPolygon({ x: 0, z: 0 }, b[0].polygon)).toBe(true);
    expect(pointInPolygon({ x: 50, z: 0 }, b[0].polygon)).toBe(false);
  });

  it('no push when clear', () => {
    expect(collideBuildings(b, { x: 30, z: 0 }, 1)).toBeNull();
  });

  it('pushes an overlapping circle out to its radius', () => {
    const pushed = collideBuildings(b, { x: 10.5, z: 0 }, 1);
    expect(pushed).not.toBeNull();
    expect(pushed!.x).toBeGreaterThanOrEqual(11 - 1e-6);
    expect(collideBuildings(b, pushed!, 1)).toBeNull();
  });

  it('pushes a centre-inside circle out of the building', () => {
    const pushed = collideBuildings(b, { x: 0, z: 0 }, 0.55);
    expect(pushed).not.toBeNull();
    expect(pointInPolygon(pushed!, b[0].polygon)).toBe(false);
    expect(collideBuildings(b, pushed!, 0.55)).toBeNull();
  });

  it('project() agrees with the fixture centre', () => {
    const ll = unproject(100, 50);
    const p = project(ll.lng, ll.lat);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.z).toBeCloseTo(50, 6);
  });
});
