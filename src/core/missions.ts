/**
 * Missions. The first two are ported from the desktop game's
 * data/missions/*.json (GTAfredericton repo, © OpenStreetMap contributors
 * coordinate frame — see README attribution); v0.20 adds two more built
 * from the same step kinds, one of them timed, all of them started at
 * ringing payphones GTA-1-style.
 *
 * The desktop JSON positions live in the ROTATED MVT grid frame. They are
 * converted to the core frame at definition time with mvtGridToLocal()
 * (rotate by -GRID_ROTATION_DEG). The original grid coordinates are kept
 * alongside for traceability and tests. The two added missions use the
 * same grid conversion with hand-placed downtown grid coordinates.
 */
import { dist, mvtGridToLocal, type Vec2 } from './geo';
import { collideWorld, nearestRoadPoint, pointInWater, type WorldModel } from './world';

export type StepKind = 'interact' | 'steal_vehicle' | 'deliver_vehicle';

export interface MissionStep {
  id: string;
  kind: StepKind;
  objective: string;
  /** Core-frame position, when the step is place-bound. */
  pos?: Vec2;
  /** Original desktop grid position [x, z], for traceability. */
  gridPos?: [number, number];
  radius?: number;
  prompt?: string;
}

export interface MissionDef {
  id: string;
  title: string;
  brief: string;
  /** Desktop payout in $ — the game awards it as score (see game.ts). */
  payout: number;
  startPos: Vec2;
  startGridPos: [number, number];
  startLabel: string;
  /** Seconds on the clock once started; undefined = untimed. */
  timeLimitSec?: number;
  steps: MissionStep[];
}

function grid(x: number, z: number): { pos: Vec2; gridPos: [number, number] } {
  return { pos: mvtGridToLocal(x, z), gridPos: [x, z] };
}

/** Desktop spawn: [0.5, 27.8] in the MVT grid (Queen St near City Hall). */
export const SPAWN_GRID: [number, number] = [0.5, 27.8];
export const SPAWN_POS: Vec2 = mvtGridToLocal(SPAWN_GRID[0], SPAWN_GRID[1]);

export const MISSIONS: MissionDef[] = [
  {
    // data/missions/queen_street_errand.json — verbatim steps/payout.
    id: 'queen_street_errand',
    title: 'Queen Street Errand',
    brief: 'Someone left an envelope at Gallery on Queen. Walk it down to Gahan House.',
    payout: 150,
    ...(() => {
      const g = grid(-4.0, 26.0);
      return { startPos: g.pos, startGridPos: g.gridPos };
    })(),
    startLabel: 'ERRAND',
    steps: [
      {
        id: 'pickup',
        kind: 'interact',
        objective: 'Pick up the envelope at Gallery on Queen',
        ...(() => {
          const g = grid(8.8, 28.0);
          return { pos: g.pos, gridPos: g.gridPos };
        })(),
        radius: 6,
        prompt: 'Take envelope',
      },
      {
        id: 'dropoff',
        kind: 'interact',
        objective: 'Drop the envelope at Gahan House',
        ...(() => {
          const g = grid(48.0, 28.0);
          return { pos: g.pos, gridPos: g.gridPos };
        })(),
        radius: 6,
        prompt: 'Deliver envelope',
      },
    ],
  },
  {
    // data/missions/cap_wheels.json — verbatim steps/payout.
    id: 'cap_wheels',
    title: 'Wheels for The Cap',
    brief: 'The Cap needs a ride. Steal any car and dump it out front.',
    payout: 250,
    ...(() => {
      const g = grid(-50.0, 33.0);
      return { startPos: g.pos, startGridPos: g.gridPos };
    })(),
    startLabel: 'WHEELS',
    steps: [
      { id: 'steal', kind: 'steal_vehicle', objective: 'Steal any parked car' },
      {
        id: 'drop',
        kind: 'deliver_vehicle',
        objective: 'Dump the car in front of The Cap',
        ...(() => {
          const g = grid(-58.0, 32.0);
          return { pos: g.pos, gridPos: g.gridPos };
        })(),
        radius: 12,
      },
    ],
  },
  {
    // v0.20 addition — TIMED. Steal a car up Queen and burn it downtown
    // to the west-end drop against the clock.
    id: 'downtown_burner',
    title: 'Downtown Burner',
    brief: 'Grab any car and burn it downtown to the west-end drop. Clock\'s ticking — don\'t be late.',
    payout: 400,
    timeLimitSec: 80,
    ...(() => {
      const g = grid(150.0, 30.0);
      return { startPos: g.pos, startGridPos: g.gridPos };
    })(),
    startLabel: 'BURNER',
    steps: [
      { id: 'steal', kind: 'steal_vehicle', objective: 'Steal any parked car' },
      {
        id: 'drop',
        kind: 'deliver_vehicle',
        objective: 'Get the car to the west-end drop before time runs out',
        ...(() => {
          const g = grid(-150.0, 35.0);
          return { pos: g.pos, gridPos: g.gridPos };
        })(),
        radius: 13,
      },
    ],
  },
  {
    // v0.20 addition — a foot job on the south block (George/King area).
    id: 'george_street_drop',
    title: 'George Street Drop',
    brief: 'Package is waiting on the south block. Pick it up and walk it to the George Street door. No car — keep it quiet.',
    payout: 300,
    ...(() => {
      const g = grid(60.0, 110.0);
      return { startPos: g.pos, startGridPos: g.gridPos };
    })(),
    startLabel: 'DROP',
    steps: [
      {
        id: 'pickup',
        kind: 'interact',
        objective: 'Pick up the package on the south block',
        ...(() => {
          const g = grid(66.0, 112.0);
          return { pos: g.pos, gridPos: g.gridPos };
        })(),
        radius: 7,
        prompt: 'Take package',
      },
      {
        id: 'dropoff',
        kind: 'interact',
        objective: 'Drop the package at the George Street door',
        ...(() => {
          const g = grid(-40.0, 115.0);
          return { pos: g.pos, gridPos: g.gridPos };
        })(),
        radius: 7,
        prompt: 'Leave package',
      },
    ],
  },
];

