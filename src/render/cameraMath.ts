/**
 * Camera maths for the MapLibre adapter (v0.23) — pure + testable.
 *
 * The core frame now specifies metres across the viewport WIDTH.
 * MapLibre zoom is defined by metres-per-pixel at the centre latitude:
 * mPerPx(z) = 156543.03392 · cos(lat) / 2^z (Web Mercator, 512px tiles
 * in MapLibre GL's convention — the same constant the adapter has
 * always used). These helpers convert between the core's view width
 * and MapLibre zoom, and metres ↔ screen pixels at a given zoom.
 */

/** Metres per pixel at zoom 0 for a latitude (degrees). */
export function mPerPxAtZoom0(latDeg: number): number {
  return 156543.03392 * Math.cos((latDeg * Math.PI) / 180);
}

/** MapLibre zoom at which `viewWidthM` metres span `viewportWidthPx`. */
export function zoomForViewWidth(viewWidthM: number, viewportWidthPx: number, latDeg: number): number {
  const mPerPx = viewWidthM / Math.max(1, viewportWidthPx);
  return Math.log2(mPerPxAtZoom0(latDeg) / mPerPx);
}

/** Inverse: metres across the viewport width at a MapLibre zoom. */
export function viewWidthForZoom(zoom: number, viewportWidthPx: number, latDeg: number): number {
  return (mPerPxAtZoom0(latDeg) / Math.pow(2, zoom)) * viewportWidthPx;
}

/** Screen pixels per world metre at a MapLibre zoom + latitude. */
export function pixelsPerMetre(zoom: number, latDeg: number): number {
  return Math.pow(2, zoom) / mPerPxAtZoom0(latDeg);
}
