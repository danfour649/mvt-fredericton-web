import { describe, it, expect } from 'vitest';
import { Game, GOAL_SCORE, RESPRAY_COST_PER_STAR, BUBBLE_R, DRIVE_HINT } from './game';
import { Wallet, BUSTED_FINE } from './wallet';
import { loadWorld } from './world';
import { unproject, dist } from './geo';
import { MemoryStorage } from './save';
import { SPAWN_POS } from './missions';
import downtownRaw from '../../public/data/downtown.json?raw';

/**
 * A toy world: one long east-west road through the spawn area, no
 * buildings. Enough for the game systems (cars spawn on roads > 45 m,
 * respray/exit snap onto the road) without the real dataset.
 */
function toyWorld() {
  const line = (z: number) => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [-600, 0, 600].map((x) => {
        const ll = unproject(x, z);
        return [ll.lng, ll.lat];
      }),
    },
    properties: {
      Number_Of_Lanes: 2,
      Formatted_Street_Name: 'TEST Street',
      Speed_Restrictions_Both: 50,
      Dir_of_Traffic_Flow: 'Both Directions',
    },
  });
  return loadWorld({
    buildings: { features: [] },
    roads: { features: [line(SPAWN_POS.z), line(SPAWN_POS.z + 120), line(SPAWN_POS.z - 120)] },
  });
}

function newGame(): Game {
  return new Game(toyWorld(), new MemoryStorage());
}

describe('score & multiplier (Wallet)', () => {
  it('earn() applies the multiplier to every gain', () => {
    const w = new Wallet();
    expect(w.earn(100)).toBe(100); // ×1
    w.missionCompleted(); // ×2
    expect(w.multiplier).toBe(2);
    expect(w.earn(100)).toBe(200);
    w.missionCompleted(); // ×3
    expect(w.earn(50)).toBe(150);
    expect(w.money).toBe(450);
  });

  it('mission payout lands as payout × 100 × multiplier via the game', () => {
    const g = newGame();
    // Queen Street Errand through the real state machine.
    const errand = g.missions.available().find((m) => m.id === 'queen_street_errand')!;
    g.playerPos = { ...errand.startPos };
    g.pressInteract();
    expect(g.missions.active?.id).toBe('queen_street_errand');
    g.playerPos = { ...errand.steps[0].pos! };
    g.pressInteract();
    g.playerPos = { ...errand.steps[1].pos! };
    g.pressInteract();
    expect(g.missions.active).toBeNull();
    expect(g.wallet.money).toBe(150 * 100 * 1); // payout × scale × ×1
    expect(g.wallet.multiplier).toBe(2);
  });

  it('BUSTED halves the multiplier (floor ×1) and confiscates the fine', () => {
    const g = newGame();
    g.wallet.set(5000);
    g.wallet.multiplier = 5;
    g.applyBusted();
    expect(g.wallet.multiplier).toBe(2); // floor(5/2)
    expect(g.wallet.money).toBe(5000 - BUSTED_FINE);
    expect(g.wanted.stars).toBe(0);
    expect(g.playerPos).toEqual(SPAWN_POS);
    // Floor: ×1 stays ×1, fine still bounded by the balance.
    const w = new Wallet();
    w.set(300);
    expect(w.bustedPenalty()).toBe(300);
    expect(w.multiplier).toBe(1);
    expect(w.money).toBe(0);
  });
});

describe('respray', () => {
  it('charges $500 × stars, zeroes heat and repaints', () => {
    const g = newGame();
    const car = g.cars[0];
    expect(car).toBeDefined();
    g.wallet.set(5000);
    g.wanted.heat = 2;
    expect(g.wanted.stars).toBe(2);
    g.drivenCar = car;
    const oldColor = car.color;
    car.pos = { ...g.resprayPos };
    g.playerPos = { ...g.resprayPos };
    g.update(0.016);
    expect(g.wanted.stars).toBe(0);
    expect(g.wallet.money).toBe(5000 - RESPRAY_COST_PER_STAR * 2);
    expect(car.color).not.toBe(oldColor);
  });

  it('does nothing without heat', () => {
    const g = newGame();
    const car = g.cars[0];
    g.wallet.set(5000);
    g.drivenCar = car;
    car.pos = { ...g.resprayPos };
    g.playerPos = { ...g.resprayPos };
    g.update(0.016);
    expect(g.wallet.money).toBe(5000);
  });
});

