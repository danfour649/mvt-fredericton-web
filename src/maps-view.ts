// Maps tab: downtown Fredericton in 3D, built natively on the same
// data the Maps of New Brunswick viewer (maps-of-nb) uses — GeoNB's
// own imagery basemap service underneath, and building extrusions
// from this site's baked fredericton.pmtiles (the maps-of-nb bake:
// GeoNB's LiDAR-derived footprints, extruded by max_b_elev −
// min_g_elev with the viewer's own colour ramp).
//
// The map is created lazily the first time the Maps panel is shown —
// a MapLibre map born in a hidden container has zero size — and
// resized on every later show. The view-switching itself lives in
// index.html's inline tab script; this module only watches the
// panel's `hidden` attribute.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';

// The maps-of-nb viewer's GeoNB imagery tile template, verbatim
// (its exportTile('GeoNB_Basemap_Imagery', false)).
const GEONB_IMAGERY =
  'https://geonb.snb.ca/arcgis/rest/services/GeoNB_Basemap_Imagery/MapServer/export' +
  '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32' +
  '&transparent=false&dpi=96&f=image';

let mapsMap: maplibregl.Map | null = null;

function initMapsView(): void {
  const container = document.getElementById('maps-map');
  if (!container || mapsMap) return;
  const proto = new Protocol();
  maplibregl.addProtocol('pmtiles', proto.tile);
  mapsMap = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        'geonb-imagery': {
          type: 'raster',
          tileSize: 256,
          maxzoom: 18,
          tiles: [GEONB_IMAGERY],
          attribution: 'Imagery © GeoNB / Service New Brunswick',
        },
        nbtiles: { type: 'vector', url: 'pmtiles:///fredericton.pmtiles' },
      },
      layers: [
        { id: 'geonb-imagery', type: 'raster', source: 'geonb-imagery' },
        {
          id: 'buildings-3d',
          type: 'fill-extrusion',
          source: 'nbtiles',
          'source-layer': 'buildings',
          minzoom: 12,
          paint: {
            'fill-extrusion-height': ['max', ['-', ['get', 'max_b_elev'], ['get', 'min_g_elev']], 0],
            'fill-extrusion-base': 0,
            'fill-extrusion-opacity': 0.85,
            'fill-extrusion-color': [
              'interpolate',
              ['linear'],
              ['-', ['get', 'max_b_elev'], ['get', 'min_g_elev']],
              0, '#7fa6bd',
              8, '#c9a86a',
              18, '#d96f3c',
              30, '#b83a2a',
            ],
          },
        },
      ],
    },
    center: [-66.6431, 45.9636],
    zoom: 14,
    pitch: 57,
    bearing: 0,
    cooperativeGestures: true,
    attributionControl: { compact: true },
  });
  mapsMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
}

const section = document.getElementById('view-maps');
if (section) {
  const onVisibility = (): void => {
    if (section.hidden) return;
    if (!mapsMap) initMapsView();
    else mapsMap.resize();
  };
  new MutationObserver(onVisibility).observe(section, {
    attributes: true,
    attributeFilter: ['hidden'],
  });
  onVisibility();
}
