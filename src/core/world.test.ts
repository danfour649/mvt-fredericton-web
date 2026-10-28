import { describe, it, expect } from 'vitest';
import { loadWorld, collideBuildings, pointInPolygon, pointInWater } from './world';
import { project, unproject } from './geo';
import downtownRaw from '../../public/data/downtown.json?raw';

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

describe('water (v0.28)', () => {
  it('loads water bodies with rings, name and area', () => {
    const ring: Array<[number, number]> = [
      [-60, 300], [60, 300], [60, 420], [-60, 420], [-60, 300],
    ].map(([x, z]) => {
      const ll = unproject(x, z);
      return [ll.lng, ll.lat] as [number, number];
    });
    const world = loadWorld({
      buildings: { features: [] },
      roads: { features: [] },
      water: {
        features: [
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { NAME1: 'Saint John River' } },
        ],
      },
    });
    expect(world.water).toHaveLength(1);
    expect(world.water[0].name).toBe('Saint John River');
    expect(world.water[0].areaM2).toBeCloseTo(120 * 120, -2);
    expect(pointInWater(world, { x: 0, z: 360 })).toBe(true);
    expect(pointInWater(world, { x: 0, z: 0 })).toBe(false);
  });

  it('a doc without water still loads (water = [])', () => {
    const world = loadWorld({ buildings: { features: [] }, roads: { features: [] } });
    expect(world.water).toEqual([]);
  });

  describe('the real downtown dataset', () => {
    const world = loadWorld(JSON.parse(downtownRaw));

    it('carries the Saint John River at river scale', () => {
      expect(world.water.length).toBeGreaterThanOrEqual(2);
      const total = world.water.reduce((s, w) => s + w.areaM2, 0);
      expect(total).toBeGreaterThan(1_500_000); // ~1.85 km² baked
      expect(world.water.every((w) => w.name === 'Saint John River')).toBe(true);
    });

    it('the river spans the southern edge of the extract (eastern reach)', () => {
      // z = 906 m is the bbox south edge (lat 45.955). Across the
      // riverfront reach the channel touches that edge continuously.
      for (let x = 850; x <= 1300; x += 50) {
        expect(pointInWater(world, { x, z: 906 }), `x=${x}`).toBe(true);
      }
      // Mid-channel and the NW reach are water; downtown is not.
      expect(pointInWater(world, { x: 759, z: 517 })).toBe(true);
      expect(pointInWater(world, { x: -480, z: -817 })).toBe(true);
      expect(pointInWater(world, { x: 0, z: 0 })).toBe(false); // City Hall
      expect(pointInWater(world, { x: 0, z: 28 })).toBe(false); // spawn
    });
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

describe('bridge guardrails — iteration 5 derivation', () => {
  const riverFeature = (x0: number, z0: number, x1: number, z1: number) => {
    const ring = [
      [x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0],
    ].map(([x, z]) => {
      const ll = unproject(x, z);
      return [ll.lng, ll.lat] as [number, number];
    });
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { NAME1: 'Test River' },
    };
  };
  const roadLine = (name: string, pts: Array<[number, number]>) => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: pts.map(([x, z]) => {
        const ll = unproject(x, z);
        return [ll.lng, ll.lat] as [number, number];
      }),
    },
    properties: { Formatted_Street_Name: name, Speed_Restrictions_Both: 50, Number_Of_Lanes: 2 },
  });

  it('a road crossing water becomes one span with a rail on each side; a bank road gets none', () => {
    const world = loadWorld({
      buildings: { features: [] },
      roads: {
        features: [
          roadLine('Crossing Rd', [[0, -150], [0, 150]]),
          roadLine('Bank Rd', [[-150, -100], [150, -100]]),
        ],
      },
      water: { features: [riverFeature(-200, -60, 200, 60)] },
    });
    expect(world.bridges.length).toBe(1);
    const span = world.bridges[0];
    expect(span.roadName).toBe('Crossing Rd');
    expect(span.lengthM).toBeGreaterThan(110); // the 120 m river + approaches
    expect(span.rails.length).toBe(2);
    expect(span.posts.length).toBeGreaterThan(10);
    expect(world.barriers.length).toBe(2);
    expect(world.colliders.length).toBe(world.buildings.length + world.barriers.length);
    expect(world.barriers.every((b) => b.heightM === 1.1)).toBe(true);
  });

  it('no water, no bridges', () => {
    const world = loadWorld({
      buildings: { features: [] },
      roads: { features: [roadLine('Dry Rd', [[0, -150], [0, 150]])] },
    });
    expect(world.bridges.length).toBe(0);
    expect(world.barriers.length).toBe(0);
    expect(world.colliders).toBe(world.buildings);
  });

  it('REAL dataset: the whole Westmorland complex is railed, main span over 250 m', () => {
    const world = loadWorld(JSON.parse(downtownRaw));
    expect(world.bridges.length).toBeGreaterThanOrEqual(8);
    expect(world.bridges.every((b) => b.roadName.includes('WESTMORLAND'))).toBe(true);
    const longest = world.bridges.reduce((a, b) => (a.lengthM > b.lengthM ? a : b));
    expect(longest.lengthM).toBeGreaterThan(250);
    expect(longest.rails.length).toBeGreaterThanOrEqual(2);
    const railCount = world.bridges.reduce((s, b) => s + b.rails.length, 0);
    expect(world.barriers.length).toBe(railCount);
    expect(world.colliders.length).toBe(world.buildings.length + world.barriers.length);
  });

  it('REAL dataset: no rail vertex stands inside another road\u2019s carriageway (junction mouths stay open)', () => {
    const world = loadWorld(JSON.parse(downtownRaw));
    const segDist = (p: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => {
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
      return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
    };
    for (const span of world.bridges) {
      for (const rail of span.rails) {
        for (const p of rail) {
          for (const r of world.roads) {
            if (r === span.road) continue;
            let d = Infinity;
            for (let i = 0; i < r.path.length - 1; i++) d = Math.min(d, segDist(p, r.path[i], r.path[i + 1]));
            expect(d).toBeGreaterThan(r.widthM / 2 - 0.05);
          }
        }
      }
    }
  });
});
