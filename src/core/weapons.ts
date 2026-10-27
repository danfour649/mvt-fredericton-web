/**
 * Weapons & the player's loadout (v0.30 — the GTA 1 gap audit's #1
 * hole: MVTF1 had NO combat at all; on foot you could bump a ped
 * 0.5 m and that was the whole arsenal).
 *
 * GTA 1's set, staged: fists (non-lethal stun), pistol (one-shot ped
 * kill, plentiful ammo), machine gun (fast, rarer ammo), plus the
 * two heavy tiers — rocket launcher (vehicle-killer, explosive) and
 * flamethrower (torches cars). Combat itself lives in game.ts; this
 * module is the data + the player's pockets.
 */

export type WeaponId = 'fists' | 'pistol' | 'mg' | 'rocket' | 'flame';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** Seconds between shots (flame: between damage ticks). */
  cooldown: number;
  /** Effective range, metres. */
  range: number;
  /** Damage per hit to a car. Fists can't dent a car. */
  carDamage: number;
  /** Uses ammo (fists never do). */
  usesAmmo: boolean;
  /** Projectile weapon (rocket) — no hitscan. */
  projectile: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: { id: 'fists', name: 'FISTS', cooldown: 0.45, range: 1.9, carDamage: 0, usesAmmo: false, projectile: false },
  pistol: { id: 'pistol', name: 'PISTOL', cooldown: 0.3, range: 27, carDamage: 12, usesAmmo: true, projectile: false },
  mg: { id: 'mg', name: 'MACHINE GUN', cooldown: 0.09, range: 25, carDamage: 8, usesAmmo: true, projectile: false },
  rocket: { id: 'rocket', name: 'ROCKET LAUNCHER', cooldown: 0.95, range: 48, carDamage: 0, usesAmmo: true, projectile: true },
  flame: { id: 'flame', name: 'FLAMETHROWER', cooldown: 0.06, range: 7.5, carDamage: 2.2, usesAmmo: true, projectile: false },
};

/** Cycle order for the weapon button / Q key. */
export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'mg', 'rocket', 'flame'];

/** What the player carries: owned weapons, ammo per weapon, current pick. */
export class Loadout {
  weapon: WeaponId = 'fists';
  readonly owned = new Set<WeaponId>(['fists']);
  ammo: Record<WeaponId, number> = { fists: 0, pistol: 0, mg: 0, rocket: 0, flame: 0 };

  get def(): WeaponDef {
    return WEAPONS[this.weapon];
  }

  /** Pick up a weapon (and its bundled ammo). Selects it — grabbing
   *  a gun and not holding it would be a strange kind of mercy. */
  give(id: WeaponId, ammo: number): void {
    this.owned.add(id);
    this.ammo[id] += ammo;
    this.weapon = id;
  }

  addAmmo(id: WeaponId, n: number): void {
    this.ammo[id] += n;
  }

  /** Can the current weapon fire right now (ammo check)? */
  canFire(): boolean {
    const d = this.def;
    return !d.usesAmmo || this.ammo[this.weapon] > 0;
  }

  /** Consume for one shot/tick; flame drains per second instead. */
  consume(amount = 1): void {
    if (!this.def.usesAmmo) return;
    this.ammo[this.weapon] = Math.max(0, this.ammo[this.weapon] - amount);
  }

  /** Next owned weapon in cycle order (wraps). */
  cycle(): WeaponId {
    const start = WEAPON_ORDER.indexOf(this.weapon);
    for (let i = 1; i <= WEAPON_ORDER.length; i++) {
      const cand = WEAPON_ORDER[(start + i) % WEAPON_ORDER.length];
      if (this.owned.has(cand)) {
        this.weapon = cand;
        break;
      }
    }
    return this.weapon;
  }

  /** Switch to the best owned weapon that still has ammo, else fists. */
  fallback(): WeaponId {
    for (const id of ['rocket', 'mg', 'pistol', 'flame'] as WeaponId[]) {
      if (this.owned.has(id) && this.ammo[id] > 0) {
        this.weapon = id;
        return id;
      }
    }
    this.weapon = 'fists';
    return 'fists';
  }

  /** BUSTED, GTA 1 rules: the police keep your weapons and armour. */
  strip(): void {
    this.owned.clear();
    this.owned.add('fists');
    this.ammo = { fists: 0, pistol: 0, mg: 0, rocket: 0, flame: 0 };
    this.weapon = 'fists';
  }
}