describe('district goal', () => {
  it('reaching the goal flips to to-exit; arriving at the exit completes the district', () => {
    const storage = new MemoryStorage();
    const g = new Game(toyWorld(), storage);
    expect(g.goalState).toBe('progress');
    g.wallet.set(GOAL_SCORE);
    // Any score gain path runs checkGoal through mission completion;
    // the continuous check lives in update via checkGoal callers, so
    // drive it through a fresh mission completion: set just under and
    // finish the errand (which earns).
    g.wallet.set(GOAL_SCORE - 1);
    const errand = g.missions.available().find((m) => m.id === 'queen_street_errand')!;
    g.playerPos = { ...errand.startPos };
    g.pressInteract();
    g.playerPos = { ...errand.steps[0].pos! };
    g.pressInteract();
    g.playerPos = { ...errand.steps[1].pos! };
    g.pressInteract();
    expect(g.wallet.money).toBeGreaterThanOrEqual(GOAL_SCORE);
    expect(g.goalState).toBe('to-exit');
    // Drive to the exit.
    g.playerPos = { ...g.exitPos };
    g.update(0.016);
    expect(g.goalState).toBe('done');
    expect(g.phase).toBe('district-done');
    // Archived: a new Game on the same storage knows the district is cleared.
    const g2 = new Game(toyWorld(), storage);
    expect(g2.goalState).toBe('done');
  });

  it('cop spawns scale with stars and cap at 4 pursuit (+2 roadblock at 4★+)', () => {
    const g = newGame();
    g.wanted.heat = 5;
    for (let i = 0; i < 40; i++) g.update(0.1);
    expect(g.cops.length).toBeGreaterThan(0);
    // v0.30: the PURSUIT cap is still 4; a roadblock pair may add 2.
    expect(g.cops.filter((c) => !c.roadblock).length).toBeLessThanOrEqual(4);
    expect(g.cops.length).toBeLessThanOrEqual(6);
  });
});

describe('demo scenario hook', () => {
  it('produces a live in-car state with heat and score', () => {
    const g = newGame();
    g.applyDemoScenario();
    expect(g.drivenCar).not.toBeNull();
    expect(g.wanted.stars).toBe(2);
    expect(g.wallet.multiplier).toBe(3);
  });
});

/**
 * A road grid for the bubble tests: long east-west streets every
 * 120 m through and around the spawn area, so a 60 s drive stays on
 * the network the whole way.
 */
function gridWorld() {
  const roadAt = (dz: number) => ({
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [-2200, 0, 2200].map((x) => {
        const ll = unproject(SPAWN_POS.x + x, SPAWN_POS.z + dz);
        return [ll.lng, ll.lat];
      }),
    },
    properties: {
      Number_Of_Lanes: 2,
      Formatted_Street_Name: 'GRID Street',
      Speed_Restrictions_Both: 50,
      Dir_of_Traffic_Flow: 'Both Directions',
    },
  });
  const features = [];
  for (let k = -5; k <= 5; k++) features.push(roadAt(k * 120));
  return loadWorld({ buildings: { features: [] }, roads: { features } });
}

/**
 * Put the player behind the wheel of a kerbside car for the bubble
 * tests. Prefers a west-facing car: grid traffic all flows east on
 * the far kerb lane, so westbound is a clean run with no head-ons.
 * Crash damage is taken out of scope (health) — these tests isolate
 * the population system; police are held out the same way.
 */
function stealForDrive(g: Game): void {
  const parked = g.cars.filter((c) => c.kind === 'parked');
  const car = parked.find((c) => Math.cos(c.heading) < -0.99) ?? parked[0];
  car.stolen = true;
  car.health = 1e9;
  g.drivenCar = car;
  g.playerPos = { ...car.pos };
  g.playerHeading = car.heading;
  g.carInput = { throttle: 1, steer: 0 };
}

