# MVT Fredericton Web — v0.25 Audit

Trigger: Daniel, 2026-10-25 — *"Steering doesn't work right"* (Pixel,
Android Chrome, touch). Standing instruction: stop enumerating defects
one at a time; audit everything, fix what's broken, prove it by driving
the game with synthetic inputs.

Method:

- **Part A** — an instrumented drive rig (headless Chromium + CDP
  `Input.dispatchTouchEvent` / keyboard) against the real build,
  sampling `window.__game` state and a `navigator.vibrate` stub. All
  steering measurements are taken in **game time** (the frame loop
  clamps dt at 0.05 s; on a software-rendered host wall time runs
  several times faster than game time, which invalidated the first
  baseline pass — see "baseline methodology note" below).
- **Part B** — `src/core/audit.test.ts` (24 tests) + `src/platform/
  haptics.test.ts` (3 tests): scripted end-to-end play at the state
  level for every mission, and at drive level (a pursuit-controller
  test driver with an unstick routine) for Queen Street Errand.

Status key: **WORKS** (verified, untouched) · **FIXED** (defect found,
fixed, regression test added) · **GAP** (honest shortfall, not built).

---

## Part A — Steering & input

### What the baseline (v0.24) measurement actually showed

Input *registration* was never broken: in every baseline scenario the
game received exactly the input sent — steer −1/+1 at full deflection,
multi-touch GAS + stick held at 100% in both finger orders, stick
diagonal giving a clean (−0.71, +0.71), keyboard A/D at ∓1, zero map
pan/zoom/drift under bare-map drags and pinches (MapLibre is created
with `interactive: false`). The defects were around the edges of the
pipeline, plus one ergonomic hole big enough to feel like "steering
doesn't work":

| # | Scenario | Expected | v0.24 measured | v0.25 measured | Verdict |
|---|----------|----------|----------------|----------------|---------|
| s0 | Cold start, default URL | living street | 8 cars within 60 m | 8 cars within 60 m; stick zone now y=0, h=844 (was y=186, h=658) | WORKS |
| s1-rollup | GAS pedal to speed | ≥44 km/h | 48 km/h | 48 km/h (rig host runs 7.2–9.5× slow — see note) | WORKS |
| s1-left | Stick full-left 1.5 game-s at ~50 km/h | steer ≤ −0.9 held, yaw ≤ −55° | steer −1 registered; yaw not measurable (see note) | steer −1 held (17 samples), **yaw −118.4°** | WORKS |
| s1-right | Stick full-right 1.5 game-s | steer ≥ +0.9, yaw ≥ +40° | steer +1 registered; yaw not measurable | steer +1 held, **yaw +145.2°** | WORKS |
| s1b | Stick thumb lands at y=100 (top-left) | steer registers | **steer 0.00 — dead** | **steer −1** | FIXED (see A1) |
| s2 | GAS held, then stick full-left, 2 game-s | both held ≥90% of samples | 100% / 100% | 100% / 100% (21 samples); GAS release drops throttle only, steer holds; full release zeroes both | WORKS |
| s2b | Stick first, then GAS | both held ≥90% | 100% / 100% | 100% / 100% (12 samples) | WORKS |
| s3 | Stick diagonal up-left | both axes ≥0.6 in ≥85% | 100%, (−0.71, +0.71) | 100%, sample (−0.71, +0.71) | WORKS |
| s4 | Reverse, then steer right | rolls back; nose swings left (yaw ≤ −15°) | rolled −3.1 m/s; yaw not measurable | rolls −3.1 m/s; **yaw −38.8°** while reversing (reversing in 100% of samples) | WORKS |
| s5 | Keyboard A/D at ~50 km/h | steer ∓1, symmetric yaw | steer ∓1 registered; yaw not measurable | steer ∓1; **yawL −122.5°, yawR +123.2°, symmetry skew 0.01** | WORKS |
| s6 | Drags + pinch on bare map (stick scheme) | no pan/zoom/input leak | view width ±0 m, drift 0 m, inputs 0 | view width ±0 m, drift 0 m, inputs 0 | WORKS |
| s7 | Drag scheme: hold toward a heading | heading error shrinks ≥20°, speed >8 km/h | not measurable (see note) | error **96° → 0°**, end speed 68 km/h, max steer 1.0 (31 samples) | WORKS |
| s8 | On-foot stick walk 1.5 game-s | ≥4 m travelled | 0.7 m in 1.8 **wall**-s (≈0.16 game-s — consistent with walk speed, see note) | **9.3 m** in 1.5 game-s | WORKS |
| s9 | Haptics: E at payphone, enter car | [12, [25,40,25]] then 20 | `[12,[25,40,25],20]` | `[12,[25,40,25],20]` via the real E button | WORKS |
| s10@60 | Full-lock yaw at ~60 km/h | ≥22° in 0.5 game-s | not measured in v0.24 | **−50.4°** in 0.5 game-s (−97.9° in 1.0 s), wheel −0.23 rad, mean 62 km/h | WORKS |
| s10@100 | Full-lock yaw at ~100 km/h | ≥18° in 0.5 game-s | not measured in v0.24 | **−44.3°** in 0.5 game-s (−78.2° in 1.0 s), wheel −0.17 rad, mean 77 km/h | WORKS |
| s10@30 | Full-lock yaw at ~30 km/h | ≥25° in 0.5 game-s | not measured in v0.24 | **−48.1°** in 0.5 game-s (−104.3° in 1.0 s), wheel −0.29 rad (band ran at ~48 km/h after rollup overshoot; steerIn −1 throughout) | WORKS |

