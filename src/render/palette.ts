/**
 * Shared world palette — used identically by both adapters.
 *
 * v0.28 art pass (Daniel: v0.23 "still looks nothing like GTA 1"):
 * v0.23's muted grit was an overcorrection. GTA 1's city is BOLD flat
 * colour with hard edges — saturated brick, slate and teal masses on
 * deep recessive green; dark blue-grey roads with chunky yellow
 * dashes; warm light stone pavement; and (new with the river) a bold
 * flat blue for water. Variety still comes from texture and the v0.22
 * shade steps, but the hues themselves are turned back UP.
 */

/** Parapet/wall band colours per building (index-assigned like before). */
export const WALL_COLORS = [
  '#9e5233', // bold brick
  '#8b8578', // warm concrete
  '#33655f', // deep teal
  '#4d6172', // slate blue
  '#b08d57', // sandstone
  '#8e3b2f', // dark brick red
  '#5c7050', // moss slate
  '#7d5238', // brownstone
];

/**
 * Roof texture variant per building: 0..2 → grain roofs (roof1..3),
 * 3 → the window-grid roof (roofgrid, textures.ts) — the refs'
 * signature gridded mass, for mid/large buildings (footprint area or
 * height). Small buildings keep the quiet grain roofs.
 */
export function roofVariant(buildingIndex: number, heightM: number, areaM2 = 0): 0 | 1 | 2 | 3 {
  if (areaM2 >= 260 || heightM >= 14) return 3;
  return ((buildingIndex * 5 + Math.floor(heightM)) % 3) as 0 | 1 | 2;
}

/** Ground base colour under the grass texture (and MapLibre bg). */
export const GROUND_BASE = '#2e4a24';
/** PMTiles context buildings (outside the game extract). */
export const CONTEXT_BUILDING = '#7e7768';
/** Road casing / edge (the dark outline under kerb + asphalt). */
export const ROAD_CASING = '#22242a';
/** Kerb line between casing and asphalt. */
export const ROAD_KERB = '#ddd5c0';
/** Asphalt fallback / centre-line surround tone. */
export const ROAD_ASPHALT = '#343945';
/** GTA-style dashed centre line: chunky saturated yellow. */
export const CENTRE_LINE = '#f0c41c';
/** Water bank: pale outer line along the shoreline (both adapters). */
export const WATER_BANK = '#d9e9f2';
/** Water edge: the darker shoreline stroke right at the waterline. */
export const WATER_EDGE = '#17486e';
