/**
 * Game: the whole v0 simulation in one renderer-agnostic class.
 * Owns the player, cars (parked + traffic + driven), wanted, wallet,
 * missions and save. Feed it inputs, call update(dt), hand buildFrame()
 * to any Renderer. No DOM, no MapLibre, no canvas anywhere in here.
 */
import { dist, type Vec2 } from './geo';
import type { WorldModel } from './world';
import { pointAlongRoad } from './world';
import { moveCircle, stepCar, type CarInput, type CarState } from './physics';
import { spawnTraffic, updateTraffic, type TrafficCar } from './traffic';
import { Wanted } from './wanted';
import { Wallet } from './wallet';
import { MissionRunner, SPAWN_POS, type MissionDef } from './missions';
import { SaveStore, type StorageAdapter } from './save';
import type { RenderFrame, RenderEntity, RenderMarker } from './renderer';

export interface CarEntity extends CarState {
  id: string;
  kind: 'parked' | 'traffic';
  color: string;
  traffic?: TrafficCar;
}

export interface HudState {
  money: number;
  stars: number;
  objective: string;
  /** Short-lived event text (mission started/completed, payout, busted…). */
  toast: string;
  inCar: boolean;
  speedKmh: number;
}

const CAR_COLORS = ['#c0392b', '#2471a3', '#616a6b', '#b7950b', '#6c3483', '#117a65', '#ca6f1e', '#d5d8dc'];
const WALK_SPEED = 5.2;

