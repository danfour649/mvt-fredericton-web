# MVT Fredericton Web

A minimalist, web-playable, top-down (GTA 1 style) take on **MVT Fredericton** —
drive and walk the real streets of downtown Fredericton, New Brunswick, in your
browser. Real building footprints and real roads, a player on foot, stealable
parked cars, traffic, a wanted level, and the desktop game's first two missions.

This is **Route A** of the web plan: browser-native, built on the
[maps-of-nb](https://github.com/danfour649/maps-of-nb) data stack (GeoNB open
data, baked PMTiles, MapLibre). It is a fresh repo — not a fork of the desktop
Godot game — and it is architected so **Route C** (a standalone Canvas 2D
renderer with no map library at all) can replace the rendering layer later
without touching the game simulation. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Play (dev)

```sh
npm install
npm run dev        # http://localhost:5173
```

- **WASD / arrows** — walk, or drive when in a car
- **E** — start a mission at a green marker, interact at a gold marker,
  enter/exit a car
- `?renderer=canvas` in the URL swaps the MapLibre renderer for the
  Route C canvas prototype — same game, same data.

## What's in v0

- Downtown Fredericton dataset (`public/data/downtown.json`, ~0.5 MB):
  **1,225 GeoNB buildings** with LiDAR heights and **219 roads** with names,
  lanes, speed limits and traffic-flow direction, bbox W −66.652, S 45.955,
  E −66.628, N 45.97 — the maps-of-nb downtown game-mesh extract.
- Full-city context from `public/fredericton.pmtiles` (7.7 MB, the
  maps-of-nb bake) as a faint underlay outside the playable dataset.
- Flat vector style only: dark ground, road ribbons, buildings shaded by
  height. No satellite imagery.
- Player on foot with building collision; 16 parked cars and 7 traffic cars
  following road polylines (GeoNB `Dir_of_Traffic_Flow` honoured); E to
  enter/drive/exit; arcade car physics in the core.
- HUD: money, wanted stars (0–5 — reckless driving raises it, it decays),
  objective text, event toasts, speed while driving.
- Two missions ported verbatim from the desktop game
  (`data/missions/` in GTAfredericton): **Queen Street Errand** ($150) and
  **Wheels for The Cap** ($250), including their real start/pickup/dropoff
  coordinates, converted from the desktop's rotated grid (see ARCHITECTURE).
- Progress (money + completed missions) persists in `localStorage`.

## Tests & build

```sh
npm test           # build + dist output checks + unit tests
npm run test:unit  # vitest: geo conversion, mission state machine, collision
npm run build      # tsc + vite build -> dist/
npm run preview    # serve the production build locally
```

Geo conversion is unit-tested against the desktop game's own constants:
`mvtGridToLngLat(0, ~27)` lands on Queen St beside City Hall
(≈ 45.9629, −66.6428), and project/unproject + grid round-trips are exact.

## Data pipeline

```sh
python3 tools/build_downtown.py   # re-pull GeoNB -> public/data/downtown.json
```

Stdlib-only; queries GeoNB's public ArcGIS services in a 3×3 grid (the
maps-of-nb extractor's envelope mode currently fails on the buildings
service — it rejects its `orderByFields` — so this tool omits it and dedupes
across grid cells instead). `fredericton.pmtiles` is copied from the
maps-of-nb repo (`web/public/fredericton.pmtiles`).

## Attribution

- **Buildings, roads, LiDAR heights:** © GeoNB / Service New Brunswick,
  distributed under the
  [Open Government Licence – New Brunswick](https://www2.gnb.ca/content/gnb/en/departments/government_services.html).
- **Mission & spawn coordinates:** from MVT Fredericton (desktop), whose map
  frame derives from © OpenStreetMap contributors, licensed under the
  [ODbL](https://opendatacommons.org/licenses/odbl/).
- **Rendering:** [MapLibre GL JS](https://maplibre.org) (BSD-3) and
  [PMTiles](https://github.com/protomaps/PMTiles) (BSD-3).

## Layout

```
src/core/            renderer-agnostic simulation (no DOM/MapLibre/canvas)
src/render/maplibre/ Route A adapter (current default)
src/render/canvas/   Route C adapter (working prototype/stub)
src/main.ts          boot, input, HUD wiring — no game logic
public/data/         downtown.json (GeoNB extract)
public/              fredericton.pmtiles (full-city context, from maps-of-nb)
tools/               build_downtown.py — the GeoNB data pull
```