describe('v0.24 cold start & population bubble', () => {
  it('cold start on the REAL dataset: parked cars at the kerb + traffic rolling at spawn', () => {
    const g = new Game(loadWorld(JSON.parse(downtownRaw)), new MemoryStorage());
    const parked60 = g.cars.filter((c) => c.kind === 'parked' && dist(c.pos, SPAWN_POS) <= 60);
    const traffic150 = g.cars.filter((c) => c.kind === 'traffic' && dist(c.pos, SPAWN_POS) <= 150);
    expect(parked60.length).toBeGreaterThanOrEqual(3);
    expect(traffic150.length).toBeGreaterThanOrEqual(4);
  });

  it('anchor ring shows until the first car entry, then never again (persisted)', () => {
    const storage = new MemoryStorage();
    const g = new Game(toyWorld(), storage);
    const playerOf = (game: Game) => game.buildFrame().entities.find((e) => e.kind === 'player');
    expect(playerOf(g)?.anchor).toBe(true);
    // Get into a parked car that is NOT beside a payphone (interact
    // would answer the phone instead of opening the door).
    const starts = g.missions.available().map((m) => m.startPos);
    const clearance = (p: { x: number; z: number }) => Math.min(...starts.map((s) => dist(s, p)));
    const car = g.cars
      .filter((c) => c.kind === 'parked')
      .sort((a, b) => clearance(b.pos) - clearance(a.pos))[0];
    expect(clearance(car.pos)).toBeGreaterThan(7);
    g.playerPos = { ...car.pos };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    g.pressInteract(); // step back out
    expect(g.drivenCar).toBeNull();
    expect(playerOf(g)?.anchor).toBe(false);
    // Persisted: a fresh Game on the same storage never shows it.
    const g2 = new Game(toyWorld(), storage);
    expect(playerOf(g2)?.anchor).toBe(false);
  });

  it('traffic bubble holds at ≥8 within 220 m through a 60 s cross-map drive', () => {
    const g = new Game(gridWorld(), new MemoryStorage());
    stealForDrive(g);
    const step = 1 / 20;
    let samples = 0;
    for (let s = 0; s < 60 / step; s++) {
      g.wanted.heat = 0;
      g.cops = [];
      g.update(step);
      if (s % (5 / step) === (5 / step) - 1) {
        const n = g.cars.filter((c) => c.traffic && dist(c.pos, g.playerPos) <= BUBBLE_R).length;
        expect(n).toBeGreaterThanOrEqual(8);
        samples++;
      }
    }
    expect(samples).toBe(12);
    // The drive really crossed the map, it did not idle at spawn.
    expect(Math.abs(g.playerPos.x - SPAWN_POS.x)).toBeGreaterThan(500);
  });

  it('recycled traffic never pops in inside the view width', () => {
    const g = new Game(gridWorld(), new MemoryStorage());
    stealForDrive(g);
    const step = 1 / 20;
    const prev = new Map<string, { x: number; z: number }>();
    let teleports = 0;
    for (let s = 0; s < 60 / step; s++) {
      g.wanted.heat = 0;
      g.cops = [];
      g.update(step);
      const viewW = g.buildFrame().viewWidthM;
      for (const c of g.cars) {
        if (!c.traffic) continue;
        const before = prev.get(c.id);
        prev.set(c.id, { ...c.pos });
        if (!before) continue;
        const jump = Math.hypot(c.pos.x - before.x, c.pos.z - before.z);
        if (jump > 10) {
          // A discontinuity traffic flow can't produce (≤0.6 m/step):
          // this car was recycled — it must land outside the view.
          teleports++;
          expect(dist(c.pos, g.playerPos)).toBeGreaterThan(viewW);
        }
      }
    }
    expect(teleports).toBeGreaterThan(0); // the bubble actually recycled
  });
});