/** Deterministic RNG so every load spawns the same city. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  readonly wanted = new Wanted();
  readonly wallet = new Wallet();
  readonly missions: MissionRunner;
  private saveStore: SaveStore;

  playerPos: Vec2 = { ...SPAWN_POS };
  playerHeading = 0;
  cars: CarEntity[] = [];
  drivenCar: CarEntity | null = null;

  /** Movement input in screen terms: x = right, z = down (south). */
  moveInput: Vec2 = { x: 0, z: 0 };
  carInput: CarInput = { throttle: 0, steer: 0 };

  private toast = '';
  private toastTtl = 0;
  private crashCooldown = 0;

  private world: WorldModel;

  constructor(world: WorldModel, storage: StorageAdapter) {
    this.world = world;
    this.saveStore = new SaveStore(storage);
    const save = this.saveStore.load();
    this.wallet.set(save.money);
    this.missions = new MissionRunner(save.completedMissions);
    this.spawnCars();
  }

  private spawnCars(): void {
    const rng = mulberry32(20261025);
    const near = this.world.roads.filter(
      (r) => r.lengthM > 45 && dist(r.path[0], SPAWN_POS) < 900,
    );
    // Parked cars: deterministic picks along road edges.
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
      });
      n++;
    }
    // Traffic: the longest roads in the dataset.
    const longest = [...this.world.roads].sort((a, b) => b.lengthM - a.lengthM).slice(0, 14);
    let t = 0;
    for (let i = 0; i < longest.length && t < 7; i += 2) {
      const road = longest[i];
      const traffic = spawnTraffic(road, road.lengthM * (0.2 + 0.6 * rng()));
      this.cars.push({
        id: `traffic-${t}`,
        kind: 'traffic',
        color: CAR_COLORS[(t + 3) % CAR_COLORS.length],
        pos: traffic.pos,
        heading: traffic.heading,
        speed: 0,
        traffic,
      });
      t++;
    }
  }

  /** E key. Priority: active interact step > mission start > car in/out. */
  pressInteract(): void {
    if (this.drivenCar) {
      // Exit beside the car.
      const car = this.drivenCar;
      this.playerPos = {
        x: car.pos.x + Math.cos(car.heading - Math.PI / 2) * 2.2,
        z: car.pos.z + Math.sin(car.heading - Math.PI / 2) * 2.2,
      };
      this.playerHeading = car.heading;
      car.speed = 0;
      this.drivenCar = null;
      return;
    }
    const step = this.missions.currentStep;
    if (step?.kind === 'interact' && this.missions.tryInteract(this.playerPos)) {
      this.afterMissionEvent();
      return;
    }
    if (!this.missions.active) {
      for (const m of this.missions.available()) {
        if (dist(this.playerPos, m.startPos) <= 7) {
          this.missions.start(m);
          this.afterMissionEvent();
          return;
        }
      }
    }
    // Enter the nearest car within reach.
    let best: CarEntity | null = null;
    let bestD = 4;
    for (const car of this.cars) {
      const d = dist(this.playerPos, car.pos);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    if (best) {
      this.drivenCar = best;
      if (best.traffic) best.traffic.stopped = true;
      if (best.kind === 'parked') {
        this.missions.notifyEnteredParkedCar();
        this.afterMissionEvent();
      }
    }
  }

  private afterMissionEvent(): void {
    for (const ev of this.missions.drainEvents()) {
      if (ev.type === 'started') {
        this.showToast(`${ev.mission.title} — ${ev.mission.brief}`);
      } else if (ev.type === 'completed') {
        this.wallet.add(ev.mission.payout);
        this.showToast(`${ev.mission.title} complete! +$${ev.mission.payout}`);
        this.persist();
      } else if (ev.type === 'step') {
        this.showToast(ev.step.objective);
      }
    }
  }

  private showToast(text: string): void {
    this.toast = text;
    this.toastTtl = 5;
  }

  private persist(): void {
    this.saveStore.save({
      money: this.wallet.money,
      completedMissions: [...this.missions.completed],
    });
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.toastTtl = Math.max(0, this.toastTtl - dt);
    if (this.toastTtl === 0) this.toast = '';
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    this.wanted.update(dt);

    // Traffic (except a car the player is driving).
    for (const car of this.cars) {
      if (car.traffic && car !== this.drivenCar) {
        updateTraffic(car.traffic, dt);
        car.pos = car.traffic.pos;
        car.heading = car.traffic.heading;
      }
    }

    if (this.drivenCar) {
      const car = this.drivenCar;
      const before = Math.abs(car.speed);
      const stepped = stepCar(this.world, car, this.carInput, dt);
      car.pos = stepped.car.pos;
      car.heading = stepped.car.heading;
      car.speed = stepped.car.speed;
      if (stepped.hitBuilding && before > 8) this.crash();
      // Car-vs-car.
      for (const other of this.cars) {
        if (other === car) continue;
        if (dist(car.pos, other.pos) < 3.4) {
          if (Math.abs(car.speed) > 3 && this.crashCooldown === 0) this.crash();
          car.speed = 0;
          if (other.traffic) other.traffic.stopped = true;
        }
      }
      this.playerPos = { ...car.pos };
      this.playerHeading = car.heading;
      this.missions.update(this.playerPos, true);
      this.afterMissionEvent();
    } else {
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
      this.missions.update(this.playerPos, false);
    }
  }

  private crash(): void {
    if (this.crashCooldown > 0) return;
    this.crashCooldown = 1.5;
    this.wanted.add(1);
    this.showToast('Reckless driving — wanted level up');
  }

  objectiveText(): string {
    const step = this.missions.currentStep;
    if (this.missions.active && step) {
      return `${this.missions.active.title}: ${step.objective}`;
    }
    if (!this.missions.active) {
      const avail = this.missions.available();
      if (avail.length) return `Find a mission marker (${avail.map((m) => m.startLabel).join(' / ')}) and press E`;
      return 'All missions complete. Free roam Fredericton.';
    }
    return '';
  }

  hud(): HudState {
    return {
      money: this.wallet.money,
      stars: this.wanted.stars,
      objective: this.objectiveText(),
      toast: this.toast,
      inCar: !!this.drivenCar,
      speedKmh: this.drivenCar ? Math.round(Math.abs(this.drivenCar.speed) * 3.6) : 0,
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
      });
    }
    if (!this.drivenCar) {
      entities.push({
        id: 'player',
        kind: 'player',
        pos: this.playerPos,
        heading: this.playerHeading,
        color: '#ffd23f',
      });
    }
    const markers: RenderMarker[] = [];
    if (!this.missions.active) {
      for (const m of this.missions.available()) {
        markers.push({ pos: m.startPos, radius: 7, label: m.startLabel, kind: 'mission-start' });
      }
    }
    const step = this.missions.currentStep;
    if (this.missions.active && step?.pos) {
      markers.push({
        pos: step.pos,
        radius: step.radius ?? 6,
        label: this.missions.active.title,
        kind: 'objective',
      });
    }
    return {
      camera: this.drivenCar ? this.drivenCar.pos : this.playerPos,
      viewHeightM: this.drivenCar ? 175 : 120,
      playerInCar: !!this.drivenCar,
      entities,
      markers,
    };
  }
}

export type { MissionDef };
