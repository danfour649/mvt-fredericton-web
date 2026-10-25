/**
 * Missions, ported from the desktop game's data/missions/*.json
 * (GTAfredericton repo, © OpenStreetMap contributors coordinate frame —
 * see README attribution).
 *
 * The desktop JSON positions live in the ROTATED MVT grid frame. They are
 * converted to the core frame at definition time with mvtGridToLocal()
 * (rotate by -GRID_ROTATION_DEG). The original grid coordinates are kept
 * alongside for traceability and tests.
 */
import { mvtGridToLocal, type Vec2 } from './geo';

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
  payout: number;
  startPos: Vec2;
  startGridPos: [number, number];
  startLabel: string;
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
];

export type MissionEvent =
  | { type: 'started'; mission: MissionDef }
  | { type: 'step'; mission: MissionDef; step: MissionStep }
  | { type: 'completed'; mission: MissionDef };

/**
 * Mission state machine: at most one active mission. Positional steps are
 * completed by the game calling tryInteract() (interact steps, player near
 * and pressing E) or by state predicates in update() (vehicle steps).
 */
export class MissionRunner {
  active: MissionDef | null = null;
  stepIndex = 0;
  completed = new Set<string>();
  events: MissionEvent[] = [];

  constructor(completedIds: string[] = []) {
    for (const id of completedIds) this.completed.add(id);
  }

  get currentStep(): MissionStep | null {
    return this.active ? (this.active.steps[this.stepIndex] ?? null) : null;
  }

  /** Missions that can still be started (not completed, not active). */
  available(): MissionDef[] {
    return MISSIONS.filter((m) => !this.completed.has(m.id) && m.id !== this.active?.id);
  }

  start(mission: MissionDef): boolean {
    if (this.active || this.completed.has(mission.id)) return false;
    this.active = mission;
    this.stepIndex = 0;
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
      this.events.push({ type: 'completed', mission });
    } else {
      this.events.push({ type: 'step', mission: this.active, step: this.currentStep! });
    }
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