describe('v0.29 — first-drive hint, reversing signal, walk cycle', () => {
  it('the drive hint (with REVERSE) shows once, on the first car entry ever', () => {
    const storage = new MemoryStorage();
    const g = new Game(toyWorld(), storage);
    // Walk up to a parked car and press E — a real entry, not a poke.
    const car = g.cars.find((c) => c.kind === 'parked')!;
    g.playerPos = { ...car.pos };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    // The theft toast owns the slot first; the hint queues behind it.
    // (Heat cleared per-tick so a cop can't bust the parked test car.)
    let sawHint = false;
    for (let i = 0; i < 400 && !sawHint; i++) {
      g.wanted.heat = 0;
      g.cops = [];
      g.update(0.05);
      if (g.hud().toast === DRIVE_HINT) sawHint = true;
    }
    expect(sawHint).toBe(true);
    // Let the first hint's toast fully expire before judging round 2.
    for (let i = 0; i < 200 && g.hud().toast !== ''; i++) {
      g.wanted.heat = 0;
      g.cops = [];
      g.update(0.05);
    }
    expect(g.hud().toast).toBe('');
    // Exit, re-enter: the hint never fires again in this Game...
    g.pressInteract();
    expect(g.drivenCar).toBeNull();
    g.playerPos = { ...car.pos };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    for (let i = 0; i < 200; i++) {
      g.wanted.heat = 0;
      g.cops = [];
      g.update(0.05);
      expect(g.hud().toast).not.toBe(DRIVE_HINT);
    }
    // ...and the flag persisted: a fresh Game on the same storage
    // stays silent too.
    const g2 = new Game(toyWorld(), storage);
    const car2 = g2.cars.find((c) => c.kind === 'parked')!;
    g2.playerPos = { ...car2.pos };
    g2.pressInteract();
    expect(g2.drivenCar).toBe(car2);
    for (let i = 0; i < 200; i++) {
      g2.wanted.heat = 0;
      g2.cops = [];
      g2.update(0.05);
      expect(g2.hud().toast).not.toBe(DRIVE_HINT);
    }
  });

  it('hud().reversing and the driven entity flag light up while backing up', () => {
    const g = newGame();
    const car = g.cars.find((c) => c.kind === 'parked')!;
    car.stolen = true; // skip the theft/cop noise; this is a signal test
    g.drivenCar = car;
    g.playerPos = { ...car.pos };
    g.carInput = { throttle: -1, steer: 0 };
    let reversing = false;
    for (let i = 0; i < 120 && !reversing; i++) {
      g.update(0.05);
      reversing = g.hud().reversing;
    }
    expect(reversing).toBe(true);
    // Keep backing up until the speed is unambiguous, then check.
    for (let i = 0; i < 60 && g.hud().speedKmh < 10; i++) g.update(0.05);
    expect(g.hud().speedKmh).toBeGreaterThan(5);
    const driven = g.buildFrame().entities.find((e) => e.kind === 'car-driven')!;
    expect(driven.reversing).toBe(true);
    // Forward again: the signal clears.
    g.carInput = { throttle: 1, steer: 0 };
    for (let i = 0; i < 120 && g.hud().reversing; i++) g.update(0.05);
    expect(g.hud().reversing).toBe(false);
  });

  it('the player walk cycle advances with distance walked, not wall time', () => {
    const g = newGame();
    const before = g.buildFrame().entities.find((e) => e.kind === 'player')!;
    expect(before.walkPhase).toBe(0);
    expect(before.speedMps).toBe(0);
    // Stand still for game-time: phase must NOT advance.
    for (let i = 0; i < 40; i++) g.update(0.05);
    const idle = g.buildFrame().entities.find((e) => e.kind === 'player')!;
    expect(idle.walkPhase).toBe(0);
    // Walk east for a second: ~5.4 m at WALK_SPEED → phase cycles.
    g.moveInput = { x: 1, z: 0 };
    for (let i = 0; i < 20; i++) g.update(0.05);
    const walking = g.buildFrame().entities.find((e) => e.kind === 'player')!;
    expect(walking.speedMps!).toBeGreaterThan(4);
    expect(walking.walkPhase).toBeGreaterThan(0);
    expect(walking.heading).toBeCloseTo(0, 5); // facing the way he walks
  });

  it('peds carry a walk phase and speed too', () => {
    // The toy world spawns no peds (its roads start >420 m from
    // spawn) — use the real dataset, which has 20 walkers at spawn.
    const g = new Game(loadWorld(JSON.parse(downtownRaw)), new MemoryStorage());
    for (let i = 0; i < 20; i++) g.update(0.05);
    const peds = g.buildFrame().entities.filter((e) => e.kind === 'ped');
    expect(peds.length).toBeGreaterThan(0);
    for (const p of peds) {
      expect(typeof p.walkPhase).toBe('number');
      expect(p.speedMps).toBeGreaterThan(0);
    }
  });
});
