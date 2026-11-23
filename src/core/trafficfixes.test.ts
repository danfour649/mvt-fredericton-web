/**
 * v0.34 fixes — permanent tests for the two defects the 2026-11-23
 * exploratory pass convicted:
 *
 *  1. The bridge speed sentinel. GeoNB marks "no posted limit" as
 *     -1 in Speed_Restrictions_Both; both Westmorland Street Bridge
 *     spans carry it. cruiseFor's old `|| 40` guard caught 0 but let
 *     -1 through, giving those roads a cruise speed of -0.28 m/s:
 *     no traffic car could ever cross the bridge — cars thrashed at
 *     its gateway junctions and queued back into the small downtown
 *     streets (Daniel's phone report: "cars get stuck in small
 *     roads"). Fix: cruiseFor treats any non-positive limit as "none
 *     posted" (40 km/h default), and the world loader clamps the raw
 *     sentinel to 0 so it can never reach speed maths.
 *
 *  2. The player-brake freeze (exploratory Finding 2). The player-
 *     ahead brake fired for the player anywhere in the car's 9 m
 *     front hemisphere, so standing on the sidewalk froze the
 *     street; followers' caps collapsed to the leader's 0 and a
 *     15-car Queen St queue sat at exactly 0 for 6 sim-minutes.
 *     Fix: (a) the brake only fires when the player is inside the
 *     car's 1.7 m lane corridor (the same corridor the car-ahead
 *     logic uses); (b) a car held at ~0 for over ~6 s creeps at up
 *     to 1 m/s, easing to a stop 3.4 m short of the player or
 *     ~0.9 m behind its leader — a queue compresses and inches
 *     instead of freezing permanently. Hard stops (hit-pause,
 *     driverless, burning) never creep.
 */
import { describe, it, expect } from 'vitest';
import downtownRaw from '../../public/data/downtown.json?raw';
import { loadWorld, type WorldModel } from './world';
import { buildRoadGraph } from './routing';
import { cruiseFor, spawnTraffic, updateTraffic } from './traffic';
import { Game } from './game';
import { MemoryStorage } from './save';
import { unproject, dist, type Vec2 } from './geo';
import { SPAWN_POS } from './missions';

function realWorld(): WorldModel {
  return loadWorld(JSON.parse(downtownRaw));
}

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

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A point `along` metres ahead of a traffic car and `lateral`
 *  metres to its side, in the car's own frame. */
function aheadOf(pos: Vec2, heading: number, along: number, lateral: number): Vec2 {
  return {
    x: pos.x + Math.cos(heading) * along + Math.cos(heading + Math.PI / 2) * lateral,
    z: pos.z + Math.sin(heading) * along + Math.sin(heading + Math.PI / 2) * lateral,
  };
}

describe('[v0.34-fix] bridge speed sentinel', () => {
  it('no road in the real dataset gives a non-positive cruise speed', () => {
    const world = realWorld();
    for (const road of world.roads) {
      expect(cruiseFor(road), `cruise on "${road.name}"`).toBeGreaterThan(0);
    }
    // Unit-level: the sentinel values themselves are safe.
    const anyRoad = world.roads[0];
    expect(cruiseFor({ ...anyRoad, speedKmh: -1 })).toBeGreaterThan(0);
    expect(cruiseFor({ ...anyRoad, speedKmh: 0 })).toBeGreaterThan(0);
    expect(cruiseFor({ ...anyRoad, speedKmh: -1 })).toBeCloseTo(cruiseFor({ ...anyRoad, speedKmh: 0 }), 9);
  });

  it('the loader normalises the -1 sentinel on both bridge spans to 0', () => {
    const world = realWorld();
    // Seven segments carry the bridge's name; exactly two of them —
    // the 25.9 m and 109.1 m deck spans — carry the GeoNB -1
    // sentinel in the raw extract.
    const spans = world.roads.filter((r) => r.name === 'WESTMORLAND STREET BRIDGE' && r.speedKmh === 0);
    expect(spans.length).toBe(2);
    expect(spans.map((s) => Math.round(s.lengthM)).sort((x, y) => x - y)).toEqual([26, 109]);
    for (const span of spans) {
      expect(cruiseFor(span)).toBeCloseTo((40 * 1000) / 3600, 6);
    }
  });

  it('a traffic car drives across the Westmorland bridge', () => {
    const world = realWorld();
    const graph = buildRoadGraph(world);
    const ramp = world.roads.find(
      (r) => r.name === 'WESTMORLAND STREET BRIDGE ON Ramp' && Math.abs(r.lengthM - 163.1) < 0.5,
    )!;
    const car = spawnTraffic(ramp, ramp.lengthM * 0.5);
    const rng = mulberry(99);
    let minZ = Infinity;
    const visited = new Set<string>();
    for (let t = 0; t < 3000; t++) {
      // Game.updateTrafficCars' speed rule with no other cars.
      car.speedMps = car.stopped ? 0 : Math.max(0, car.baseSpeedMps);
      updateTraffic(car, 0.1, graph, rng);
      minZ = Math.min(minZ, car.pos.z);
      visited.add(car.road.name);
    }
    expect(visited.has('WESTMORLAND STREET BRIDGE')).toBe(true);
    // The bridge deck ends around z = -470; -600 is well onto the
    // south bank. Pre-fix the car never got past z = -444.
    expect(minZ).toBeLessThan(-600);
  }, 60000);
});

