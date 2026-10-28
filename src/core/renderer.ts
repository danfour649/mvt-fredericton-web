/**
 * The Renderer contract — the ONLY seam between the game core and any
 * drawing technology.
 *
 * Route A (src/render/maplibre) implements this over MapLibre GL + PMTiles
 * with sprites drawn on a synced canvas overlay. Route C
 * (src/render/canvas) implements it over a plain Canvas 2D.
 * The core never imports either; src/main.ts picks one at boot.
 *
 * Everything the renderer is handed is in core-frame local metres
 * (+X east, +Z south of City Hall). Adapters convert to their own
 * coordinate system internally (the MapLibre adapter unprojects to
 * lon/lat via core/geo; the canvas adapter scales metres to pixels).
 */
import type { Vec2 } from './geo';
import type { WorldModel } from './world';

export type EntityKind =
  | 'player' | 'car-parked' | 'car-traffic' | 'car-driven' | 'car-cop' | 'ped' | 'pickup';

export interface RenderEntity {
  id: string;
  kind: EntityKind;
  pos: Vec2;
  /** Radians, 0 = east (+X), increasing clockwise (because +Z is south). */
  heading: number;
  /** Paint hint for adapters that want variety; ignored otherwise. */
  color: string;
  /** Car is a burned-out wreck (dead, dark). */
  wrecked?: boolean;
  /** Pedestrian is down on the ground. */
  down?: boolean;
  /** Slip angle in degrees (nose vs velocity) — drives skid marks. */
  slip?: number;
  /** Speed magnitude, m/s. */
  speedMps?: number;
  /** Handbrake currently held (driven car only). */
  handbrake?: boolean;
  /**
   * v0.24: draw the pulsing spawn anchor ring under this entity
   * (player only, until the first car entry).
   */
  anchor?: boolean;
  /**
   * v0.29: walk-cycle phase 0..1, advanced by DISTANCE walked (the
   * core accumulates metres; a full cycle is two steps). Adapters
   * pick the person-sprite frame from this + speedMps — standing
   * entities (speedMps ≈ 0) rest in the neutral stance.
   */
  walkPhase?: number;
  /** v0.29: rolling backwards — adapters light the reverse lamps. */
  reversing?: boolean;
  /** v0.30: vehicle is on fire (fuse burning) — adapters flame it. */
  burning?: boolean;
  /** v0.30: traffic body variety — 'car' (default) | 'taxi' | 'van' | 'pickup'. */
  bodyType?: 'car' | 'taxi' | 'van' | 'pickup';
  /** v0.30: pickup glyph + label (kind 'pickup' only). */
  glyph?: string;
  label?: string;
}

/**
 * v0.30: transient visual effects. `age01` is progress through the
 * effect's life (0..1); -1 means a standing effect whose flicker
 * phase the adapter derives from the frame clock (burning cars).
 */
export interface RenderEffect {
  kind: 'fire' | 'explosion' | 'splash' | 'tracer' | 'muzzle';
  pos: Vec2;
  /** End point (tracers). */
  to?: Vec2;
  age01: number;
  radiusM?: number;
}

export interface RenderMarker {
  pos: Vec2;
  /** Ground trigger radius in metres — adapters may draw it faintly for
   *  objectives, or ignore it; icons themselves are SCREEN-sized. */
  radius: number;
  label: string;
  /** Single glyph drawn inside the marker badge (payphone ☎, etc.). */
  icon: string;
  kind: 'payphone' | 'objective' | 'respray' | 'exit' | 'chopshop' | 'vehicle';
}

export interface RenderFrame {
  /** Camera centre, core metres (already smoothed by the core). */
  camera: Vec2;
  /** Metres visible across the viewport WIDTH (v0.23: the camera is
   *  framed GTA-1-style by width — ~30 m on foot since v0.24, 50 m at
   *  a driving crawl up to 85 m at top speed since iteration 4 — so
   *  horizontal framing is identical on any aspect ratio).
   *  Adapters translate this to a MapLibre zoom / canvas scale using
   *  their own viewport size. */
  viewWidthM: number;
  playerInCar: boolean;
  /** Seconds since boot, for pulse/blink animation phases. */
  timeSec: number;
  entities: RenderEntity[];
  markers: RenderMarker[];
  /** v0.30: transient effects (fire, explosions, splashes, tracers). */
  effects: RenderEffect[];
  /** v0.30: permanent scorch marks left by explosions (metres). */
  scorches: Vec2[];
  /** 0..1 hard-impact pulse, decaying — adapters shake the view. */
  impact: number;
}

export interface Renderer {
  readonly name: string;
  /** Called once with the loaded world (projected, core metres). */
  init(world: WorldModel): void | Promise<void>;
  /** Called every animation frame with the full scene state. */
  sync(frame: RenderFrame): void;
  dispose(): void;
}
