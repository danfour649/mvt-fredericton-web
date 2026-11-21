/**
 * Game: the whole simulation in one renderer-agnostic class.
 *
 * v0.20 — the GTA 1 loop: score IS money, one meter. The multiplier is
 * the progression (mission completions raise it, BUSTED halves it).
 * Payphone missions (2 ported from desktop + 2 new, one timed), pursuing
 * police with a bust timer, pedestrians, a respray garage, car/player
 * damage, 5 lives, and a $250,000 district goal with an exit point.
 *
 * v0.24 — the cold start: spawn is a living street (guaranteed kerbside
 * + rolling traffic at t=0) and a population bubble keeps traffic and
 * parked cars around the player everywhere (see maintainPopulation).
 *
 * v0.25 — the audit release (docs/AUDIT-v025.md): E-interact resolves
 * by NEAREST interactable (spawn geometry put a parked car inside
 * payphone radius — one fixed priority always ate the other action);
 * traffic follows/brakes behind leaders instead of driving through
 * them; pedestrians bubble like cars; a cop ram that wrecks the
 * player's car no longer dereferences the nulled drivenCar (that
 * crash froze the frame loop); bubble top-up cadence 0.4 s → 0.1 s
 * with burst 6 so the ≥8 traffic floor holds at every tick.
 *
 * Feed it inputs, call update(dt), hand buildFrame() to any Renderer.
 * No DOM, no MapLibre, no canvas anywhere in here.
 */
import { dist, mvtGridToLocal, type Vec2 } from './geo';
import { nearestRoadPoint, pointAlongRoad, pointInWater, type Road, type WorldModel } from './world';
import { moveCircle, stepCar, type CarInput, type CarState } from './physics';
import { spawnTraffic, updateTraffic, type TrafficCar } from './traffic';
import { buildRoadGraph, type RoadGraph } from './routing';
import { spawnCop, updateCop, type CopCar } from './cops';
import { spawnPeds, spawnProcession, updatePed, nudgePed, reanchorPed, forceDown, type Ped } from './peds';
import { Wanted } from './wanted';
import { Wallet, BUSTED_FINE, HOSPITAL_FEE } from './wallet';
import { MissionRunner, SPAWN_POS, type MissionDef } from './missions';
import { SaveStore, type StorageAdapter } from './save';
import { Loadout, WEAPONS, type WeaponId } from './weapons';
import { placePickups, PICKUP_STYLE, RESPAWN_SEC, type Pickup } from './pickups';
import type { RenderFrame, RenderEntity, RenderEffect, RenderMarker } from './renderer';

export type BodyType = 'car' | 'taxi' | 'van' | 'pickup';

export interface CarEntity extends CarState {
  id: string;
  kind: 'parked' | 'traffic';
  color: string;
  traffic?: TrafficCar;
  /** 0..100. 0 = burning (v0.30: fire comes before the wreck). */
  health: number;
  wrecked: boolean;
  /** Player has stolen this car at least once. */
  stolen: boolean;
  /** Seconds a traffic car stays stopped after being hit. */
  trafficStopT: number;
  /** v0.30: health hit 0 — the car is ON FIRE and will explode when
   *  burnT runs out. Bail, or burn with it. */
  burning: boolean;
  burnT: number;
  exploded: boolean;
  /** v0.30: this fire is the player's work (frenzy/payout credit). */
  burnByPlayer: boolean;
  /** v0.30: accumulated flamethrower heat — ignites the car early. */
  flameHeat: number;
  /** v0.30: sprite variety on the shared handling classes. */
  bodyType: BodyType;
  /** v0.30: delivered for the vehicle job — the chop shop won't
   *  double-pay for the same car. */
  delivered: boolean;
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
  /** v0.29: the driven car is rolling backwards — HUD shows the R. */
  reversing: boolean;
  /** v0.30: current weapon + ammo (null ammo = infinite, fists). */
  weaponId: WeaponId;
  weaponName: string;
  ammo: number | null;
  /** v0.30: armour pool (absorbs on-foot damage before health). */
  armour: number;
  /** v0.30: holding a Get Outta Jail Free card. */
  jailCard: boolean;
  /** v0.30: class of the driven car (radio station source), null on foot. */
  carClass: string | null;
  /** v0.30: active Kill Frenzy readout, null when none. */
  frenzy: { label: string; have: number; need: number; secsLeft: number } | null;
  /** Iteration 4: a vehicle job is live (marked car → chop shop) —
   *  the HUD's edge arrow aims at the chop shop while it's on. */
  vehJob: boolean;
  /** v0.30: monotonic event counters — main.ts diffs these to fire
   *  one-shot audio (the established state-diff seam). */
  shotsFired: number;
  explosions: number;
  splashes: number;
  pickupsTaken: number;
  frenzyStarts: number;
  frenzyWins: number;
}

/** v0.30: an active Kill Frenzy (timed quota, GTA 1 rampage shape). */
export interface FrenzyState {
  kind: 'runover' | 'destroy' | 'gun';
  label: string;
  need: number;
  have: number;
  tLeft: number;
  /** Gun frenzy: this weapon fires for free while the frenzy runs. */
  weapon?: WeaponId;
}

const FRENZY_DEFS: Record<FrenzyState['kind'], { need: number; secs: number; label: string; weapon?: WeaponId }> = {
  runover: { need: 8, secs: 75, label: 'run down 8 pedestrians' },
  destroy: { need: 4, secs: 90, label: 'destroy 4 cars' },
  gun: { need: 10, secs: 90, label: 'shoot 10 pedestrians', weapon: 'mg' },
};
export const FRENZY_PAYOUT = 2500;
export const FRENZY_CONSOLATION = 100;

/** v0.29: shown once, on the first car entry ever (persisted). */
export const DRIVE_HINT = 'Drive: steer ◀ ▶ · GAS / BRK pedals · hold BRK at a stop to REVERSE';

/**
 * FOLLOW iteration 2: the boot cinematic — camera starts at "space"
 * altitude (the whole extract in frame) and descends onto the spawn,
 * fast at altitude and progressively slower near the street. The
 * duration lives here so the tests and the platform layer agree.
 */
export const INTRO_DURATION_S = 4.2;

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
/**
 * v0.24 population bubble: traffic is kept rolling around the player
 * wherever they go; parked cars are kept on the kerbs nearby. Radii in
 * metres from the player, counts are the floors we recycle toward.
 */
export const BUBBLE_R = 220;
/** Iteration 3 mayhem dial (Follow PR): 10 → 14 traffic in the bubble.
 *  v0.34: 14 → 16 — fuller streets (Daniel: "make it less boring"). */
export const TRAFFIC_TARGET = 16;
export const PARKED_NEAR_R = 150;
export const PARKED_TARGET = 4;
/** v0.25: pedestrians bubble too — peds beyond PED_BUBBLE_R are
 *  re-anchored near the player until PED_TARGET are within range.
 *  Iteration 3 mayhem dial: the floor rises 12 → 16 (of the 20-ped
 *  pool) — the sidewalks should feel populated, not sprinkled.
 *  v0.34: pool 20 → 26, floor 16 → 19 — busier sidewalks still. */
export const PED_BUBBLE_R = 260;
export const PED_TARGET = 19;
const PED_SCORE = 100;
const THEFT_SCORE = 500;
/** v0.30 crime economy (audit #9): GTA 1 paid for violence directly —
 *  ramming 10, a pedestrian down 100, a cop destroyed 1,000. */
const SHOOT_PED_SCORE = 150;
const FIST_PED_SCORE = 25;
const COP_KILL_SCORE = 1000;
const RAM_SCORE = 30;
/** v0.30: a cop within this range has "eyes on" you — wanted decay
 *  pauses entirely (audit #4: GTA 1 heat never melted on its own;
 *  ours still can, but only once you've actually broken contact). */
const COP_EYES_M = 80;
/** v0.30: chop shop pays class base × remaining health fraction. */
const CHOP_BASE: Record<string, number> = { standard: 800, fast: 1600 };
/** v0.30: the vehicle job (a marked parked car → timed delivery). */
const VEH_JOB_PAYOUT = 250; // × MISSION_SCORE_SCALE, like the payphones
const VEH_JOB_SECS = 90;
/** v0.34: the wait between vehicle jobs drops 120 s → 30 s — two
 *  minutes of nothing between jobs was dead air (Daniel: "make it
 *  less boring"). */
const VEH_JOB_COOLDOWN_SEC = 30;
const WALK_SPEED = 5.4;
/** v0.29: metres per full 4-frame walk cycle (two steps). */
const PLAYER_STRIDE_M = 1.5;
const PED_STRIDE_M = 1.3;
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

/** Closest distance from a point to a road's centreline path (m). */
function roadMinDist(road: Road, p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < road.path.length - 1; i++) {
    const a = road.path[i];
    const b = road.path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
    if (d < best) best = d;
  }
  return best;
}

/** distAlong of the point on a road closest to `p` (m). */
function closestAlong(road: Road, p: Vec2): number {
  let best = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < road.path.length - 1; i++) {
    const a = road.path[i];
    const b = road.path[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
    if (d < best) {
      best = d;
      bestAlong = road.segLens.slice(0, i).reduce((s, l) => s + l, 0) + road.segLens[i] * t;
    }
  }
  return bestAlong;
}

/** Kerbside placement on a road at `along` (clamped): parked just off
 *  the carriageway, facing along the road on a random side. */
function kerbPlacement(road: Road, along: number, rng: () => number): { pos: Vec2; heading: number } {
  const d = Math.max(3, Math.min(road.lengthM - 3, along));
  const { pos, heading } = pointAlongRoad(road, d);
  const off = road.widthM / 2 - 0.6;
  const side = rng() > 0.5 ? 1 : -1;
  return {
    pos: {
      x: pos.x + Math.cos(heading + Math.PI / 2) * off * side,
      z: pos.z + Math.sin(heading + Math.PI / 2) * off * side,
    },
    heading: side === 1 ? heading : heading + Math.PI,
  };
}

export class Game {
  readonly wanted = new Wanted();
  readonly wallet = new Wallet();
  missions: MissionRunner;
  private saveStore: SaveStore;
  private archive: { completed: string[]; districtCleared: boolean; bestScore: number };
  /** v0.24: persisted — the spawn anchor ring shows until this flips. */
  private enteredCar = false;
  /** v0.29: persisted — the first-drive hint shows exactly once. */
  private seenDriveHint = false;
  private driveHintPending = false;
  /**
   * The first-drive hint TEXT. The core default teaches the pedals;
   * the platform layer swaps in a gesture vocabulary when the
   * FOLLOW scheme is live (no pedals exist there). Set at boot and
   * on scheme changes; the once-ever persistence is unaffected.
   */
  driveHintText: string = DRIVE_HINT;
  /** v0.29: metres walked (drives the walk-cycle phase, distance-based). */
  private playerWalkM = 0;

  phase: GamePhase = 'play';
  goalState: GoalState = 'progress';
  lives = START_LIVES;
  playerHealth = 100;

  playerPos: Vec2 = { ...SPAWN_POS };
  playerHeading = 0;
  playerVel: Vec2 = { x: 0, z: 0 };
  /** Walk-speed multiplier (1 = stroll). The FOLLOW scheme raises
   *  it for the jog on long on-foot map picks (followDrive's
   *  FOLLOW_JOG_* rule, applied in main.ts); nothing else does. */
  walkSpeedMul = 1;
  cars: CarEntity[] = [];
  cops: CopCar[] = [];
  peds: Ped[] = [];
  drivenCar: CarEntity | null = null;

  moveInput: Vec2 = { x: 0, z: 0 };
  carInput: CarInput = { throttle: 0, steer: 0 };

