/**
 * v0.30 mega-build coverage: water/bridge, weapons, pickups (incl.
 * bribe + jail card), fire/explosion chains, frenzy quota, wanted
 * decay-pause, roadblocks, chop shop, vehicle job, radio mapping,
 * and pickup placement invariants on the real dataset.
 */
import { describe, it, expect } from 'vitest';
import { Game } from './game';
import { loadWorld, pointInWater, pointInPolygon, nearestRoadPoint } from './world';
import { unproject, dist } from './geo';
import { MemoryStorage } from './save';
import { SPAWN_POS } from './missions';
import { spawnCop } from './cops';
import { Loadout } from './weapons';
import { placePickups, type Pickup } from './pickups';
import { stationForClass, noteHz } from '../platform/audio';
import downtownRaw from '../../public/data/downtown.json?raw';

function roadFeature(points: { x: number; z: number }[], name = 'TEST Street') {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: points.map((p) => {
        const ll = unproject(p.x, p.z);
        return [ll.lng, ll.lat];
      }),
    },
    properties: {
      Number_Of_Lanes: 2,
      Formatted_Street_Name: name,
      Speed_Restrictions_Both: 50,
      Dir_of_Traffic_Flow: 'Both Directions',
    },
  };
}

/** Same three-road toy world the other suites use. (Roads start
 *  300 m west: spawnPeds ignores roads whose first point lies more
 *  than 420 m from spawn — start them at −600 and the city is
 *  mysteriously pedestrian-free.) */
function toyWorld() {
  const line = (z: number) =>
    roadFeature([{ x: -300, z }, { x: 0, z }, { x: 600, z }]);
  return loadWorld({
    buildings: { features: [] },
    roads: {
      features: [line(SPAWN_POS.z), line(SPAWN_POS.z + 120), line(SPAWN_POS.z - 120)],
    },
  });
}

/**
 * A toy world with a river: a water band 120–260 m south of spawn,
 * an east-west road on each bank, and one north-south road crossing
 * the band — the bridge.
 */
function waterWorld() {
  const S = SPAWN_POS;
  const roads = [
    roadFeature([{ x: S.x - 600, z: S.z }, { x: S.x + 600, z: S.z }]),
    roadFeature([{ x: S.x - 600, z: S.z + 320 }, { x: S.x + 600, z: S.z + 320 }]),
    roadFeature([{ x: S.x + 100, z: S.z - 200 }, { x: S.x + 100, z: S.z + 400 }], 'BRIDGE Road'),
  ];
  const ring = [
    { x: S.x - 400, z: S.z + 120 },
    { x: S.x + 400, z: S.z + 120 },
    { x: S.x + 400, z: S.z + 260 },
    { x: S.x - 400, z: S.z + 260 },
    { x: S.x - 400, z: S.z + 120 },
  ];
  const water = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        ring.map((p) => {
          const ll = unproject(p.x, p.z);
          return [ll.lng, ll.lat];
        }),
      ],
    },
    properties: { NAME1: 'Toy River' },
  };
  return loadWorld({
    buildings: { features: [] },
    roads: { features: roads },
    water: { features: [water] },
  });
}

function step(g: Game, seconds: number, dt = 0.05): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) g.update(dt);
}

function fakePickup(g: Game, kind: Pickup['kind']): void {
  g.pickups.push({
    id: `test-${kind}`,
    kind,
    pos: { ...g.playerPos },
    active: true,
    respawnT: 0,
  });
}

// ---------------------------------------------------------------------------

describe('v0.30 water: deep water kills, bridges hold', () => {
  it('the toy river is really in the world data path', () => {
    const w = waterWorld();
    expect(pointInWater(w, { x: SPAWN_POS.x + 40, z: SPAWN_POS.z + 190 })).toBe(true);
    expect(pointInWater(w, { ...SPAWN_POS })).toBe(false);
  });

  it('walking into deep water drowns the player (WASTED)', () => {
    const g = new Game(waterWorld(), new MemoryStorage());
    g.playerPos = { x: SPAWN_POS.x + 40, z: SPAWN_POS.z + 190 };
    step(g, 0.2);
    expect(g.phase).toBe('wasted');
    expect(g.hud().splashes).toBeGreaterThanOrEqual(1);
  });

  it('the shoreline itself is safe — one real step in is not', () => {
    const g = new Game(waterWorld(), new MemoryStorage());
    g.playerPos = { x: SPAWN_POS.x + 40, z: SPAWN_POS.z + 120.4 };
    step(g, 0.5);
    expect(g.phase).toBe('play');
  });

  it('standing on the bridge over the river is safe (road surface exception)', () => {
    const g = new Game(waterWorld(), new MemoryStorage());
    // Dead centre of the river band, but on the crossing road.
    g.playerPos = { x: SPAWN_POS.x + 100, z: SPAWN_POS.z + 190 };
    step(g, 0.5);
    expect(g.phase).toBe('play');
  });

  it('driving into the river sinks the car and wastes the player', () => {
    const g = new Game(waterWorld(), new MemoryStorage());
    const car = g.cars.find((c) => c.kind === 'parked')!;
    g.drivenCar = car;
    car.pos = { x: SPAWN_POS.x + 40, z: SPAWN_POS.z + 190 };
    g.playerPos = { ...car.pos };
    step(g, 0.2);
    expect(car.wrecked).toBe(true);
    expect(g.drivenCar).toBeNull();
    expect(g.phase).toBe('wasted');
  });
});

