/**
 * Arcade physics, core frame metres. Player-on-foot movement and a simple
 * bicycle-ish car model — deliberately GTA-1-simple. All collision is
 * circle-vs-building-polygon via world.collideBuildings.
 */
import type { Vec2 } from './geo';
import { collideBuildings, type WorldModel } from './world';

export function moveCircle(
  world: WorldModel,
  pos: Vec2,
  dx: number,
  dz: number,
  radius: number,
): { pos: Vec2; hitBuilding: boolean } {
  const next = { x: pos.x + dx, z: pos.z + dz };
  const pushed = collideBuildings(world.buildings, next, radius);
  if (pushed) return { pos: pushed, hitBuilding: true };
  return { pos: next, hitBuilding: false };
}

export interface CarState {
  pos: Vec2;
  /** Radians, 0 = +X (east), clockwise positive (z is south). */
  heading: number;
  /** Signed m/s along heading. */
  speed: number;
}

export interface CarInput {
  /** -1 (reverse/brake) .. 1 (accelerate). */
  throttle: number;
  /** -1 (left) .. 1 (right). */
  steer: number;
}

const MAX_SPEED = 25; // ~90 km/h
const MAX_REVERSE = 8;
const ACCEL = 9;
const BRAKE = 18;

export function stepCar(
  world: WorldModel,
  car: CarState,
  input: CarInput,
  dt: number,
): { car: CarState; hitBuilding: boolean } {
  let speed = car.speed;
  if (input.throttle > 0) {
    speed += ACCEL * input.throttle * dt;
  } else if (input.throttle < 0) {
    speed += (speed > 0.5 ? -BRAKE : ACCEL * input.throttle) * dt * (speed > 0.5 ? 1 : 1);
  }
  // Drag + rolling resistance.
  speed -= speed * 0.35 * dt;
  if (input.throttle === 0 && Math.abs(speed) < 0.15) speed = 0;
  speed = Math.max(-MAX_REVERSE, Math.min(MAX_SPEED, speed));

  // Steering authority grows with speed, capped; reversing flips it.
  const steerRate = 1.9 * Math.min(1, Math.abs(speed) / 6) * (speed < 0 ? -1 : 1);
  const heading = car.heading + input.steer * steerRate * dt;

  const dx = Math.cos(heading) * speed * dt;
  const dz = Math.sin(heading) * speed * dt;
  const moved = moveCircle(world, car.pos, dx, dz, 1.6);
  const hitBuilding = moved.hitBuilding;
  if (hitBuilding) speed *= 0.25; // wall scrape: kill most speed
  return { car: { pos: moved.pos, heading, speed }, hitBuilding };
}