  // --- v0.30 systems state -------------------------------------------------
  /** The player's arsenal (weapons.ts). Public: input layer + rig. */
  loadout = new Loadout();
  /** Set by the input layer (touch FIRE button / Space / gamepad). */
  fireHeld = false;
  private fireCooldown = 0;
  /** Armour pool: soaks on-foot damage before health (pickup-fed). */
  armour = 0;
  /** Holding a Get Outta Jail Free card: the next bust is free. */
  jailCard = false;
  /** The world's pickups (crates, cards, skulls). Public for the rig. */
  pickups: Pickup[] = [];
  frenzy: FrenzyState | null = null;
  /** Transient visual effects (explosions, splashes, tracers). */
  private fx: { kind: RenderEffect['kind']; pos: Vec2; to?: Vec2; t: number; ttl: number; radiusM?: number }[] = [];
  /** Scorch marks left by explosions (capped, oldest fade out). */
  scorches: Vec2[] = [];
  private projectiles: { pos: Vec2; vel: Vec2; life: number }[] = [];
  /** Why the player last died — applyWasted prefers it in the toast. */
  private wastedReason = '';
  // Monotonic event counters for the audio seam (see HudState).
  private shotsFired = 0;
  private explosionsCount = 0;
  private splashesCount = 0;
  private pickupsTaken = 0;
  private frenzyStarts = 0;
  private frenzyWins = 0;
  /** Vehicle job: a marked parked car + the active delivery. */
  private markedCarId: string | null = null;
  private vehJob: { carId: string; tLeft: number } | null = null;
  private vehJobCd = 0;
  private roadblockCd = 0;
  private witnessCd = 0;
  /** Gouranga procession timer + per-group down tracking. */
  private gourangaT = 75;
  private gourangaSeq = 0;
  private gourangaDowns = new Map<string, Map<string, number>>();

  /** Snapped POIs (core metres). */
  readonly resprayPos: Vec2;
  readonly exitPos: Vec2;
  /** v0.30: the chop shop — stolen cars in, money out. */
  readonly chopShopPos: Vec2;

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
  // camViewM is the view WIDTH in metres (v0.23 GTA-1 framing;
  // on-foot width tightened to 30 m in v0.24).
  private camPos: Vec2 = { ...SPAWN_POS };
  private camViewM = 30;

  // Boot cinematic (FOLLOW iteration 2): beginIntro() arms it when
  // the loading overlay dismisses; updateCamera() then interpolates
  // centre + view width from the whole-map framing down to the
  // normal gameplay framing, and update() locks driving input while
  // it runs. Any input skips it (the platform calls skipIntro()).
  private introActive = false;
  private introT = 0;
  private introFrom: { pos: Vec2; view: number } = { pos: { ...SPAWN_POS }, view: 30 };
  /** The demo scenario wants its settled framing — no cinematic. */
  private introSuppressed = false;

  // v0.24 population bubble (see ARCHITECTURE.md): traffic and parked
  // cars are recycled around the player so the street is never empty.
  private bubbleTimer = 0;

  private world: WorldModel;