describe('v0.30 weapons', () => {
  it('Loadout: give/consume/fallback/strip/cycle bookkeeping', () => {
    const l = new Loadout();
    expect(l.weapon).toBe('fists');
    l.give('pistol', 24);
    expect(l.weapon).toBe('pistol');
    expect(l.canFire()).toBe(true);
    l.consume();
    expect(l.ammo.pistol).toBe(23);
    l.give('mg', 60);
    expect(l.weapon).toBe('mg');
    expect(l.cycle()).toBe('fists'); // the ring wraps through fists
    expect(l.cycle()).toBe('pistol');
    l.ammo.pistol = 0;
    expect(l.fallback()).toBe('mg'); // mg still loaded
    l.ammo.mg = 0;
    expect(l.fallback()).toBe('fists');
    l.strip();
    expect(l.owned.size).toBe(1);
    expect(l.weapon).toBe('fists');
  });

  it('a fist swing downs a ped for pocket change and no heat when unseen', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const ped = g.peds[0];
    g.playerPos = { x: ped.pos.x - 1.2, z: ped.pos.z };
    g.playerHeading = 0;
    g.fireHeld = true;
    step(g, 0.2);
    expect(ped.state).toBe('down');
    expect(g.wallet.money).toBe(25);
    expect(g.wanted.heat).toBe(0);
  });

  it('a pistol shot downs a ped: bigger score, +1 star, one round spent', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.loadout.give('pistol', 24);
    const ped = g.peds[0];
    g.playerPos = { x: ped.pos.x - 6, z: ped.pos.z - 2 };
    g.playerHeading = Math.atan2(ped.pos.z - g.playerPos.z, ped.pos.x - g.playerPos.x);
    g.fireHeld = true;
    step(g, 0.2);
    expect(ped.state).toBe('down');
    expect(g.wallet.money).toBe(150);
    // +1 star, minus a breath of decay over the remaining steps.
    expect(g.wanted.heat).toBeGreaterThan(0.9);
    expect(g.loadout.ammo.pistol).toBe(23);
    expect(g.hud().shotsFired).toBeGreaterThanOrEqual(1);
  });

  it('the machine gun chews ammo at its own rate', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.loadout.give('mg', 60);
    g.fireHeld = true;
    step(g, 1.0);
    expect(g.hud().shotsFired).toBeGreaterThanOrEqual(8);
    expect(g.loadout.ammo.mg).toBeLessThanOrEqual(52);
  });

  it('bullets burn a car down, and the explosion chains to its neighbour', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    for (const ped of g.peds) {
      ped.state = 'down';
      ped.downT = 9999;
    }
    const [a, b] = g.cars.filter((c) => c.kind === 'parked');
    b.pos = { x: a.pos.x + 3, z: a.pos.z };
    b.health = 50;
    g.loadout.give('pistol', 200);
    // Stand west of car A and keep firing until it catches.
    for (let i = 0; i < 240 && !a.burning; i++) {
      g.playerPos = { x: a.pos.x - 8, z: a.pos.z };
      g.playerHeading = 0;
      g.fireHeld = true;
      g.update(0.05);
    }
    expect(a.burning).toBe(true);
    // Get well clear and let the fuses run: A goes up, B chains.
    g.fireHeld = false;
    g.playerPos = { x: a.pos.x - 90, z: a.pos.z };
    step(g, 7);
    expect(a.wrecked).toBe(true);
    expect(b.wrecked).toBe(true);
    expect(g.hud().explosions).toBeGreaterThanOrEqual(2);
    expect(g.buildFrame().scorches.length).toBeGreaterThanOrEqual(1);
  });

  it('armour soaks an explosion before health does', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    for (const ped of g.peds) {
      ped.state = 'down';
      ped.downT = 9999;
    }
    const a = g.cars.find((c) => c.kind === 'parked')!;
    g.loadout.give('pistol', 200);
    for (let i = 0; i < 240 && !a.burning; i++) {
      g.playerPos = { x: a.pos.x - 8, z: a.pos.z };
      g.playerHeading = 0;
      g.fireHeld = true;
      g.update(0.05);
    }
    expect(a.burning).toBe(true);
    g.fireHeld = false;
    g.armour = 100;
    g.playerPos = { x: a.pos.x - 5, z: a.pos.z };
    step(g, 5);
    expect(a.wrecked).toBe(true);
    expect(g.playerHealth).toBe(100); // the armour ate all of it
    expect(g.armour).toBeLessThan(100);
    expect(g.armour).toBeGreaterThan(40);
  });
});

