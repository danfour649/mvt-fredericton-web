/**
 * Junction routing tests (v0.21 addition B): traffic must circulate —
 * cross junctions onto different road segments — instead of the v0.20
 * ping-pong at road ends. Dead ends still U-turn.
 */
import { describe, it, expect } from 'vitest';
import { loadWorld } from './world';
import { unproject } from './geo';
import { buildRoadGraph, findRoute } from './routing';
import { spawnTraffic, updateTraffic } from './traffic';

function line(name: string, pts: [number, number][]) {
  return {
    geometry: {
      type: 'LineString',
      coordinates: pts.map(([x, z]) => {
        const ll = unproject(x, z);
        return [ll.lng, ll.lat];
      }),
    },
    properties: { Formatted_Street_Name: name, Speed_Restrictions_Both: 50, Number_Of_Lanes: 2 },
  };
}

/** A T/L network: A runs west->junction, B runs junction->south, C junction->east. */
function network() {
  return loadWorld({
    buildings: { features: [] },
    roads: {
      features: [
        line('A St', [[-120, 0], [0, 0]]),
        line('B St', [[0, 0], [0, 120]]),
        line('C St', [[0, 0], [120, 0]]),
      ],
    },
  });
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('junction routing', () => {
  it('builds a shared node where three road ends meet', () => {
    const world = network();
    const graph = buildRoadGraph(world);
    const junction = graph.nodes.find((n) => n.edges.length >= 3);
    expect(junction).toBeTruthy();
    expect(junction!.edges.length).toBe(3);
  });

  it('a traffic car simulated for 120 s crosses junctions onto other segments', () => {
    const world = network();
    const graph = buildRoadGraph(world);
    const rng = mulberry(42);
    const car = spawnTraffic(world.roads[0], 5);
    const visited = new Set<string>([car.road.name]);
    let switches = 0;
    let lastRoad = car.road;
    const dt = 1 / 30;
    for (let t = 0; t < 120; t += dt) {
      updateTraffic(car, dt, graph, rng);
      if (car.road !== lastRoad) {
        switches++;
        lastRoad = car.road;
      }
      visited.add(car.road.name);
    }
    expect(switches).toBeGreaterThanOrEqual(2);
    expect(visited.size).toBeGreaterThanOrEqual(2);
  });

  it('dead end: the only option is a U-turn on the same road', () => {
    const world = network();
    const graph = buildRoadGraph(world);
    const rng = mulberry(7);
    // Road B ends at (0,120) — a dead end. Drive there.
    const car = spawnTraffic(world.roads[1], world.roads[1].lengthM - 5);
    car.dir = 1;
    const dt = 1 / 30;
    let flipped = false;
    for (let t = 0; t < 20 && !flipped; t += dt) {
      updateTraffic(car, dt, graph, rng);
      const d: number = car.dir;
      if (d === -1) flipped = true;
    }
    expect(flipped).toBe(true);
    expect(car.road.name).toBe('B St');
  });

  it('without a graph the legacy ping-pong still works (spawnTraffic callers unaffected)', () => {
    const world = network();
    const car = spawnTraffic(world.roads[0], world.roads[0].lengthM - 2);
    const dt = 1 / 30;
    for (let t = 0; t < 3; t += dt) updateTraffic(car, dt);
    expect(car.dir).toBe(-1);
  });
});

describe('findRoute — iteration 5 map-pick routing', () => {
  it('routes across a junction and ends exactly on the target', () => {
    const world = network();
    const graph = buildRoadGraph(world);
    const route = findRoute(graph, world, { x: -100, z: 0 }, { x: 0, z: 100 });
    expect(route).not.toBeNull();
    const last = route![route!.length - 1];
    expect(last.x).toBeCloseTo(0, 6);
    expect(last.z).toBeCloseTo(100, 6);
    // The path must pass through the junction, not cut the corner.
    expect(route!.some((p) => Math.hypot(p.x, p.z) < 30)).toBe(true);
  });

  it('same-road targets take the direct sub-path along the street', () => {
    const world = network();
    const graph = buildRoadGraph(world);
    const route = findRoute(graph, world, { x: -100, z: 0 }, { x: -40, z: 0 });
    expect(route).not.toBeNull();
    expect(route!.every((p) => Math.abs(p.z) < 0.01)).toBe(true);
    const last = route![route!.length - 1];
    expect(last.x).toBeCloseTo(-40, 6);
    expect(last.z).toBeCloseTo(0, 6);
  });

  it('returns null for a road island with no junction or link to the network', () => {
    const world = loadWorld({
      buildings: { features: [] },
      roads: {
        features: [
          line('A St', [[-120, 0], [0, 0]]),
          line('B St', [[0, 0], [0, 120]]),
          line('Far St', [[300, 300], [420, 300]]),
        ],
      },
    });
    const graph = buildRoadGraph(world);
    expect(findRoute(graph, world, { x: -100, z: 0 }, { x: 360, z: 300 })).toBeNull();
  });

  it('leaves by the FAR endpoint when the near one is a dead end (multi-source start)', () => {
    // R1 runs (0,0)->(100,0); only its east end junctions onward.
    // A point 10 m from the west (dead) end must still route out
    // east — seeding Dijkstra from the nearest endpoint only
    // would strand it.
    const world = loadWorld({
      buildings: { features: [] },
      roads: {
        features: [
          line('R1 St', [[0, 0], [100, 0]]),
          line('R2 St', [[100, 0], [100, 100]]),
        ],
      },
    });
    const graph = buildRoadGraph(world);
    const route = findRoute(graph, world, { x: 10, z: 0 }, { x: 100, z: 80 });
    expect(route).not.toBeNull();
    const last = route![route!.length - 1];
    expect(last.x).toBeCloseTo(100, 6);
    expect(last.z).toBeCloseTo(80, 6);
  });
});
