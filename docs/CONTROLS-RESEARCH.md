# Controls research — v0.31 UX revamp

Why this exists: Daniel's verdict on v0.30 — *"It's still too hard to
steer… The little thumb drive isn't working for me, and frankly the
buttons still overlap and I can't easily press them in game. We need a
UX revamp."* He explicitly asked for (a) a survey of state-of-the-art
mobile driving-game controls and (b) tilt steering, remembering a free
game from ~15 years ago where you steered by tilting the phone (that
era's default: early Asphalt / Real Racing tilt schemes).

Method: web survey of the current schemes shipped by the leading
mobile driving games + platform/UX guidance, October 2026. Sources
are cited per claim; "adopt / reject" decisions at the end drive the
v0.31 build.

## What the top games actually ship

| Game | Steering schemes | Default | Auto-accelerate? | Customization |
|---|---|---|---|---|
| **Asphalt Legends Unite** (Gameloft) | Tilt to Steer, Tap to Steer (left/right screen taps), **TouchDrive** (auto-steer; player swipes to pick routes/stunts) | TouchDrive for casual play | Yes under TouchDrive | Scheme choice; no full layout editor |
| **Real Racing 3** (EA/Firemonkeys) | **Tilt A / B / C** (B adds tilt-controlled throttle), on-screen **Wheel**, buttons | Tilt | Yes in most schemes (brake is a tap) | **Steering sensitivity slider 0–10**, steering/brake/traction assists |
| **GRID Autosport** (Feral) | **Tilt** (hold right side = accelerate, left side = brake), Tilt Pro, **Wheel Touch** (a wheel appears where you hold on the left), Arrow Touch, gamepad | Tilt | No — hold-to-accelerate zones | "Customise Controls" fine-tuning saved as a *(Custom)* variant per scheme; **Mirrored Mode** flips the sides |
| **CarX Street / CarX Drift Racing 2** (CarX Tech) | Buttons, accelerometer (tilt), virtual steering wheel | Buttons | No | **Full editor: size, position, transparency, sensitivity of every control** |
| **GTA: San Andreas — mobile** (Rockstar) | Driving: analog stick, buttons, **flick/tilt**; on foot: floating virtual stick | Analog | No | Button **resize + reposition** editor; **contextual buttons** (e.g. sprint becomes the accelerator in a car); generous auto-aim on foot |
| **Mario Kart Tour** (Nintendo) | Slide-to-steer or **gyro**, portrait one-hand play | Slide | **Yes, always** (plus optional smart-steering assist with adjustable intensity) | Minimal — assist toggles |
| **Horizon Chase** (Aquiris) | On-screen buttons or stick; gamepad | Buttons | Optional | Fully customizable button layout |

Sources: Asphalt Legends Unite control schemes & TouchDrive —
[Wikipedia](https://en.wikipedia.org/wiki/Asphalt_Legends_Unite),
[Gamesense](https://c.gamesense.co/game/asphalt-legends-unite/).
Real Racing 3 tilt family, first-run calibration, auto-accelerate,
sensitivity — [Gamezebo walkthrough](https://www.gamezebo.com/walkthroughs/real-racing-3-walkthrough/),
[Android Police review (2013)](http://www.androidpolice.com/2013/03/06/real-racing-3-review-there-is-a-good-game-in-here-somewhere/),
[RR3 community settings thread](https://rr3.fandom.com/f/p/4400000000000068532/r/4400000000000204841).
GRID Autosport schemes, hold-side pedals, Customise Controls, Mirrored
Mode — [Feral Interactive FAQ](https://www.feralinteractive.com/en/faqs/gridautosport/latest/ios/).
CarX three schemes + editor —
[Uptodown](https://carx-street.en.uptodown.com/android),
[CarX Drift Racing 2 guide](https://kanmomssuanco.weebly.com/uploads/1/4/8/6/148685141/download-game-carx-drift-racing-2-mod-apk.pdf).
GTA SA mobile schemes, floating stick, contextual buttons, editor —
[APKPrime DE guide](https://apkprime.org/gta-san-andreas-definitive/),
[APKPrime](https://apkprime.org/gta-san-andreas/).
Mario Kart Tour gyro/slide, auto-accelerate —
[MarioWiki](https://www.mariowiki.com/Special:MobileLanguages/Mario_Kart_Tour).
Horizon Chase customizable buttons —
[JVGS review](https://www.jvgs.net/blog/2023/07/11/horizon-chase-turbo-review/).

## Cross-cutting patterns

1. **Tilt is always offered, never the only option.** Every surveyed
   game ships tilt *alongside* at least one touch scheme and lets you
   switch mid-game from settings/pause. Nobody ships tilt-only.
2. **Tilt is a first-class default in the sim-leaning titles**
   (RR3, GRID) — both open on tilt, and RR3 opens with a **calibration
   ritual**: "rotate your device so the game knows how to offset your
   controls" before the first race.
3. **Auto-accelerate is the casual-scheme norm** (RR3 most schemes,
   Mario Kart Tour always, Asphalt TouchDrive). It exists to cut the
   simultaneous-input load: steer + brake is all the player manages.
4. **Calibration = capture the player's actual neutral pose.**
   Motion-sensitivity guidance is consistent: sample the resting
   pose, average it, subtract it as the baseline; offer a manual
   re-zero for when posture changes
   ([baseline-capture pattern](https://app.studyraid.com/en/read/14983/517430/calibrating-motion-sensitivity),
   [runtime "Calibrate at Rest" flow](https://docs.visualpinball.org/developer-guide/accelerometer-input-design.html)).
   Auto-calibration with no manual override is a known failure mode
   ([Game Developer, accelerometer usability](https://www.gamedeveloper.com/design/the-usability-of-accelerometer-controls-on-ios)).
5. **Full lock at a modest roll.** Practical guides converge on
   reaching maximum lock at ~30–35° of wrist rotation ("never turn
   the device completely sideways"), with sensitivity kept moderate
   so tremor doesn't become steering
   ([Velocity Unleashed tilt guide](https://www.velocityunleashed.ca/blog/touch-and-tilt-controls-guide)).
6. **A small dead zone + smoothing, not a big gate.** ~5° (or
   5–8 % of range) dead zone and a low-pass filter (α ≈ 0.1–0.3)
   over raw samples are the standard recipe; oversized dead zones
   with hard cut-ins are the classic complaint
   ([accelerometer smoothing guide](https://copyprogramming.com/howto/accelerometer-based-games-smoothness),
   [dead-zone practice](https://nztpoker.com/tilt-control-tips/)).
7. **Sensitivity is a user setting.** RR3 exposes 0–10, CarX exposes
   per-control sliders. One fixed sensitivity fits nobody.
8. **Buttons are contextual.** GTA SA's right cluster changes with
   state (sprint on foot becomes accelerator in a car). Buttons that
   can't act in the current state are how clusters got crowded here:
   v0.30 shows GAS/BRK/DRIFT *and* FIRE/WPN/E at once.
9. **Touch targets: platform floors are 44 pt (Apple HIG) / 48 dp
   (Material, with ≥8 dp spacing); games go bigger** — pedals and
   primary actions in the surveyed games are large corner-anchored
   zones, not 48 px chips
   ([Miquido standards roundup](https://www.miquido.com/blog/app-accessibility-in-mobile-development-design/),
   [touch-target spec](https://github.com/aklodhi98/humanstandards/blob/HEAD/src/content/docs/code-design-tokens/touch-targets-spacing.md)).
10. **Layout editors are the high end** (CarX, GTA SA). Powerful, but
    a big build; a fixed layout that is *provably* non-overlapping at
    phone sizes is the prerequisite either way.
11. **The floating stick already matches the field** — GTA SA's stick
    "appears wherever you place your thumb", same as our v0.21+
    dynamic origin. The stick wasn't the anomaly; Daniel's hands are
    the spec, and for him it still fails — hence tilt as a peer
    scheme, not a patch on the stick.
12. **An on-screen wheel that mirrors input is standard feedback**
    (RR3's wheel recentres on release; GRID's Wheel Touch). Under
    tilt there is no thumb on the wheel, so the wheel must mirror
    the *sensor* — the player needs to see their steer value.

## Web-platform facts for tilt (DeviceOrientation)

- `gamma` is the left–right axis (−90…90°); in portrait it is the
  roll a steering tilt produces. `beta` is front–back. Steering maps
  from **gamma** ([MDN: DeviceOrientationEvent](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent)).
- iOS 13+ requires `DeviceOrientationEvent.requestPermission()`,
  called **from a user gesture**; it resolves `"granted"`/`"denied"`.
  Android Chrome on HTTPS generally delivers events with no prompt.
  Secure context (HTTPS) is required
  ([MDN: Detecting device orientation](https://developer.mozilla.org/en-US/docs/Web/API/Detecting_device_orientation?ref=blairmacintyre.me),
  [W3C spec](https://www.w3.org/TR/2023/WD-orientation-event-20231110/)).
- Browsers may fire the event with all-null angles when no sensor
  exists (desktop) — availability must be detected from *actual
  non-null samples*, not from the API's presence.

## Decisions for v0.31 (adopt / reject)

| Pattern | Decision | Why |
|---|---|---|
| Tilt steering scheme (gamma, portrait) | **ADOPT** — new peer scheme `tilt` | Daniel's explicit ask; the field's sim titles lead with it |
| Neutral captured on enable + **Calibrate tilt** button | **ADOPT** | RR3 ritual + every calibration guide; auto-only calibration is the known failure mode |
| Full lock ±30° standard; sensitivity Low/Standard/High = 38°/30°/22° | **ADOPT** | ~35° max-lock guidance; sensitivity-as-setting (RR3/CarX) in a 3-step form |
| Dead zone 2° + EMA smoothing (α 0.35) on gamma | **ADOPT** | Small-gate + low-pass recipe; ~2° at a 30° range ≈ the 5–8 % guidance, kept fine because the shared merge curve (below) softens centre response |
| Response curve owned by the existing merge (`shapeSteer` \|s\|^0.7) | **ADOPT** | Tilt emits a normalized linear deflection like keyboard/stick already do; one curve owner = identical feel pipeline, zero risk to the v0.27 stick behaviour or drive metrics |
| Wheel visual mirrors tilt steer (±135°) | **ADOPT** | Pattern 12; the player must see sensor input |
| Auto-accelerate | **REJECT** | Reverse-at-a-stop via BRK is core GTA-style play here (v0.29); auto-accel schemes are also brake-only, which deletes reverse. Pedals stay manual |
| Contextual clusters (car: GAS/BRK/DRIFT/E · foot: FIRE/WPN/E) | **ADOPT** | GTA SA pattern; directly answers the overlap complaint |
| Targets ≥56 px, pedals 76 px wide, gaps ≥12 px, corner anchors + safe-area insets, dim at rest / solid when pressed | **ADOPT** | Platform floors are 44/48; games go bigger; 56+ is the floor for *this* game's primary controls |
| Mechanical layout audit (both phone sizes × both states) shipped as `tools/layout-audit.mjs` | **ADOPT** | "Provably non-overlapping" beats another round of eyeballing |
| Full button position/size editor (CarX/GTA style) | **REJECT (for now)** | Scope; a fixed audited layout is the prerequisite. Noted as the known next step if fixed positions still fight Daniel's hands |
| Mirrored (left-handed) mode (GRID) | **REJECT (for now)** | No request for it; tilt makes the steering side moot |
| Tilt on foot | **REJECT** | No surveyed game tilts the walker; on foot the stick/drag still moves the player under the tilt scheme (GTA SA keeps its stick on foot under every driving scheme) |
| In-car FIRE button | **REJECT** | No drive-by firing exists in this game (GTA 1 rules, v0.30); an in-car FIRE would be a dead button — the exact thing being fixed |
