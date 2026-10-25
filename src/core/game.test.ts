import { describe, it, expect } from 'vitest';
import { Game, GOAL_SCORE, RESPRAY_COST_PER_STAR } from './game';
import { Wallet, BUSTED_FINE } from './wallet';
import { loadWorld } from './world';
import { unproject } from './geo';
import { MemoryStorage } from './save';
import { SPAWN_POS } from './missions';

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

  it('cop spawns scale with stars and cap at 4', () => {
    const g = newGame();
    g.wanted.heat = 5;
    for (let i = 0; i < 40; i++) g.update(0.1);
    expect(g.cops.length).toBeGreaterThan(0);
    expect(g.cops.length).toBeLessThanOrEqual(4);
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
