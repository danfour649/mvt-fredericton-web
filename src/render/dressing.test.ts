/**
 * Dressing tests (v0.23): building shadows offset SE; roof clutter is
 * deterministic and stays on its roof piece; crosswalks appear at a
 * synthetic junction and nowhere on a lone road; street trees never
 * land inside buildings or on road surfaces.
 */
import { describe, expect, it } from 'vitest';
import type { WorldModel, Road } from '../core/world';
import { pointInPolygon, pointInWater, buildColliderGrid } from '../core/world';
import { buildRoadGraph } from '../core/routing';
import { segmentRoof } from './segment';
import { shadowRing, roofClutter, crosswalkStripes, scatterTrees, SHADOW_OFFSET } from './dressing';

function road(path: { x: number; z: number }[], name: string): Road {
  const segLens: number[] = [];
  let lengthM = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const l = Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
    segLens.push(l);
    lengthM += l;
  }
  return { path, name, lanes: 2, speedKmh: 0, dirFlow: '', widthM: 9.2, segLens, lengthM };
}

function building(cx: number, cz: number, w: number, d: number): WorldModel['buildings'][number] {
  const polygon = [
    { x: cx - w / 2, z: cz - d / 2 },
    { x: cx + w / 2, z: cz - d / 2 },
    { x: cx + w / 2, z: cz + d / 2 },
    { x: cx - w / 2, z: cz + d / 2 },
  ];
  return {
    polygon,
    heightM: 9,
    center: { x: cx, z: cz },
    minX: cx - w / 2,
    maxX: cx + w / 2,
    minZ: cz - d / 2,
    maxZ: cz + d / 2,
  };
}

describe('building shadows', () => {
  it('offset every vertex south-east by the same delta', () => {
    const ring = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 8 },
    ];
    const s = shadowRing(ring);
    expect(s).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(s[i].x - ring[i].x).toBeCloseTo(SHADOW_OFFSET.x);
      expect(s[i].z - ring[i].z).toBeCloseTo(SHADOW_OFFSET.z);
    }
    expect(SHADOW_OFFSET.x).toBeGreaterThan(0);
    expect(SHADOW_OFFSET.z).toBeGreaterThan(0);
  });
});

describe('roof clutter', () => {
  const big = building(0, 0, 60, 30);

  it('puts deterministic clutter on a big roof, none on a tiny one', () => {
    const piece = segmentRoof(big.polygon, 3)[0];
    const a = roofClutter(piece, 3);
    const b = roofClutter(piece, 3);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    const tiny = segmentRoof(building(0, 0, 6, 5).polygon, 0)[0];
    expect(roofClutter(tiny, 0)).toEqual([]);
  });

  it('keeps every clutter centre inside the piece', () => {
    for (const piece of segmentRoof(big.polygon, 5)) {
      for (const item of roofClutter(piece, 5)) {
        const cx = item.ring.reduce((s, p) => s + p.x, 0) / item.ring.length;
        const cz = item.ring.reduce((s, p) => s + p.z, 0) / item.ring.length;
        expect(pointInPolygon({ x: cx, z: cz }, piece.ring)).toBe(true);
      }
    }
  });
});

describe('crosswalks', () => {
  const ew = road([{ x: -60, z: 0 }, { x: 0, z: 0 }], 'E-W A');
  const ew2 = road([{ x: 0, z: 0 }, { x: 60, z: 0 }], 'E-W B');
  const ns = road([{ x: 0, z: 0 }, { x: 0, z: 60 }], 'N-S');
  const world: WorldModel = {
    buildings: [],
    roads: [ew, ew2, ns],
    water: [],
    bridges: [], barriers: [], colliders: [], colliderGrid: buildColliderGrid([]),
    bounds: { minX: -60, maxX: 60, minZ: 0, maxZ: 60 },
  };

  it('lays zebra stripes at a real junction', () => {
    const stripes = crosswalkStripes(buildRoadGraph(world));
    expect(stripes.length).toBeGreaterThan(12); // 3 road ends × ~7 stripes
    for (const s of stripes) {
      expect(s).toHaveLength(4);
      // Near the junction, not wandering off down the block.
      const cx = s.reduce((a, p) => a + p.x, 0) / 4;
      const cz = s.reduce((a, p) => a + p.z, 0) / 4;
      expect(Math.hypot(cx, cz)).toBeLessThan(12);
    }
  });

  it('a single dead-end road gets no crosswalk', () => {
    const lone: WorldModel = { buildings: [], roads: [ew], water: [], bridges: [], barriers: [], colliders: [], colliderGrid: buildColliderGrid([]), bounds: world.bounds };
    expect(crosswalkStripes(buildRoadGraph(lone))).toEqual([]);
  });
});

describe('street trees', () => {
  const street = road([{ x: -120, z: 0 }, { x: 120, z: 0 }], 'Main');
  const blocker = building(30, 9.5, 26, 13); // sits on the south sidewalk line
  const world: WorldModel = {
    buildings: [blocker],
    roads: [street],
    water: [],
    bridges: [], barriers: [], colliders: [blocker], colliderGrid: buildColliderGrid([blocker]),
    bounds: { minX: -120, maxX: 120, minZ: -20, maxZ: 20 },
  };

  it('scatters a sane number of trees, deterministically', () => {
    const a = scatterTrees(world);
    const b = scatterTrees(world);
    expect(a.length).toBeGreaterThan(2);
    expect(a.length).toBeLessThanOrEqual(240);
    expect(a.map((t) => t.pos)).toEqual(b.map((t) => t.pos));
  });

  it('never plants inside a building or on the road surface', () => {
    for (const t of scatterTrees(world)) {
      expect(pointInPolygon(t.pos, blocker.polygon)).toBe(false);
      expect(Math.abs(t.pos.z)).toBeGreaterThan(street.widthM / 2);
    }
  });

  it('every tree carries a canopy ring and an offset shadow', () => {
    for (const t of scatterTrees(world)) {
      expect(t.ring.length).toBeGreaterThanOrEqual(8);
      expect(t.shadow[0].x - t.ring[0].x).toBeCloseTo(SHADOW_OFFSET.x);
      expect(t.shadow[0].z - t.ring[0].z).toBeCloseTo(SHADOW_OFFSET.z);
    }
  });

  it('never plants a tree in the water (v0.28: the river is in the model)', () => {
    // Same street, but the whole south sidewalk strip is river.
    const riverWorld: WorldModel = {
      buildings: [],
      roads: [street],
      water: [
        {
          rings: [[
            { x: -130, z: 5 }, { x: 130, z: 5 }, { x: 130, z: 45 }, { x: -130, z: 45 },
          ]],
          name: 'Saint John River',
          areaM2: 260 * 40,
          minX: -130, maxX: 130, minZ: 5, maxZ: 45,
        },
      ],
      bridges: [], barriers: [], colliders: [], colliderGrid: buildColliderGrid([]),
      bounds: { minX: -120, maxX: 120, minZ: -20, maxZ: 45 },
    };
    const trees = scatterTrees(riverWorld);
    expect(trees.length).toBeGreaterThan(0); // the dry north side still plants
    for (const t of trees) {
      expect(pointInWater(riverWorld, t.pos)).toBe(false);
      expect(t.pos.z).toBeLessThan(5);
    }
  });
});
