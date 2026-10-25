# Architecture — the core/renderer split

The one rule this repo is built around: **the game simulation must not know
how it is being drawn.** That is what keeps Route C (standalone Canvas 2D)
open while Route A (MapLibre) ships now, and it is enforced structurally —
`src/core/` has zero imports of MapLibre, the DOM, or canvas, and only the
adapter folders may import rendering tech.

## Layers

```
        ┌────────────────────────────────────────────────┐
        │ src/main.ts — boot, keyboard, HUD (DOM)        │
        └───────────────┬────────────────────────────────┘
                        │ inputs (move/throttle/steer, E)
                        ▼
        ┌────────────────────────────────────────────────┐
        │ src/core/ — SIMULATION                         │
        │  geo.ts      projection + desktop-grid convert │
        │  world.ts    projected world model + collision │
        │  physics.ts  on-foot movement, arcade car      │
        │  traffic.ts  cars following road polylines     │
        │  wanted.ts   0–5 star heat, decay              │
        │  wallet.ts   money                             │
        │  missions.ts definitions + state machine      │
        │  save.ts     persistence via injected storage  │
        │  game.ts     orchestrates all of the above     │
        │  renderer.ts the Renderer interface (the seam) │
        └───────────────┬────────────────────────────────┘
                        │ RenderFrame each tick: camera + entities
                        │ + markers, ALL in core-frame local metres
              ┌─────────┴──────────┐
              ▼                    ▼
   src/render/maplibre/   src/render/canvas/
   Route A (ships now)    Route C (prototype)
   MapLibre GL + PMTiles  plain Canvas 2D
```

A renderer is chosen in `main.ts` (`?renderer=canvas` for Route C) and must
implement three methods from `core/renderer.ts`:

```ts
interface Renderer {
  init(world: WorldModel): void | Promise<void>;
  sync(frame: RenderFrame): void;   // every animation frame
  dispose(): void;
}
```

`RenderFrame` is plain data: camera centre, view height in metres, entity
list (player + cars with position/heading/colour), and mission markers.
Adapters own all presentation choices (colours, line widths, zoom math).

## Coordinates — one frame, conversions only at the edges

The core works **only in projected local metres**: +X east, +Z south of
City Hall (ORIGIN_LAT 45.96315, ORIGIN_LON −66.64280), using the exact
formulae from the desktop game's `tools/osm_import.py`
(`m_lat = 111132.92 − 559.82·cos(2φ)`, `m_lon = 111412.84·cos(φ)`).

- **World data in:** `downtown.json` is lon/lat GeoJSON; `world.ts`
  projects every coordinate once at load. Nothing after load touches
  lon/lat — except renderers, which convert back at the draw boundary
  (the MapLibre adapter unprojects; the canvas adapter never needs to).
- **Desktop positions in:** the desktop game world is *rotated* by
  `grid_rotation_deg = −35.936°` so Queen St reads east–west. Mission and
  spawn positions therefore live in that rotated grid. Conversion
  (`core/geo.ts`): `mvtGridToLngLat(x, z)` = rotate by −GRID_ROTATION_DEG,
  then unproject; `mvtGridToLocal(x, z)` is the same rotation alone and
  lands directly in the core frame. Both are unit-tested: grid (0, ~27)
  → Queen St, ≈ (45.9629, −66.6428); the two ported missions and the spawn
  [0.5, 27.8] convert through this path only.

## Simulation notes

- **Collision:** circle vs building-polygon (bbox reject → nearest-edge
  push-out, with an inside-polygon case), shared by the player and cars.
- **Cars:** parked cars are deterministic (seeded RNG, same city every
  load). Traffic cars follow road polylines with `pointAlongRoad`, drive
  on the right, honour GeoNB `Dir_of_Traffic_Flow` ("Opposite Direction"
  travels against the digitised path), and ping-pong at road ends — v0
  has no intersection routing.
- **Driving:** throttle/steer arcade model in `physics.ts` (top speed
  ~90 km/h); building hits and car-vs-car hits at speed raise wanted heat
  via `wanted.ts`, which also decays it.
- **Missions:** data-first definitions in `missions.ts` mirroring the
  desktop JSON (same ids, briefs, payouts, step order). `MissionRunner`
  is a small state machine: `interact` steps complete via E near the
  step position, `steal_vehicle` via entering a parked car,
  `deliver_vehicle` via arriving in a car inside the step radius.
- **Persistence:** `SaveStore` serialises { money, completedMissions }
  through the injected `StorageAdapter`. `main.ts` injects a
  localStorage-backed adapter; tests (and future Route C shells) inject
  `MemoryStorage`. The core never touches `window`.

## Taking Route C from prototype to standalone

The canvas adapter already plays the identical simulation. A true
standalone Route C release additionally needs: (1) inline/bundle
`downtown.json` instead of fetching it, (2) drop the MapLibre/PMTiles
chunks (they're dynamically separable in `main.ts`), (3) polish the
canvas draw (road labels, culling, DPR handling). No core changes —
that is the point of the seam.

## Known v0 simplifications

- The world loader skips non-Polygon building geometries (10 of 1,235
  features, MultiPolygons) and one sub-4 m road stub (218 of 219 loaded).
- No Wolastoq river polygon in the playable dataset (GeoNB extract layers
  used here don't carry it); the PMTiles context has no water layer either.
  The river is a data addition, not an architecture change.
- Traffic doesn't route through intersections; police don't pursue yet
  (wanted is a display + decay system in v0).