  /** Junction graph for traffic routing (v0.21). */
  readonly roadGraph: RoadGraph;
  private trafficRng = mulberry32(777);
  /** v0.25: peds draw from their OWN stream. The ped bubble must not
   *  consume trafficRng — sharing it couples the two systems through
   *  the PRNG sequence and measurably perturbed the traffic bubble's
   *  top-up history (the v0.24 ≥8-within-220 m invariant dipped to 7). */
  private pedRng = mulberry32(31337);

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
    this.enteredCar = save.hasEnteredCar;
    this.seenDriveHint = save.hasSeenDriveHint;
    if (save.districtCleared) this.goalState = 'done';
    this.missions = new MissionRunner(); // a fresh run: payphones ring again
    this.resprayPos = snapToRoad(world, 95, 55);
    this.exitPos = snapToRoad(world, 170, 20);
    this.chopShopPos = snapToRoad(world, -120, 100);
    this.spawnCars();
    this.peds = spawnPeds(world, SPAWN_POS, 26, mulberry32(777));
    this.pickups = placePickups(world);
    this.markVehJobCar();
  }

  /** v0.30: designate a parked car as the vehicle-job car (nearest
   *  parked car to the east-side job point). Entering it starts the
   *  timed delivery to the chop shop. */
  private markVehJobCar(): void {
    const target = snapToRoad(this.world, 140, 60);
    let best: CarEntity | null = null;
    let bestD = 70;
    for (const car of this.cars) {
      if (car.kind !== 'parked' || car.wrecked) continue;
      const d = dist(car.pos, target);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    this.markedCarId = best?.id ?? null;
  }

  // --- world population ---------------------------------------------------

  /**
   * v0.24: the cold start must be a LIVING street (GTA 1 drops you in
   * traffic; the v0.20–0.23 spawner scattered cars over the whole
   * extract and could leave the spawn block completely empty — the
   * nearest car was 156 m away). Placement order is now:
   *   1. guaranteed kerbside parked cars within 60 m of spawn;
   *   2. guaranteed traffic already rolling within 150 m of spawn;
   *   3. the old wide fill for the rest of the extract;
   * and maintainPopulation() keeps the bubble full wherever the
   * player goes afterwards.
   */
  private spawnCars(): void {
    const rng = mulberry32(20261025);
    this.cars = [];
    let n = 0;
    // v0.30 body variety: deterministic by spawn index — taxis are
    // yellow with a roof sign, vans and pickups share the car
    // footprint/handling (sprite variety only, physics untouched).
    const bodyFor = (i: number): { bodyType: BodyType; color: string } => {
      if (i % 5 === 4) return { bodyType: 'taxi', color: '#e0a81c' };
      if (i % 7 === 3) return { bodyType: 'van', color: CAR_COLORS[(i + 2) % CAR_COLORS.length] };
      if (i % 6 === 2) return { bodyType: 'pickup', color: CAR_COLORS[(i + 5) % CAR_COLORS.length] };
      return { bodyType: 'car', color: CAR_COLORS[i % CAR_COLORS.length] };
    };
    const freshCar = {
      burning: false, burnT: 0, exploded: false, burnByPlayer: false,
      flameHeat: 0, delivered: false,
    };
    const addParked = (road: Road, along: number): CarEntity => {
      const at = kerbPlacement(road, along, rng);
      const body = bodyFor(n);
      const car: CarEntity = {
        id: `parked-${n}`,
        kind: 'parked',
        color: body.color,
        pos: at.pos,
        heading: at.heading,
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
        bodyType: body.bodyType,
        ...freshCar,
      };
      this.cars.push(car);
      n++;
      return car;
    };
    let t = 0;
    const addTraffic = (road: Road, along: number): void => {
      const traffic = spawnTraffic(road, along);
      const body = bodyFor(t + 3);
      this.cars.push({
        id: `traffic-${t}`,
        kind: 'traffic',
        color: body.color,
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
        bodyType: body.bodyType,
        ...freshCar,
      });
      t++;
    };
    /** Place a parked car; reject (and un-place) when it would land
     *  on top of another parked car or outside `maxFromSpawn`. */
    const tryParked = (road: Road, along: number, maxFromSpawn?: number): boolean => {
      const car = addParked(road, along);
      const ok =
        (maxFromSpawn === undefined || dist(car.pos, SPAWN_POS) <= maxFromSpawn) &&
        !this.cars.some((c) => c !== car && c.kind === 'parked' && dist(c.pos, car.pos) < 7);
      if (!ok) {
        this.cars.splice(this.cars.indexOf(car), 1);
        n--;
      }
      return ok;
    };

    const usable = this.world.roads.filter((r) => r.lengthM > 45);
    const byDist = usable
      .map((road) => ({ road, d: roadMinDist(road, SPAWN_POS) }))
      .sort((a, b) => a.d - b.d);

    // 1. Kerbside at spawn: ≥5 parked cars within 60 m, each placed at
    // its road's closest approach to spawn (staggered along the road
    // when one street has to carry more than one). Five, tightly
    // staggered, so the tight 30 m first frame itself shows a full
    // kerb — three in frame read as luck, five placed is a street.
    let nearParked = 0;
    for (const { road, d } of byDist) {
      if (d > 60 || nearParked >= 5) break;
      const at = closestAlong(road, SPAWN_POS);
      for (const off of [0, 8, -8, 16, -16, 24, -24]) {
        if (nearParked >= 5) break;
        if (tryParked(road, at + off, 60)) nearParked++;
      }
    }

    // 2. Rolling at spawn: a traffic STREAM on the spawn street
    // (four cars spaced upstream + one leaving downstream, so cars
    // keep passing the spawn block for tens of seconds) plus one
    // cross-traffic car on the next-nearest street within 150 m.
    let nearTraffic = 0;
    for (const { road, d } of byDist) {
      if (d > 150 || nearTraffic >= 6) break;
      const at = closestAlong(road, SPAWN_POS);
      if (nearTraffic === 0) {
        const dir = road.dirFlow.includes('Opposite') ? -1 : 1;
        for (const back of [22, 55, 95, 140]) {
          addTraffic(road, at - dir * back);
          nearTraffic++;
        }
        addTraffic(road, at + dir * 24);
        nearTraffic++;
      } else {
        addTraffic(road, at + (nearTraffic - 2) * 22);
        nearTraffic++;
      }
    }

    // 3. Wide fill (the pre-v0.24 scheme, separation-checked): parked
    // across the extract, traffic topped up on the longest roads.
    const wide = this.world.roads.filter(
      (r) => r.lengthM > 45 && dist(r.path[0], SPAWN_POS) < 900,
    );
    for (let i = 0; i < wide.length && n < 20; i += 3) {
      const road = wide[i];
      tryParked(road, road.lengthM * (0.25 + 0.5 * rng()));
    }
    const longest = [...this.world.roads].sort((a, b) => b.lengthM - a.lengthM).slice(0, 22);
    // Iteration 3: the wide-fill pool cap rises 12 → 18 (and the
    // longest-roads window widens so the loop can actually reach
    // it) so the raised bubble target (14) always has far cars to
    // recycle FROM. The pool stays a fixed spawn-time count — the
    // bubble recycles within it, nothing grows at runtime.
    for (let i = 0; i < longest.length && t < 18; i += 2) {
      addTraffic(longest[i], longest[i].lengthM * (0.2 + 0.6 * rng()));
    }
  }

  // --- population bubble (v0.24) -------------------------------------------

  /**
   * Keeps the street alive around the player: ~TRAFFIC_TARGET traffic
   * cars inside BUBBLE_R at all times, plus a kerb population of
   * untouched parked cars. Recycling only ever moves a car that is
   * OUTSIDE the bubble ONTO a spot that is inside the bubble but
   * beyond the current view (view width × 1.2 + 30 m — covers the
   * frame diagonal on any aspect), so a recycled car never pops in
   * on screen. The driven car, stolen/wrecked cars and cars mid-stop
   * after a hit are never recycled. Deterministic (trafficRng).
   */
  private maintainPopulation(dt: number): void {
    this.bubbleTimer += dt;
    // v0.25: 0.1 s cadence (was 0.4 s). The bubble floor (≥8 traffic
    // within 220 m) is a gameplay guarantee, and at 0.4 s a deficit
    // could survive a whole tick — measured: the count sat below 8
    // for 1.7–2.2% of ticks in BOTH v0.24 and v0.25 dynamics, which
    // made the v0.24 invariant test a coin flip for any build whose
    // traffic history shifted. At 0.1 s the top-up corrects a dip
    // before it can persist.
    if (this.bubbleTimer < 0.1) return;
    this.bubbleTimer = 0;
    const player = this.playerPos;
    // Feedback fix (2026-11-21, "cars disappear / people teleport"):
    // the recycle margin must cover what the player can actually
    // SEE, or a recycled car/ped vanishes (or pops in) on screen.
    // The old margin (camViewM × 1.2 + 30, measured from the PLAYER)
    // under-counted three ways: (1) the visible half-diagonal of a
    // portrait frame is ~1.2–1.35× the view WIDTH alone; (2) it
    // ignored the player's zoom target — while a pinch zoom-out is
    // still chasing, cars were recycled against the old narrow view
    // and then disappeared as the frame widened onto them; (3) the
    // camera centre is offset from the player (lookahead + smoothing
    // lag). Now: margin from the CAMERA centre, against the larger
    // of the current and target view, with a diagonal factor.
    const visibleView = Math.max(this.camViewM, this.zoomViewM ?? 0);
    const viewMargin = visibleView * 1.45 + 40;
    const rng = this.trafficRng;

    // Traffic: top the bubble up from the far pool. Usually one car
    // per tick; burst up to 6 when a fast crossing has emptied a
    // whole side at once (v0.25: at 31 m/s the player can outrun 4+
    // bubble cars between ticks — a burst cap of 3 left a one-tick
    // hole below the ≥8 floor even at the faster 0.1 s cadence).
    const live = this.cars.filter((c) => c.traffic && !c.wrecked);
    const inBubble = live.filter((c) => c !== this.drivenCar && dist(c.pos, player) <= BUBBLE_R);
    let deficit = TRAFFIC_TARGET - inBubble.length;
    for (let k = 0; k < 6 && deficit > 0; k++) {
      // Only cars that are off-screen (from the CAMERA, not just
      // outside the player bubble) may be recycled — a car the
      // player can see must drive out of view, never vanish.
      const far = live.filter(
        (c) =>
          c !== this.drivenCar &&
          dist(c.pos, player) > BUBBLE_R &&
          dist(c.pos, this.camPos) > viewMargin,
      );
      if (!far.length) break;
      const car = far[Math.floor(rng() * far.length)];
      const spot = this.pickBubbleSpot(player, viewMargin, BUBBLE_R, true);
      if (!spot) break;
      // Never land a recycled car on top of another car: the spot
      // sampler knew nothing about occupancy, so a recycle could
      // stack two cars on one point (which then drove overlapped —
      // see the stacked-pair fix in updateTrafficCars). Skip this
      // tick instead; a free spot is sampled next tick.
      const landing = spawnTraffic(spot.road, spot.along);
      if (this.cars.some((o) => o !== car && dist(o.pos, landing.pos) < 8)) break;
      // The recycled slot is a DIFFERENT car in the fiction (new
      // driver, elsewhere): the player's claim on the old one ends
      // here — otherwise a once-stolen car would sit stopped
      // forever at its new spot under the driverless rule in
      // updateTrafficCars. A recycle must never carry a fire
      // across the map either.
      car.stolen = false;
      car.burning = false;
      car.burnT = 0;
      car.traffic = landing;
      car.trafficStopT = 0;
      car.pos = { ...car.traffic.pos };
      car.heading = car.traffic.heading;
      car.speed = car.traffic.speedMps;
      car.vel = {
        x: Math.cos(car.traffic.heading) * car.traffic.speedMps,
        z: Math.sin(car.traffic.heading) * car.traffic.speedMps,
      };
      deficit--;
    }

    // Parked: lighter touch — just keep a few stealable cars near.
    const nearParked = this.cars.filter(
      (c) => c.kind === 'parked' && !c.stolen && !c.wrecked && dist(c.pos, player) <= PARKED_NEAR_R,
    );
    if (nearParked.length < PARKED_TARGET) {
      const far = this.cars.filter(
        (c) =>
          c.kind === 'parked' && !c.stolen && !c.wrecked &&
          c !== this.drivenCar && dist(c.pos, player) > BUBBLE_R + 80 &&
          dist(c.pos, this.camPos) > viewMargin,
      );
      if (far.length) {
        const car = far[Math.floor(rng() * far.length)];
        const spot = this.pickBubbleSpot(player, viewMargin, PARKED_NEAR_R, false);
        if (spot) {
          const at = kerbPlacement(spot.road, spot.along, rng);
          // Same occupancy guard as traffic: don't stack kerbside.
          if (!this.cars.some((o) => o !== car && dist(o.pos, at.pos) < 7)) {
            car.pos = at.pos;
            car.heading = at.heading;
          }
        }
      }
    }

    // Peds (v0.25): before this, the 20 walkers were spawned around
    // SPAWN_POS and stayed there forever — drive two blocks and the
    // city was pedestrian-free. Now the far pool is re-anchored onto
    // roads near the player, a few per tick, until PED_TARGET are
    // within PED_BUBBLE_R. Recycled spots sit beyond the view margin
    // like the car spots, so nobody pops in on screen.
    const nearPeds = this.peds.filter((p) => dist(p.pos, player) <= PED_BUBBLE_R).length;
    if (nearPeds < PED_TARGET) {
      const candidates = this.world.roads.filter(
        (r) => r.lengthM > 50 && roadMinDist(r, player) <= PED_BUBBLE_R - 40,
      );
      if (candidates.length) {
        const farPeds = this.peds.filter(
          (p) => dist(p.pos, player) > PED_BUBBLE_R && dist(p.pos, this.camPos) > viewMargin,
        );
        let moved = 0;
        for (const ped of farPeds) {
          if (nearPeds + moved >= PED_TARGET || moved >= 3) break;
          // Try sampled roads until one lands the ped inside the
          // bubble but outside the current view; restore the ped
          // untouched when nothing qualifies (retry next tick).
          const saved = {
            road: ped.road, distAlong: ped.distAlong, dir: ped.dir, side: ped.side,
            state: ped.state, pos: { ...ped.pos }, heading: ped.heading,
          };
          let placed = false;
          for (let i = 0; i < 24 && !placed; i++) {
            const road = candidates[Math.floor(this.pedRng() * candidates.length)];
            reanchorPed(ped, road, this.pedRng);
            const d = dist(ped.pos, player);
            // Landing must be off-screen from the camera too, not
            // just far from the player (see viewMargin note above).
            if (d >= viewMargin && d <= PED_BUBBLE_R && dist(ped.pos, this.camPos) >= viewMargin) placed = true;
          }
          if (placed) {
            moved++;
          } else {
            ped.road = saved.road;
            ped.distAlong = saved.distAlong;
            ped.dir = saved.dir;
            ped.side = saved.side;
            ped.state = saved.state;
            ped.pos = saved.pos;
            ped.heading = saved.heading;
          }
        }
      }
    }
  }

  /**
   * A random (road, distAlong) whose resulting car position sits
   * between `minD` and `maxD` of the player — inside the bubble,
   * outside the view. Samples `along` around the road's closest
   * approach to the player (uniform-over-the-whole-road sampling
   * almost never lands inside a 220 m bubble on a 2 km street).
   * Null when nothing qualifies (retry next tick).
   */
  private pickBubbleSpot(
    player: Vec2,
    minD: number,
    maxD: number,
    rolling: boolean,
  ): { road: Road; along: number } | null {
    const candidates = this.world.roads.filter(
      (r) => r.lengthM > 45 && roadMinDist(r, player) <= maxD,
    );
    if (!candidates.length) return null;
    const rng = this.trafficRng;
    for (let i = 0; i < 60; i++) {
      const road = candidates[Math.floor(rng() * candidates.length)];
      const near = closestAlong(road, player);
      const along = Math.max(4, Math.min(road.lengthM - 4, near + (rng() * 2 - 1) * maxD));
      const pos = rolling
        ? spawnTraffic(road, along).pos
        : kerbPlacement(road, along, rng).pos;
      const d = dist(pos, player);
      if (d >= minD && d <= maxD) return { road, along };
    }
    return null;
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
    // v0.25: NEAREST interactable wins between cars and payphones.
    // The old fixed priority (payphone first) silently ate car entry
    // at the cold start: the spawn kerb's first parked car sits ~4 m
    // from spawn and the Errand payphone ~4.8 m, so a player standing
    // at the car pressing E to get in got a mission instead — E felt
    // broken. The reverse priority would eat the payphone the same
    // way (the player AT the phone is ~2.6 m from that car). Distance
    // is the only honest arbiter: whichever you're actually standing
    // next to is the one E means.
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
    let phone: MissionDef | null = null;
    let phoneD = 7;
    if (!this.missions.active) {
      for (const m of this.missions.available()) {
        const d = dist(this.playerPos, m.startPos);
        if (d < phoneD) {
          phoneD = d;
          phone = m;
        }
      }
    }
    if (best && (!phone || bestD <= phoneD)) return this.enterCar(best);
    if (phone) {
      this.missions.start(phone);
      this.afterMissionEvents();
      return;
    }
    if (best) this.enterCar(best);
  }

  private enterCar(car: CarEntity): void {
    this.drivenCar = car;
    if (!this.enteredCar) {
      // v0.24: first entry retires the spawn anchor ring for good.
      this.enteredCar = true;
      this.persist();
    }
    if (!this.seenDriveHint) {
      // v0.29: teach the controls — including reverse — the first
      // time the player ever gets in a car. Queued behind the theft
      // toast (update() shows it once the toast slot is free).
      this.seenDriveHint = true;
      this.driveHintPending = true;
      this.persist();
    }
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
    // v0.30 vehicle job: the marked car starts its delivery the
    // moment you get in (GTA 1's vehicle-triggered missions).
    if (car.id === this.markedCarId && !this.vehJob) {
      this.markedCarId = null;
      this.vehJob = { carId: car.id, tLeft: VEH_JOB_SECS };
      this.brief = 'VEHICLE JOB — a buyer wants this exact car. Deliver it to the CHOP SHOP across town, fast and in one piece.';
      this.briefTtl = 8;
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
    // v0.30: a fresh run starts unarmed and unarmoured, GTA-style.
    this.loadout = new Loadout();
    this.armour = 0;
    this.jailCard = false;
    this.frenzy = null;
    this.fx = [];
    this.scorches = [];
    this.projectiles = [];
    this.vehJob = null;
    this.vehJobCd = 0;
    this.gourangaT = 75;
    this.gourangaDowns.clear();
    this.wastedReason = '';
    this.pickups = placePickups(this.world);
    this.spawnCars();
    this.markVehJobCar();
    this.peds = spawnPeds(this.world, SPAWN_POS, 26, mulberry32(777));
    this.phase = 'play';
    this.camPos = { ...SPAWN_POS };
    this.showToast('New run — reach $250,000');
    this.persist();
  }

  /** Place the on-foot player at `pos` instantly, camera snapped
   *  onto them — the respawn treatment, without the respawn. The
   *  FOLLOW zip (long map picks) is the caller; population and
   *  traffic bubbles re-anchor off playerPos on their own. */
  teleportPlayer(pos: Vec2): void {
    this.playerPos = { ...pos };
    this.playerVel = { x: 0, z: 0 };
    this.camPos = { ...pos };
  }

  // --- mission events -------------------------------------------------------

  private afterMissionEvents(): void {
    for (const ev of this.missions.drainEvents()) {
      if (ev.type === 'started') {
        this.brief = `${ev.mission.title} — ${ev.mission.brief}`;
        this.briefTtl = 7;
      } else if (ev.type === 'completed') {
        const gained = this.wallet.earn(ev.mission.payout * MISSION_SCORE_SCALE * ev.payoutScale);
        this.wallet.missionCompleted();
        this.showToast(
          `${ev.mission.title} complete! +$${gained.toLocaleString()} — multiplier now ×${this.wallet.multiplier}`,
        );
        if (!this.archive.completed.includes(ev.mission.id)) {
          this.archive.completed.push(ev.mission.id);
        }
        this.checkGoal();
        this.persist();
      } else if (ev.type === 'lap') {
        this.brief = `ENCORE LAP ${ev.lap} — every payphone in the district is ringing again. Payouts +50%.`;
        this.briefTtl = 8;
        this.showToast(`ENCORE LAP ${ev.lap}! Mission payouts now ×${this.missions.payoutScale()}`);
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
      hasEnteredCar: this.enteredCar,
      hasSeenDriveHint: this.seenDriveHint,
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

  /** Apply the bust: fine + halved multiplier + heat cleared + respawn.
   *  v0.30: holding a Get Outta Jail Free card makes it FREE — no
   *  fine, no multiplier halving, and you keep your weapons/armour
   *  (the GTA 1 card, exactly). Without one, GTA 1 rules bite in
   *  full: fine, halved multiplier, and your gear is confiscated. */
  applyBusted(): void {
    const hadCard = this.jailCard;
    this.jailCard = false;
    const fine = hadCard ? 0 : this.wallet.bustedPenalty();
    if (!hadCard) {
      this.loadout.strip();
      this.armour = 0;
    }
    if (this.drivenCar) {
      // The car is impounded — gone.
      this.cars = this.cars.filter((c) => c !== this.drivenCar);
      this.drivenCar = null;
    }
    this.wanted.reset();
    this.cops = [];
    this.frenzy = null;
    this.playerHealth = 100;
    this.playerPos = { ...SPAWN_POS };
    this.camPos = { ...SPAWN_POS };
    this.showToast(
      hadCard
        ? 'GET OUTTA JAIL FREE — card played! No fine, multiplier and gear intact'
        : `Busted! Fine $${fine.toLocaleString()} — multiplier cut to ×${this.wallet.multiplier}, gear confiscated`,
    );
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
    this.frenzy = null;
    this.armour = 0;
    this.playerHealth = 100;
    this.playerPos = { ...SPAWN_POS };
    this.camPos = { ...SPAWN_POS };
    if (this.lives > 0) {
      const reason = this.wastedReason ? `${this.wastedReason} ` : '';
      this.showToast(`${reason}Wasted! Hospital fee $${fee} — ${this.lives} ${this.lives === 1 ? 'life' : 'lives'} left`);
    }
    this.wastedReason = '';
    this.persist();
  }

  // --- main update --------------------------------------------------------------

  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.toastTtl = Math.max(0, this.toastTtl - dt);
    if (this.toastTtl === 0) this.toast = '';
    // v0.29: the first-drive hint takes the toast slot as soon as
    // it's free (it queues behind the car-theft toast on entry).
    if (this.driveHintPending && this.toast === '') {
      this.driveHintPending = false;
      this.showToast(this.driveHintText);
    }
    // The cinematic belongs to the living spawn: if the run leaves
    // 'play' mid-descent (a bus finds the stationary player), the
    // normal camera rules take over immediately.
    if (this.introActive && this.phase !== 'play') this.introActive = false;
    this.briefTtl = Math.max(0, this.briefTtl - dt);
    if (this.briefTtl === 0) this.brief = '';
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);
    this.ramCooldown = Math.max(0, this.ramCooldown - dt);
    this.resprayCooldown = Math.max(0, this.resprayCooldown - dt);
    this.copSpawnCooldown = Math.max(0, this.copSpawnCooldown - dt);
    this.healthRegenDelay = Math.max(0, this.healthRegenDelay - dt);
    this.witnessCd = Math.max(0, this.witnessCd - dt);
    // Age transient effects in every phase (an explosion should
    // finish playing out behind the WASTED stamp).
    this.fx = this.fx.filter((f) => (f.t += dt) < f.ttl);

    // Mission clock runs in every phase except overlays.
    if (this.phase === 'play') {
      this.missions.tick(dt);
      this.afterMissionEvents();
    }

    // Traffic always rolls (except end overlays) so stamp scenes stay alive.
    if (this.phase !== 'gameover' && this.phase !== 'district-done') {
      this.updateTrafficCars(dt);
      this.maintainPopulation(dt);
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

    // Wanted decay (v0.30): pauses entirely while any cop has eyes
    // on you (within COP_EYES_M) — the melt only runs once you've
    // broken contact, and at a third of the old rate.
    const nearestCop = this.cops.length
      ? Math.min(...this.cops.map((c) => dist(c.pos, this.playerPos)))
      : Infinity;
    if (nearestCop > COP_EYES_M) this.wanted.update(dt);

    // Boot cinematic: driving input is locked while it runs (the
    // world stays alive — traffic rolls, peds stroll — but the
    // player's own inputs read as zero until the camera lands or
    // the player skips). Stash + zero + restore around the systems
    // that consume inputs, so nothing latches.
    const introLock = this.introActive;
    const savedCarInput = this.carInput;
    const savedMoveInput = this.moveInput;
    const savedFireHeld = this.fireHeld;
    if (introLock) {
      this.carInput = { throttle: 0, steer: 0 };
      this.moveInput = { x: 0, z: 0 };
      this.fireHeld = false;
    }

    if (this.drivenCar) this.updateDriving(dt);
    else this.updateOnFoot(dt);

    this.updatePeds(dt);
    this.updateCops(dt);
    this.updateCombat(dt);
    this.updateBurning(dt);
    this.updateProjectiles(dt);
    this.updatePickups(dt);
    this.updateFrenzy(dt);
    this.updateVehJob(dt);
    this.updateChopShop();
    this.updateGouranga(dt);
    this.updateRespray();
    this.updateExit();
    this.updateCamera(dt);

    if (introLock) {
      this.carInput = savedCarInput;
      this.moveInput = savedMoveInput;
      this.fireHeld = savedFireHeld;
    }

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
      // A car the player has taken is DRIVERLESS once he steps
      // out: traffic must not resume its route and drive it away
      // from beside him (Daniel, 2026-11-21: "the car disappeared
      // after I got out of it" — the sim drove it off at full route
      // speed the moment he exited). And a BURNING car's engine is
      // dead — the same rule updateDriving applies to the driven
      // car — so a burning traffic car sits, burns and explodes
      // where it stopped instead of driving off mid-fuse. Both read
      // as "stopped" here, which zeroes the route speed below and
      // also makes followers queue behind the car, as they should
      // for a car abandoned in the road.
      car.traffic.stopped = car.trafficStopT > 0 || ahead || car.stolen || car.burning;
      // v0.25 follow behaviour: cap this car's speed by whatever is
      // rolling ahead of it in its lane corridor — another traffic car
      // or the player's car. Before this, traffic had NO car-ahead
      // braking at all: a follower drove straight through a stopped
      // leader (measured overlap −21 m in the audit test) and every
      // queue collapsed into one point. The cap is a closing-speed
      // profile: match the leader's speed plus a term that grows
      // with the bumper gap, so the follower creeps up to ~1.6 m
      // behind a stopped leader and never touches it. Parked cars
      // are excluded — they're kerbside (lateral offset ~2 m from
      // the traffic lane), outside the 1.7 m corridor anyway.
      if (car.traffic.stopped) {
        car.traffic.speedMps = 0;
      } else {
        let cap = Infinity;
        const hvx = Math.cos(car.heading);
        const hvz = Math.sin(car.heading);
        for (const other of this.cars) {
          if (other === car || other.wrecked) continue;
          const isDriven = other === this.drivenCar;
          if (!isDriven && !other.traffic) continue; // parked: not in the lane
          const rx = other.pos.x - car.pos.x;
          const rz = other.pos.z - car.pos.z;
          const along = rx * hvx + rz * hvz;
          // Feedback fix (2026-11-21, "cars pass over each other"):
          // the old `along <= 0` cut-off meant two cars spawned or
          // junction-merged onto the SAME spot (along ≈ 0) never saw
          // each other as leader/follower at all — both drove at full
          // cruise in perfect overlap forever. A car up to 2.5 m
          // BEHIND centre now still counts, so the rear car of a
          // stacked pair brakes (bumperGap below is deeply negative)
          // and the pair separates as the front car pulls away.
          if (along <= -2.5 || along > 17) continue;
          // Stacked-pair tie-break: with along ≈ 0 neither car is
          // geometrically in front, so both would brake forever
          // (a deadlock, verified in the feedback test's first run).
          // The lower id is the front car and ignores its twin; the
          // higher id brakes until a real gap opens, then follows
          // under the normal profile.
          if (along < 0.5 && other.traffic && car.id <= other.id) continue;
          const lateral = Math.abs(rx * -hvz + rz * hvx);
          if (lateral > 1.7) {
            // Crossing traffic at a junction: not in this car's lane
            // corridor, but about to cross its path. Yield for a car
            // on a non-parallel heading within a few metres ahead —
            // without this, cross traffic drove straight through
            // each other at every intersection.
            const otherHeading = other === this.drivenCar ? other.heading : other.traffic!.heading;
            const parallel = Math.abs(Math.cos(otherHeading - car.heading));
            const gap = Math.hypot(rx, rz);
            if (parallel < 0.65 && along > 0 && gap < 9) {
              const capHere = Math.max(0, (gap - 5.2) * 1.1);
              if (capHere < cap) cap = capHere;
            }
            continue;
          }
          const leaderSpeed = isDriven
            ? Math.abs(other.speed)
            : other.traffic!.stopped || other.trafficStopT > 0
              ? 0
              : other.traffic!.speedMps;
          const bumperGap = along - 4.4;
          let capHere = leaderSpeed + Math.max(0, bumperGap - 1.6) * 0.85;
          // Inside the desired 1.6 m bumper gap the follower must go
          // SLOWER than the leader (a fraction of its speed), not
          // merely match it — matching speed froze a stacked pair at
          // a 4.2 m centre distance (bumpers touching) forever.
          if (bumperGap < 1.6) capHere = Math.min(capHere, leaderSpeed * Math.max(0, bumperGap / 1.6));
          if (bumperGap <= 0.2) capHere = 0;
          if (capHere < cap) cap = capHere;
        }
        car.traffic.speedMps = Math.max(0, Math.min(car.traffic.baseSpeedMps, cap));
      }
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
    // v0.30 crime economy: ramming traffic at speed damages THEM a
    // little and pays a little (GTA 1 paid 10 a ram; inflation).
    if (mySpeed > 6 && !other.wrecked) {
      this.damageCar(other, (mySpeed - 4) * 0.9, true);
      const gained = this.wallet.earn(RAM_SCORE);
      if (gained > 0) this.checkGoal();
    }
  }

  private crashWanted(): void {
    this.wanted.add(1);
    this.showToast('Reckless driving — wanted level up');
  }

  /**
   * v0.30: damage routes through FIRE (audit #10). A car at 0 health
   * no longer dies in place — it catches fire and explodes a few
   * seconds later. `byPlayer` marks the damage as the player's work
   * (frenzy destroy credit, chain attribution); `burnT` overrides
   * the fuse (chain ignitions burn shorter).
   */
  private damageCar(car: CarEntity, amount: number, byPlayer = false, burnT?: number): void {
    if (car.wrecked) return;
    if (car.burning) {
      if (byPlayer) car.burnByPlayer = true;
      return;
    }
    car.health = Math.max(0, car.health - amount);
    if (car.health <= 0) {
      this.startBurning(car, byPlayer || car === this.drivenCar, burnT);
    }
  }

  private startBurning(car: CarEntity, byPlayer: boolean, burnT?: number): void {
    if (car.burning || car.wrecked) return;
    car.burning = true;
    car.burnByPlayer = byPlayer;
    car.health = 0;
    // Deterministic fuse spread from the id (same city, same fires).
    let h = 0;
    for (const ch of car.id) h = (h * 31 + ch.charCodeAt(0)) % 997;
    car.burnT = burnT ?? 2.8 + (h % 100) / 100;
    if (car.traffic) car.traffic.stopped = true;
    if (car === this.drivenCar) {
      this.showToast('YOUR CAR IS ON FIRE — E TO BAIL OUT!');
    }
  }

  private damageCop(cop: CopCar, amount: number, byPlayer = false): void {
    if (cop.health <= 0) return; // already burning or destroyed
    cop.health = Math.max(0, cop.health - amount);
    if (cop.health <= 0 && !cop.burning) {
      cop.burning = true;
      cop.burnByPlayer = byPlayer;
      cop.burnT = 2.2;
      cop.speed = 0;
      cop.vel = { x: 0, z: 0 };
      cop.angVel = 0;
    }
  }

  private updateBurning(dt: number): void {
    for (const car of this.cars) {
      if (!car.burning) continue;
      car.burnT -= dt;
      if (car.burnT <= 0) this.explodeCar(car);
    }
    for (const cop of [...this.cops]) {
      if (!cop.burning) continue;
      cop.burnT -= dt;
      if (cop.burnT <= 0) this.explodeCop(cop);
    }
  }

  private explodeCar(car: CarEntity): void {
    car.burning = false;
    car.exploded = true;
    car.wrecked = true;
    car.speed = 0;
    car.vel = { x: 0, z: 0 };
    car.angVel = 0;
    if (car.traffic) car.traffic.stopped = true;
    const byPlayer = car.burnByPlayer;
    if (byPlayer && car !== this.drivenCar) this.frenzyProgress('destroy');
    if (this.drivenCar === car) {
      // Sitting in it when it goes up is death (bailing in time is
      // the whole point of the fuse).
      this.drivenCar = null;
      this.playerHealth = 0;
      this.wastedReason = 'Your car exploded with you in it!';
    }
    this.explodeAt(car.pos, 7, byPlayer, car);
  }

  private explodeCop(cop: CopCar): void {
    this.cops = this.cops.filter((c) => c !== cop);
    const byPlayer = cop.burnByPlayer;
    if (byPlayer) {
      const gained = this.wallet.earn(COP_KILL_SCORE);
      this.wanted.add(2);
      this.frenzyProgress('destroy');
      this.showToast(`Cop car destroyed! +$${gained.toLocaleString()} — wanted level up`);
      this.checkGoal();
    }
    this.explodeAt(cop.pos, 6.5, byPlayer, cop);
  }

  /** One explosion: visual, scorch, radial damage, chain ignition. */
  private explodeAt(pos: Vec2, radius: number, byPlayer: boolean, source?: CarEntity | CopCar): void {
    this.explosionsCount++;
    this.fx.push({ kind: 'explosion', pos: { ...pos }, t: 0, ttl: 0.55, radiusM: radius });
    this.scorches.push({ ...pos });
    if (this.scorches.length > 48) this.scorches.splice(0, this.scorches.length - 48);
    for (const car of this.cars) {
      if (car === source || car.wrecked) continue;
      const d = dist(car.pos, pos);
      if (d > radius + 2.2) continue;
      this.damageCar(car, 90 * Math.max(0.25, 1 - d / (radius + 3)), byPlayer, 1.2 + (d % 1));
    }
    for (const cop of [...this.cops]) {
      if (cop === source || cop.health <= 0) continue;
      const d = dist(cop.pos, pos);
      if (d > radius + 2.2) continue;
      this.damageCop(cop, 90 * Math.max(0.25, 1 - d / (radius + 3)), byPlayer);
    }
    for (const ped of this.peds) {
      if (ped.state === 'down') continue;
      if (dist(ped.pos, pos) <= radius) this.pedDowned(ped, 'explosion');
    }
    // The player, caught in it: shrapnel in a car, the full thing
    // on foot. (Being IN the exploding car is handled by explodeCar.)
    if (this.drivenCar && this.drivenCar !== source) {
      if (dist(this.drivenCar.pos, pos) <= radius + 1) this.hurtPlayer(10);
    } else if (!this.drivenCar && dist(this.playerPos, pos) <= radius) {
      const d = dist(this.playerPos, pos);
      this.hurtPlayer(Math.round(8 + 34 * (1 - d / (radius + 1))));
    }
  }

  private updateDriving(dt: number): void {
    const car = this.drivenCar!;
    // v0.30: a burning car's engine is dead — it rolls out on
    // momentum with no throttle while the fuse burns.
    const input = car.burning ? { throttle: 0, steer: 0 } : this.carInput;
    const stepped = stepCar(this.world, car, input, dt);
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
    // v0.30: drive into the Saint John and the car sinks — deep
    // water is death in GTA 1 — unless the surface under you is a
    // road, which over this river means the Westmorland bridge.
    if (this.inDeepWater(car.pos, 2.2)) {
      car.wrecked = true;
      car.burning = false;
      car.speed = 0;
      car.vel = { x: 0, z: 0 };
      this.fx.push({ kind: 'splash', pos: { ...car.pos }, t: 0, ttl: 0.8, radiusM: 3.2 });
      this.splashesCount++;
      this.drivenCar = null;
      this.wastedReason = 'Your car sank in the Saint John River!';
      this.triggerWasted();
    }
  }

  /** Road surface: within half a carriageway (+ kerb) of a centreline. */
  private onRoadSurface(pos: Vec2): boolean {
    const near = nearestRoadPoint(this.world, pos);
    return !!near && dist(pos, near.pos) <= near.road.widthM / 2 + 1.0;
  }

  /**
   * Deep water: inside a water polygon, off every road surface, with
   * water (and no road) a full `sampleR` out in all four directions.
   * The cross-sample keeps the shoreline itself safe — the bank
   * trail runs at the polygon's edge — while one real step in is
   * drowning depth. Bridges pass on the road test alone.
   */
  private inDeepWater(pos: Vec2, sampleR: number): boolean {
    if (!pointInWater(this.world, pos) || this.onRoadSurface(pos)) return false;
    const pts: [number, number][] = [[sampleR, 0], [-sampleR, 0], [0, sampleR], [0, -sampleR]];
    for (const [dx, dz] of pts) {
      const s = { x: pos.x + dx, z: pos.z + dz };
      if (!pointInWater(this.world, s) || this.onRoadSurface(s)) return false;
    }
    return true;
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
        nx * WALK_SPEED * this.walkSpeedMul * dt,
        nz * WALK_SPEED * this.walkSpeedMul * dt,
        0.55,
      );
      this.playerPos = moved.pos;
    }
    // v0.29: walk-cycle phase is driven by DISTANCE actually walked
    // (post-collision), so the feet step in sync with the ground.
    this.playerWalkM += Math.hypot(this.playerPos.x - before.x, this.playerPos.z - before.z);
    this.playerVel = dt > 0
      ? { x: (this.playerPos.x - before.x) / dt, z: (this.playerPos.z - before.z) / dt }
      : { x: 0, z: 0 };
    // Harmless ped bumps.
    for (const ped of this.peds) {
      if (dist(this.playerPos, ped.pos) < 0.95) nudgePed(ped, this.playerPos);
    }
    this.missions.update(this.playerPos, false);
    // v0.30: walk into the river and you drown (GTA 1 rules) — the
    // bank's edge is safe, the open water is not (see inDeepWater).
    if (this.inDeepWater(this.playerPos, 1.0)) {
      this.fx.push({ kind: 'splash', pos: { ...this.playerPos }, t: 0, ttl: 0.8, radiusM: 1.6 });
      this.splashesCount++;
      this.wastedReason = 'You drowned in the Saint John River!';
      this.triggerWasted();
    }
  }

  /** v0.30: armour soaks damage first, point for point. */
  private hurtPlayer(amount: number): void {
    if (this.armour > 0) {
      const absorbed = Math.min(this.armour, amount);
      this.armour -= absorbed;
      amount -= absorbed;
    }
    if (amount > 0) this.playerHealth = Math.max(0, this.playerHealth - amount);
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
      if (ev === 'downed') this.pedDowned(ped, 'car', true);
    }
  }

  /**
   * v0.30: every way a pedestrian goes down, booked in one place —
   * score, heat, frenzy credit, and the Gouranga tracker all hang
   * off the cause. 'car' keeps the exact v0.20 semantics (updatePed
   * already put them down; `alreadyDown` skips the force-down).
   */
  private pedDowned(
    ped: Ped,
    cause: 'car' | 'gun' | 'fist' | 'explosion',
    alreadyDown = false,
  ): void {
    if (ped.state === 'down' && !alreadyDown) return;
    if (!alreadyDown) {
      forceDown(ped, cause === 'fist' ? 3.5 : cause === 'explosion' ? 8 : 10);
    }
    if (cause === 'car') {
      const gained = this.wallet.earn(PED_SCORE);
      this.wanted.add(1);
      this.showToast(`Ped down! +$${gained.toLocaleString()} — wanted level up`);
      this.frenzyProgress('runover');
    } else if (cause === 'gun') {
      const gained = this.wallet.earn(SHOOT_PED_SCORE);
      this.wanted.add(1);
      this.showToast(`Ped shot! +$${gained.toLocaleString()} — wanted level up`);
      this.frenzyProgress('gun');
    } else if (cause === 'fist') {
      const gained = this.wallet.earn(FIST_PED_SCORE);
      // A punch is quiet: it only draws heat if a cop sees it.
      const witnessed = this.cops.some((c) => dist(c.pos, this.playerPos) < 45);
      if (witnessed) {
        this.wanted.add(1);
        this.showToast(`Punched a pedestrian! +$${gained.toLocaleString()} — a cop saw that`);
      } else {
        this.showToast(`Punched a pedestrian! +$${gained.toLocaleString()}`);
      }
    } else {
      this.wallet.earn(PED_SCORE);
    }
    if (cause !== 'explosion') this.checkGoal();
    // Gouranga: the whole saffron line down inside 12 s = the bonus.
    if (ped.group) {
      let byPed = this.gourangaDowns.get(ped.group);
      if (!byPed) {
        byPed = new Map();
        this.gourangaDowns.set(ped.group, byPed);
      }
      byPed.set(ped.id, this.time);
      for (const [id, t] of byPed) if (this.time - t > 12) byPed.delete(id);
      const members = this.peds.filter((p) => p.group === ped.group).length;
      if (members >= 7 && byPed.size >= members) {
        this.gourangaDowns.delete(ped.group);
        const gained = this.wallet.earn(1500);
        this.showToast(`GOURANGA! The whole procession! +$${gained.toLocaleString()}`);
        this.checkGoal();
      }
    }
  }

  /** Advance the active frenzy's quota when the cause matches. */
  private frenzyProgress(kind: FrenzyState['kind']): void {
    if (!this.frenzy || this.frenzy.kind !== kind) return;
    this.frenzy.have++;
  }

  private updateCops(dt: number): void {
    const stars = this.wanted.stars;
    this.roadblockCd = Math.max(0, this.roadblockCd - dt);
    const pursuitCount = this.cops.filter((c) => !c.roadblock).length;
    const desired = stars > 0 ? Math.min(stars, 4) : 0;
    // Spawn up to the desired pressure, at a road point ~120-170 m out.
    if (pursuitCount < desired && this.copSpawnCooldown <= 0) {
      // Iteration 3 mayhem dial: reinforcements arrive faster —
      // spawn cadence 1.5 s → 0.9 s.
      this.copSpawnCooldown = 0.9;
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
    // v0.30 roadblocks (audit #5): a pair of cop cars parks ACROSS
    // a road ahead of the player's heading. They hold position
    // (and shoot, below) until the heat drops or the player
    // leaves them far behind. Iteration 3 mayhem dial: the
    // threshold drops 4★ → 3★ — roadblocks are a mid-heat event
    // now, not an endgame one.
    if (stars >= 3 && !this.cops.some((c) => c.roadblock) && this.roadblockCd <= 0) {
      const speed = Math.hypot(this.playerVel.x, this.playerVel.z);
      const dirVec = speed > 2
        ? { x: this.playerVel.x / speed, z: this.playerVel.z / speed }
        : { x: Math.cos(this.playerHeading), z: Math.sin(this.playerHeading) };
      const probe = {
        x: this.playerPos.x + dirVec.x * 85,
        z: this.playerPos.z + dirVec.z * 85,
      };
      const near = nearestRoadPoint(this.world, probe);
      if (near && dist(near.pos, this.playerPos) > 35) {
        const px = Math.cos(near.heading + Math.PI / 2);
        const pz = Math.sin(near.heading + Math.PI / 2);
        for (const side of [-1, 1]) {
          const cop = spawnCop(
            { x: near.pos.x + px * 2.3 * side, z: near.pos.z + pz * 2.3 * side },
            near.heading + Math.PI / 2,
          );
          cop.roadblock = true;
          this.cops.push(cop);
        }
        this.roadblockCd = 25;
      }
    }
    const target = { pos: this.playerPos, vel: this.playerVel };
    const survivors: CopCar[] = [];
    for (const cop of this.cops) {
      const d = dist(cop.pos, this.playerPos);
      // Roadblocks abandon their post when the heat drops or the
      // player is long gone.
      if (cop.roadblock && (stars < 3 || d > 170)) continue;
      // A burning cop car sits and burns (updateBurning owns it).
      if (cop.burning) {
        survivors.push(cop);
        continue;
      }
      if (!cop.roadblock) updateCop(this.world, cop, target, dt);
      // Give up when the heat is gone and they're far behind.
      if (stars === 0 && d > 200) continue;
      // Ramming.
      if (this.ramCooldown === 0) {
        if (this.drivenCar && d < 3.5) {
          this.ramCooldown = 0.9;
          cop.ramCooldown = 0.9;
          const mine = this.drivenCar;
          const rel = Math.max(0, Math.abs(cop.speed) - Math.abs(mine.speed)) + Math.abs(cop.speed) * 0.4;
          this.damageCar(mine, 4 + rel * 1.4);
          // v0.25 fix (still load-bearing): the ram's damage used
          // to be able to null drivenCar mid-loop (the old instant
          // wreck ejected the player) and the shove then threw,
          // freezing the frame loop. v0.30 damage starts a fire
          // instead of ejecting, but the guard stays — only shove
          // a car the player is still sitting in.
          if (this.drivenCar === mine) {
            mine.vel = {
              x: mine.vel.x + cop.vel.x * 0.35,
              z: mine.vel.z + cop.vel.z * 0.35,
            };
          }
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
      // v0.30 return fire: at 4+ stars the police shoot at a
      // player on foot (GTA 1's shoot-on-sight tier). Deliberately
      // survivable: one shot per cop per ~2 s, accuracy falls with
      // distance, armour eats it first. In a car they still ram.
      cop.shootCd = Math.max(0, cop.shootCd - dt);
      if (stars >= 4 && !this.drivenCar && cop.shootCd <= 0 && d < 34 && d > 2.6) {
        cop.shootCd = 1.7 + Math.random() * 1.2;
        this.fx.push({ kind: 'muzzle', pos: { ...cop.pos }, t: 0, ttl: 0.09 });
        this.fx.push({ kind: 'tracer', pos: { ...cop.pos }, to: { ...this.playerPos }, t: 0, ttl: 0.12 });
        if (Math.random() < Math.max(0.15, 0.6 - d * 0.011)) {
          this.hurtPlayer(7);
          this.showToast('Taking police fire!');
        }
      }
      survivors.push(cop);
    }
    this.cops = survivors;

    // The bust itself. (Burning cop cars don't bust anyone.)
    const activeCops = this.cops.filter((c) => !c.burning);
    if (stars > 0 && activeCops.length) {
      if (this.drivenCar) {
        const copNear = Math.min(...activeCops.map((c) => dist(c.pos, this.playerPos)));
        if (Math.abs(this.drivenCar.speed) < 1.5 && copNear < 7) {
          this.bustMeter += dt / 3;
          if (this.bustMeter >= 1) return this.triggerBusted();
        } else {
          this.bustMeter = Math.max(0, this.bustMeter - dt / 2);
        }
      } else {
        const touching = activeCops.some((c) => dist(c.pos, this.playerPos) < 2.6);
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

  // --- v0.30: combat ---------------------------------------------------------

  /** Weapon cycling (Q key / weapon button / gamepad Y). */
  cycleWeapon(): void {
    if (this.drivenCar) return;
    const w = this.loadout.cycle();
    this.showToast(`Weapon: ${WEAPONS[w].name}${WEAPONS[w].usesAmmo ? ` · ${this.loadout.ammo[w]} rounds` : ''}`);
  }

  private updateCombat(dt: number): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    for (const car of this.cars) {
      if (car.flameHeat > 0) car.flameHeat = Math.max(0, car.flameHeat - dt * 10);
    }
    if (this.drivenCar || !this.fireHeld) return;
    if (this.fireCooldown > 0) return;
    const def = this.loadout.def;
    // A weapon granted by a gun frenzy fires free while it runs.
    const frenzyFree = this.frenzy?.weapon === this.loadout.weapon;
    if (!frenzyFree && !this.loadout.canFire()) {
      this.loadout.fallback();
      this.showToast(`Out of ammo — ${this.loadout.def.name} ready`);
      this.fireCooldown = 0.35;
      return;
    }
    this.fireCooldown = def.cooldown;
    this.fireOnce();
  }

  /**
   * Pick the firing direction: the nearest valid target inside a
   * modest auto-aim cone of the facing wins an exact snap (GTA 1
   * shot where you faced; the cone is the mercy). Otherwise the
   * shot goes straight down the facing.
   */
  private aimDirection(range: number): { dir: Vec2; target: { kind: 'ped' | 'car' | 'cop'; ref: Ped | CarEntity | CopCar } | null } {
    const fx = Math.cos(this.playerHeading);
    const fz = Math.sin(this.playerHeading);
    let best: { kind: 'ped' | 'car' | 'cop'; ref: Ped | CarEntity | CopCar } | null = null;
    let bestScore = Infinity;
    const consider = (kind: 'ped' | 'car' | 'cop', ref: Ped | CarEntity | CopCar, pos: Vec2): void => {
      const dx = pos.x - this.playerPos.x;
      const dz = pos.z - this.playerPos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.5 || d > range) return;
      const dot = (dx * fx + dz * fz) / d;
      if (dot < Math.cos(0.5)) return; // outside the ±0.5 rad cone
      const score = d + (1 - dot) * 18;
      if (score < bestScore) {
        bestScore = score;
        best = { kind, ref };
      }
    };
    for (const ped of this.peds) if (ped.state !== 'down') consider('ped', ped, ped.pos);
    for (const car of this.cars) if (!car.wrecked && car !== this.drivenCar) consider('car', car, car.pos);
    for (const cop of this.cops) if (cop.health > 0) consider('cop', cop, cop.pos);
    if (best) {
      const t = best as { ref: Ped | CarEntity | CopCar };
      const dx = t.ref.pos.x - this.playerPos.x;
      const dz = t.ref.pos.z - this.playerPos.z;
      const d = Math.hypot(dx, dz) || 1;
      return { dir: { x: dx / d, z: dz / d }, target: best };
    }
    return { dir: { x: fx, z: fz }, target: null };
  }

  /** First thing a hitscan ray meets: building, ped, car or cop. */
  private raycastHit(
    from: Vec2,
    dir: Vec2,
    range: number,
  ): { kind: 'building' | 'ped' | 'car' | 'cop'; ref?: Ped | CarEntity | CopCar; at: Vec2 } | null {
    for (let s = 0.8; s <= range; s += 0.7) {
      const p = { x: from.x + dir.x * s, z: from.z + dir.z * s };
      for (const b of this.world.buildings) {
        // The world stores buildings as axis-aligned boxes — the
        // bbox IS the footprint here, so it stops the bullet.
        if (p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ) {
          return { kind: 'building', at: p };
        }
      }
      for (const ped of this.peds) {
        if (ped.state !== 'down' && dist(p, ped.pos) < 0.6) return { kind: 'ped', ref: ped, at: p };
      }
      for (const car of this.cars) {
        if (!car.wrecked && car !== this.drivenCar && dist(p, car.pos) < 2.35) {
          return { kind: 'car', ref: car, at: p };
        }
      }
      for (const cop of this.cops) {
        if (cop.health > 0 && dist(p, cop.pos) < 2.35) return { kind: 'cop', ref: cop, at: p };
      }
    }
    return null;
  }

  private fireOnce(): void {
    const def = this.loadout.def;
    const frenzyFree = this.frenzy?.weapon === this.loadout.weapon;
    const from = {
      x: this.playerPos.x + Math.cos(this.playerHeading) * 0.5,
      z: this.playerPos.z + Math.sin(this.playerHeading) * 0.5,
    };

    if (def.id === 'fists') {
      // A swing: nearest ped in a short front arc goes down, stunned.
      let best: Ped | null = null;
      let bestD = def.range;
      for (const ped of this.peds) {
        if (ped.state === 'down') continue;
        const d = dist(ped.pos, this.playerPos);
        if (d >= bestD) continue;
        const dot = ((ped.pos.x - this.playerPos.x) * Math.cos(this.playerHeading) +
          (ped.pos.z - this.playerPos.z) * Math.sin(this.playerHeading)) / (d || 1);
        if (dot < 0.2) continue;
        bestD = d;
        best = ped;
      }
      if (best) this.pedDowned(best, 'fist');
      return;
    }

    if (def.projectile) {
      // Rocket: a travelling projectile that explodes on contact.
      const { dir } = this.aimDirection(def.range);
      this.playerHeading = Math.atan2(dir.z, dir.x);
      this.projectiles.push({
        pos: { ...from },
        vel: { x: dir.x * 42, z: dir.z * 42 },
        life: def.range / 42,
      });
      if (!frenzyFree) this.loadout.consume();
      this.shotsFired++;
      this.fx.push({ kind: 'muzzle', pos: { ...from }, t: 0, ttl: 0.1 });
      return;
    }

    if (def.id === 'flame') {
      // Flamethrower: a short cone of fire, ticked damage. Cars
      // soak damage AND heat — heat alone can light them early.
      const { dir } = this.aimDirection(def.range);
      this.playerHeading = Math.atan2(dir.z, dir.x);
      if (!frenzyFree) this.loadout.consume(2);
      this.shotsFired++;
      for (let i = 1; i <= 3; i++) {
        this.fx.push({
          kind: 'fire',
          pos: { x: from.x + dir.x * i * 2.2, z: from.z + dir.z * i * 2.2 },
          t: 0, ttl: 0.14, radiusM: 1.1,
        });
      }
      for (const car of this.cars) {
        if (car.wrecked || car === this.drivenCar) continue;
        const d = dist(car.pos, this.playerPos);
        if (d > def.range + 2) continue;
        const dot = ((car.pos.x - this.playerPos.x) * dir.x + (car.pos.z - this.playerPos.z) * dir.z) / (d || 1);
        if (dot < 0.55) continue;
        this.damageCar(car, def.carDamage, true);
        if (!car.burning && !car.wrecked) {
          car.flameHeat += 3.6;
          if (car.flameHeat >= 18) this.startBurning(car, true, 1.6);
        }
      }
      for (const cop of this.cops) {
        if (cop.health <= 0) continue;
        const d = dist(cop.pos, this.playerPos);
        if (d > def.range + 2) continue;
        const dot = ((cop.pos.x - this.playerPos.x) * dir.x + (cop.pos.z - this.playerPos.z) * dir.z) / (d || 1);
        if (dot < 0.55) continue;
        this.damageCop(cop, def.carDamage, true);
      }
      for (const ped of this.peds) {
        if (ped.state === 'down') continue;
        const d = dist(ped.pos, this.playerPos);
        if (d > def.range) continue;
        const dot = ((ped.pos.x - this.playerPos.x) * dir.x + (ped.pos.z - this.playerPos.z) * dir.z) / (d || 1);
        if (dot < 0.5) continue;
        this.pedDowned(ped, 'gun');
      }
      return;
    }

    // Hitscan (pistol / machine gun).
    const { dir } = this.aimDirection(def.range);
    this.playerHeading = Math.atan2(dir.z, dir.x);
    if (!frenzyFree) this.loadout.consume();
    this.shotsFired++;
    this.fx.push({ kind: 'muzzle', pos: { ...from }, t: 0, ttl: 0.07 });
    const hit = this.raycastHit(from, dir, def.range);
    const end = hit ? hit.at : { x: from.x + dir.x * def.range, z: from.z + dir.z * def.range };
    this.fx.push({ kind: 'tracer', pos: { ...from }, to: end, t: 0, ttl: 0.09 });
    if (!hit) return;
    if (hit.kind === 'ped') {
      this.pedDowned(hit.ref as Ped, 'gun');
    } else if (hit.kind === 'car') {
      const car = hit.ref as CarEntity;
      this.damageCar(car, def.carDamage, true);
      // Hot metal in public draws heat when the law is watching.
      if (this.witnessCd <= 0 && this.cops.some((c) => dist(c.pos, this.playerPos) < 42)) {
        this.witnessCd = 4;
        this.wanted.add(1);
        this.showToast('Shots fired at a car — wanted level up');
      }
    } else if (hit.kind === 'cop') {
      this.damageCop(hit.ref as CopCar, def.carDamage, true);
    }
  }

  private updateProjectiles(dt: number): void {
    const survivors: typeof this.projectiles = [];
    for (const pr of this.projectiles) {
      pr.pos = { x: pr.pos.x + pr.vel.x * dt, z: pr.pos.z + pr.vel.z * dt };
      pr.life -= dt;
      this.fx.push({ kind: 'fire', pos: { ...pr.pos }, t: 0, ttl: 0.12, radiusM: 0.55 });
      let boom = pr.life <= 0;
      if (!boom) {
        for (const car of this.cars) {
          if (!car.wrecked && car !== this.drivenCar && dist(pr.pos, car.pos) < 2.4) boom = true;
        }
        for (const cop of this.cops) {
          if (cop.health > 0 && dist(pr.pos, cop.pos) < 2.4) boom = true;
        }
        if (!boom) {
          for (const b of this.world.buildings) {
            if (pr.pos.x > b.minX && pr.pos.x < b.maxX && pr.pos.z > b.minZ && pr.pos.z < b.maxZ) {
              boom = true;
              break;
            }
          }
        }
      }
      if (boom) this.explodeAt(pr.pos, 6.5, true);
      else survivors.push(pr);
    }
    this.projectiles = survivors;
  }

  // --- v0.30: pickups, frenzies, chop shop, procession -----------------------

  private updatePickups(dt: number): void {
    for (const p of this.pickups) {
      if (!p.active) {
        p.respawnT -= dt;
        if (p.respawnT <= 0) p.active = true;
        continue;
      }
      if (dist(this.playerPos, p.pos) <= 1.9) this.collectPickup(p);
    }
  }

  private collectPickup(p: Pickup): void {
    // A skull while a frenzy is already running is left standing.
    if (p.kind.startsWith('frenzy-') && this.frenzy) {
      this.showToast('A Kill Frenzy is already running!');
      return;
    }
    p.active = false;
    p.respawnT = RESPAWN_SEC[p.kind];
    this.pickupsTaken++;
    switch (p.kind) {
      case 'pistol':
        this.loadout.give('pistol', 24);
        this.showToast('PISTOL — 24 rounds. FIRE to shoot');
        break;
      case 'mg':
        this.loadout.give('mg', 60);
        this.showToast('MACHINE GUN — 60 rounds');
        break;
      case 'rocket':
        this.loadout.give('rocket', 4);
        this.showToast('ROCKET LAUNCHER — 4 rockets. Mind the splash');
        break;
      case 'flame':
        this.loadout.give('flame', 120);
        this.showToast('FLAMETHROWER — lights cars beautifully');
        break;
      case 'ammo':
        if (this.loadout.owned.has('mg')) this.loadout.addAmmo('mg', 40);
        if (this.loadout.owned.has('pistol')) this.loadout.addAmmo('pistol', 18);
        if (!this.loadout.owned.has('mg') && !this.loadout.owned.has('pistol')) {
          this.loadout.give('pistol', 12);
        }
        this.showToast('AMMO — topped up');
        break;
      case 'armour':
        this.armour = 100;
        this.showToast('ARMOUR — soaks damage before your health');
        break;
      case 'bribe':
        this.wanted.reset();
        this.showToast('COP BRIBE — the heat is just… gone');
        break;
      case 'jailcard':
        this.jailCard = true;
        this.showToast('GET OUTTA JAIL FREE — your next bust costs nothing');
        break;
      case 'multiplier':
        this.wallet.multiplier += 1;
        this.showToast(`MULTIPLIER up — now ×${this.wallet.multiplier}`);
        break;
      case 'life':
        this.lives = Math.min(9, this.lives + 1);
        this.showToast('EXTRA LIFE!');
        break;
      case 'frenzy-runover':
      case 'frenzy-destroy':
      case 'frenzy-gun':
        this.startFrenzy(p.kind.slice('frenzy-'.length) as FrenzyState['kind']);
        break;
    }
  }

  private startFrenzy(kind: FrenzyState['kind']): void {
    const def = FRENZY_DEFS[kind];
    this.frenzy = { kind, label: def.label, need: def.need, have: 0, tLeft: def.secs, weapon: def.weapon };
    if (def.weapon && !this.loadout.owned.has(def.weapon)) {
      this.loadout.give(def.weapon, 0); // frenzy ammo is on the house
    }
    if (def.weapon) this.loadout.weapon = def.weapon;
    this.frenzyStarts++;
    this.brief = `KILL FRENZY! ${def.label} — ${def.secs} seconds. Pays $${FRENZY_PAYOUT.toLocaleString()} and +1 multiplier.`;
    this.briefTtl = 6;
  }

  private updateFrenzy(dt: number): void {
    if (!this.frenzy) return;
    if (this.frenzy.have >= this.frenzy.need) {
      const gained = this.wallet.earn(FRENZY_PAYOUT);
      this.wallet.multiplier += 1;
      this.frenzyWins++;
      this.showToast(
        `FRENZY COMPLETE! +$${gained.toLocaleString()} — multiplier now ×${this.wallet.multiplier}`,
      );
      this.frenzy = null;
      this.checkGoal();
      return;
    }
    this.frenzy.tLeft -= dt;
    if (this.frenzy.tLeft <= 0) {
      const gained = this.wallet.earn(FRENZY_CONSOLATION);
      this.showToast(`Frenzy failed — +$${gained.toLocaleString()} for the effort`);
      this.frenzy = null;
    }
  }

  private updateVehJob(dt: number): void {
    this.vehJobCd = Math.max(0, this.vehJobCd - dt);
    if (!this.vehJob) {
      // Re-mark a new job car once the cooldown runs out.
      if (!this.markedCarId && this.vehJobCd <= 0) this.markVehJobCar();
      return;
    }
    const job = this.vehJob;
    job.tLeft -= dt;
    const car = this.cars.find((c) => c.id === job.carId);
    if (!car || car.wrecked) {
      this.showToast('VEHICLE JOB FAILED — the car is wreckage');
      this.vehJob = null;
      this.vehJobCd = VEH_JOB_COOLDOWN_SEC;
      return;
    }
    if (job.tLeft <= 0) {
      this.showToast('VEHICLE JOB FAILED — too slow');
      this.vehJob = null;
      this.vehJobCd = VEH_JOB_COOLDOWN_SEC;
      return;
    }
    if (this.drivenCar === car && dist(this.playerPos, this.chopShopPos) <= 10 && Math.abs(car.speed) < 3) {
      car.delivered = true;
      const gained = this.wallet.earn(VEH_JOB_PAYOUT * MISSION_SCORE_SCALE);
      this.wallet.missionCompleted();
      this.showToast(`VEHICLE JOB complete! +$${gained.toLocaleString()} — multiplier now ×${this.wallet.multiplier}`);
      this.vehJob = null;
      this.vehJobCd = VEH_JOB_COOLDOWN_SEC;
      this.checkGoal();
      this.persist();
    }
  }

  private updateChopShop(): void {
    const car = this.drivenCar;
    if (!car || !car.stolen || car.burning || car.delivered) return;
    if (this.vehJob && this.vehJob.carId === car.id) return; // the job pays for this one
    if (dist(this.playerPos, this.chopShopPos) > 8) return;
    // You have to actually STOP in the bay — rolling through the
    // forecourt at speed is not a sale (and must never yank the car
    // out from under a drive that happens to pass the marker).
    if (Math.abs(car.speed) > 2) return;
    const base = CHOP_BASE[car.classId] ?? CHOP_BASE.standard;
    const pay = Math.round(base * (car.health / 100));
    const gained = this.wallet.earn(pay);
    this.cars = this.cars.filter((c) => c !== car);
    this.drivenCar = null;
    this.showToast(
      `CHOP SHOP: sold the ${car.classId === 'fast' ? 'fast one' : 'ride'} at ${Math.round(car.health)}% condition — +$${gained.toLocaleString()}`,
    );
    this.checkGoal();
    this.persist();
  }

  /** The Gouranga procession: a saffron line crossing downtown. */
  private updateGouranga(dt: number): void {
    this.gourangaT -= dt;
    if (this.gourangaT > 0) return;
    this.gourangaT = 170;
    const candidates = this.world.roads.filter(
      (r) => r.lengthM > 90 && r.path.some((p) => dist(p, this.playerPos) < 150),
    );
    if (!candidates.length) return;
    const rng = mulberry32(Math.floor(this.time * 977) + this.gourangaSeq * 7919);
    const road = candidates[Math.floor(rng() * candidates.length)];
    const line = spawnProcession(road, 7, rng, `gouranga-${this.gourangaSeq}`, `gouranga-${this.gourangaSeq}`);
    this.gourangaSeq++;
    this.peds.push(...line);
    this.showToast('A saffron procession is crossing downtown…');
  }

  /** FOLLOW iteration 5: the player's own zoom (pinch / wheel) —
   *  a desired view WIDTH in metres that replaces the speed-based
   *  framing while set. The platform owns the gesture state and
   *  the arrival return; the core owns the clamp and the chase. */
  private zoomViewM: number | null = null;

  /** Set (or clear, with null) the player's zoom override. */
  setZoomView(viewM: number | null): void {
    this.zoomViewM = viewM === null ? null : Math.max(18, viewM);
  }

  get playerZoomViewM(): number | null {
    return this.zoomViewM;
  }

  /** The framing the normal speed-based camera wants right now —
   *  what the zoom override hands back to when it clears. */
  get streetViewM(): number {
    return this.dynamicCameraTarget().view;
  }

  /**
   * The whole-map framing for a viewport aspect: centre + view
   * width covering the full extract (buildings ∪ river), or null
   * when the world has no finite bounds (toy worlds — there is no
   * "whole map" to show). Shared by the boot cinematic (which
   * starts here) and the player's zoom-out (which ends here).
   */
  wholeMapFraming(viewportAspect: number): { pos: Vec2; view: number } | null {
    let { minX, maxX, minZ, maxZ } = this.world.bounds;
    for (const w of this.world.water) {
      minX = Math.min(minX, w.minX);
      maxX = Math.max(maxX, w.maxX);
      minZ = Math.min(minZ, w.minZ);
      maxZ = Math.max(maxZ, w.maxZ);
    }
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return null;
    const wM = Math.max(1, maxX - minX);
    const hM = Math.max(1, maxZ - minZ);
    const aspect = Math.max(0.2, Math.min(4, viewportAspect));
    // Visible height = viewWidth / aspect, so the width must cover
    // the extract's height × aspect as well as its own width.
    return {
      pos: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
      view: Math.max(wM, hM * aspect) * 1.06,
    };
  }

  /** The framing the camera is steering toward this frame: the
   *  player's zoom when one is set, else the speed-based framing.
   *  The centre is the gameplay anchor either way — zoomed out,
   *  the camera still follows the car across the map. */
  private cameraTarget(): { pos: Vec2; view: number } {
    const t = this.dynamicCameraTarget();
    if (this.zoomViewM === null) return t;
    return { pos: t.pos, view: this.zoomViewM };
  }

  /** The framing the normal camera is steering toward this frame. */
  private dynamicCameraTarget(): { pos: Vec2; view: number } {
    // Lookahead BY THE VELOCITY VECTOR (v0.21): the camera leans into
    // the direction of travel — including the lateral component when
    // the car slides — so a drift reads before it bites.
    const pos = {
      x: this.playerPos.x + this.playerVel.x * 0.45,
      z: this.playerPos.z + this.playerVel.z * 0.45,
    };
    const speedRatio = this.drivenCar
      ? Math.min(1, Math.abs(this.drivenCar.speed) / 38)
      : Math.min(1, Math.hypot(this.playerVel.x, this.playerVel.z) / 8);
    // Zoom-out-with-speed (the GTA 1 signature), retargeted in v0.23
    // to GTA-1 framing: values are metres across the viewport WIDTH.
    // Iteration 4 (Daniel's gameplay footage as the spec): the
    // footage's cruise frame is ≈55–65 m wide with the car at
    // ~15–17 % of frame width — v0.23's 130 m top-speed frame made
    // the car ~3–4 % and read slow and small. Now: 30 m on foot
    // (v0.24), 50 m at a driving crawl, max 85 m at top speed
    // (38 m/s standard since iteration 3) — the car is ~5 % of the
    // frame LENGTHWISE in landscape and much bigger across the
    // portrait width Daniel actually plays in, and the road ahead
    // still holds >2 s of travel at full pace.
    const view = this.drivenCar ? 50 + speedRatio * 35 : 30;
    return { pos, view };
  }

  /** True while the boot cinematic owns the camera. */
  get introRunning(): boolean {
    return this.introActive;
  }

  /**
   * Arm the boot cinematic (called by the platform when the loading
   * overlay dismisses). The descent starts over the whole extract —
   * buildings ∪ river bounds, centred, wide enough that BOTH axes
   * fit the viewport — and lands on the live gameplay framing.
   * `viewportAspect` is viewport width / height (portrait phone
   * ≈ 0.46, landscape desktop ≈ 1.9). No-op for the demo scenario
   * (screenshots want the settled framing) and once a run has
   * started moving (restarts never replay it).
   */
  beginIntro(viewportAspect: number): void {
    if (this.introSuppressed || this.introActive) return;
    // A world with no buildings has unbounded bounds (the toy test
    // worlds) — there is no "whole map" to descend from, so don't.
    const framing = this.wholeMapFraming(viewportAspect);
    if (!framing) return;
    this.introFrom = framing;
    this.introT = 0;
    this.introActive = true;
    this.camPos = { ...this.introFrom.pos };
    this.camViewM = framing.view;
  }

  /** Any input ends the cinematic NOW: the camera snaps to exactly
   *  the framing the normal camera targets, so play continues from
   *  the landing state with no jump. */
  skipIntro(): void {
    if (!this.introActive) return;
    this.introActive = false;
    const t = this.cameraTarget();
    this.camPos = { ...t.pos };
    this.camViewM = t.view;
  }

  private updateCamera(dt: number): void {
    const target = this.cameraTarget();
    if (this.introActive) {
      // Ease-out cubic on BOTH the centre and the LOG of the view
      // width: the descent covers ground (and orders of magnitude
      // of zoom) fast at altitude, then creeps the last stretch
      // into the car placement — exponential-smooth, no bounce.
      this.introT += dt;
      const p = Math.min(1, this.introT / INTRO_DURATION_S);
      const e = 1 - Math.pow(1 - p, 3);
      this.camPos = {
        x: this.introFrom.pos.x + (target.pos.x - this.introFrom.pos.x) * e,
        z: this.introFrom.pos.z + (target.pos.z - this.introFrom.pos.z) * e,
      };
      this.camViewM = Math.exp(
        Math.log(this.introFrom.view) + (Math.log(target.view) - Math.log(this.introFrom.view)) * e,
      );
      if (p >= 1) {
        // Land EXACTLY on the gameplay framing; the smoothing below
        // takes over next frame from its own target — no jump cut.
        this.introActive = false;
        this.camPos = { ...target.pos };
        this.camViewM = target.view;
      }
      return;
    }
    const kp = 1 - Math.exp(-6.5 * dt);
    this.camPos = {
      x: this.camPos.x + (target.pos.x - this.camPos.x) * kp,
      z: this.camPos.z + (target.pos.z - this.camPos.z) * kp,
    };
    // v0.21: GTA's zoom tracks speed aggressively — rate 3.6/s reaches
    // the target view in ~0.3 s (was 2.2/s, a visible ~0.5 s+ lag).
    // Iteration 5: the chase runs in LOG space, like the intro's
    // descent — across the street framing's small range it behaves
    // exactly as before, but a pinch from 85 m to the 2 km map (or
    // the arrival dive back) now eases through the orders of
    // magnitude instead of sprinting linearly then crawling.
    const kv = 1 - Math.exp(-3.6 * dt);
    this.camViewM = Math.exp(
      Math.log(this.camViewM) + (Math.log(target.view) - Math.log(this.camViewM)) * kv,
    );
  }

  // --- demo / test hooks -----------------------------------------------------

  /** Deterministic live-gameplay state for screenshots (?scenario=demo). */
  applyDemoScenario(): void {
    // Screenshots frame the settled scene — the boot cinematic
    // must never run over the demo state.
    this.introSuppressed = true;
    this.introActive = false;
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
    this.camViewM = 58; // ≈ the settled width at the demo's 9 m/s roll
  }

  private drainBriefForDemo(): void {
    this.afterMissionEvents();
    this.briefTtl = Math.max(this.briefTtl, 60); // hold the pager for the shot
  }

  private enterCarSilent(car: CarEntity): void {
    this.drivenCar = car;
    this.enteredCar = true;
    car.stolen = true;
    this.playerPos = { ...car.pos };
    this.playerHeading = car.heading;
  }

  // --- HUD / frame ---------------------------------------------------------------

  objectiveText(): string {
    if (this.goalState === 'to-exit') return 'Goal reached! Get to the EXIT point downtown';
    // v0.30: frenzies and the vehicle job outrank the payphone list.
    if (this.frenzy) {
      return `KILL FRENZY — ${this.frenzy.label}: ${this.frenzy.have}/${this.frenzy.need}`;
    }
    if (this.vehJob) {
      return this.drivenCar && this.drivenCar.id === this.vehJob.carId
        ? 'VEHICLE JOB — deliver this car to the CHOP SHOP'
        : 'VEHICLE JOB — get back in the marked car';
    }
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
      timerSec: this.missions.active
        ? this.missions.timeLeft
        : this.frenzy
          ? this.frenzy.tLeft
          : this.vehJob
            ? this.vehJob.tLeft
            : null,
      inCar: !!this.drivenCar,
      speedKmh: this.drivenCar ? Math.round(Math.abs(this.drivenCar.speed) * 3.6) : 0,
      carHealth: this.drivenCar ? Math.round(this.drivenCar.health) : null,
      reversing: !!this.drivenCar && this.drivenCar.speed < -0.5,
      weaponId: this.loadout.weapon,
      weaponName: this.loadout.def.name,
      ammo: this.loadout.def.usesAmmo ? this.loadout.ammo[this.loadout.weapon] : null,
      armour: Math.round(this.armour),
      jailCard: this.jailCard,
      carClass: this.drivenCar ? this.drivenCar.classId : null,
      frenzy: this.frenzy
        ? {
            label: this.frenzy.label,
            have: this.frenzy.have,
            need: this.frenzy.need,
            secsLeft: Math.ceil(this.frenzy.tLeft),
          }
        : null,
      vehJob: !!this.vehJob,
      shotsFired: this.shotsFired,
      explosions: this.explosionsCount,
      splashes: this.splashesCount,
      pickupsTaken: this.pickupsTaken,
      frenzyStarts: this.frenzyStarts,
      frenzyWins: this.frenzyWins,
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
        // v0.29: reverse lights while the driven car rolls backwards.
        reversing: car === this.drivenCar && car.speed < -0.3,
        // v0.30: fire state + traffic body variety.
        burning: car.burning,
        bodyType: car.bodyType,
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
        burning: cop.burning,
      });
    }
    // v0.30: pickups as entities (ground-anchored crates + glyphs).
    for (const p of this.pickups) {
      if (!p.active) continue;
      const style = PICKUP_STYLE[p.kind];
      entities.push({
        id: `pickup-${p.kind}-${Math.round(p.pos.x)}-${Math.round(p.pos.z)}`,
        kind: 'pickup',
        pos: p.pos,
        heading: 0,
        color: style.color,
        glyph: style.glyph,
        label: style.label,
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
        speedMps: ped.state === 'down' ? 0 : ped.state === 'flee' ? 4.4 : ped.speed,
        walkPhase: (ped.walkM / PED_STRIDE_M) % 1,
      });
    }
    if (!this.drivenCar && this.phase !== 'gameover') {
      entities.push({
        id: 'player',
        kind: 'player',
        pos: this.playerPos,
        heading: this.playerHeading,
        color: '#ffd23f',
        // v0.24: anchor ring until the first car entry, then never.
        anchor: !this.enteredCar,
        speedMps: Math.hypot(this.playerVel.x, this.playerVel.z),
        walkPhase: (this.playerWalkM / PLAYER_STRIDE_M) % 1,
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
    // v0.30: the chop shop is a standing landmark; the marked job
    // car gets its own beacon while it waits.
    markers.push({ pos: this.chopShopPos, radius: 7, label: 'CHOP SHOP', icon: '$', kind: 'chopshop' });
    if (this.markedCarId && !this.vehJob) {
      const jc = this.cars.find((c) => c.id === this.markedCarId);
      if (jc && !jc.wrecked) {
        markers.push({ pos: jc.pos, radius: 6, label: 'JOB CAR', icon: '★', kind: 'vehicle' });
      }
    }
    if (this.goalState === 'to-exit') {
      markers.push({ pos: this.exitPos, radius: 10, label: 'EXIT', icon: '⚑', kind: 'exit' });
    }
    const impactAge = this.time - this.lastImpactAt;
    // v0.30 effects: the fx queue plus standing fire on every
    // burning vehicle (flicker phase rides the world clock).
    const effects: RenderEffect[] = this.fx.map((f) => ({
      kind: f.kind,
      pos: f.pos,
      to: f.to,
      age01: f.t / f.ttl,
      radiusM: f.radiusM,
    }));
    for (const car of this.cars) {
      if (car.burning) effects.push({ kind: 'fire', pos: car.pos, age01: -1, radiusM: 2.6 });
    }
    for (const cop of this.cops) {
      if (cop.burning) effects.push({ kind: 'fire', pos: cop.pos, age01: -1, radiusM: 2.6 });
    }
    return {
      camera: { ...this.camPos },
      viewWidthM: this.camViewM,
      playerInCar: !!this.drivenCar,
      timeSec: this.time,
      entities,
      markers,
      effects,
      scorches: this.scorches,
      impact: impactAge < 0.45 ? this.lastImpactMag * (1 - impactAge / 0.45) : 0,
    };
  }
}

export type { MissionDef };
export { BUSTED_FINE, HOSPITAL_FEE };
