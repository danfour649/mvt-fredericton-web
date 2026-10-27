# Drive metrics — v0.20 hack vs v0.21 rigid body

Measured by `src/core/physics.test.ts`: scripted, deterministic drive
tests (fixed dt = 1/60, synthetic inputs, empty world). Run
`npx vitest run src/core/physics.test.ts` to reproduce; the measured
table prints at the top of the test output.

The "before" column is the v0.20 model (velocity lerped toward the
nose, no angular velocity, no car classes) measured with the SAME
harness before the rewrite. Note its 0–100 km/h time: the old code
ramped an internal `speed` scalar quickly, but the actual velocity
only chased it through a blend — the car really took ~16.6 s.

| Metric | v0.20 (before) | v0.21 (after) | Target |
|---|---|---|---|
| Top speed, standard | 112 km/h | **113 km/h** | 110–120 |
| 0–100 km/h, standard | 16.65 s | **5.57 s** | ~4–6 s |
| Top speed, fast class | (no classes) | **143 km/h** | > standard |
| 0–100 km/h, fast class | — | **3.40 s** | < standard |
| Top speed, police class | — | **134 km/h** | > standard |
| 0–100 km/h, police class | — | **4.17 s** | < standard |
| Turn @50 km/h, full lock: slip | 10.7° | **9.4°** | ≥8°, no spin |
| Turn @50 km/h: radius | ~5 m | **7 m** | 6–40 m |
| Turn @100 km/h: slip | 8.5° | **11.3°** | no spin |
| Turn @100 km/h: radius | ~14 m | **21 m** | 2.5–4× the 50 km/h radius (got 3.0×) |
| Handbrake @80: peak slip | 88° | **149°** | ≥35° |
| Handbrake @80: time to rotate 180° | never (slid sideways) | **1.27 s** | ≤2.5 s |
| Handbrake @80: speed shed by 180° | — | **67%** | ≥50% |
| Handbrake: slip after release | 0.0° | **0.0°** (extra spin 0°) | recovers, no perpetual spin |
| Coast 100→0 km/h | >14 s (never stopped in window) | **8.55 s** | ~6–10 s |
| Brake 100→0 km/h | 5.98 s | **2.35 s** | ~2–2.5 s |
| Pivot from rest (light throttle, full lock, 2 s) | 66° yaw / 2.0 m | **77° yaw / 7.9 m** | yaws, stays local |

## Tuning passes

1. **Pass 1 (first rigid-body tune):** top 107 km/h, 0–100 8.85 s,
   turn slips 2.6°/1.2° (too grippy, velocity glued to nose), handbrake
   never completed 180°. Coast/brake/pivot already in range.
2. **Pass 2:** more engine force, lower linear grip → launch fixed
   (5.57 s) but steady-state slip fell to 0.3° and the handbrake car
   stalled at ~130° of rotation.
3. **Pass 3:** rear-grip deficit (oversteer bias) + handbrake lock-ups
   → handbrake nailed (180° in 1.32 s, 70% shed); turn slip 3.3° —
   still short.
4. **Pass 4:** tanh tyre-force saturation with low caps → car spun at
   both speeds (slip 56–97°). Caps were below the lateral demand of an
   ordinary turn.
5. **Pass 5:** caps raised, rear cap still lowest → 50 km/h slip
   11.6° ✓ but 100 km/h still spun (front torque > rear counter-torque
   once saturated).
6. **Pass 6 (final):** exponential speed-fade on steering lock; rear
   CAP raised above front (high-speed stability) while rear grip RATE
   stays lower (the tail needs more slip to build force = the visible
   slide at city speeds). All targets green.

## v0.29 addendum — reverse + wall slide (physics.test.ts, same harness)

The v0.21 metrics above are UNCHANGED by v0.29 (verified by re-run:
every figure identical — the slide only touches the building-contact
path and the reverse constants, neither of which the v0.21 scenarios
exercise). New measured behaviour, pinned by the v0.29 test blocks:

| Metric | v0.28 (before) | v0.29 (after) |
|---|---|---|
| Reverse top speed, standard | 28.2 km/h | **32.7 km/h** |
| Reverse 0→−25 km/h, full throttle | 3.23 s | **2.02 s** |
| Reverse top speed, half throttle | 22.3 km/h | **27.4 km/h** |
| Brake 50→0 holding BRK | 1.18 s | 1.18 s (then −15 km/h at 2.10 s) |
| Glance 13° off wall plane, speed 1 s after contact | ~0 km/h (dead stop) | **≥ pre-contact speed** (slides along the wall, engine pulling) |
| Oblique crash 24° off normal, speed 1 s after contact | 0 km/h | 0 km/h (head-ons still stop) |
| Nose-in head-on → reversed 1.9 m clear | 1.00 s | **0.85 s** |
| Nose-in 45°, wrong-lock reverse | slid 13 m along wall, ground to 0 km/h, still pinned | nose swings free ≤1.03 s phase-1, drives out |
| Two-wall corner pocket, reverse + either lock | NEVER freed (0.0 km/h, unmoved) | frees in 1.5 s / 3.5 s |

Root cause of the v0.28 wedge: the collision response multiplied the
whole velocity by 0.3 per 180 Hz substep on any building contact —
one frame of contact cost ~97% of speed and sustained contact while
reversing kept re-killing the escape velocity. v0.29 removes only the
into-wall velocity component (collideBuildingsN reports the contact
normal), applies time-scaled scrape friction (a flat per-hit factor
compounds at 180 Hz — that was the first fix attempt's own bug), and
swings the nose toward wall-parallel weighted by the glancing
fraction, so tyres stop fighting the surviving tangential velocity.