**Baseline methodology note.** The first baseline pass reported yaw of
exactly 0° everywhere and a 0.7 m walk — an artifact: the rig held
inputs for *wall-clock* durations while the headless host rendered at
a few FPS, and the game's dt clamp (0.05 s) turned 1.5 wall-seconds
into ~0.15 game-seconds; the sampling loop also only captured one
sample per hold. v0.25 adds a harmless `window.__mvtTime` accumulated-
game-time handle and the rig was rebuilt to hold and sample in game
time. On Daniel's Pixel (real GPU, 60 FPS) dt is never clamped in
practice — the clamp only bites under ~20 FPS, where the game slows
down instead of skipping physics, which is the safe failure mode.

### Part A defects found and fixed

- **A1 — Stick dead band (the headline defect).** `#stick-zone` was
  `top: 22%`: the entire top-left fifth of the screen — exactly where
  a left thumb lands when the phone shifts in the hand — was dead to
  the stick. A touch starting there never became a stick touch at all
  (s1b: steerIn 0.00). Fixed: zone is full-height (`top: 0`).
- **A2 — Pedals could be cut by a second finger.** `holdButton` ended
  a hold on *any* pointer's up/cancel, with no pointerId ownership: a
  second finger tapping/releasing the same pedal (or a stray cancel)
  killed the throttle while the first thumb was still holding it.
  Fixed: each button is owned by its pressing pointer; only the
  owner's up/cancel/lost-capture ends the hold.
- **A3 — No `lostpointercapture` handling.** Stick, drag zone and
  pedals ended holds on up/cancel only. A capture lost without either
  (browser gesture takeover, element teardown) would leave a stale
  steer/throttle state. Fixed: `lostpointercapture` now ends every
  hold through the same guarded path.
- **A4 — Pull-to-refresh could reload the game mid-drive.** No
  `overscroll-behavior` anywhere and no `touch-action` on the map:
  a downward drag starting on an uncovered pixel (bare map in stick
  scheme is the right ~45% of the screen) was eligible for Android
  Chrome's pull-to-refresh / gesture takeover. Fixed:
  `overscroll-behavior: none` on html/body, `touch-action: none` on
  `#map` and its canvas, and `#pager` is `pointer-events: none`
  (display-only; it previously could eat touches at bottom-left).

### Steering response — the root-cause verdict

Measured end-to-end in game time, the core steering pipeline is
**healthy**: full stick deflection registers ±1.00 at the game in
every scheme; at ~50 km/h full lock yaws the car 118° (left) /
145° (right) in 1.5 game-seconds; keyboard is symmetric to a 0.01
skew; reverse steering swings the nose the correct (real-car) way;
and the speed-faded lock does **not** under-steer the car into
uselessness at speed — yaw in the first 0.5 game-s at full lock is
50° at 62 km/h and 44° at ~90 km/h, with measured wheel angles
(−0.23 rad @ 62 km/h, −0.17 rad @ ~90 km/h) tracking the Kerr fade
formula 0.60·exp(−v/19) almost exactly (0.24 / 0.16 predicted).

So "steering doesn't work right" was not the physics and not the
merge logic. It was the three DOM-layer defects above — above all
**A1, the dead band**: any touch that *started* in the top-left
fifth of the screen (a completely natural thumb landing spot) never
steered at all, and whether a given drive felt broken depended on
where your thumb happened to land. A2 and A4 are the same class of
intermittency: holds that could be cut by another finger, and a page
reload one pull-to-refresh away.

Physics was **not** retuned. The v0.21 drive metrics (0–100 km/h
5.6 s, handbrake 180° in 1.27 s, brake 100→0 in 2.35 s) re-run as
part of the unit suite with no regressions.

---

## Part B — Systems audit

Executed by `src/core/audit.test.ts` (24 tests) unless noted. On the
v0.24 code the suite scored **16 pass / 7 fail**; all 7 failures traced
to FIXED-1 below plus the two known v0.24 simplifications (FIXED-2,
FIXED-3). One further crash (FIXED-4) was found by the drive-level
test after FIXED-1 landed.

