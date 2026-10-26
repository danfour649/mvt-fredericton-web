/**
 * Game: the whole simulation in one renderer-agnostic class.
 *
 * v0.20 — the GTA 1 loop: score IS money, one meter. The multiplier is
 * the progression (mission completions raise it, BUSTED halves it).
 * Payphone missions (2 ported from desktop + 2 new, one timed), pursuing
 * police with a bust timer, pedestrians, a respray garage, car/player
 * damage, 5 lives, and a $250,000 district goal with an exit point.
 *
 * Feed it inputs, call update(dt), hand buildFrame() to any Renderer.
 * No DOM, no MapLibre, no canvas anywhere in here.
 */
import { dist, mvtGridToLocal, type Vec2 } from './geo';
import { nearestRoadPoint, pointAlongRoad, type WorldModel } from './world';
import { moveCircle, stepCar, type CarInput, type CarState } from './physics';
import { spawnTraffic, updateTraffic, type TrafficCar } from './traffic';
import { buildRoadGraph, type RoadGraph } from './routing';
import { spawnCop, updateCop, type CopCar } from './cops';
import { spawnPeds, updatePed, nudgePed, type Ped } from './peds';
import { Wanted } from './wanted';
import { Wallet, BUSTED_FINE, HOSPITAL_FEE } from './wallet';
import { MissionRunner, SPAWN_POS, type MissionDef } from './missions';
import { SaveStore, type StorageAdapter } from './save';
import type { RenderFrame, RenderEntity, RenderMarker } from './renderer';

export interface CarEntity extends CarState {
  id: string;
  kind: 'parked' | 'traffic';
  color: string;
  traffic?: TrafficCar;
  /** 0..100. 0 = wreck. */
  health: number;
  wrecked: boolean;
  /** Player has stolen this car at least once. */
  stolen: boolean;
  /** Seconds a traffic car stays stopped after being hit. */
  trafficStopT: number;
}

export type GamePhase = 'play' | 'busted' | 'wasted' | 'gameover' | 'district-done';
export type GoalState = 'progress' | 'to-exit' | 'done';

export interface HudState {
  score: number;
  multiplier: number;
  stars: number;
  lives: number;
  /** 0..1 progress toward the district goal. */
  goalPct: number;
  goalReached: boolean;
  objective: string;
  /** PAGER brief, shown while non-empty. */
  brief: string;
  /** Short-lived event text. */
  toast: string;
  /** Full-screen stamp text (BUSTED / WASTED), '' when none. */
  stamp: string;
  phase: GamePhase;
  /** Seconds left on a timed mission, null = no clock. */
  timerSec: number | null;
  inCar: boolean;
  speedKmh: number;
  carHealth: number | null;
}

/** District goal: reach this score, then get to the exit. */
export const GOAL_SCORE = 250000;
/**
 * Desktop mission payouts are small dollars ($150…); as GTA-1 score they
 * are awarded ×100 so the district goal is a real arc across the four
 * missions, not a 40-hour grind. Fees/fines stay literal dollars.
 */
