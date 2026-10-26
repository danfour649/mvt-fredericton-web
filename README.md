# MVT Fredericton Web

A minimalist, web-playable, top-down (GTA 1 style) take on **MVT Fredericton** —
drive and walk the real streets of downtown Fredericton, New Brunswick, in your
browser. Real building footprints and real roads, sprites not dots, pursuing
police, payphone missions, and a score to chase.

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
- **E** — answer a ringing payphone, interact, enter/exit a car
- **Space** — handbrake (drift!)
- **R / F** — new run / keep freeroaming on the end screens
- **Touch (v0.21)**: default is a floating **analog stick** (thumb down
  anywhere on the left half — horizontal = proportional steering, push
  up = gas, pull down = brake/reverse) plus big GAS/BRK pedals, DRIFT
  and E on the right. A **Drag-steer** scheme (hold and drag; the car
  steers toward your thumb and drives itself) and the legacy **Buttons**
  scheme are switchable in the `?` overlay and remembered. **Gamepads**
  work too: left stick steers, RT/LT are the pedals, A = E, X/Y =
  handbrake. **Haptics** (Vibration API, Android/Chrome) tick on E,
  thump on collisions, and play patterns for payphones, mission
  complete, BUSTED and WASTED — toggle in the `?` overlay.
- `?renderer=canvas` swaps the MapLibre renderer for the Route C canvas
  adapter — same game, same data. `?scenario=demo` boots into a scripted
  live-gameplay state (used for screenshots).

## What's new in v0.21 — driving feel + input

- **Real GTA 1 vehicle physics.** The v0.20 velocity-lerp hack (measured
  0–100 km/h: **16.6 s**) is gone. Cars are now a 2D rigid body with
  four approximate tyres, exactly the model from Pat Kerr's 1996
  prototype that became GTA 1's handling: per-tyre velocity split into
  forward/sideways, grip forces at the contact patches, torque for
  free. Standard car: 113 km/h top speed, 0–100 in 5.6 s, ~9° of
  visible slip in a full-lock 50 km/h turn, handbrake 180° in ~1.3 s.
  Three classes (standard / fast / police), and traffic + cops run the
  same physics as you. Full before/after table:
  [tools/drive-metrics.md](tools/drive-metrics.md).
- **Paved city.** Roads get pavement ribbons with sidewalk margins and
  every building sits on a pavement apron — downtown reads as city,
  not lawns. Green is open ground; the wetlands stay blue.
- **Traffic circulates.** A junction graph over the road network means
  traffic turns at intersections (preferring to continue its line,
  U-turning only at dead ends) instead of ping-ponging at road ends.
- **Feedback.** Fading rear-tyre skid marks while you slide, and a
  small screen shake on hard impacts. Camera zoom now tracks speed
  tightly (~0.3 s) with velocity-vector lookahead.

## The game (v0.20 — the GTA 1 loop)

- **Score IS money.** One meter, top-left, with a **×N multiplier chip**.
  Completing a mission raises the multiplier (×1 → ×2 → …) and *everything*
  you earn is multiplied. District goal: **$250,000** (gold hairline bar at
  the very top of the screen), then drive to the **EXIT** point to clear
  downtown. Desktop mission payouts ($150–$400) are awarded as score ×100,
  GTA-1-points style; fines and fees are literal dollars.
- **Payphone missions** — they ring (green ☎ badges). Walk up, press E, the
  brief arrives on the pager. Four missions: the two ported from the desktop
  game (**Queen Street Errand** $150, **Wheels for The Cap** $250) plus
  **Downtown Burner** ($400, *timed*: 80 s to steal a car and cross downtown)
  and **George Street Drop** ($300, on foot). Failed missions ring again.
- **Police** scale with your stars (up to 4 pursuit cars, flashing
  lightbars). They ram. Sit stopped next to one for 3 s in a car — or let
  one hold you for 2 s on foot — and you're **BUSTED**: full-screen stamp,
  $1,000 fine, multiplier halved, car impounded. Wanted decays when no cop
  is close.
- **Queen St Respray** (blue S badge): drive in hot and it costs
  $500 × stars, clears your heat and repaints the car.
- **Pedestrians** stroll the sidewalks, flee fast cars, and go down for
  +$100 ×multiplier (and a star — monster).
- **Damage & lives**: hard hits wreck cars (you're ejected) and hurt you;
  health 0 = **WASTED** (hospital fee $500, lose a life). 5 lives ♥,
  then GAME OVER. Car theft is +$500 ×multiplier and a star.
- Freeroam crime pays petty cash; missions are how you actually progress —
  just like 1997.

## Rendering

- **Sprites, not dots.** Player, cars, cops and peds are drawn from
  generated sprite canvases (car = body + roof + windshield + headlights,
  ~4.4 × 1.9 m; person ~0.6 m with a direction cue; police get a flashing
  lightbar) on a canvas overlay synced to the map — see ARCHITECTURE.md
  for why this replaced the v0 GeoJSON approach.
- **Bright GTA-1 palette**: green ground, light asphalt with dark casing
  and dashed centrelines, saturated buildings with dark outlines and
  inset roofs faking height. Camera is north-up, follows with velocity
  lookahead, and **zooms out as your speed rises**.
- Downtown dataset (`public/data/downtown.json`, ~0.5 MB): **1,225 GeoNB
  buildings** with LiDAR heights and **219 roads** with names, lanes,
  speed limits and traffic-flow direction. Full-city context from
  `public/fredericton.pmtiles` (7.7 MB, the maps-of-nb bake).
- HUD is game chrome, not a panel: slim top strip (score, multiplier,
  lives, stars, speed), a pager that only appears when it has something
  to say, transient toasts, full-screen BUSTED/WASTED stamps, and a
  one-line corner credit.

## Tests & build

```sh
npm test           # build + dist output checks + unit tests
npm run test:unit  # vitest: geo, missions, world, game systems
npm run build      # tsc + vite build -> dist/
npm run preview    # serve the production build locally
```

Unit tests cover the geo conversion (against the desktop game's own
constants: `mvtGridToLngLat(0, ~27)` lands on Queen St beside City Hall),
the mission state machine incl. the timed failure path, multiplier
application, the BUSTED penalty, respray cost/heat, and the district
goal trigger. v0.21 adds **scripted drive-metrics tests** (top speed,
0–100, turn slip/radius, handbrake behaviour, coast/brake, pivot —
`src/core/physics.test.ts`, table in tools/drive-metrics.md) and
**junction-routing tests** (a traffic car simulated for 120 s crosses
onto other road segments; dead ends U-turn).

## Data pipeline

```sh
python3 tools/build_downtown.py   # re-pull GeoNB -> public/data/downtown.json
```

Stdlib-only; queries GeoNB's public ArcGIS services in a 3×3 grid.
`fredericton.pmtiles` is copied from the maps-of-nb repo
(`web/public/fredericton.pmtiles`).

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
src/render/maplibre/ Route A adapter (MapLibre statics + sprite overlay)
src/render/canvas/   Route C adapter (same sprites, plain Canvas 2D)
src/render/sprites.ts generated top-down sprites shared by both adapters
src/render/groundwork.ts pavement geometry + skid tracks (both adapters)
src/platform/        haptics (Vibration API) — platform layer, not core
src/main.ts          boot, input (keyboard/touch/gamepad), HUD wiring
public/data/         downtown.json (GeoNB extract)
public/              fredericton.pmtiles (full-city context, from maps-of-nb)
tools/               build_downtown.py — the GeoNB data pull
```
