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

export type EntityKind = 'player' | 'car-parked' | 'car-traffic' | 'car-driven' | 'car-cop' | 'ped';

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
}

export interface RenderMarker {
  pos: Vec2;
  /** Ground trigger radius in metres — adapters may draw it faintly for
   *  objectives, or ignore it; icons themselves are SCREEN-sized. */
  radius: number;
  label: string;
  /** Single glyph drawn inside the marker badge (payphone ☎, etc.). */
  icon: string;
  kind: 'payphone' | 'objective' | 'respray' | 'exit';
}

export interface RenderFrame {
  /** Camera centre, core metres (already smoothed by the core). */
  camera: Vec2;
  /** Metres visible across the viewport height, roughly. Camera adapters
   *  translate this to a MapLibre zoom / canvas scale. */
  viewHeightM: number;
  playerInCar: boolean;
  /** Seconds since boot, for pulse/blink animation phases. */
  timeSec: number;
  entities: RenderEntity[];
  markers: RenderMarker[];
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
