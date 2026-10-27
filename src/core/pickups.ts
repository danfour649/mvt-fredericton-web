/**
 * Pickups (v0.30 — gap audit #3: the world had NOTHING in it to find
 * off-route). GTA 1 scattered crates citywide: weapons, armour, cop
 * bribes, Get Outta Jail Free cards, multipliers, extra lives. Ours
 * sit where GTA 1 would put them — alleys, car parks, behind
 * buildings: sampled off the road network at sidewalk-plus offsets,
 * rejected when they'd land inside a building, in the river, or on
 * the carriageway itself. Deterministic (seeded), like the trees and
 * roof clutter — same city, same hiding spots, every load.
 *
 * Frenzy skulls ride the same system: three fixed spots that start a
 * Kill Frenzy instead of handing over an item.
 */
import { dist, type Vec2 } from './geo';
import { pointInPolygon, pointInWater, type WorldModel } from './world';
import { SPAWN_POS } from './missions';

export type PickupKind =
  | 'pistol' | 'mg' | 'rocket' | 'flame' | 'ammo'
  | 'armour' | 'bribe' | 'jailcard' | 'multiplier' | 'life'
  | 'frenzy-runover' | 'frenzy-destroy' | 'frenzy-gun';

export interface Pickup {
  id: string;
  kind: PickupKind;
  pos: Vec2;
  active: boolean;
  /** Seconds until this spot respawns after being taken. */
  respawnT: number;
}

/** Respawn delay per kind (s): commons come back fast, the jail card
 *  and extra life are rare for a reason. */
export const RESPAWN_SEC: Record<PickupKind, number> = {
  pistol: 60, mg: 90, rocket: 150, flame: 150, ammo: 45,
  armour: 90, bribe: 120, jailcard: 240, multiplier: 150, life: 300,
  'frenzy-runover': 120, 'frenzy-destroy': 120, 'frenzy-gun': 120,
};

/** HUD/render glyph + crate colour per kind. */
export const PICKUP_STYLE: Record<PickupKind, { glyph: string; color: string; label: string }> = {
  pistol: { glyph: '🔫', color: '#2f7fd0', label: 'PISTOL' },
  mg: { glyph: '🔫', color: '#c22e2e', label: 'MACHINE GUN' },
  rocket: { glyph: '🚀', color: '#5b3a8e', label: 'ROCKETS' },
  flame: { glyph: '🔥', color: '#e07a2e', label: 'FLAMETHROWER' },
  ammo: { glyph: '▸', color: '#7a8288', label: 'AMMO' },
  armour: { glyph: '🛡', color: '#1fae8e', label: 'ARMOUR' },
  bribe: { glyph: '💵', color: '#3f9e4d', label: 'COP BRIBE' },
  jailcard: { glyph: '🃏', color: '#e8c547', label: 'JAIL CARD' },
  multiplier: { glyph: '×2', color: '#e34ba9', label: 'MULTIPLIER' },
  life: { glyph: '♥', color: '#ff5a4e', label: 'EXTRA LIFE' },
  'frenzy-runover': { glyph: '💀', color: '#20242c', label: 'KILL FRENZY' },
  'frenzy-destroy': { glyph: '💀', color: '#20242c', label: 'KILL FRENZY' },
  'frenzy-gun': { glyph: '💀', color: '#20242c', label: 'KILL FRENZY' },
};

/** The shopping list: 23 spots (3 of them frenzy skulls). */
const MANIFEST: PickupKind[] = [
  'pistol', 'pistol', 'pistol',
  'mg', 'mg',
  'ammo', 'ammo', 'ammo', 'ammo',
  'armour', 'armour', 'armour',
  'bribe', 'bribe',
  'jailcard',
  'multiplier', 'multiplier',
  'life',
  'rocket', 'flame',
  'frenzy-runover', 'frenzy-destroy', 'frenzy-gun',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function insideBuilding(world: WorldModel, p: Vec2): boolean {
  for (const b of world.buildings) {
    if (p.x < b.minX - 1 || p.x > b.maxX + 1 || p.z < b.minZ - 1 || p.z > b.maxZ + 1) continue;
    if (pointInPolygon(p, b.polygon)) return true;
  }
  return false;
}

/**
 * Place the manifest. A spot qualifies when it is:
 *  - beside a road (sampled off a centreline at carriageway + 2.5–6 m),
 *  - not inside a building, not in water, not on the road surface
 *    (road-surface test re-checked against the nearest road),
 *  - ≥18 m from spawn (the spawn corner stays clean for the cold start),
 *  - ≥14 m from every already-placed pickup.
 * Bounded attempts; on a sparse toy world some spots simply don't
 * place (tests use their own worlds and tolerate fewer).
 */
export function placePickups(world: WorldModel, seed = 20261030): Pickup[] {
  const rng = mulberry32(seed);
  const roads = world.roads.filter((r) => r.lengthM > 60);
  const out: Pickup[] = [];
  if (!roads.length) return out;
  for (let k = 0; k < MANIFEST.length; k++) {
    const kind = MANIFEST[k];
    let placed: Vec2 | null = null;
    for (let attempt = 0; attempt < 300 && !placed; attempt++) {
      const road = roads[Math.floor(rng() * roads.length)];
      const along = 6 + rng() * (road.lengthM - 12);
      // Point + travel heading at `along` (recompute from segments).
      let rem = along;
      let pos: Vec2 | null = null;
      let heading = 0;
      for (let i = 0; i < road.segLens.length; i++) {
        const a = road.path[i];
        const b = road.path[i + 1];
        if (rem <= road.segLens[i] || i === road.segLens.length - 1) {
          const t = road.segLens[i] > 0 ? rem / road.segLens[i] : 0;
          pos = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
          heading = Math.atan2(b.z - a.z, b.x - a.x);
          break;
        }
        rem -= road.segLens[i];
      }
      if (!pos) continue;
      const side = rng() > 0.5 ? 1 : -1;
      const off = road.widthM / 2 + 2.5 + rng() * 3.5;
      const cand = {
        x: pos.x + Math.cos(heading + (Math.PI / 2) * side) * off,
        z: pos.z + Math.sin(heading + (Math.PI / 2) * side) * off,
      };
      if (dist(cand, SPAWN_POS) < 18) continue;
      if (pointInWater(world, cand)) continue;
      if (insideBuilding(world, cand)) continue;
      // On-road re-check against the closest road of all: the
      // candidate must clear THAT road's carriageway + kerb too
      // (a wide arterial's lanes reach further than 5.2 m).
      let minRoadD = Infinity;
      let minRoadHalfW = 0;
      for (const r of world.roads) {
        for (let i = 0; i < r.path.length - 1; i++) {
          const a = r.path[i];
          const b = r.path[i + 1];
          const abx = b.x - a.x;
          const abz = b.z - a.z;
          const len2 = abx * abx + abz * abz;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((cand.x - a.x) * abx + (cand.z - a.z) * abz) / len2)) : 0;
          const d = Math.hypot(cand.x - (a.x + abx * t), cand.z - (a.z + abz * t));
          if (d < minRoadD) {
            minRoadD = d;
            minRoadHalfW = r.widthM / 2;
          }
        }
      }
      if (minRoadD < Math.max(5.2, minRoadHalfW + 1.2)) continue;
      if (out.some((p) => dist(p.pos, cand) < 14)) continue;
      placed = cand;
    }
    if (placed) out.push({ id: `pickup-${k}`, kind, pos: placed, active: true, respawnT: 0 });
  }
  return out;
}
