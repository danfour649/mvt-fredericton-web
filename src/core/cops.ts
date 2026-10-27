/**
 * Police pursuit cars. A cop is just a CarState driven by a tiny pursuit
 * brain: steer at a point predicted from the target's velocity, full
 * throttle when far, ease off when close so it can sit on the player and
 * force a bust instead of orbit-ramming forever. Movement/physics is the
 * shared stepCar, so cops slide and hit buildings exactly like the player.
 */
import type { Vec2 } from './geo';
import { stepCar, type CarState } from './physics';
import type { WorldModel } from './world';

export interface CopCar extends CarState {
  id: string;
  /** Seconds since this cop last rammed something (ram cooldown). */
  ramCooldown: number;
  /** v0.30: cop cars have health now — they can be shot, burned and
   *  blown up like any other car. 100 = fresh. */
  health: number;
  /** v0.30: on fire (health hit 0) — explodes when burnT runs out. */
  burning: boolean;
  burnT: number;
  /** v0.30: the current fire was started by the player's actions
   *  (frenzy destroy credit + cop-kill payout attribution). */
  burnByPlayer: boolean;
  /** v0.30: a roadblock unit — parked across a road, does not pursue. */
  roadblock: boolean;
  /** v0.30: return-fire cooldown (seconds until this cop may shoot). */
  shootCd: number;
}

let copSeq = 0;

export function spawnCop(pos: Vec2, heading: number): CopCar {
  return {
    id: `cop-${copSeq++}`,
    pos: { ...pos },
    heading,
    speed: 0,
    vel: { x: 0, z: 0 },
    angVel: 0,
    steer: 0,
    slipAngle: 0,
    classId: 'police',
    ramCooldown: 0,
    health: 100,
    burning: false,
    burnT: 0,
    burnByPlayer: false,
    roadblock: false,
    shootCd: 0,
  };
}

export interface PursuitTarget {
  pos: Vec2;
  vel: Vec2;
}

/** Advance one cop one tick toward the target. */
export function updateCop(
  world: WorldModel,
  cop: CopCar,
  target: PursuitTarget,
  dt: number,
): { hitBuilding: boolean; impactSpeed: number } {
  cop.ramCooldown = Math.max(0, cop.ramCooldown - dt);
  // Predict where the target is heading, GTA-simple.
  const lead = 0.45;
  const aim = {
    x: target.pos.x + target.vel.x * lead,
    z: target.pos.z + target.vel.z * lead,
  };
  const d = Math.hypot(aim.x - cop.pos.x, aim.z - cop.pos.z);
  const desired = Math.atan2(aim.z - cop.pos.z, aim.x - cop.pos.x);
  let err = desired - cop.heading;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  const steer = Math.max(-1, Math.min(1, err * 2.4));
  // Far: flat out. Close: pace the target so contact (and the bust
  // timer) can happen; point-blank and facing away: reverse out.
  let throttle = 1;
  if (d < 7) throttle = 0.25;
  if (d < 3.2 && Math.abs(err) > 2.2) throttle = -0.7;
  const stepped = stepCar(world, cop, { throttle, steer }, dt);
  cop.pos = stepped.car.pos;
  cop.heading = stepped.car.heading;
  cop.speed = stepped.car.speed;
  cop.vel = stepped.car.vel;
  return { hitBuilding: stepped.hitBuilding, impactSpeed: stepped.impactSpeed };
}
