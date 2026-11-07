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
      // Stage 1: the extract now also carries the Nashwaak River,
      // Nashwaaksis Stream and Kaine Creek — the Saint John River
      // remains the dominant body by an order of magnitude.
      expect(world.water.length).toBeGreaterThanOrEqual(5);
      const total = world.water.reduce((s, w) => s + w.areaM2, 0);
      expect(total).toBeGreaterThan(4_000_000); // ~4.95 km² baked
      const saintJohn = world.water
        .filter((w) => w.name === 'Saint John River')
        .reduce((s, w) => s + w.areaM2, 0);
      expect(saintJohn).toBeGreaterThan(3_500_000); // ~4.57 km²
      expect(world.water.some((w) => w.name === 'Nashwaak River')).toBe(true);
    });

    it('the river spans the southern edge of the extract (eastern reach)', () => {
      // z = 906 m was the old downtown bbox's south edge (lat
      // 45.955); in the Stage 1 extract it is interior. Across the
      // riverfront reach the channel runs continuously there.
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

  it('REAL dataset: the bridge complexes are railed, Westmorland main span over 250 m', () => {
    const world = loadWorld(JSON.parse(downtownRaw));
    // Stage 1: Westmorland is no longer the only complex — the
    // Princess Margaret Bridge and the Union Street Nashwaak
    // crossings derive decks too.
    expect(world.bridges.length).toBeGreaterThanOrEqual(12);
    const westmorland = world.bridges.filter((b) => b.roadName.includes('WESTMORLAND'));
    expect(westmorland.length).toBeGreaterThanOrEqual(8);
    const wmLongest = westmorland.reduce((a, b) => (a.lengthM > b.lengthM ? a : b));
    expect(wmLongest.lengthM).toBeGreaterThan(250);
    const pm = world.bridges.filter((b) => b.roadName.includes('PRINCESS MARGARET'));
    expect(pm.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...pm.map((b) => b.lengthM))).toBeGreaterThan(500);
    const longest = world.bridges.reduce((a, b) => (a.lengthM > b.lengthM ? a : b));
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
    // Stage 1 made the old all-pairs scan (rail vertices x every
    // road segment in the city) take ~45 s. Bucket road segments
    // into 50 m cells first and only measure against segments near
    // the vertex: a carriageway violation needs d <= widthM/2
    // (<= ~9 m), far inside the 40 m query box, so any segment that
    // could violate is necessarily in the queried cells. The
    // assertion itself is unchanged.
    const CELL = 50, QUERY = 40;
    type Seg = { r: (typeof world.roads)[number]; a: { x: number; z: number }; b: { x: number; z: number } };
    const segCells = new Map<string, Seg[]>();
    for (const r of world.roads) {
      for (let i = 0; i < r.path.length - 1; i++) {
        const seg: Seg = { r, a: r.path[i], b: r.path[i + 1] };
        const x0 = Math.floor(Math.min(seg.a.x, seg.b.x) / CELL), x1 = Math.floor(Math.max(seg.a.x, seg.b.x) / CELL);
        const z0 = Math.floor(Math.min(seg.a.z, seg.b.z) / CELL), z1 = Math.floor(Math.max(seg.a.z, seg.b.z) / CELL);
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          const key = `${x},${z}`;
          const arr = segCells.get(key);
          if (arr) arr.push(seg); else segCells.set(key, [seg]);
        }
      }
    }
    for (const span of world.bridges) {
      for (const rail of span.rails) {
        for (const p of rail) {
          const near = new Map<Seg['r'], number>();
          const x0 = Math.floor((p.x - QUERY) / CELL), x1 = Math.floor((p.x + QUERY) / CELL);
          const z0 = Math.floor((p.z - QUERY) / CELL), z1 = Math.floor((p.z + QUERY) / CELL);
          for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
            for (const seg of segCells.get(`${x},${z}`) ?? []) {
              if (seg.r === span.road) continue;
              const d = segDist(p, seg.a, seg.b);
              const prev = near.get(seg.r);
              if (prev === undefined || d < prev) near.set(seg.r, d);
            }
          }
          for (const [r, d] of near) {
            expect(d).toBeGreaterThan(r.widthM / 2 - 0.05);
          }
        }
      }
    }
  }, 30_000);
});
