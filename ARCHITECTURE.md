# Architecture — the core/renderer split

The one rule this repo is built around: **the game simulation must not know
how it is being drawn.** That is what keeps Route C (standalone Canvas 2D)
open while Route A (MapLibre) ships now, and it is enforced structurally —
`src/core/` has zero imports of MapLibre, the DOM, or canvas, and only the
adapter folders may import rendering tech.

## Layers

```
        ┌────────────────────────────────────────────────┐
        │ src/main.ts — boot, keyboard/touch, HUD (DOM)  │
        └───────────────┬────────────────────────────────┘
                        │ inputs (move/throttle/steer, E)
                        ▼
        ┌────────────────────────────────────────────────┐
        │ src/core/ — SIMULATION                         │
        │  geo.ts      projection + desktop-grid convert │
        │  world.ts    projected world model + collision │
        │  physics.ts  rigid-body cars (4 tyres) + foot    │
        │  traffic.ts  cars following road polylines     │
        │  cops.ts     police pursuit steering           │
        │  peds.ts     pedestrians on road-offset paths  │
        │  wanted.ts   0–5 star heat, decay              │
        │  wallet.ts   score + multiplier (score=money)  │
        │  missions.ts payphone missions + state machine │
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

`RenderFrame` is plain data: camera centre (already smoothed by the core,
with velocity lookahead and speed-driven zoom), view **width** in
metres (v0.23 — framing is width-based so horizontal framing is
identical on any aspect ratio), a frame clock, entity list (player,
parked/traffic/driven/cop cars, pedestrians — with wreck/down flags),
and markers (payphone, objective, respray, exit). Adapters own all
presentation choices (colours, line widths, zoom math).

## Sprites (v0.20 — the dot is dead)

v0 drew entities as GeoJSON: the player was a MapLibre circle layer and
mission markers were metre-radius polygon rings — which is exactly what
it looked like ("a dot with a ring around it"). v0.20 generates real
top-down sprites once from offscreen canvases (`src/render/sprites.ts`:
car bodies with roof/windshield/headlights at 4.4 × 1.9 m, police with
a two-phase flashing lightbar, wrecks, little people with feet/head
direction cues) and both adapters draw them rotated by heading:

- **MapLibre adapter:** MapLibre now renders ONLY the static world
  (bright palette style: green ground, light asphalt + casing + centre
  dashes, per-building saturated colours with inset-roof polygons).
  A transparent canvas overlay pinned to the map container is redrawn
  per frame: each entity is projected to screen px (`map.project`),
  sized by the live px-per-metre at its position, and blitted.
  Markers are screen-pixel badges (22 px) with labels; only objective/
  exit zones keep a faint metre-accurate ground circle (that's their
  actual trigger area). No per-frame GeoJSON rebuilds at all.
- **Canvas adapter:** same sprites, same marker treatment, metre-space
  transform instead of map projection.

The core knew nothing about any of this — `RenderEntity`/`RenderMarker`
gained kinds and flags, that's all.

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
  push-out, with an inside-polygon case), shared by the player, cars,
  cops and peds.
- **Cars:** parked cars are deterministic (seeded RNG, same city every
  load). Traffic cars follow road polylines with `pointAlongRoad`, drive
  on the right, honour GeoNB `Dir_of_Traffic_Flow` ("Opposite Direction"
  travels against the digitised path), and brake when the player blocks
  them. **v0.21:** at road ends traffic consults the junction graph
  (`routing.ts`): road endpoints are clustered into nodes (5 m snap),
  and the car picks a connecting segment — preferring the exit that
  continues its direction of travel, random otherwise, U-turn only at a
  dead end — so traffic circulates downtown instead of ping-ponging.
  Cops do NOT road-follow; they free-steer in pursuit (unchanged), so
  routing applies where road-following is used: traffic.
- **Driving (v0.21 — the actual GTA 1 model):** `physics.ts` is one
  2D rigid body + four approximate tyres, after Pat Kerr's 1996
  prototype ("2D Vehicles"; via Kočica's "The weekend prototype that
  taught GTA how to drift", and Mike Dailly's account). At each tyre:
  point velocity (body velocity + angular velocity × offset) is split
  along/across the tyre's heading; a lateral grip force opposes the
  sideways component (tanh saturation — rear grip RATE lower, rear CAP
  higher, so the tail steps out at city speed but the car stays stable
  at 100+), and longitudinal forces cover engine (linear taper to the
  class top speed), brakes, reverse, and rolling lock. Forces at the
  contact patches create torque naturally — slide-and-recover is
  emergent, not scripted. Front tyres steer with an exponentially
  speed-faded lock; the handbrake collapses rear grip to 6%, softens
  the front, and locks the rear longitudinally. Substeps at 180 Hz.
  Three parameter classes: `standard`, `fast` (every 4th parked car),
  `police` (grippier, stronger). Player, cops and the BUSTED/WASTED
  roll-out all run this same `stepCar`; only traffic *spawning* is
  kinematic (a stolen traffic car becomes a rigid body on entry).
  Measured feel targets live in `src/core/physics.test.ts` /
  tools/drive-metrics.md — standard car 113 km/h, 0–100 in 5.6 s,
  handbrake 180° in ~1.3 s shedding ~67% speed, coast 100→0 in ~8.6 s.
  The v0.20 model it replaced measured 0–100 in 16.6 s and a coast
  that never stopped.
- **Visual rebuild (v0.23, render adapters):** the world stopped being
  flat fills. `render/textures.ts` generates seeded tileable bitmaps
  once at load (asphalt grain, 1.5 m pavement slabs, three roof
  variants, grass, water; pure + deterministic, unit-tested). Route A
  registers them as MapLibre pattern images — GL patterns are
  screen-space, so features hold world scale only near the authored
  nominal ppm (documented compromise); Route C rescales
  `CanvasPattern` transforms per frame and holds true world scale at
  any zoom. `render/dressing.ts` derives, once at load: building
  drop shadows (footprint offset 1.6 m SE), per-piece roof clutter
  (AC/vents/skylights, seeded by building index), zebra crosswalks at
  junction nodes from the routing graph, and a seeded roadside tree
  scatter (rejected inside buildings/roads). `render/palette.ts` is
  the shared grit palette (brick/slate/concrete/tar). The camera is
  GTA-1 tight — 50 m across on foot, ≤130 m at top speed — with
  MapLibre zoom math factored into `render/cameraMath.ts`
  (round-trip unit-tested). Sprites gained inked outlines, glass
  glare and SE drop shadows in `render/sprites.ts`.
- **Giant-roof segmentation (v0.22, render adapters):** `render/segment.ts`
  (shared by both adapters) subdivides the roof treatment of giant
  footprints — principal-axis (min-area bounding box) long side > 35 m,
  or area > 1,100 m² — into GTA-scale segments of ~20 m along the long
  axis: footprint clipped to bands, per-piece inset roof, deterministic
  per-segment shade step (±~5 %) and a toned seam stroke. The true
  outline never changes (pieces exactly tile it); the scale audit showed
  the car/streets already match GTA 1's 4.5 m cube, but real GeoNB giants
  (max 197 m ≈ 45 car lengths) had no GTA counterpart. 125 of 1,225
  buildings segment into 1,466 roof pieces total. PMTiles context
  buildings outside the downtown extract are not segmented.
- **Ground treatment (v0.21, render adapters):** `render/groundwork.ts`
  builds pavement ribbons under roads (width + 7 m sidewalk margin)
  and pavement aprons under buildings (footprint pushed out 2.4 m) in
  both adapters, so built-up blocks read as city instead of lawns;
  the PMTiles context buildings are pavement-grey too. The same
  module owns rear-tyre skid tracks (laid when |slip| > 13° or the
  handbrake is on, fading over ~7 s) drawn by both adapters, and both
  adapters shake the view on the frame's `impact` pulse.
- **Score/multiplier (`wallet.ts`):** score IS money. `earn()` multiplies
  every gain; mission completion raises the multiplier; BUSTED halves it
  (floor ×1) plus a $1,000 fine. The game awards desktop mission payouts
  ×100 as score (fees stay literal) so the $250,000 district goal is a
  real arc: goal → EXIT point → district archived → freeroam or new run.
- **Police (`cops.ts`):** pursuit cars are player-physics cars steered at
  a velocity-predicted aim point. Count = stars (cap 4), spawned ~150 m
  out on roads. They ram (damage + shove); a stopped player with a cop
  alongside for 3 s (car) or a cop holding the player 2 s (foot) is
  BUSTED. Heat decays only while no cop is within 45 m.
- **Pedestrians (`peds.ts`):** ~20 walkers on road-offset paths near the
  player; they flee fast/close cars; a car contact downs one (+score,
  +star); on-foot contact is a harmless nudge.
- **Respray:** a snapped roadside point on Queen St (grid (95, 55));
  driving in hot charges $500 × stars (floor $0), zeroes heat, clears
  cops, repaints the car.
- **Missions:** data-first definitions in `missions.ts`. The two ported
  missions mirror the desktop JSON (same ids, briefs, payouts, steps);
  v0.20 adds a timed steal-and-deliver (80 s) and a foot drop, placed via
  the same grid conversion. `MissionRunner` is a small state machine:
  `interact` steps complete via E near the step position,
  `steal_vehicle` via entering a parked car, `deliver_vehicle` via
  arriving in a car inside the step radius; timed missions `tick()` down
  and fail (re-takable, not completed). Missions are started at their
  start positions, presented as ringing payphones by the renderers.
- **Camera (in `game.ts`, not the adapters):** exponential smoothing
  toward the player plus velocity-vector lookahead (0.45 s of velocity,
  lateral slide included); view height interpolates from ~70 m on foot
  to ~300 m at full speed — the GTA 1 zoom-out. v0.21 tightens the
  zoom response (rate 2.2 → 3.6/s, ~0.3 s to target) and the position
  tracking (5 → 6.5/s).
- **Input & haptics (platform layer, `src/main.ts` + `src/platform/`):**
  the core only ever sees `carInput`/`moveInput`. Merged sources:
  keyboard (unchanged), gamepad (standard mapping), and one of three
  touch schemes — **Stick** (default: dynamic-origin analog stick,
  proportional steering + push/pull throttle, plus GAS/BRK pedals —
  either source wins), **Drag-steer** (hold anywhere; desired-heading
  steering toward the thumb relative to screen centre + auto-throttle),
  **Buttons** (the legacy binary layout). Scheme + haptics toggle live
  in the `?` overlay and persist in localStorage. Haptics
  (`platform/haptics.ts`) are inferred from HUD/state transitions in
  the frame loop — E tick 12 ms, enter car [20], collisions 15–80 ms
  scaled by health drop (≥120 ms apart), payphone [25,40,25], mission
  complete [40,60,40], BUSTED [90,60,90,60,180], WASTED [200,80,200],
  cancelled when stamps clear. Vibration API only: Android Chrome
  yes, iOS Safari absent → no-op.
- **Persistence:** `SaveStore` (key save-v2) archives { completedMissions,
  districtCleared, bestScore } through the injected `StorageAdapter`.
  Runs themselves are NOT restored (a fresh load = a fresh run, GTA
  style); only the archive persists. `main.ts` injects a
  localStorage-backed adapter; tests inject `MemoryStorage`. The core
  never touches `window`.

## Taking Route C from prototype to standalone

The canvas adapter already plays the identical simulation. A true
standalone Route C release additionally needs: (1) inline/bundle
`downtown.json` instead of fetching it, (2) drop the MapLibre/PMTiles
chunks (they're dynamically separable in `main.ts`), (3) polish the
canvas draw (road labels, culling, DPR handling). No core changes —
that is the point of the seam.

## Known v0.20 simplifications

- The world loader loads all 1,225 buildings in the dataset (all are
  Polygons; non-Polygon geometries would be skipped) and 218 of 219 roads
  (one sub-4 m stub is dropped).
- No Wolastoq river polygon in the playable dataset (GeoNB extract layers
  used here don't carry it); the PMTiles wetlands layer stands in as
  water/marsh in the context area. The river is a data addition, not an
  architecture change.
- Traffic routes through junctions (v0.21), but the graph only joins
  road ENDPOINTS — mid-block crossings where a road's polyline passes
  through another without a shared endpoint are not junctions. Cops
  free-steer and occasionally take a wall the scenic route.
- Pedestrians are anchored to their spawn roads rather than roaming the
  whole graph; downed peds get up after ~6 s (GTA-forgiving).
- Save v1 (v0's money/completed) is not migrated — save-v2 archives only
  districtCleared + bestScore, and every load starts a fresh run.
