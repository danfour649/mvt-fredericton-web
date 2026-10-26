/**
 * Shared world palette (v0.23) — used identically by both adapters.
 *
 * v0.22's candy set (saturated coral, lilac, mint, a neon-purple slab)
 * is gone. GTA 1's city is brick, slate, concrete, tar and brownstone:
 * muted, warm-grey-biased, with variety carried by texture and shade
 * steps instead of hue fireworks. Building "wall" colour is what shows
 * as the parapet band around each roof piece; roofs themselves are
 * textured (textures.ts roof1–3) in tar/gravel tones.
 */

/** Parapet/wall band colours per building (index-assigned like before). */
export const WALL_COLORS = [
  '#8a6f5c', // brownstone
  '#7d7468', // weathered concrete
  '#94573f', // brick
  '#6f7a72', // slate green-grey
  '#86755a', // sand stone
  '#707a84', // slate blue-grey
  '#7a5a50', // mauve brick
  '#8d8577', // ashlar stone
];

/** Roof texture variant per building (0..2 → roof1..roof3). */
export function roofVariant(buildingIndex: number, heightM: number): 0 | 1 | 2 {
  return ((buildingIndex * 5 + Math.floor(heightM)) % 3) as 0 | 1 | 2;
}

/** Ground base colour under the grass texture (and MapLibre bg). */
export const GROUND_BASE = '#3e522c';
/** PMTiles context buildings (outside the game extract). */
export const CONTEXT_BUILDING = '#8f8a7d';
/** Road casing / edge (the dark outline under kerb + asphalt). */
export const ROAD_CASING = '#33353b';
/** Kerb line between casing and asphalt. */
export const ROAD_KERB = '#c9c4b4';
/** Asphalt fallback / centre-line surround tone. */
export const ROAD_ASPHALT = '#3e4049';
/** GTA-style dashed centre line: worn yellow. */
export const CENTRE_LINE = '#d8b93a';
