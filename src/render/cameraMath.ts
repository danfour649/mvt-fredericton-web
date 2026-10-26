/**
 * Camera maths for the MapLibre adapter (v0.23) — pure + testable.
 *
 * The core frame now specifies metres across the viewport WIDTH.
 * MapLibre zoom is defined by metres-per-pixel at the centre latitude:
 * mPerPx(z) = 78271.51696 · cos(lat) / 2^z. The constant is the Web
 * Mercator world circumference over MapLibre GL's 512-px tile size
 * (40075016.686 / 512) — NOT the 156543 figure for 256-px OSM tiles.
 * (v0.23's first cut used 156543 and framed everything 2× too tight;
 * the production screenshots caught it. These helpers convert between
 * the core's view width and MapLibre zoom, and metres ↔ screen pixels
 * at a given zoom.
 */

/** Metres per pixel at zoom 0 for a latitude (degrees). */
export function mPerPxAtZoom0(latDeg: number): number {
  return 78271.51696 * Math.cos((latDeg * Math.PI) / 180);
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
