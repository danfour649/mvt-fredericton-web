/**
 * Feedback fixes (2026-11-21) — the r/newbrunswickcanada report on the
 * 2D demo: "Cars pass over each other, some just disappear. People
 * teleport." Each test pins one of the three complaints.
 */
import { describe, it, expect } from 'vitest';
import { Game } from './game';
import { loadWorld, type WorldModel } from './world';
import { unproject, dist } from './geo';
import { MemoryStorage } from './save';
import { SPAWN_POS } from './missions';
import { spawnTraffic } from './traffic';
import { spawnPeds, forceDown, updatePed, type Ped } from './peds';

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

function run(g: Game, seconds: number, dt = 0.05): void {
  for (let i = 0; i < Math.ceil(seconds / dt); i++) g.update(dt);
}

describe('[feedback] cars pass over each other', () => {
  it('two traffic cars stacked on the same spot separate instead of driving overlapped', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const a = g.cars.find((c) => c.kind === 'traffic')!;
    const b = g.cars.find((c) => c.kind === 'traffic' && c !== a)!;
    const road = a.traffic!.road;
    g.cars = [a, b];
    // The stack: both cars on the identical road point (the state a
    // junction merge or an occupied bubble-recycle landing produces).
    a.traffic = spawnTraffic(road, 500);
    b.traffic = spawnTraffic(road, 500);
    a.pos = { ...a.traffic.pos };
    b.pos = { ...b.traffic.pos };
    expect(dist(a.pos, b.pos)).toBeLessThan(0.01);
    g.playerPos = { x: a.pos.x, z: a.pos.z + 45 }; // off the road, near the pair
    run(g, 6);
    // They must no longer be one overlapped blob, and neither may
    // have passed through the other (order along the road preserved
    // or separated by a full car length in either arrangement).
    expect(dist(a.pos, b.pos)).toBeGreaterThan(4.4);
  });
});

describe('[feedback] cars disappear', () => {
  it('while zoomed out to the whole map, no traffic car is recycled (nothing vanishes or pops in)', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    g.setZoomView(4000); // whole-map zoom-out
    run(g, 3); // let the camera chase reach the wide view
    const before = new Map(g.cars.filter((c) => c.traffic).map((c) => [c.id, { ...c.pos }]));
    let maxJump = 0;
    for (let i = 0; i < 200; i++) {
      g.update(0.05);
      for (const c of g.cars) {
        if (!c.traffic) continue;
        const prev = before.get(c.id);
        if (prev) maxJump = Math.max(maxJump, dist(c.pos, prev));
        before.set(c.id, { ...c.pos });
      }
    }
    // Per-tick movement at cruise is < 1 m; a recycle is a > 100 m
    // jump. Zoomed out, the whole toy map is on screen, so recycling
    // must simply not happen.
    expect(maxJump).toBeLessThan(2);
  });
});

describe('[feedback] people teleport', () => {
  it('a downed ped gets up where they fell, not 25 m away', () => {
    const world = toyWorld();
    const peds: Ped[] = spawnPeds(world, { x: -500, z: SPAWN_POS.z }, 1, () => 0.42);
    const ped = peds[0];
    const fellAt = { ...ped.pos };
    forceDown(ped, 0.1);
    updatePed(ped, 0.2);
    expect(ped.state).toBe('walk');
    expect(dist(ped.pos, fellAt)).toBeLessThan(1);
  });

  it('a fleeing ped returns to the path continuously (no step > 1 m)', () => {
    const world = toyWorld();
    const peds: Ped[] = spawnPeds(world, { x: -500, z: SPAWN_POS.z }, 1, () => 0.42);
    const ped = peds[0];
    // Trigger a flee with a fast threat beside the ped.
    updatePed(ped, 0.05, { pos: { x: ped.pos.x - 6, z: ped.pos.z }, speed: 8 });
    expect(ped.state).toBe('flee');
    let prev = { ...ped.pos };
    let maxStep = 0;
    for (let i = 0; i < 200 && ped.state === 'flee'; i++) {
      updatePed(ped, 0.05);
      maxStep = Math.max(maxStep, dist(ped.pos, prev));
      prev = { ...ped.pos };
    }
    expect(ped.state).toBe('walk');
    expect(maxStep).toBeLessThan(1);
  });
});

describe('[feedback] the car stays where you left it (Daniel, 2026-11-21)', () => {
  it('a stolen traffic car does not drive away after the player gets out', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const car = g.cars.find((c) => c.kind === 'traffic')!;
    g.playerPos = { x: car.pos.x + 1.5, z: car.pos.z };
    g.pressInteract();
    expect(g.drivenCar).toBe(car);
    g.pressInteract(); // step back out
    expect(g.drivenCar).toBeNull();
    const leftAt = { ...car.pos };
    run(g, 5);
    // Still there, still parked where it was left — before the fix
    // the traffic sim resumed its route at full speed (~14 m/s)
    // the moment the player exited, and the car "disappeared".
    expect(g.cars.includes(car)).toBe(true);
    expect(dist(car.pos, leftAt)).toBeLessThan(1);
  });

  it('a burning traffic car burns and explodes in place instead of driving off mid-fuse', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const car = g.cars.find((c) => c.kind === 'traffic')!;
    g.playerPos = { x: car.pos.x + 30, z: car.pos.z };
    car.burning = true;
    car.burnT = 1.0;
    const leftAt = { ...car.pos };
    run(g, 3);
    expect(car.exploded).toBe(true);
    expect(car.wrecked).toBe(true);
    expect(g.cars.includes(car)).toBe(true); // the wreck stays
    expect(dist(car.pos, leftAt)).toBeLessThan(1);
  });
});
