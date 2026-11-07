/**
 * Spatial grid (Stage 1 backport prerequisite): the grid-accelerated
 * collision path must return EXACTLY what the brute-force scan over
 * every collider returns — same pushed-out position, same deepest
 * normal — while testing only a small fraction of the city. These
 * tests pin both properties on the real dataset and on synthetic
 * worlds whose colliders span cell borders.
 */
import { describe, expect, it } from 'vitest';
import downtownRaw from '../../public/data/downtown.json?raw';
import {
  buildColliderGrid,
  colliderCandidates,
  collideBuildingsN,
  collideWorldN,
  loadWorld,
  type Building,
  type WorldModel,
} from './world';

/** Deterministic RNG (mulberry32) so the sweep is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(cx: number, cz: number, w: number, d: number): Building {
  const polygon = [
    { x: cx - w / 2, z: cz - d / 2 }, { x: cx + w / 2, z: cz - d / 2 },
    { x: cx + w / 2, z: cz + d / 2 }, { x: cx - w / 2, z: cz + d / 2 },
  ];
  return {
    polygon, heightM: 10, center: { x: cx, z: cz },
    minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2,
  };
}

function worldOf(colliders: Building[]): WorldModel {
  return {
    buildings: colliders, roads: [], water: [], bridges: [], barriers: [],
    colliders, colliderGrid: buildColliderGrid(colliders),
    bounds: { minX: -1e4, maxX: 1e4, minZ: -1e4, maxZ: 1e4 },
  };
}

describe('collider grid', () => {
  it('matches brute force on the real dataset over a seeded sweep', () => {
    const world = loadWorld(JSON.parse(downtownRaw));
    const rand = rng(20261107);
    const { minX, maxX, minZ, maxZ } = world.bounds;
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const pos = { x: minX + rand() * (maxX - minX), z: minZ + rand() * (maxZ - minZ) };
      const r = 0.4 + rand() * 2.6;
      const brute = collideBuildingsN(world.colliders, pos, r);
      const fast = collideWorldN(world, pos, r);
      expect(fast).toEqual(brute);
      if (brute) hits++;
    }
    // The sweep must actually exercise contacts, not just empty space.
    expect(hits).toBeGreaterThan(50);
  });

  it('tests only a small fraction of colliders per query on the real dataset', () => {
    const world = loadWorld(JSON.parse(downtownRaw));
    const rand = rng(42);
    const { minX, maxX, minZ, maxZ } = world.bounds;
    let total = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const pos = { x: minX + rand() * (maxX - minX), z: minZ + rand() * (maxZ - minZ) };
      total += colliderCandidates(world.colliderGrid, world.colliders, pos, 1.6).length;
    }
    const avg = total / N;
    // Brute force tests every collider every call; the grid should
    // average well under 2% of them even on the small downtown set.
    expect(avg).toBeLessThan(world.colliders.length * 0.02);
  });

  it('finds colliders that span cell borders and negative coordinates', () => {
    // A 200 m giant centred on a cell corner, plus a small building
    // in negative territory — the failure modes of a naive grid.
    const giant = box(64, 64, 200, 200);
    const neg = box(-500, -500, 20, 20);
    const world = worldOf([giant, neg]);
    for (const pos of [
      { x: 64, z: -30 }, { x: -30, z: 64 }, { x: 160, z: 160 }, { x: 64, z: 64 },
      { x: -500, z: -491 },
    ]) {
      expect(collideWorldN(world, pos, 1.5)).toEqual(collideBuildingsN(world.colliders, pos, 1.5));
    }
    expect(collideWorldN(world, { x: -500, z: -491 }, 1.5)).not.toBeNull();
    expect(collideWorldN(world, { x: 0, z: 1000 }, 1.5)).toBeNull();
  });

  it('preserves collider order in candidates (deepest-hit tie behaviour)', () => {
    const a = box(0, 0, 30, 30);
    const b = box(200, 0, 30, 30);
    const c = box(100, 0, 30, 30);
    const world = worldOf([a, b, c]);
    const all = colliderCandidates(world.colliderGrid, world.colliders, { x: 100, z: 0 }, 500);
    expect(all).toEqual([a, b, c]);
  });
});
