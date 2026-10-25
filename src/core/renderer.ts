/**
 * The Renderer contract — the ONLY seam between the game core and any
 * drawing technology.
 *
 * Route A (src/render/maplibre) implements this over MapLibre GL + PMTiles.
 * Route C (src/render/canvas) implements it over a plain Canvas 2D.
 * The core never imports either; src/main.ts picks one at boot.
 *
 * Everything the renderer is handed is in core-frame local metres
 * (+X east, +Z south of City Hall). Adapters convert to their own
 * coordinate system internally (the MapLibre adapter unprojects to
 * lon/lat via core/geo; the canvas adapter scales metres to pixels).
 */
import type { Vec2 } from './geo';
import type { WorldModel } from './world';

export type EntityKind = 'player' | 'car-parked' | 'car-traffic' | 'car-driven';

export interface RenderEntity {
  id: string;
  kind: EntityKind;
  pos: Vec2;
  /** Radians, 0 = east (+X), increasing clockwise (because +Z is south). */
  heading: number;
  /** Paint hint for adapters that want variety; ignored otherwise. */
  color: string;
}

export interface RenderMarker {
  pos: Vec2;
  radius: number;
  label: string;
  kind: 'mission-start' | 'objective';
}

export interface RenderFrame {
  /** Camera centre, core metres. */
  camera: Vec2;
  /** Metres visible across the viewport height, roughly. Camera adapters
   *  translate this to a MapLibre zoom / canvas scale. */
  viewHeightM: number;
  playerInCar: boolean;
  entities: RenderEntity[];
  markers: RenderMarker[];
}

export interface Renderer {
  readonly name: string;
  /** Called once with the loaded world (projected, core metres). */
  init(world: WorldModel): void | Promise<void>;
  /** Called every animation frame with the full scene state. */
  sync(frame: RenderFrame): void;
  dispose(): void;
}
