/**
 * v0.25 systems audit — scripted end-to-end checks for every game
 * system, written for docs/AUDIT-v025.md. State-machine level for all
 * four missions; drive level for the Queen Street Errand (a pursuit
 * controller actually steers the car through it). The two tests marked
 * [v0.25-fix] pin behaviour that did not exist before this release:
 * traffic follow/braking and the pedestrian bubble.
 */
import { describe, it, expect } from 'vitest';
import { Game, GOAL_SCORE, RESPRAY_COST_PER_STAR } from './game';
import { loadWorld, type WorldModel } from './world';
import { unproject, dist } from './geo';
import { MemoryStorage } from './save';
import { SPAWN_POS, type MissionDef } from './missions';
import { spawnTraffic } from './traffic';
import { spawnCop } from './cops';
import { updatePed } from './peds';
import downtownRaw from '../../public/data/downtown.json?raw';

function toyWorld(): WorldModel {
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

function realWorld(): WorldModel {
  return loadWorld(JSON.parse(downtownRaw));
}

function newGame(world: WorldModel = toyWorld()): Game {
  return new Game(world, new MemoryStorage());
}

/** Run the simulation for `seconds` of game time in fixed steps. */
function run(g: Game, seconds: number, dt = 0.05): void {
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i++) g.update(dt);
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Test driver: steer the driven car at a target point until close.
 *  Has a simple unstick: if the car barely moves for ~1.2 s (wedged
 *  on a building corner or in a traffic queue), it reverses out with
 *  opposite lock briefly, then resumes. */
function driveTo(g: Game, target: { x: number; z: number }, timeoutSec = 30): boolean {
  let lastPos = { ...(g.drivenCar?.pos ?? { x: 0, z: 0 }) };
  let stillT = 0;
  let unstickT = 0;
  for (let t = 0; t < timeoutSec; t += 0.05) {
    const car = g.drivenCar;
    if (!car) return false;
    if (dist(car.pos, target) < 4.5) {
      g.carInput = { throttle: 0, steer: 0 };
      return true;
    }
    if (dist(car.pos, lastPos) > 0.4) {
      lastPos = { ...car.pos };
      stillT = 0;
    } else {
      stillT += 0.05;
    }
    const desired = Math.atan2(target.z - car.pos.z, target.x - car.pos.x);
    const err = wrapPi(desired - car.heading);
    const d = dist(car.pos, target);
    if (unstickT > 0) {
      unstickT -= 0.05;
      g.carInput = { steer: err > 0 ? -1 : 1, throttle: -0.8 };
    } else if (stillT > 1.2) {
      unstickT = 0.7;
      stillT = 0;
    } else {
      g.carInput = {
        steer: Math.max(-1, Math.min(1, err * 2.4)),
        throttle: Math.abs(err) > 2.4 ? -0.6 : d < 9 ? 0.35 : 0.85,
      };
    }
    g.update(0.05);
  }
  return false;
}

/** Walk the on-foot player to a target point. */
function walkTo(g: Game, target: { x: number; z: number }, timeoutSec = 30): boolean {
  for (let t = 0; t < timeoutSec; t += 0.05) {
    if (dist(g.playerPos, target) < 1.2) {
      g.moveInput = { x: 0, z: 0 };
      return true;
    }
    const dx = target.x - g.playerPos.x;
    const dz = target.z - g.playerPos.z;
    const l = Math.hypot(dx, dz) || 1;
    g.moveInput = { x: dx / l, z: dz / l };
    g.update(0.05);
  }
  return false;
}

/** Complete the active mission at state-machine level (teleports). */
function completeAtStateLevel(g: Game, m: MissionDef): void {
  g.playerPos = { ...m.startPos };
  g.pressInteract();
  expect(g.missions.active?.id).toBe(m.id);
  for (const step of m.steps) {
    if (step.kind === 'interact') {
      if (g.drivenCar) g.pressInteract(); // step out first
      g.playerPos = { ...step.pos! };
      g.pressInteract();
    } else if (step.kind === 'steal_vehicle') {
      const parked = g.cars.find((c) => c.kind === 'parked' && !c.wrecked)!;
      g.playerPos = { x: parked.pos.x + 2.5, z: parked.pos.z };
      g.pressInteract();
      expect(g.drivenCar).toBe(parked);
    } else if (step.kind === 'deliver_vehicle') {
      const car = g.drivenCar!;
      car.pos = { ...step.pos! };
      car.vel = { x: 0, z: 0 };
      g.playerPos = { ...step.pos! };
      g.update(0.05);
    }
  }
  expect(g.missions.active).toBeNull();
  expect(g.missions.completed.has(m.id)).toBe(true);
}

// ---------------------------------------------------------------------------

describe('audit: all four missions completable (state level, real dataset)', () => {
  for (const id of ['queen_street_errand', 'cap_wheels', 'downtown_burner', 'george_street_drop']) {
    it(`${id}: start → steps → payout ×100 ×multiplier, multiplier +1`, () => {
      const g = newGame(realWorld());
      const m = g.missions.available().find((x) => x.id === id)!;
      const before = g.wallet.money;
      const multBefore = g.wallet.multiplier;
      completeAtStateLevel(g, m);
      // Steal missions also bank the $500 theft bonus (at the same
      // multiplier) when the car is taken mid-mission.
      const theft = m.steps.some((s) => s.kind === 'steal_vehicle') ? 500 * multBefore : 0;
      expect(g.wallet.money - before).toBe(m.payout * 100 * multBefore + theft);
      expect(g.wallet.multiplier).toBe(multBefore + 1);
      expect(g.hud().toast).toContain('complete!');
    });
  }

  it('downtown_burner: running the clock out fails it and it can be re-taken', () => {
    const g = newGame(realWorld());
    const m = g.missions.available().find((x) => x.id === 'downtown_burner')!;
    g.playerPos = { ...m.startPos };
    g.pressInteract();
    expect(g.missions.active?.id).toBe('downtown_burner');
    expect(g.hud().timerSec).not.toBeNull();
    run(g, 82);
    expect(g.missions.active).toBeNull();
    expect(g.missions.completed.has('downtown_burner')).toBe(false);
    expect(g.missions.available().some((x) => x.id === 'downtown_burner')).toBe(true);
  });
});

describe('audit: Queen Street Errand at DRIVE level', () => {
  it('walk to payphone, drive the legs, E at both stops, payout lands', () => {
    const g = newGame(realWorld());
    const m = g.missions.available().find((x) => x.id === 'queen_street_errand')!;
    // Walk to the payphone and answer it.
    expect(walkTo(g, m.startPos, 20)).toBe(true);
    g.pressInteract();
    expect(g.missions.active?.id).toBe(m.id);
    // Steal the nearest parked car (the errand is a driving job).
    const parked = g.cars
      .filter((c) => c.kind === 'parked' && !c.wrecked)
      .sort((a, b) => dist(a.pos, g.playerPos) - dist(b.pos, g.playerPos))[0];
    expect(walkTo(g, parked.pos, 20)).toBe(true);
    g.pressInteract();
    expect(g.drivenCar).toBe(parked);
    // Drive to the pickup, step out, take the envelope.
    expect(driveTo(g, m.steps[0].pos!, 40)).toBe(true);
    g.pressInteract(); // exit car
    expect(g.drivenCar).toBeNull();
    g.playerPos = { ...m.steps[0].pos! };
    g.pressInteract(); // take envelope
    expect(g.missions.stepIndex).toBe(1);
    // Isolate the mission system for the drive back: the theft heat
    // from taking the car is audited in the wanted/busted suites —
    // here it would only let a cop bust the test driver mid-leg and
    // take the car (and the test) with it.
    g.wanted.reset();
    g.cops = [];
    // Back in a car (the bubble may have recycled a different kerb
    // car next to the stop — E enters the NEAREST one, which is the
    // correct behaviour; don't pin the identity), drive the drop.
    g.playerPos = { x: parked.pos.x + 2.5, z: parked.pos.z };
    g.pressInteract();
    expect(g.drivenCar).not.toBeNull();
    expect(driveTo(g, m.steps[1].pos!, 40)).toBe(true);
    g.pressInteract(); // exit
    g.playerPos = { ...m.steps[1].pos! };
    g.pressInteract(); // deliver
    expect(g.missions.completed.has(m.id)).toBe(true);
    expect(g.wallet.money).toBeGreaterThanOrEqual(150 * 100);
  });
});

describe('audit: entering and exiting cars', () => {
  it('parked car: E enters, E exits beside the car', () => {
    const g = newGame();
    const car = g.cars.find((c) => c.kind === 'parked')!;
    g.playerPos = { x: car.pos.x + 2.5, z: car.pos.z };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    g.pressInteract();
    expect(g.drivenCar).toBeNull();
    expect(dist(g.playerPos, car.pos)).toBeLessThan(3.2);
  });

  it('traffic carjack: stolen traffic car becomes a rigid body under player control', () => {
    const g = newGame(realWorld());
    const car = g.cars.find((c) => c.kind === 'traffic' && c.traffic)!;
    g.playerPos = { ...car.pos };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    expect(car.stolen).toBe(true);
    // Rigid-body evidence: throttle + steer change heading like physics,
    // and the traffic placer no longer overwrites the position.
    g.carInput = { throttle: 1, steer: 0 };
    run(g, 1.5);
    expect(Math.abs(car.speed)).toBeGreaterThan(3);
    const h0 = car.heading;
    g.carInput = { throttle: 0.6, steer: 1 };
    run(g, 1);
    expect(Math.abs(wrapPi(car.heading - h0))).toBeGreaterThan(0.25);
  });

  it('a cop car cannot be entered', () => {
    const g = newGame();
    // Find a stretch of road with no stealable car within 9 m.
    let spot = { ...SPAWN_POS };
    for (let x = -520; x <= 520; x += 20) {
      const p = { x: SPAWN_POS.x + x, z: SPAWN_POS.z };
      if (g.cars.every((c) => dist(c.pos, p) > 9)) { spot = p; break; }
    }
    g.playerPos = { ...spot };
    g.cops.push(spawnCop({ x: spot.x + 2, z: spot.z }, 0));
    g.pressInteract();
    expect(g.drivenCar).toBeNull();
  });
});

describe('audit: BUSTED / WASTED / GAME OVER flows', () => {
  it('on-foot bust: 2 s of cop contact → stamp → fine + halved multiplier + respawn', () => {
    const g = newGame();
    g.wallet.set(5000);
    g.wallet.multiplier = 3;
    g.wanted.add(2);
    const cop = spawnCop({ x: g.playerPos.x + 2, z: g.playerPos.z }, 0);
    g.cops.push(cop);
    // Pin the cop beside the player (boxed in) until the meter fills.
    let guard = 0;
    while (g.phase === 'play' && guard++ < 200) {
      cop.pos = { x: g.playerPos.x + 2, z: g.playerPos.z };
      cop.vel = { x: 0, z: 0 };
      cop.speed = 0;
      g.update(0.05);
    }
    expect(g.phase).toBe('busted');
    expect(g.hud().stamp).toBe('BUSTED');
    run(g, 2.6);
    expect(g.phase).toBe('play');
    expect(g.wallet.money).toBe(5000 - 1000);
    expect(g.wallet.multiplier).toBe(1); // floor(3/2)
    expect(g.wanted.stars).toBe(0);
    expect(g.playerPos).toEqual(SPAWN_POS);
  });

  it('in-car bust: stopped with a cop alongside → impound + penalties', () => {
    const g = newGame();
    const car = g.cars.find((c) => c.kind === 'parked')!;
    g.playerPos = { x: car.pos.x + 2.5, z: car.pos.z };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    g.wallet.set(5000);
    g.wanted.add(2);
    const cop = spawnCop({ x: car.pos.x + 5, z: car.pos.z }, 0);
    g.cops.push(cop);
    let guard = 0;
    while (g.phase === 'play' && guard++ < 300) {
      // Boxed in: hold the car still, cop alongside.
      car.vel = { x: 0, z: 0 };
      car.speed = 0;
      car.pos = { ...car.pos };
      cop.pos = { x: car.pos.x + 5, z: car.pos.z };
      cop.vel = { x: 0, z: 0 };
      cop.speed = 0;
      g.cops = [cop];
      g.update(0.05);
    }
    expect(g.phase).toBe('busted');
    run(g, 2.6);
    expect(g.phase).toBe('play');
    expect(g.drivenCar).toBeNull();
    expect(g.cars.includes(car)).toBe(false); // impounded
    expect(g.wallet.money).toBe(4000);
  });

  it('wasted: health zero → stamp → life lost, hospital fee, respawn', () => {
    const g = newGame();
    g.wallet.set(2000);
    g.playerHealth = 0;
    g.update(0.05);
    expect(g.phase).toBe('wasted');
    expect(g.hud().stamp).toBe('WASTED');
    expect(g.lives).toBe(4);
    run(g, 2.6);
    expect(g.phase).toBe('play');
    expect(g.wallet.money).toBe(1500); // $500 hospital fee
    expect(g.playerHealth).toBe(100);
    expect(g.playerPos).toEqual(SPAWN_POS);
  });

  it('game over on the last life, restart resets the run', () => {
    const g = newGame();
    g.lives = 1;
    g.wallet.set(9000);
    g.playerHealth = 0;
    g.update(0.05);
    run(g, 2.6);
    expect(g.phase).toBe('gameover');
    g.pressRestart();
    expect(g.phase).toBe('play');
    expect(g.lives).toBe(5);
    expect(g.wallet.money).toBe(0);
    expect(g.wallet.multiplier).toBe(1);
    expect(g.playerPos).toEqual(SPAWN_POS);
  });
});

describe('audit: crash regressions', () => {
  it('[v0.25-fix] a cop ram that wrecks the player car ejects instead of throwing', () => {
    const g = newGame();
    const car = g.cars.find((c) => c.kind === 'parked')!;
    g.playerPos = { x: car.pos.x + 2.5, z: car.pos.z };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    car.health = 1; // one solid ram from wrecked
    g.wanted.add(2);
    const cop = spawnCop({ x: car.pos.x + 3, z: car.pos.z }, Math.PI);
    cop.vel = { x: -12, z: 0 };
    cop.speed = -12;
    g.cops.push(cop);
    expect(() => run(g, 0.5)).not.toThrow();
    expect(car.wrecked).toBe(true);
    expect(g.drivenCar).toBeNull(); // ejected beside the wreck
  });
});

describe('audit: district goal → EXIT → DISTRICT COMPLETE → freeroam', () => {
  it('goal flips to-exit, exit completes, freeroam resumes play, archive persists', () => {
    const storage = new MemoryStorage();
    const g = new Game(toyWorld(), storage);
    g.wallet.set(GOAL_SCORE - 1);
    const m = g.missions.available().find((x) => x.id === 'queen_street_errand')!;
    completeAtStateLevel(g, m); // the payout crosses the goal
    expect(g.goalState).toBe('to-exit');
    g.playerPos = { ...g.exitPos };
    g.update(0.05);
    expect(g.phase).toBe('district-done');
    g.confirmFreeroam();
    expect(g.phase).toBe('play');
    const g2 = new Game(toyWorld(), storage);
    expect(g2.goalState).toBe('done');
  });
});

describe('audit: wanted system', () => {
  it('heat decays only while no cop is within 45 m', () => {
    const g = newGame();
    g.wanted.add(2);
    run(g, 2); // no cops exist yet (spawn needs stars>0 — they will come)
    // Cops may have spawned during those 2 s; clear them and re-measure
    // a clean decay window, then a blocked window.
    g.cops = [];
    g.wanted.heat = 2;
    g.update(0.05);
    expect(g.wanted.heat).toBeLessThan(2); // decayed with no cop near
    g.wanted.heat = 2;
    g.cops.push(spawnCop({ x: g.playerPos.x + 20, z: g.playerPos.z }, 0));
    g.update(0.05);
    expect(g.wanted.heat).toBe(2); // cop within 45 m: no decay
  });

  it('cop pressure scales with stars (2 stars → 2 cops) and gives up when clean and far', () => {
    const g = newGame();
    g.wanted.add(2);
    // Poll until both cops exist (early-exit: an arrived cop sitting on
    // a stationary player for 2 s would legitimately bust them, which
    // is a different test's job).
    let guard = 0;
    while (g.cops.length < 2 && guard++ < 200) g.update(0.05);
    expect(g.cops.length).toBe(2);
    g.wanted.reset();
    // Teleport far away: heat 0 + distance > 200 m → cops abandon.
    g.playerPos = { x: SPAWN_POS.x + 500, z: SPAWN_POS.z };
    run(g, 1);
    expect(g.cops.length).toBe(0);
  });

  it('ped hit adds a star and pays out (state level)', () => {
    const g = newGame(realWorld());
    const car = g.cars.find((c) => c.kind === 'parked')!;
    g.playerPos = { x: car.pos.x + 2.5, z: car.pos.z };
    g.pressInteract();
    const ped = g.peds[0];
    car.pos = { x: ped.pos.x - 6, z: ped.pos.z };
    car.vel = { x: 8, z: 0 };
    car.heading = 0;
    car.speed = 8;
    const moneyBefore = g.wallet.money;
    const heatBefore = g.wanted.heat;
    g.carInput = { throttle: 0.7, steer: 0 }; // run the fleeing ped down
    run(g, 2.5);
    g.carInput = { throttle: 0, steer: 0 };
    expect(g.wallet.money).toBeGreaterThan(moneyBefore);
    expect(g.wanted.heat).toBeGreaterThan(heatBefore);
  });
});

describe('audit: respray edge cases', () => {
  it('partial funds: spend caps at the balance, heat still clears, car repainted', () => {
    const g = newGame();
    const car = g.cars[0];
    g.wallet.set(300);
    g.wanted.add(2);
    g.drivenCar = car;
    const oldColor = car.color;
    car.pos = { ...g.resprayPos };
    g.playerPos = { ...g.resprayPos };
    g.update(0.05);
    expect(g.wanted.stars).toBe(0);
    expect(g.wallet.money).toBe(0); // paid the 300 it had of the 1000
    expect(car.color).not.toBe(oldColor);
  });
  it('cost is $500 × stars', () => {
    expect(RESPRAY_COST_PER_STAR).toBe(500);
  });
});

describe('audit: save persistence across reload', () => {
  it('archive (completed missions, best score, hasEnteredCar) survives a new Game', () => {
    const storage = new MemoryStorage();
    const g = new Game(toyWorld(), storage);
    // Anchor ring on before any car entry.
    const frameBefore = g.buildFrame();
    expect(frameBefore.entities.find((e) => e.id === 'player')?.anchor).toBe(true);
    const m = g.missions.available().find((x) => x.id === 'queen_street_errand')!;
    completeAtStateLevel(g, m); // includes a car entry along the way? no — errand is on foot
    // Enter a car to flip hasEnteredCar.
    const car = g.cars.find((c) => c.kind === 'parked')!;
    g.playerPos = { x: car.pos.x + 2.5, z: car.pos.z };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    const g2 = new Game(toyWorld(), storage);
    const frameAfter = g2.buildFrame();
    expect(frameAfter.entities.find((e) => e.id === 'player')?.anchor).toBe(false);
    expect((g2 as unknown as { archive: { completed: string[] } }).archive.completed).toContain('queen_street_errand');
  });
});

describe('audit: HUD surface', () => {
  it('goal hairline tracks score; brief appears on mission start; timer shows on timed missions', () => {
    const g = newGame(realWorld());
    g.wallet.set(GOAL_SCORE / 2);
    expect(g.hud().goalPct).toBeCloseTo(0.5, 5);
    const m = g.missions.available().find((x) => x.id === 'downtown_burner')!;
    g.playerPos = { ...m.startPos };
    g.pressInteract();
    expect(g.hud().brief).toContain('Downtown Burner');
    expect(g.hud().timerSec).not.toBeNull();
    expect(g.hud().objective).toContain('Steal any parked car');
  });
});

// ---------------------------------------------------------------------------
// v0.25 fixes — these two describe blocks FAIL on v0.24 code.

describe('[v0.25-fix] traffic follows and brakes behind a leader', () => {
  it('a follower queues behind a stopped car instead of driving through it', () => {
    const g = newGame();
    const a = g.cars.find((c) => c.kind === 'traffic')!;
    const b = g.cars.find((c) => c.kind === 'traffic' && c !== a)!;
    const road = a.traffic!.road;
    g.cars = [a, b]; // isolate the pair: no bubble recycling mid-measurement
    a.traffic = spawnTraffic(road, 500);
    b.traffic = spawnTraffic(road, 462);
    a.trafficStopT = 9999; // leader held stopped
    b.trafficStopT = 0;
    // Keep the pair near the player so the bubble doesn't recycle them,
    // and keep the player's own car out of the corridor.
    g.playerPos = { x: a.pos.x + 30, z: a.pos.z };
    let minGap = Infinity;
    for (let i = 0; i < 240; i++) {
      g.update(0.05);
      g.playerPos = { x: a.pos.x + 30, z: a.pos.z };
      const gap = (a.traffic.distAlong - b.traffic.distAlong) * a.traffic.dir;
      if (gap < minGap) minGap = gap;
    }
    const finalGap = (a.traffic.distAlong - b.traffic.distAlong) * a.traffic.dir;
    expect(minGap).toBeGreaterThan(4.4); // bumpers never met
    expect(finalGap).toBeGreaterThan(4.4);
    expect(finalGap).toBeLessThan(14); // it queued, not stopped far back
    expect(Math.abs(b.traffic.speedMps)).toBeLessThan(6); // capped by the leader
    // Leader pulls away → follower resumes. (Move the player OFF the
    // road first: in phase 1 they stood in the leader's lane, and the
    // player-block brake correctly held the queue behind them.)
    a.trafficStopT = 0;
    g.playerPos = { x: a.pos.x, z: a.pos.z + 45 };
    run(g, 3);
    const gapAfter = (a.traffic.distAlong - b.traffic.distAlong) * a.traffic.dir;
    expect(gapAfter).toBeGreaterThan(4.4);
    expect(b.traffic.speedMps).toBeGreaterThan(2);
  });
});

describe('[v0.25-fix] pedestrians bubble around the player', () => {
  it('after the player crosses the map, peds are re-anchored nearby and still flee', () => {
    const g = newGame(realWorld());
    // West end of the extract: 13 roads within 220 m of this point
    // (probed against the dataset — several other corners are river).
    const far = { x: SPAWN_POS.x - 600, z: SPAWN_POS.z + 500 };
    g.playerPos = { ...far };
    run(g, 3);
    const near = g.peds.filter((p) => dist(p.pos, far) <= 260);
    expect(near.length).toBeGreaterThanOrEqual(10);
    // A recycled ped still flees a fast car.
    const ped = near[0];
    ped.state = 'walk';
    const ev = updatePed(ped, 0.05, { pos: { x: ped.pos.x - 6, z: ped.pos.z }, speed: 8 });
    expect(ev).toBeNull();
    expect(ped.state).toBe('flee');
  });
});