/**
 * Reachability guard (Daniel, 2026-11-23: "mission points that are
 * impossible to reach"). The hand-placed grid positions above were
 * never checked against the real GeoNB building geometry: the George
 * Street Drop payphone and its pickup sat sealed inside a building
 * block 36 m from the nearest road (no free spot inside their own
 * interact radius), and the Downtown Burner payphone and the George
 * dropoff were embedded in building collision. A point only stays
 * where it was authored if a player can actually stand there: free
 * of building collision, out of open water, near a road. Anything
 * else is moved to the nearest standable roadside spot — the road
 * point itself if no offset clears — so a mission point can never
 * spawn inside a building or a sealed block again, whatever the
 * dataset does to the authored coordinates.
 */
export function standablePoint(world: WorldModel, pos: Vec2): Vec2 {
  const standable = (p: Vec2): boolean => {
    if (collideWorld(world, p, 0.55)) return false;
    if (!pointInWater(world, p)) return true;
    const nr = nearestRoadPoint(world, p); // on a bridge deck = fine
    return !!nr && dist(p, nr.pos) <= 6;
  };
  if (standable(pos)) {
    const near = nearestRoadPoint(world, pos);
    if (near && dist(pos, near.pos) <= 15) return pos;
  }
  const near = nearestRoadPoint(world, pos);
  if (!near) return pos;
  const hx = Math.cos(near.heading), hz = Math.sin(near.heading);
  const candidates: Vec2[] = [near.pos];
  for (const off of [3.5, 5.5, 8]) {
    candidates.push({ x: near.pos.x - hz * off, z: near.pos.z + hx * off });
    candidates.push({ x: near.pos.x + hz * off, z: near.pos.z - hx * off });
  }
  for (const slide of [5, 10, -5, -10]) {
    candidates.push({ x: near.pos.x + hx * slide, z: near.pos.z + hz * slide });
  }
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (!standable(c)) continue;
    const d = dist(c, pos);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ?? near.pos;
}

/** MISSIONS with every payphone / step position made standable. */
export function sanitizeMissions(world: WorldModel, defs: MissionDef[] = MISSIONS): MissionDef[] {
  return defs.map((m) => ({
    ...m,
    startPos: standablePoint(world, m.startPos),
    steps: m.steps.map((s) => (s.pos ? { ...s, pos: standablePoint(world, s.pos) } : s)),
  }));
}