export const MISSION_SCORE_SCALE = 100;
export const RESPRAY_COST_PER_STAR = 500;
export const START_LIVES = 5;
const PED_SCORE = 100;
const THEFT_SCORE = 500;
const WALK_SPEED = 5.4;
const CAR_COLORS = ['#d9483b', '#2f7fd0', '#7a8288', '#e0a81c', '#7d4fc4', '#1fae8e', '#e07a2e', '#e8e9eb', '#3b5998', '#8e44ad'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function snapToRoad(world: WorldModel, gridX: number, gridZ: number): Vec2 {
  const local = mvtGridToLocal(gridX, gridZ);
  const near = nearestRoadPoint(world, local);
  return near ? near.pos : local;
}

export class Game {
  readonly wanted = new Wanted();
  readonly wallet = new Wallet();
  missions: MissionRunner;
  private saveStore: SaveStore;
  private archive: { completed: string[]; districtCleared: boolean; bestScore: number };

  phase: GamePhase = 'play';
  goalState: GoalState = 'progress';
  lives = START_LIVES;
  playerHealth = 100;

  playerPos: Vec2 = { ...SPAWN_POS };
  playerHeading = 0;
  playerVel: Vec2 = { x: 0, z: 0 };
  cars: CarEntity[] = [];
  cops: CopCar[] = [];
  peds: Ped[] = [];
  drivenCar: CarEntity | null = null;

  moveInput: Vec2 = { x: 0, z: 0 };
  carInput: CarInput = { throttle: 0, steer: 0 };

  /** Snapped POIs (core metres). */
  readonly resprayPos: Vec2;
  readonly exitPos: Vec2;

  private toast = '';
  private toastTtl = 0;
  private brief = '';
  private briefTtl = 0;
  private phaseTtl = 0;
  private time = 0;
  private crashCooldown = 0;
  private ramCooldown = 0;
  private bustMeter = 0; // 0..1 in-car bust progress
  private copContactT = 0; // on-foot cop contact seconds
  private resprayCooldown = 0;
  private copSpawnCooldown = 0;
  private healthRegenDelay = 0;
  /** Last hard impact (render shake + haptics source). */
  private lastImpactAt = -99;
  private lastImpactMag = 0;

  // Smoothed camera (core-side so every renderer gets the same feel).
  private camPos: Vec2 = { ...SPAWN_POS };
  private camViewM = 62;

  private world: WorldModel;

  /** Junction graph for traffic routing (v0.21). */
  readonly roadGraph: RoadGraph;
  private trafficRng = mulberry32(777);

  constructor(world: WorldModel, storage: StorageAdapter) {
    this.world = world;
    this.roadGraph = buildRoadGraph(world);
    this.saveStore = new SaveStore(storage);
    const save = this.saveStore.load();
    this.archive = {
      completed: save.completedMissions,
      districtCleared: save.districtCleared,
      bestScore: save.bestScore,
    };
    if (save.districtCleared) this.goalState = 'done';
    this.missions = new MissionRunner(); // a fresh run: payphones ring again
    this.resprayPos = snapToRoad(world, 95, 55);
    this.exitPos = snapToRoad(world, 170, 20);
    this.spawnCars();
    this.peds = spawnPeds(world, SPAWN_POS, 20, mulberry32(777));
  }

  // --- world population ---------------------------------------------------

  private spawnCars(): void {
    const rng = mulberry32(20261025);
    this.cars = [];
    const near = this.world.roads.filter(
      (r) => r.lengthM > 45 && dist(r.path[0], SPAWN_POS) < 900,
    );
    let n = 0;
    for (let i = 0; i < near.length && n < 16; i += 3) {
      const road = near[i];
      const d = road.lengthM * (0.25 + 0.5 * rng());
      const { pos, heading } = pointAlongRoad(road, d);
      const off = road.widthM / 2 - 0.6;
      const side = rng() > 0.5 ? 1 : -1;
      this.cars.push({
        id: `parked-${n}`,
        kind: 'parked',
        color: CAR_COLORS[n % CAR_COLORS.length],
        pos: {
          x: pos.x + Math.cos(heading + Math.PI / 2) * off * side,
          z: pos.z + Math.sin(heading + Math.PI / 2) * off * side,
        },
        heading: side === 1 ? heading : heading + Math.PI,
        speed: 0,
        vel: { x: 0, z: 0 },
        angVel: 0,
        steer: 0,
        slipAngle: 0,
        classId: n % 4 === 3 ? 'fast' : 'standard',
        health: 100,
        wrecked: false,
        stolen: false,
        trafficStopT: 0,
      });
      n++;
    }
    const longest = [...this.world.roads].sort((a, b) => b.lengthM - a.lengthM).slice(0, 14);
    let t = 0;
    for (let i = 0; i < longest.length && t < 8; i += 2) {
      const road = longest[i];
      const traffic = spawnTraffic(road, road.lengthM * (0.2 + 0.6 * rng()));
      this.cars.push({
        id: `traffic-${t}`,
        kind: 'traffic',
        color: CAR_COLORS[(t + 3) % CAR_COLORS.length],
        pos: { ...traffic.pos },
        heading: traffic.heading,
        speed: 0,
        vel: { x: 0, z: 0 },
        angVel: 0,
        steer: 0,
        slipAngle: 0,
        classId: 'standard',
        traffic,
        health: 100,
        wrecked: false,
        stolen: false,
        trafficStopT: 0,
      });
      t++;
    }
  }

  // --- interaction ----------------------------------------------------------

  /** E key. Priority: overlays > mission interact > payphone > car in/out. */
  pressInteract(): void {
    if (this.phase === 'district-done') return this.confirmFreeroam();
    if (this.phase === 'gameover') return this.pressRestart();
    if (this.phase !== 'play') return;
    if (this.drivenCar) {
      const car = this.drivenCar;
      this.playerPos = {
        x: car.pos.x + Math.cos(car.heading - Math.PI / 2) * 2.4,
        z: car.pos.z + Math.sin(car.heading - Math.PI / 2) * 2.4,
      };
      this.playerHeading = car.heading;
      car.speed = 0;
      car.vel = { x: 0, z: 0 };
      car.angVel = 0;
      car.steer = 0;
      this.drivenCar = null;
      return;
    }
    const step = this.missions.currentStep;
    if (step?.kind === 'interact' && this.missions.tryInteract(this.playerPos)) {
      this.afterMissionEvents();
      return;
    }
    if (!this.missions.active) {
      for (const m of this.missions.available()) {
        if (dist(this.playerPos, m.startPos) <= 7) {
          this.missions.start(m);
          this.afterMissionEvents();
          return;
        }
      }
    }
    let best: CarEntity | null = null;
    let bestD = 4;
    for (const car of this.cars) {
      if (car.wrecked) continue;
      const d = dist(this.playerPos, car.pos);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    if (best) this.enterCar(best);
  }

  private enterCar(car: CarEntity): void {
    this.drivenCar = car;
    if (car.traffic) {
      // car.heading is already the travel heading (traffic.placeTraffic
      // bakes the direction flip in); traffic speed is a positive scalar.
      car.vel = {
        x: Math.cos(car.heading) * car.traffic.speedMps,
        z: Math.sin(car.heading) * car.traffic.speedMps,
      };
      car.speed = car.traffic.speedMps;
      car.angVel = 0;
      car.steer = 0;
    }
    if (!car.stolen) {
      car.stolen = true;
      // Grand theft auto: the crime that starts most runs.
      this.wanted.add(1);
      const gained = this.wallet.earn(THEFT_SCORE);
      this.showToast(`Car theft! +$${gained.toLocaleString()} — wanted level up`);
      if (car.kind === 'parked') {
        this.missions.notifyEnteredParkedCar();
        this.afterMissionEvents();
      }
    }
  }

  /** Buttons/keys on the end overlays. */
  confirmFreeroam(): void {
    if (this.phase === 'district-done') {
      this.phase = 'play';
      this.showToast('Free roam — the payphones are still ringing');
    }
  }

  /** Fresh run (GAME OVER screen / district-done overlay / R key there). */
  pressRestart(): void {
    if (this.phase !== 'gameover' && this.phase !== 'district-done') return;
    this.wallet.set(0);
    this.wallet.multiplier = 1;
    this.lives = START_LIVES;
    this.playerHealth = 100;
    this.wanted.reset();
    this.missions = new MissionRunner();
    this.goalState = this.archive.districtCleared ? 'done' : 'progress';
    this.cops = [];
    this.drivenCar = null;
    this.playerPos = { ...SPAWN_POS };
    this.bustMeter = 0;
    this.copContactT = 0;
    this.spawnCars();
    this.peds = spawnPeds(this.world, SPAWN_POS, 20, mulberry32(777));
    this.phase = 'play';
    this.camPos = { ...SPAWN_POS };
    this.showToast('New run — reach $250,000');
    this.persist();
  }

  // --- mission events -------------------------------------------------------

  private afterMissionEvents(): void {
    for (const ev of this.missions.drainEvents()) {
      if (ev.type === 'started') {
        this.brief = `${ev.mission.title} — ${ev.mission.brief}`;
        this.briefTtl = 7;
      } else if (ev.type === 'completed') {
        const gained = this.wallet.earn(ev.mission.payout * MISSION_SCORE_SCALE);
        this.wallet.missionCompleted();
        this.showToast(
          `${ev.mission.title} complete! +$${gained.toLocaleString()} — multiplier now ×${this.wallet.multiplier}`,
        );
        if (!this.archive.completed.includes(ev.mission.id)) {
          this.archive.completed.push(ev.mission.id);
        }
        this.checkGoal();
        this.persist();
      } else if (ev.type === 'failed') {
        this.showToast(`${ev.mission.title} FAILED — the payphone will ring again`);
      } else if (ev.type === 'step') {
        this.showToast(ev.step.objective);
      }
    }
  }

  private checkGoal(): void {
    if (this.goalState === 'progress' && this.wallet.money >= GOAL_SCORE) {
      this.goalState = 'to-exit';
      this.brief = 'DISTRICT GOAL REACHED! Get to the EXIT point downtown to clear the district.';
      this.briefTtl = 8;
    }
  }

  private persist(): void {
    this.archive.bestScore = Math.max(this.archive.bestScore, this.wallet.money);
    this.saveStore.save({
      completedMissions: [...this.archive.completed],
      districtCleared: this.archive.districtCleared,
      bestScore: this.archive.bestScore,
    });
  }

  private showToast(text: string): void {
    this.toast = text;
    this.toastTtl = 4;
  }

  // --- penalties --------------------------------------------------------------

  /** Trigger the BUSTED stamp; penalties land when the stamp expires. */
  triggerBusted(): void {
    if (this.phase !== 'play') return;
    this.phase = 'busted';
    this.phaseTtl = 2.4;
    this.bustMeter = 0;
    this.copContactT = 0;
  }

  /** Apply the bust: fine + halved multiplier + heat cleared + respawn. */
  applyBusted(): void {
    const fine = this.wallet.bustedPenalty();
    if (this.drivenCar) {
      // The car is impounded — gone.
      this.cars = this.cars.filter((c) => c !== this.drivenCar);
      this.drivenCar = null;
    }
    this.wanted.reset();
    this.cops = [];
    this.playerHealth = 100;
    this.playerPos = { ...SPAWN_POS };
    this.camPos = { ...SPAWN_POS };
    this.showToast(`Busted! Fine $${fine.toLocaleString()} — multiplier cut to ×${this.wallet.multiplier}`);
    this.persist();
  }

  private triggerWasted(): void {
    if (this.phase !== 'play') return;
    this.phase = 'wasted';
    this.phaseTtl = 2.4;
    this.lives -= 1;
  }

  private applyWasted(): void {
    const fee = this.wallet.spend(HOSPITAL_FEE);
    if (this.drivenCar) {
      this.drivenCar = null; // left where it died; player wakes at hospital
    }
    this.wanted.reset();
    this.cops = [];
    this.playerHealth = 100;
    this.playerPos = { ...SPAWN_POS };
    this.camPos = { ...SPAWN_POS };
    if (this.lives > 0) {
      this.showToast(`Wasted! Hospital fee $${fee} — ${this.lives} ${this.lives === 1 ? 'life' : 'lives'} left`);
    }
    this.persist();
  }

  // --- main update --------------------------------------------------------------

  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.toastTtl = Math.max(0, this.toastTtl - dt);
    if (this.toastTtl === 0) this.toast = '';
    this.briefTtl = Math.max(0, this.briefTtl - dt);
    if (this.briefTtl === 0) this.brief = '';
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    this.ramCooldown = Math.max(0, this.ramCooldown - dt);
    this.resprayCooldown = Math.max(0, this.resprayCooldown - dt);
    this.copSpawnCooldown = Math.max(0, this.copSpawnCooldown - dt);
    this.healthRegenDelay = Math.max(0, this.healthRegenDelay - dt);

    // Mission clock runs in every phase except overlays.
    if (this.phase === 'play') {
      this.missions.tick(dt);
      this.afterMissionEvents();
    }

    // Traffic always rolls (except end overlays) so stamp scenes stay alive.
    if (this.phase !== 'gameover' && this.phase !== 'district-done') {
      this.updateTrafficCars(dt);
    }

    if (this.phase === 'busted' || this.phase === 'wasted') {
      this.phaseTtl -= dt;
      // The player's car rolls to a stop behind the stamp.
      if (this.drivenCar) {
        const stepped = stepCar(this.world, this.drivenCar, { throttle: 0, steer: 0 }, dt);
        Object.assign(this.drivenCar, stepped.car);
        this.playerPos = { ...this.drivenCar.pos };
      }
      if (this.phaseTtl <= 0) {
        const wasWasted = this.phase === 'wasted';
        if (wasWasted) this.applyWasted();
        else this.applyBusted();
        // A wasted that spent the last life ends the run; anything
        // else returns to play.
        this.phase = wasWasted && this.lives <= 0 ? 'gameover' : 'play';
      }
      this.updateCamera(dt);
      return;
    }
    if (this.phase !== 'play') {
      this.updateCamera(dt);
      return;
    }

    // Wanted decays only while no cop is on top of you.
    const nearestCop = this.cops.length
      ? Math.min(...this.cops.map((c) => dist(c.pos, this.playerPos)))
      : Infinity;
    if (nearestCop > 45) this.wanted.update(dt);

    if (this.drivenCar) this.updateDriving(dt);
    else this.updateOnFoot(dt);

    this.updatePeds(dt);
    this.updateCops(dt);
    this.updateRespray();
    this.updateExit();
    this.updateCamera(dt);

    // Health trickles back when nothing has hurt you lately.
    if (this.healthRegenDelay === 0 && this.playerHealth > 0 && this.playerHealth < 100) {
      this.playerHealth = Math.min(100, this.playerHealth + 6 * dt);
    }
    if (this.playerHealth <= 0) this.triggerWasted();
  }

  private updateTrafficCars(dt: number): void {
    for (const car of this.cars) {
      if (!car.traffic || car === this.drivenCar || car.wrecked) continue;
      car.trafficStopT = Math.max(0, car.trafficStopT - dt);
      // Brake when the player is blocking the road ahead.
      const toPlayer = { x: this.playerPos.x - car.pos.x, z: this.playerPos.z - car.pos.z };
      const d = Math.hypot(toPlayer.x, toPlayer.z);
      const ahead =
        d < 9 &&
        (toPlayer.x * Math.cos(car.heading) + toPlayer.z * Math.sin(car.heading)) / (d || 1) > 0.4;
      car.traffic.stopped = car.trafficStopT > 0 || ahead;
      updateTraffic(car.traffic, dt, this.roadGraph, this.trafficRng);
      car.pos = { ...car.traffic.pos };
      car.heading = car.traffic.heading;
      car.vel = {
        x: Math.cos(car.traffic.heading) * car.traffic.speedMps,
        z: Math.sin(car.traffic.heading) * car.traffic.speedMps,
      };
      car.speed = car.traffic.speedMps;
      // Traffic vs the player's car: shove + damage, both stop-ish.
      if (this.drivenCar && dist(car.pos, this.drivenCar.pos) < 3.4) {
        this.hitCarCar(this.drivenCar, car, Math.abs(this.drivenCar.speed));
      }
    }
  }

  private hitCarCar(mine: CarEntity, other: CarEntity, mySpeed: number): void {
    if (this.crashCooldown > 0) return;
    this.crashCooldown = 1.2;
    if (other.traffic) other.trafficStopT = 3;
    mine.speed *= 0.3;
    mine.vel = { x: mine.vel.x * 0.3, z: mine.vel.z * 0.3 };
    if (mySpeed > 4) {
      this.damageCar(mine, (mySpeed - 3) * 1.6);
      this.crashWanted();
    }
  }

  private crashWanted(): void {
    this.wanted.add(1);
    this.showToast('Reckless driving — wanted level up');
  }

  private damageCar(car: CarEntity, amount: number): void {
    if (car.wrecked) return;
    car.health = Math.max(0, car.health - amount);
    if (car.health <= 0) {
      car.wrecked = true;
      car.speed = 0;
      car.vel = { x: 0, z: 0 };
      car.angVel = 0;
      if (car === this.drivenCar) {
        this.showToast('WRECKED! Your car is dead');
        this.playerPos = {
          x: car.pos.x + Math.cos(car.heading - Math.PI / 2) * 2.4,
          z: car.pos.z + Math.sin(car.heading - Math.PI / 2) * 2.4,
        };
        this.drivenCar = null;
      } else if (car.traffic) {
        car.traffic.stopped = true;
      }
    }
  }

  private updateDriving(dt: number): void {
    const car = this.drivenCar!;
    const stepped = stepCar(this.world, car, this.carInput, dt);
    const impact = stepped.impactSpeed;
    Object.assign(car, stepped.car);
    if (stepped.hitBuilding && impact > 9) {
      this.lastImpactAt = this.time;
      this.lastImpactMag = Math.min(1, (impact - 9) / 15);
    }
    if (stepped.hitBuilding && impact > 8 && this.crashCooldown === 0) {
      this.crashCooldown = 1.2;
      this.damageCar(car, (impact - 7) * 2.4);
      if (impact > 13) this.hurtPlayer((impact - 12) * 2);
      this.crashWanted();
    }
    // Car vs parked/traffic cars.
    for (const other of this.cars) {
      if (other === car) continue;
      if (dist(car.pos, other.pos) < 3.4) {
        this.hitCarCar(car, other, Math.abs(car.speed));
      }
    }
    this.playerVel = { ...car.vel };
    this.playerPos = { ...car.pos };
    this.playerHeading = car.heading;
    this.missions.update(this.playerPos, true);
    this.afterMissionEvents();
  }

  private updateOnFoot(dt: number): void {
    const before = { ...this.playerPos };
    const len = Math.hypot(this.moveInput.x, this.moveInput.z);
    if (len > 0.01) {
      const nx = this.moveInput.x / Math.max(1, len);
      const nz = this.moveInput.z / Math.max(1, len);
      this.playerHeading = Math.atan2(nz, nx);
      const moved = moveCircle(
        this.world,
        this.playerPos,
        nx * WALK_SPEED * dt,
        nz * WALK_SPEED * dt,
        0.55,
      );
      this.playerPos = moved.pos;
    }
    this.playerVel = dt > 0
      ? { x: (this.playerPos.x - before.x) / dt, z: (this.playerPos.z - before.z) / dt }
      : { x: 0, z: 0 };
    // Harmless ped bumps.
    for (const ped of this.peds) {
      if (dist(this.playerPos, ped.pos) < 0.95) nudgePed(ped, this.playerPos);
    }
    this.missions.update(this.playerPos, false);
  }

  private hurtPlayer(amount: number): void {
    this.playerHealth = Math.max(0, this.playerHealth - amount);
    this.healthRegenDelay = 5;
  }

  private updatePeds(dt: number): void {
    const threat = this.drivenCar
      ? { pos: this.drivenCar.pos, speed: this.drivenCar.speed }
      : undefined;
    for (const ped of this.peds) {
      const before = { ...ped.pos };
      const ev = updatePed(ped, dt, threat);
      // Keep walkers out of walls after fleeing/nudging.
      if (ped.state !== 'down') {
        const pushed = moveCircle(this.world, ped.pos, 0, 0, 0.35);
        ped.pos = pushed.pos;
      }
      void before;
      if (ev === 'downed') {
        const gained = this.wallet.earn(PED_SCORE);
        this.wanted.add(1);
        this.showToast(`Ped down! +$${gained.toLocaleString()} — wanted level up`);
      }
    }
  }

  private updateCops(dt: number): void {
    const stars = this.wanted.stars;
    const desired = stars > 0 ? Math.min(stars, 4) : 0;
    // Spawn up to the desired pressure, at a road point ~120-170 m out.
    if (this.cops.length < desired && this.copSpawnCooldown <= 0) {
      this.copSpawnCooldown = 1.5;
      const angle = this.time * 1.7 + this.cops.length * 2.1;
      const probe = {
        x: this.playerPos.x + Math.cos(angle) * 150,
        z: this.playerPos.z + Math.sin(angle) * 150,
      };
      const near = nearestRoadPoint(this.world, probe);
      if (near && dist(near.pos, this.playerPos) > 55) {
        this.cops.push(spawnCop(near.pos, near.heading));
      }
    }
    const target = { pos: this.playerPos, vel: this.playerVel };
    const survivors: CopCar[] = [];
    for (const cop of this.cops) {
      updateCop(this.world, cop, target, dt);
      const d = dist(cop.pos, this.playerPos);
      // Give up when the heat is gone and they're far behind.
      if (stars === 0 && d > 200) continue;
      // Ramming.
      if (this.ramCooldown === 0) {
        if (this.drivenCar && d < 3.5) {
          this.ramCooldown = 0.9;
          cop.ramCooldown = 0.9;
          const rel = Math.max(0, Math.abs(cop.speed) - Math.abs(this.drivenCar.speed)) + Math.abs(cop.speed) * 0.4;
          this.damageCar(this.drivenCar, 4 + rel * 1.4);
          this.drivenCar.vel = {
            x: this.drivenCar.vel.x + cop.vel.x * 0.35,
            z: this.drivenCar.vel.z + cop.vel.z * 0.35,
          };
          cop.speed *= 0.35;
          cop.vel = { x: cop.vel.x * 0.35, z: cop.vel.z * 0.35 };
          cop.angVel *= 0.4;
          this.showToast('Police ram!');
        } else if (!this.drivenCar && d < 2.4) {
          if (Math.abs(cop.speed) > 5) {
            this.ramCooldown = 0.9;
            this.hurtPlayer(22);
            const away = {
              x: this.playerPos.x - cop.pos.x,
              z: this.playerPos.z - cop.pos.z,
            };
            const l = Math.hypot(away.x, away.z) || 1;
            const moved = moveCircle(this.world, this.playerPos, (away.x / l) * 3, (away.z / l) * 3, 0.55);
            this.playerPos = moved.pos;
            this.showToast('Hit by a police car!');
          }
        }
      }
      survivors.push(cop);
    }
    this.cops = survivors;

    // The bust itself.
    if (stars > 0 && this.cops.length) {
      if (this.drivenCar) {
        const copNear = Math.min(...this.cops.map((c) => dist(c.pos, this.playerPos)));
        if (Math.abs(this.drivenCar.speed) < 1.5 && copNear < 7) {
          this.bustMeter += dt / 3;
          if (this.bustMeter >= 1) return this.triggerBusted();
        } else {
          this.bustMeter = Math.max(0, this.bustMeter - dt / 2);
        }
      } else {
        const touching = this.cops.some((c) => dist(c.pos, this.playerPos) < 2.6);
        if (touching) {
          this.copContactT += dt;
          if (this.copContactT >= 2) return this.triggerBusted();
        } else {
          this.copContactT = Math.max(0, this.copContactT - dt);
        }
      }
    } else {
      this.bustMeter = Math.max(0, this.bustMeter - dt / 2);
      this.copContactT = 0;
    }
  }

  private updateRespray(): void {
    if (!this.drivenCar || this.resprayCooldown > 0) return;
    if (this.wanted.stars <= 0) return;
    if (dist(this.playerPos, this.resprayPos) > 7) return;
    const stars = this.wanted.stars;
    const cost = RESPRAY_COST_PER_STAR * stars;
    const paid = this.wallet.spend(cost);
    this.wanted.reset();
    this.cops = [];
    this.bustMeter = 0;
    const rng = mulberry32(Math.floor(this.time * 1000) + 42);
    let idx = Math.floor(rng() * CAR_COLORS.length);
    if (CAR_COLORS[idx] === this.drivenCar.color) idx = (idx + 1) % CAR_COLORS.length;
    this.drivenCar.color = CAR_COLORS[idx];
    this.resprayCooldown = 5;
    this.showToast(`Queen St Respray: -$${paid.toLocaleString()} — heat's off, new paint`);
    this.persist();
  }

  private updateExit(): void {
    if (this.goalState !== 'to-exit') return;
    if (dist(this.playerPos, this.exitPos) <= 10) {
      this.goalState = 'done';
      this.archive.districtCleared = true;
      this.phase = 'district-done';
      this.persist();
    }
  }

  private updateCamera(dt: number): void {
    // Lookahead BY THE VELOCITY VECTOR (v0.21): the camera leans into
    // the direction of travel — including the lateral component when
    // the car slides — so a drift reads before it bites.
    const targetPos = {
      x: this.playerPos.x + this.playerVel.x * 0.45,
      z: this.playerPos.z + this.playerVel.z * 0.45,
    };
    const kp = 1 - Math.exp(-6.5 * dt);
    this.camPos = {
      x: this.camPos.x + (targetPos.x - this.camPos.x) * kp,
      z: this.camPos.z + (targetPos.z - this.camPos.z) * kp,
    };
    const speedRatio = this.drivenCar
      ? Math.min(1, Math.abs(this.drivenCar.speed) / 31)
      : Math.min(1, Math.hypot(this.playerVel.x, this.playerVel.z) / 8);
    // Zoom-out-with-speed (the GTA 1 signature): tight on foot, pulling
    // out as the car speeds up. Values are "metres across viewport
    // height" for the renderer; the MapLibre adapter clamps zoom so
    // sprites stay readable at the far end.
    const targetView = this.drivenCar ? 115 + speedRatio * 185 : 70;
    // v0.21: GTA's zoom tracks speed aggressively — rate 3.6/s reaches
    // the target view in ~0.3 s (was 2.2/s, a visible ~0.5 s+ lag).
    const kv = 1 - Math.exp(-3.6 * dt);
    this.camViewM += (targetView - this.camViewM) * kv;
  }

  // --- demo / test hooks -----------------------------------------------------

  /** Deterministic live-gameplay state for screenshots (?scenario=demo). */
  applyDemoScenario(): void {
    this.wallet.set(42500);
    this.wallet.multiplier = 3;
    const errand = this.missions.available().find((m) => m.id === 'queen_street_errand');
    if (errand) this.missions.start(errand);
    this.drainBriefForDemo();
    // Put the player in the nearest parked car at spawn, rolling east.
    const car = this.cars
      .filter((c) => c.kind === 'parked')
      .sort((a, b) => dist(a.pos, SPAWN_POS) - dist(b.pos, SPAWN_POS))[0];
    if (car) {
      car.pos = { x: SPAWN_POS.x + 6, z: SPAWN_POS.z + 2 };
      car.heading = 0.63; // along Queen in the core frame
      car.speed = 9;
      car.vel = { x: Math.cos(car.heading) * 9, z: Math.sin(car.heading) * 9 };
      this.enterCarSilent(car);
    }
    this.wanted.heat = 2.2;
    // Two cops visible behind.
    for (let i = 0; i < 2; i++) {
      const cop = spawnCop(
        { x: this.playerPos.x - 26 - i * 12, z: this.playerPos.z + 8 + i * 5 },
        0.63,
      );
      cop.speed = 9;
      cop.vel = { x: Math.cos(0.63) * 9, z: Math.sin(0.63) * 9 };
      this.cops.push(cop);
    }
    this.camPos = { ...this.playerPos };
    this.camViewM = 120;
  }

  private drainBriefForDemo(): void {
    this.afterMissionEvents();
    this.briefTtl = Math.max(this.briefTtl, 60); // hold the pager for the shot
  }

  private enterCarSilent(car: CarEntity): void {
    this.drivenCar = car;
    car.stolen = true;
    this.playerPos = { ...car.pos };
    this.playerHeading = car.heading;
  }

  // --- HUD / frame ---------------------------------------------------------------

  objectiveText(): string {
    if (this.goalState === 'to-exit') return 'Goal reached! Get to the EXIT point downtown';
    const step = this.missions.currentStep;
    if (this.missions.active && step) {
      return `${this.missions.active.title}: ${step.objective}`;
    }
    if (!this.missions.active) {
      const avail = this.missions.available();
      if (avail.length) return `Answer a payphone: ${avail.map((m) => m.startLabel).join(' · ')}`;
      return 'All missions complete. Free roam Fredericton.';
    }
    return '';
  }

  hud(): HudState {
    return {
      score: this.wallet.money,
      multiplier: this.wallet.multiplier,
      stars: this.wanted.stars,
      lives: this.lives,
      goalPct: Math.min(1, this.wallet.money / GOAL_SCORE),
      goalReached: this.goalState !== 'progress',
      objective: this.objectiveText(),
      brief: this.brief,
      toast: this.toast,
      stamp: this.phase === 'busted' ? 'BUSTED' : this.phase === 'wasted' ? 'WASTED' : '',
      phase: this.phase,
      timerSec: this.missions.active ? this.missions.timeLeft : null,
      inCar: !!this.drivenCar,
      speedKmh: this.drivenCar ? Math.round(Math.abs(this.drivenCar.speed) * 3.6) : 0,
      carHealth: this.drivenCar ? Math.round(this.drivenCar.health) : null,
    };
  }

  buildFrame(): RenderFrame {
    const entities: RenderEntity[] = [];
    for (const car of this.cars) {
      entities.push({
        id: car.id,
        kind: car === this.drivenCar ? 'car-driven' : car.kind === 'parked' ? 'car-parked' : 'car-traffic',
        pos: car.pos,
        heading: car.heading,
        color: car.color,
        wrecked: car.wrecked,
        slip: car.slipAngle,
        speedMps: Math.hypot(car.vel.x, car.vel.z),
        handbrake: car === this.drivenCar ? !!this.carInput.handbrake : false,
      });
    }
    for (const cop of this.cops) {
      entities.push({
        id: cop.id,
        kind: 'car-cop',
        pos: cop.pos,
        heading: cop.heading,
        color: '#f2f3f5',
        slip: cop.slipAngle,
        speedMps: Math.hypot(cop.vel.x, cop.vel.z),
      });
    }
    for (const ped of this.peds) {
      entities.push({
        id: ped.id,
        kind: 'ped',
        pos: ped.pos,
        heading: ped.heading,
        color: ped.color,
        down: ped.state === 'down',
      });
    }
    if (!this.drivenCar && this.phase !== 'gameover') {
      entities.push({
        id: 'player',
        kind: 'player',
        pos: this.playerPos,
        heading: this.playerHeading,
        color: '#ffd23f',
      });
    }
    const markers: RenderMarker[] = [];
    if (!this.missions.active && this.phase === 'play') {
      for (const m of this.missions.available()) {
        markers.push({ pos: m.startPos, radius: 7, label: m.startLabel, icon: '☎', kind: 'payphone' });
      }
    }
    const step = this.missions.currentStep;
    if (this.missions.active && step?.pos) {
      markers.push({
        pos: step.pos,
        radius: step.radius ?? 6,
        label: this.missions.active!.title,
        icon: '!',
        kind: 'objective',
      });
    }
    markers.push({ pos: this.resprayPos, radius: 7, label: 'RESPRAY', icon: 'S', kind: 'respray' });
    if (this.goalState === 'to-exit') {
      markers.push({ pos: this.exitPos, radius: 10, label: 'EXIT', icon: '⚑', kind: 'exit' });
    }
    const impactAge = this.time - this.lastImpactAt;
    return {
      camera: { ...this.camPos },
      viewHeightM: this.camViewM,
      playerInCar: !!this.drivenCar,
      timeSec: this.time,
      entities,
      markers,
      impact: impactAge < 0.45 ? this.lastImpactMag * (1 - impactAge / 0.45) : 0,
    };
  }
}

export type { MissionDef };
export { BUSTED_FINE, HOSPITAL_FEE };