describe('[v0.34-fix] player-brake corridor and queue creep', () => {
  it('a player standing BESIDE the road does not stop traffic', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const a = g.cars.find((c) => c.kind === 'traffic')!;
    g.cars = [a];
    a.traffic = spawnTraffic(a.traffic!.road, 500);
    a.pos = { ...a.traffic.pos }; // entity sync, as the recycle path does
    a.heading = a.traffic.heading;
    // 6 m ahead but 4 m to the side: on the sidewalk, outside the
    // 1.7 m lane corridor. The old hemisphere test braked for this.
    g.playerPos = aheadOf(a.traffic.pos, a.traffic.heading, 6, 4);
    const startAlong = a.traffic.distAlong;
    for (let i = 0; i < 60; i++) g.update(0.05); // 3 s
    expect(a.traffic.speedMps).toBeGreaterThan(3);
    expect(a.traffic.distAlong).toBeGreaterThan(startAlong + 10);
  }, 60000);

  it('a player standing IN the lane still brakes the first car', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const a = g.cars.find((c) => c.kind === 'traffic')!;
    g.cars = [a];
    a.traffic = spawnTraffic(a.traffic!.road, 500);
    a.pos = { ...a.traffic.pos }; // entity sync, as the recycle path does
    a.heading = a.traffic.heading;
    g.playerPos = aheadOf(a.traffic.pos, a.traffic.heading, 6, 0);
    const startAlong = a.traffic.distAlong;
    // 2 s — inside the ~6 s creep timeout, so the car must be at a
    // genuine full stop, exactly as before the fix.
    for (let i = 0; i < 40; i++) g.update(0.05);
    expect(a.traffic.stopped).toBe(true);
    expect(a.traffic.speedMps).toBe(0);
    expect(Math.abs(a.traffic.distAlong - startAlong)).toBeLessThan(0.05);
  }, 60000);

  it('the queue behind an in-lane player creeps instead of freezing forever', () => {
    const g = new Game(toyWorld(), new MemoryStorage());
    const a = g.cars.find((c) => c.kind === 'traffic')!;
    const b = g.cars.find((c) => c.kind === 'traffic' && c !== a)!;
    const road = a.traffic!.road;
    g.cars = [a, b];
    a.traffic = spawnTraffic(road, 500);
    b.traffic = spawnTraffic(road, 462);
    a.pos = { ...a.traffic.pos };
    a.heading = a.traffic.heading;
    b.pos = { ...b.traffic.pos };
    b.heading = b.traffic.heading;
    // The player stands in the leader's lane, 7 m ahead, and does
    // not move for the whole test.
    const player = aheadOf(a.traffic.pos, a.traffic.heading, 7, 0);
    g.playerPos = player;
    const bStart = b.traffic.distAlong;
    let speedAt3s = -1;
    for (let i = 0; i < 1800; i++) {
      g.update(0.05); // 90 s total
      if (i === 60) speedAt3s = a.traffic.speedMps;
    }
    // Before the timeout the leader is at a full stop…
    expect(speedAt3s).toBe(0);
    // …then it creeps up to its stand-off distance from the player
    // (3.4 m by design) — it does NOT sit at 7 m forever, and it
    // never reaches or passes the player.
    const finalD = dist(a.pos, player);
    expect(finalD).toBeLessThan(3.9);
    expect(finalD).toBeGreaterThan(3.2);
    // The follower came up the road with the queue (it was 38 m
    // behind the leader) and never overlapped it.
    expect(b.traffic.distAlong).toBeGreaterThan(bStart + 15);
    const gap = (a.traffic.distAlong - b.traffic.distAlong) * a.traffic.dir;
    expect(gap).toBeGreaterThan(4.4);
    expect(gap).toBeLessThan(12);
  }, 120000);
});