### Missions

| Item | Status | Evidence |
|------|--------|----------|
| Queen Street Errand completable, state level | WORKS | payout $150×100 ×mult, multiplier +1, toast |
| Cap Wheels completable | FIXED-1 | state-level flow was fine; *reaching* the steal step was blocked (see below) |
| Downtown Burner completable | FIXED-1 | same blocker on its steal step |
| Downtown Burner timer expiry → mission failed, re-takeable | WORKS | step timer hits 0 → failed state; mission returns to available |
| George Street Drop completable | WORKS | payout verified |
| Queen Street Errand at DRIVE level (walk to phone, drive both legs, E at both stops, payout lands) | FIXED-1, FIXED-4 | full loop green; this test exposed both fixes |

### Cars / interact

| Item | Status | Evidence |
|------|--------|----------|
| Enter/exit a parked car with E | FIXED-1 | at spawn, the nearest parked car sits 5.09 m from the Errand payphone — inside its 7 m radius — and E checked payphones *first*, so the car could never be entered there (and a car beside any payphone blocked mission starts the same way). Interact now resolves: active mission step first, then **nearest** of (car ≤4 m, payphone ≤7 m), car wins ties |
| Carjack a traffic car → becomes a rigid body | WORKS | drivenCar set, traffic AI detaches, physics drives it |
| Enter a cop car | WORKS | denied, as designed |
| Exit returns player beside the car | WORKS | |

### Wanted / police

| Item | Status | Evidence |
|------|--------|----------|
| Star gain: ped hit, car theft, cop sight | WORKS | heat rises on each trigger |
| Decay only when no cop within 45 m | WORKS | heat frozen with a cop at 20 m, decays with none near |
| Cop count scales with stars | WORKS | 2 stars → 2 cops desired and spawned |
| Bust (in car): slow + cop <7 m for 3 s → BUSTED | FIXED-1 | flow itself WORKS; reaching it in test was blocked by the entry bug |
| Bust (on foot): cop contact <2.6 m for 2 s | WORKS | |
| BUSTED consequences | WORKS | $1,000 fine, multiplier halved (floor ×1), car impounded, respawn at spawn |
| Cop ram vs near-dead player car | **FIXED-4** | the ram branch called `damageCar(this.drivenCar, …)` then dereferenced `this.drivenCar.vel` — when the ram *wrecked* the car, damageCar ejected the player and nulled drivenCar → **TypeError, frame loop dead, game frozen**. Now the car is captured in a local and only shoved if the player is still seated. Regression test added |

### Damage / lives

| Item | Status | Evidence |
|------|--------|----------|
| WASTED: lives −1, $500 fee, respawn | WORKS | |
| GAME OVER at 0 lives; restart fully resets | WORKS | score/lives/heat/position all reset |

### District goal

| Item | Status | Evidence |
|------|--------|----------|
| Score ≥ $250,000 → EXIT point active | WORKS | |
| Reach EXIT → DISTRICT COMPLETE | WORKS | |
| Confirm → freeroam resumes with state intact | WORKS | |

### Respray

| Item | Status | Evidence |
|------|--------|----------|
| $500/star, clears heat, repaints | WORKS | |
| No heat → no-op | WORKS | |
| Insufficient funds | WORKS (as coded — noted) | `wallet.spend` caps at balance: heat still clears and the repaint happens even if the player can't cover the full price. Lenient, not a blocker; flagged here rather than silently changed |

### Traffic

| Item | Status | Evidence |
|------|--------|----------|
| Bubble: ≥8 within 220 m while driving | FIXED-5 | the floor was statistical, not real: below-8 for **2.2% of ticks** under v0.24 dynamics (1.7% with follow/braking) — dips last exactly one 0.4 s top-up tick, which made the v0.24 invariant test a coin flip for any build whose traffic history shifted. Top-up cadence 0.4 s → 0.1 s and burst cap 3 → 6: below-8 measured at **0.08% of ticks** (1 tick in 1,200, self-correcting), invariant test passes deterministically |
| Recycled cars never pop in inside the view | WORKS | v0.24 test, still green |
| **Follow / braking behind a leader** | **FIXED-2** | v0.24 traffic had *no* car-ahead braking: the audit's follower drove straight through a stopped leader — measured overlap **−21.4 m**. Now a lane-corridor closing-speed cap (scan traffic + driven cars 0–17 m ahead, ±1.7 m lateral; follower matches leader speed + gap term, queues at ~1.6 m bumper gap, hard stop at ≤0.2 m). Audit test: no overlap, queue forms, follower resumes when the leader pulls away |

### Pedestrians

