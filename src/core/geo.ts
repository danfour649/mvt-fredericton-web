/**
 * Geo projection for MVT Fredericton Web — renderer-agnostic, no imports
 * beyond this module.
 *
 * Two frames matter:
 *  1. CORE frame ("local metres"): +X east, +Z south of City Hall, obtained
 *     by projecting lon/lat with the same formulae as the desktop game's
 *     tools/osm_import.py. ALL simulation happens in this frame.
 *  2. MVT GRID frame (desktop game coordinates): the core frame rotated by
 *     GRID_ROTATION_DEG (-35.936°) so Queen St reads east-west in the desktop
 *     game. Desktop mission/spawn positions live in this frame.
 *
 * Converting an MVT-grid position to lon/lat = rotate by -GRID_ROTATION_DEG
 * (undoing the grid rotation), then unproject. Converting it to the core
 * frame is just that same rotation — no lon/lat round trip needed.
 */

export const ORIGIN_LAT = 45.96315;
export const ORIGIN_LON = -66.6428;

/** Pinned in desktop tools/osm_import.py (PINNED_ROTATION_DEG). */
export const GRID_ROTATION_DEG = -35.936;

export interface LngLat {
  lng: number;
  lat: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

/** Metres per degree at a latitude (osm_import.py metres_per_degree). */
export function metresPerDegree(lat: number): { mLat: number; mLon: number } {
  const latRad = (lat * Math.PI) / 180;
  return {
    mLat: 111132.92 - 559.82 * Math.cos(2 * latRad),
    mLon: 111412.84 * Math.cos(latRad),
  };
}

const { mLat: M_LAT, mLon: M_LON } = metresPerDegree(ORIGIN_LAT);
export { M_LAT, M_LON };

/** Project lon/lat to core-frame local metres (+X east, +Z south). */
export function project(lng: number, lat: number): Vec2 {
  return {
    x: (lng - ORIGIN_LON) * M_LON,
    z: (ORIGIN_LAT - lat) * M_LAT,
  };
}

/** Inverse of project(): core-frame metres back to lon/lat. */
export function unproject(x: number, z: number): LngLat {
  return {
    lat: ORIGIN_LAT - z / M_LAT,
    lng: ORIGIN_LON + x / M_LON,
  };
}

/** rotate_point() from osm_import.py: angle in radians. */
export function rotatePoint(x: number, z: number, angRad: number): Vec2 {
  const c = Math.cos(angRad);
  const s = Math.sin(angRad);
  return { x: x * c - z * s, z: x * s + z * c };
}

const DEG = Math.PI / 180;

/** MVT grid frame -> core frame (undo the desktop grid rotation). */
export function mvtGridToLocal(x: number, z: number): Vec2 {
  return rotatePoint(x, z, -GRID_ROTATION_DEG * DEG);
}

/** Core frame -> MVT grid frame. */
export function localToMvtGrid(x: number, z: number): Vec2 {
  return rotatePoint(x, z, GRID_ROTATION_DEG * DEG);
}

/**
 * MVT grid position -> lon/lat: rotate by -GRID_ROTATION_DEG, then unproject.
 * e.g. (0, ~27) — just south of City Hall in the desktop grid — lands on
 * Queen St at approx (45.9629, -66.6428).
 */
export function mvtGridToLngLat(x: number, z: number): LngLat {
  const local = mvtGridToLocal(x, z);
  return unproject(local.x, local.z);
}

/** lon/lat -> MVT grid position (exact inverse of mvtGridToLngLat). */
export function lngLatToMvtGrid(lng: number, lat: number): Vec2 {
  const local = project(lng, lat);
  return localToMvtGrid(local.x, local.z);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