export type MissionEvent =
  | { type: 'started'; mission: MissionDef }
  | { type: 'step'; mission: MissionDef; step: MissionStep }
  | { type: 'completed'; mission: MissionDef; payoutScale: number }
  | { type: 'failed'; mission: MissionDef }
  | { type: 'lap'; lap: number };

/**
 * Mission state machine: at most one active mission. Positional steps are
 * completed by the game calling tryInteract() (interact steps, player near
 * and pressing E) or by state predicates in update() (vehicle steps).
 * Timed missions count down via tick(); expiry fails the mission (it can
 * be re-taken at its payphone — it is NOT marked completed).
 */
export class MissionRunner {
  active: MissionDef | null = null;
  stepIndex = 0;
  completed = new Set<string>();
  /** Encore lap (v0.34): when every mission is done the payphones
   *  ring again instead of the run going dry — the completed set
   *  clears, the lap increments and payouts scale +50% per lap. */
  lap = 1;
  events: MissionEvent[] = [];

  /** Payout multiplier for the current lap: ×1, ×1.5, ×2, … */
  payoutScale(): number {
    return 1 + 0.5 * (this.lap - 1);
  }
  /** Seconds left on the active timed mission; null when untimed/none. */
  timeLeft: number | null = null;

  /** The mission definitions in play (the Game passes a
   *  reachability-sanitized copy — see sanitizeMissions). */
  readonly defs: MissionDef[];

  constructor(completedIds: string[] = [], defs: MissionDef[] = MISSIONS) {
    for (const id of completedIds) this.completed.add(id);
    this.defs = defs;
  }

  get currentStep(): MissionStep | null {
    return this.active ? (this.active.steps[this.stepIndex] ?? null) : null;
  }

  /** Missions that can still be started (not completed, not active). */
  available(): MissionDef[] {
    return this.defs.filter((m) => !this.completed.has(m.id) && m.id !== this.active?.id);
  }

  start(mission: MissionDef): boolean {
    if (this.active || this.completed.has(mission.id)) return false;
    this.active = mission;
    this.stepIndex = 0;
    this.timeLeft = mission.timeLimitSec ?? null;
    this.events.push({ type: 'started', mission });
    return true;
  }

  private advance(): void {
    if (!this.active) return;
    this.stepIndex++;
    if (this.stepIndex >= this.active.steps.length) {
      const mission = this.active;
      this.completed.add(mission.id);
      this.active = null;
      this.stepIndex = 0;
      this.timeLeft = null;
      this.events.push({ type: 'completed', mission, payoutScale: this.payoutScale() });
      if (this.completed.size >= this.defs.length) {
        // Encore lap: refill the payphones rather than declaring
        // "all missions complete" and leaving free roam goalless.
        this.completed.clear();
        this.lap++;
        this.events.push({ type: 'lap', lap: this.lap });
      }
    } else {
      this.events.push({ type: 'step', mission: this.active, step: this.currentStep! });
    }
  }

  /** Fail the active mission (timer expiry). It stays un-completed. */
  fail(): void {
    if (!this.active) return;
    const mission = this.active;
    this.active = null;
    this.stepIndex = 0;
    this.timeLeft = null;
    this.events.push({ type: 'failed', mission });
  }

  /** Count down a timed mission; fails it at zero. */
  tick(dt: number): void {
    if (!this.active || this.timeLeft === null) return;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) this.fail();
  }

  /** Interact steps: call when the player presses E near the step pos. */
  tryInteract(playerPos: Vec2): boolean {
    const step = this.currentStep;
    if (!step || step.kind !== 'interact' || !step.pos) return false;
    if (Math.hypot(playerPos.x - step.pos.x, playerPos.z - step.pos.z) <= (step.radius ?? 6)) {
      this.advance();
      return true;
    }
    return false;
  }

  /** Vehicle-step predicates, evaluated by the game loop each tick. */
  notifyEnteredParkedCar(): void {
    if (this.currentStep?.kind === 'steal_vehicle') this.advance();
  }

  update(playerPos: Vec2, inCar: boolean): void {
    const step = this.currentStep;
    if (!step) return;
    if (step.kind === 'deliver_vehicle' && inCar && step.pos) {
      if (Math.hypot(playerPos.x - step.pos.x, playerPos.z - step.pos.z) <= (step.radius ?? 12)) {
        this.advance();
      }
    }
  }

  drainEvents(): MissionEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