describe('v0.30 pickups', () => {
  it('placement on the real dataset: off-road, off-water, out of buildings, spaced', () => {
    const world = loadWorld(JSON.parse(downtownRaw) as unknown);
    const pickups = placePickups(world);
    expect(pickups.length).toBeGreaterThanOrEqual(15);
    for (const p of pickups) {
      expect(pointInWater(world, p.pos)).toBe(false);
      expect(world.buildings.some((b) => pointInPolygon(p.pos, b.polygon))).toBe(false);
      const near = nearestRoadPoint(world, p.pos);
      expect(near).not.toBeNull();
      // Clear of the nearest carriageway (half width + kerb margin).
      expect(dist(p.pos, near!.pos)).toBeGreaterThanOrEqual(near!.road.widthM / 2 + 1.0);
      expect(dist(p.pos, SPAWN_POS)).toBeGreaterThanOrEqual(18);
    }
    for (let i = 0; i < pickups.length; i++) {
      for (let j = i + 1; j < pickups.length; j++) {
        expect(dist(pickups[i].pos, pickups[j].pos)).toBeGreaterThanOrEqual(13.9);
      }
    }
  });

  it('a cop bribe wipes the heat completely', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.wanted.heat = 3.5;
    fakePickup(g, 'bribe');
    step(g, 0.1);
    expect(g.wanted.heat).toBe(0);
    expect(g.hud().pickupsTaken).toBe(1);
  });

  it('GET OUTTA JAIL FREE: the next bust costs nothing and keeps your gear', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.loadout.give('pistol', 24);
    g.armour = 60;
    fakePickup(g, 'jailcard');
    step(g, 0.1);
    expect(g.jailCard).toBe(true);
    g.wallet.set(5000);
    g.wallet.multiplier = 3;
    g.applyBusted();
    expect(g.jailCard).toBe(false); // card consumed
    expect(g.wallet.money).toBe(5000); // no fine
    expect(g.wallet.multiplier).toBe(3); // no halving
    expect(g.loadout.weapon).toBe('pistol'); // gear kept
    expect(g.armour).toBe(60);
  });

  it('without the card, a bust confiscates weapons and armour (GTA 1 rules)', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.loadout.give('pistol', 24);
    g.armour = 60;
    g.wallet.set(5000);
    g.applyBusted();
    expect(g.loadout.weapon).toBe('fists');
    expect(g.armour).toBe(0);
    expect(g.wallet.money).toBeLessThan(5000);
  });

  it('an armour pickup fills the pool; a multiplier token raises the multiplier', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    fakePickup(g, 'armour');
    step(g, 0.1);
    expect(g.armour).toBe(100);
    fakePickup(g, 'multiplier');
    step(g, 0.1);
    expect(g.wallet.multiplier).toBe(2);
  });
});

describe('v0.30 wanted teeth', () => {
  it('decay runs at one star per 60 s while unseen', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.wanted.heat = 3;
    // NB: Game.update clamps dt to 0.05 — 600 × 0.05 = 30 game-seconds.
    for (let i = 0; i < 600; i++) {
      g.update(0.05);
      g.cops = []; // hold the police out of this measurement entirely
    }
    expect(g.wanted.heat).toBeCloseTo(2.5, 1);
  });

  it('decay PAUSES while a cop has eyes on the player', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.wanted.heat = 3;
    const cop = spawnCop({ x: g.playerPos.x + 60, z: g.playerPos.z }, Math.PI);
    g.cops.push(cop);
    for (let i = 0; i < 50; i++) {
      cop.pos = { x: g.playerPos.x + 60, z: g.playerPos.z }; // keep him watching
      g.update(0.1);
    }
    expect(g.wanted.heat).toBeCloseTo(3, 5);
  });

  it('at 4 stars a roadblock pair sets up ahead of the player', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const car = g.cars.filter((c) => c.kind === 'parked')
      .find((c) => Math.cos(c.heading) < -0.99) ?? g.cars.find((c) => c.kind === 'parked')!;
    car.stolen = true;
    car.health = 1e9;
    g.drivenCar = car;
    g.playerPos = { ...car.pos };
    g.carInput = { throttle: 1, steer: 0 };
    for (let i = 0; i < 40 && !g.cops.some((c) => c.roadblock); i++) {
      g.wanted.heat = 4;
      g.update(0.1);
    }
    expect(g.cops.some((c) => c.roadblock)).toBe(true);
    expect(g.cops.filter((c) => c.roadblock).length).toBe(2);
  });
});