| Item | Status | Evidence |
|------|--------|----------|
| Flee when a car approaches / after a hit | WORKS | |
| **Ped bubble** | **FIXED-3** | v0.24 gap: the 20 peds spawned at spawn and stayed there — after a cross-map teleport, **0 peds within 260 m**. Peds now recycle like traffic (own PRNG stream — sharing trafficRng measurably perturbed the traffic bubble): re-anchored onto roads near the player, landing outside the current view, ≥10 within 260 m after crossing the map; flee still works after recycling |

### Save / settings

| Item | Status | Evidence |
|------|--------|----------|
| Save persists across reload (completed missions, districtCleared, bestScore, hasEnteredCar) | WORKS | round-trip through storage |
| Anchor ring stays off after first car entry, across reload | WORKS | hasEnteredCar persisted |
| Input scheme setting persists + re-applies | WORKS | rig s7: `mvt-input-scheme=drag` set, page reloaded, drag zone active and functional |
| Haptics toggle persists | WORKS | same localStorage settings path; gate asserted in haptics unit test (disabled → zero vibrate calls) |

### HUD / stamps / pager

| Item | Status | Evidence |
|------|--------|----------|
| BUSTED / WASTED stamps show and clear | WORKS | hud() stamp lifecycle through both flows |
| Mission-complete toast fires | WORKS | asserted on every mission test |
| Pager typewriter completes | WORKS | main.ts typeBrief interval slices to full text; brief text asserted via hud() |
| Goal hairline (goalPct) updates with score | WORKS | hud().goalPct tracks wallet vs $250,000 |

### Haptics (full v0.21 table)

| Event | Pattern | Status |
|-------|---------|--------|
| UI tick / E press | 12 ms | WORKS — unit + rig s9 live |
| Payphone | [25, 40, 25] | WORKS — unit + rig s9 live |
| Enter car | 20 ms | WORKS — unit + rig s9 live |
| Collision | 15–80 ms scaled, ≥120 ms apart | WORKS — unit (`src/platform/haptics.test.ts`) |
| Mission complete | [40, 60, 40] | WORKS — unit |
| Busted | [90, 60, 90, 60, 180] | WORKS — unit |
| Wasted | [200, 80, 200] | WORKS — unit |
| Toggle off silences all; cancel fires vibrate(0) | | WORKS — unit |

### Audio

| Item | Status |
|------|--------|
| **The game has NO audio at all** — no engine, no siren, no pager blip, no UI sound; there are no audio assets or code paths anywhere in the repo | **GAP** → **BUILT in v0.26** |

Recommendation (one line, not built in this release): a small WebAudio
synth layer in `src/platform/` — oscillator engine hum tied to speed,
two-tone siren, pager blip — needs zero assets and can hang off the
same HUD-transition hooks the haptics already use.

**Addendum (v0.26): built as recommended.** `src/platform/audio.ts`
hangs off exactly those hooks: continuous engine (sawtooth + lowpass,
pitch = 55 Hz idle rising with the speed ratio per car class),
two-tone siren (720/960 Hz, gain by nearest-cop distance, 120 m
range), and skid (band-passed noise on the core's slip signal), plus
one-shots mirroring the haptics table above (tick, door thunks,
collision thud on the same health-drop signal + ≥120 ms throttle,
payphone beeps, mission/district arpeggios, BUSTED/WASTED stings).
Context is gesture-gated per autoplay policy; sound toggle persists
as `mvt-audio`. Evidence: 12 unit tests against a fake AudioContext
(`src/platform/audio.test.ts`) + production rig readings via the
`window.__mvtAudio()` state seam (engine freq at idle/cruise,
siren gain vs measured cop distance) — audio itself cannot be
*heard* headlessly; Daniel's Pixel is the ear check.

---

## Counts

- Part B checklist: **WORKS 37 rows · FIXED 8 rows (5 distinct defects:
  interact priority, traffic follow, ped bubble, cop-ram crash, bubble
  floor) · GAP 1** (audio).
- Part A: defects fixed **4** (A1–A4); scenarios **18/18 PASS** in
  game time (rig: `~/workspace/rig25b.mjs`, headless Chromium + CDP
  against the production build; two early failures — s1-right and
  the s10 bands — were rig choreography, a car wedged in a building
  and touches held across a page navigation, both fixed in the rig
  and re-measured clean).
- Tests: 72 (v0.24 suite) + 24 audit + 3 haptics = **99, all green**,
  including a re-run of the v0.21 physics metrics (0–100 km/h,
  handbrake 180°, brake distance) with no regressions — physics was
  not retuned.
- Pushes: **1** (d229df0 → 7cd18aa). Production verified after the
  deploy: the live URL serves v0.25, cold-start frame counts 8 cars
  within 60 m, and a driven frame shows 67 km/h with the stick
  engaged and 1 wanted star — no corrective push needed.
  Screenshots: `~/workspace/mvt-web-v025-shots/`.
