/**
 * Traffic: cars that follow road polylines in the core frame. Uses GeoNB's
 * Dir_of_Traffic_Flow where sensible: "Opposite Direction" roads are driven
 * against the digitised path direction; anything else follows it. Cars
 * ping-pong at road ends (v0 simplification — no intersection routing yet).
 */
import type { Vec2 } from './geo';
import { pointAlongRoad, type Road } from './world';

export interface TrafficCar {
  road: Road;
  /** Metres along the road path. */
  distAlong: number;
  /** +1 travelling along the path, -1 against it. */
  dir: 1 | -1;
  speedMps: number;
  pos: Vec2;
  heading: number;
  stopped: boolean;
}

export function spawnTraffic(road: Road, distAlong: number): TrafficCar {
  const dir: 1 | -1 = road.dirFlow.includes('Opposite') ? -1 : 1;
  const speedMps = Math.min(11, ((road.speedKmh || 40) * 1000) / 3600);
  const car: TrafficCar = {
    road,
    distAlong,
    dir,
    speedMps,
    pos: { x: 0, z: 0 },
    heading: 0,
    stopped: false,
  };
  placeTraffic(car);
  return car;
}

function placeTraffic(car: TrafficCar): void {
  const { pos, heading } = pointAlongRoad(car.road, car.distAlong);
  const travelHeading = car.dir === 1 ? heading : heading + Math.PI;
  // Drive on the right: offset perpendicular-right of the travel direction.
  const off = car.road.widthM * 0.22;
  car.pos = {
    x: pos.x + Math.cos(travelHeading + Math.PI / 2) * off,
    z: pos.z + Math.sin(travelHeading + Math.PI / 2) * off,
  };
  car.heading = travelHeading;
}

export function updateTraffic(car: TrafficCar, dt: number): void {
  if (car.stopped) return;
  car.distAlong += car.dir * car.speedMps * dt;
  if (car.distAlong >= car.road.lengthM - 2) {
    car.distAlong = car.road.lengthM - 2;
    car.dir = car.dir === 1 ? -1 : 1;
  } else if (car.distAlong <= 2) {
    car.distAlong = 2;
    car.dir = car.dir === 1 ? -1 : 1;
  }
  placeTraffic(car);
}