describe('v0.30 crime economy', () => {
  it('the chop shop pays class × health for a stopped stolen car', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const car = g.cars.find((c) => c.kind === 'parked')!;
    car.stolen = true;
    car.health = 100;
    g.drivenCar = car;
    car.pos = { ...g.chopShopPos };
    car.speed = 0;
    g.playerPos = { ...g.chopShopPos };
    const expected = car.classId === 'fast' ? 1600 : 800;
    step(g, 0.1);
    expect(g.cars.includes(car)).toBe(false);
    expect(g.drivenCar).toBeNull();
    expect(g.wallet.money).toBe(expected);
  });

  it('crossing the bay at speed does NOT sell the car', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const car = g.cars.find((c) => c.kind === 'parked')!;
    car.stolen = true;
    car.health = 1e9;
    g.drivenCar = car;
    // Approach the bay already moving: 6 m out at 12 m/s eastward
    // (vel must agree with speed — the physics derives one from it).
    car.pos = { x: g.chopShopPos.x - 6, z: g.chopShopPos.z };
    car.heading = 0;
    car.speed = 12;
    car.vel = { x: 12, z: 0 };
    g.playerPos = { ...car.pos };
    g.carInput = { throttle: 1, steer: 0 };
    step(g, 0.3);
    expect(g.drivenCar).toBe(car);
    expect(g.wallet.money).toBe(0);
  });

  it('the marked job car starts a timed delivery; delivering it pays out', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const starts = g.missions.available().map((m) => m.startPos);
    const clearance = (p: { x: number; z: number }) => Math.min(...starts.map((s) => dist(s, p)));
    const car = g.cars
      .filter((c) => c.kind === 'parked')
      .sort((a, b) => clearance(b.pos) - clearance(a.pos))[0];
    (g as unknown as { markedCarId: string | null }).markedCarId = car.id;
    g.playerPos = { ...car.pos };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    expect(g.hud().objective).toContain('VEHICLE JOB');
    expect(g.hud().timerSec).not.toBeNull();
    const before = g.wallet.money;
    car.pos = { ...g.chopShopPos };
    car.speed = 0;
    g.playerPos = { ...g.chopShopPos };
    step(g, 0.1);
    expect(g.wallet.money - before).toBe(250 * 100);
    expect(g.hud().objective).not.toContain('VEHICLE JOB');
  });

  it('completing a runover frenzy pays the bounty and raises the multiplier', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.wallet.set(0);
    g.frenzy = { kind: 'runover', label: 'Run down 8 pedestrians', need: 8, have: 7, tLeft: 60 };
    const car = g.cars.find((c) => c.kind === 'parked')!;
    car.health = 1e9;
    g.drivenCar = car;
    g.playerPos = { ...car.pos };
    const ped = g.peds[0];
    for (let i = 0; i < 40 && ped.state !== 'down'; i++) {
      car.heading = 0;
      car.pos = { x: ped.pos.x - 1.0, z: ped.pos.z };
      car.speed = 8;
      car.vel = { x: 8, z: 0 };
      g.carInput = { throttle: 0, steer: 0 };
      g.update(0.05);
    }
    expect(ped.state).toBe('down');
    step(g, 0.2);
    expect(g.frenzy).toBeNull();
    expect(g.wallet.multiplier).toBe(2);
    expect(g.wallet.money).toBeGreaterThanOrEqual(2500);
    expect(g.hud().frenzyWins).toBe(1);
  });
});

describe('v0.30 radio mapping', () => {
  it('stations follow the car class; note math is exact octaves', () => {
    expect(stationForClass(null)).toBe(-1);
    expect(stationForClass('standard')).toBe(0);
    expect(stationForClass('police')).toBe(0);
    expect(stationForClass('fast')).toBe(1);
    expect(noteHz(55, 12)).toBeCloseTo(110, 6);
    expect(noteHz(55, 0)).toBe(55);
  });
});
