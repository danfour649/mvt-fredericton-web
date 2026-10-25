/**
 * Arcade physics, core frame metres. Player-on-foot movement and a
 * GTA-1-style car model: snappy acceleration, speed-sensitive steering,
 * and a velocity vector with grip so the handbrake produces real slide.
 * All collision is circle-vs-building-polygon via world.collideBuildings.
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
  /** Signed m/s along heading (HUD/logic speed). */
  speed: number;
  /** Actual velocity vector m/s — differs from heading*speed when sliding. */
  vel: Vec2;
}

export interface CarInput {
  /** -1 (reverse/brake) .. 1 (accelerate). */
  throttle: number;
  /** -1 (left) .. 1 (right). */
  steer: number;
  /** Space: cuts grip, melts speed, lets the tail swing. */
  handbrake?: boolean;
}

export const CAR_MAX_SPEED = 31; // ~112 km/h
const MAX_REVERSE = 9;
const ACCEL = 16;
const BRAKE = 26;

export function stepCar(
  world: WorldModel,
  car: CarState,
  input: CarInput,
  dt: number,
): { car: CarState; hitBuilding: boolean; impactSpeed: number } {
  const fwd = { x: Math.cos(car.heading), z: Math.sin(car.heading) };
  let speed = car.vel.x * fwd.x + car.vel.z * fwd.z; // signed speed along nose

  // Engine / brakes.
  if (input.throttle > 0) {
    speed += ACCEL * input.throttle * dt * (speed < 0 ? 2.2 : 1); // punchy out of reverse
  } else if (input.throttle < 0) {
    speed += (speed > 0.5 ? -BRAKE : -ACCEL * 0.8) * dt;
  }
  // Drag + rolling resistance; handbrake melts speed hard.
  const drag = input.handbrake ? 1.6 : 0.32;
  speed -= speed * drag * dt;
  if (input.throttle === 0 && !input.handbrake && Math.abs(speed) < 0.12) speed = 0;
  speed = Math.max(-MAX_REVERSE, Math.min(CAR_MAX_SPEED, speed));

  // Steering: authority peaks at low/mid speed, fades at the top end;
  // reversing flips it, handbrake roughly doubles it (tail-happy).
  const speedFactor = Math.min(1, Math.abs(speed) / 5) / (1 + Math.abs(speed) * 0.028);
  const steerRate = 2.6 * speedFactor * (input.handbrake ? 1.7 : 1) * (speed < 0 ? -1 : 1);
  const heading = car.heading + input.steer * steerRate * dt;

  // Velocity chases the nose direction at the grip rate — low grip
  // (handbrake) means the old velocity lingers and the car slides.
  const nf = { x: Math.cos(heading), z: Math.sin(heading) };
  const grip = input.handbrake ? 2.4 : 10;
  const blend = 1 - Math.exp(-grip * dt);
  const vel: Vec2 = {
    x: car.vel.x + (nf.x * speed - car.vel.x) * blend,
    z: car.vel.z + (nf.z * speed - car.vel.z) * blend,
  };

  const impactSpeed = Math.hypot(vel.x, vel.z);
  const moved = moveCircle(world, car.pos, vel.x * dt, vel.z * dt, 1.6);
  const hitBuilding = moved.hitBuilding;
  if (hitBuilding) {
    vel.x *= 0.25;
    vel.z *= 0.25;
  }
  const outSpeed = vel.x * nf.x + vel.z * nf.z;
  return {
    car: { pos: moved.pos, heading, speed: outSpeed, vel },
    hitBuilding,
    impactSpeed: hitBuilding ? impactSpeed : 0,
  };
}
