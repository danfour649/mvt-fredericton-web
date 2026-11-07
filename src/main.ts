/**
 * Boot + wiring only: fetch the world data, build the core Game, pick a
 * renderer (Route A MapLibre by default; Route C canvas with
 * ?renderer=canvas), translate keyboard/touch input into core inputs,
 * and copy the core HUD state into the DOM each frame.
 *
 * All game logic is in src/core — this file only paints chrome:
 * score strip, pager, toasts, BUSTED/WASTED stamps, end overlays and
 * the touch controls.
 */
import './style.css';
import { loadWorld } from './core/world';
import { Game, DRIVE_HINT, type CarEntity } from './core/game';
import { CAR_CLASSES } from './core/physics';
import type { Renderer, RenderFrame, RenderMarker } from './core/renderer';
import { dist, type Vec2 } from './core/geo';
import type { Ped } from './core/peds';
import type { CopCar } from './core/cops';
import type { StorageAdapter } from './core/save';
import { MapLibreRenderer } from './render/maplibre/MapLibreRenderer';
import { CanvasRenderer } from './render/canvas/CanvasRenderer';
import { Haptics } from './platform/haptics';
import { GameAudio, stationForClass, STATIONS, type AudioStateSnapshot } from './platform/audio';
import { shapeSteer, stickDeflection } from './platform/stickMath';
import {
  TiltSensor,
  tiltConfigFor,
  TILT_DEFAULT_SENSITIVITY,
  type TiltEnableResult,
} from './platform/tilt';
import {
  resolveInitialScheme,
  SCHEME_MIGRATION_KEY,
  SCHEME_STORAGE_KEY,
  type Scheme,
} from './platform/scheme';
import {
  followCarInput,
  followWalkInput,
  screenToWorld,
  worldToScreen,
  isDoubleTap,
  nearestScreenHit,
  carTapIntent,
  planFollowPoints,
  RouteFollower,
  FOLLOW_STOP_TAP_M,
  FOLLOW_CAR_ENTER_M,
  FOLLOW_JOG_MIN_REMAINING_M,
  FOLLOW_JOG_MUL,
  FOLLOW_DRIFT_PULSE_MS,
  FOLLOW_EXIT_MAX_SPEED_MPS,
  type TapStamp,
} from './platform/followDrive';

/** First-drive hint for the FOLLOW scheme: gestures, not pedals. */
const FOLLOW_DRIVE_HINT =
  'Tap the street to drive there · tap behind the car to reverse · double-tap: stopped = get out · moving = handbrake';

const localStorageAdapter: StorageAdapter = {
  read: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* private mode etc. — game still runs, just doesn't persist */
    }
  },
};

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

const fmt = (n: number) => `$${n.toLocaleString('en-US')}`;

/**
 * v0.30 loading screen driver: the overlay is static HTML (paints
 * before this bundle); boot reports REAL progress into it — fetch
 * bytes against Content-Length, then the build steps — and the
 * frame loop dismisses it after the first rendered frame (with a
 * minimum display so the lockup actually reads). The inline script
 * in index.html carries a 20 s failsafe if boot never gets here.
 */
function setLoading(pct: number, note?: string): void {
  const bar = document.getElementById('load-bar-fill');
  if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`;
  const pctEl = document.getElementById('load-pct');
  if (pctEl) pctEl.textContent = `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`;
  if (note) {
    const n = document.getElementById('load-note');
    if (n) n.textContent = note;
  }
}

async function boot(): Promise<void> {
  const bootStart = performance.now();
  const container = el('map');
  const params = new URLSearchParams(window.location.search);
  const rendererParam = params.get('renderer');

  setLoading(0.06, 'CALLING THE CITY…');
  const res = await fetch(`${import.meta.env.BASE_URL}data/downtown.json`);
  if (!res.ok) throw new Error(`downtown.json: HTTP ${res.status}`);
  let worldJson: unknown;
  const declaredLen = Number(res.headers.get('Content-Length') ?? 0);
  if (res.body && declaredLen > 0) {
    // Stream the download so the bar tracks real bytes.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        got += value.length;
        setLoading(0.06 + 0.44 * Math.min(1, got / declaredLen), 'DOWNLOADING DOWNTOWN…');
      }
    }
    const all = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.length;
    }
    worldJson = JSON.parse(new TextDecoder().decode(all)) as unknown;
  } else {
    worldJson = await res.json();
    setLoading(0.5, 'DOWNLOADING DOWNTOWN…');
  }
  setLoading(0.62, 'PAVING THE STREETS…');
  const world = loadWorld(worldJson as Parameters<typeof loadWorld>[0]);

  setLoading(0.74, 'WAKING THE CITIZENS…');
  const game = new Game(world, localStorageAdapter);
  if (params.get('scenario') === 'demo') game.applyDemoScenario();
  // Screenshot/testing hook: harmless, exposes the running game.
  (window as unknown as { __game?: Game }).__game = game;

  const renderer: Renderer =
    rendererParam === 'canvas' ? new CanvasRenderer(container) : new MapLibreRenderer(container);
  el('renderer-name').textContent = renderer.name === 'canvas' ? 'Canvas 2D (Route C)' : 'MapLibre (Route A)';
  setLoading(0.9, 'ROLLING OUT THE MAP…');
  await renderer.init(world);

  // --- input ---------------------------------------------------------------
  // v0.21: three touch schemes (stick / drag-steer / legacy buttons) +
  // gamepad, all merged with the keyboard into the same core inputs.
  // Haptics fire from state transitions observed in the frame loop.
  const store = {
    get(k: string): string | null {
      try { return window.localStorage.getItem(k); } catch { return null; }
    },
    set(k: string, v: string): void {
      try { window.localStorage.setItem(k, v); } catch { /* ignore */ }
    },
  };
  // FOLLOW is the default now (iteration 2) — and because the
  // choice is persisted, a one-time versioned migration moves
  // existing players onto it; after that their settings pick
  // sticks. See platform/scheme.ts.
  const initialScheme = resolveInitialScheme(
    store.get(SCHEME_STORAGE_KEY),
    store.get(SCHEME_MIGRATION_KEY) !== null,
  );
  let scheme: Scheme = initialScheme.scheme;
  if (initialScheme.migrate) {
    store.set(SCHEME_STORAGE_KEY, scheme);
    store.set(SCHEME_MIGRATION_KEY, '1');
  }
  // Tilt steering (v0.31): gamma-roll steering as a peer scheme —
  // see platform/tilt.ts and docs/CONTROLS-RESEARCH.md. The sensor
  // is created idle; it only listens while the tilt scheme is live.
  const tiltSensor = new TiltSensor();
  let tiltSens = store.get('mvt-tilt-sens') ?? TILT_DEFAULT_SENSITIVITY;
  const tiltCfg = () => tiltConfigFor(tiltSens);
  (window as unknown as {
    __mvtTilt?: () => unknown;
  }).__mvtTilt = () => ({
    scheme,
    sensitivity: tiltSens,
    ...tiltSensor.snapshot(),
    steer: Math.round(tiltSensor.steer(tiltCfg()) * 1000) / 1000,
  });
  // Chrome toast: transient platform messages (tilt state, radio
  // station) that must not be clobbered by the per-frame HUD toast
  // write. Wins over hud.toast until it expires.
  let chromeToastText = '';
  let chromeToastUntil = 0;
  function chromeToast(msg: string, ms = 3500): void {
    chromeToastText = msg;
    chromeToastUntil = performance.now() + ms;
  }
  let hapticsOn = store.get('mvt-haptics') !== 'off';
  const haptics = new Haptics(() => hapticsOn);
  // Audio (v0.26): WebAudio synth layer, same shape as haptics — the
  // context stays uncreated until the first user gesture (autoplay
  // policy), and every event is inferred from state transitions in
  // the frame loop below.
  let audioOn = store.get('mvt-audio') !== 'off';
  const audio = new GameAudio(() => audioOn);
  (window as unknown as { __mvtAudio?: () => AudioStateSnapshot }).__mvtAudio = () => audio.state();
  const unlockAudio = (): void => audio.unlock();
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio);
  const interact = (): void => {
    haptics.tick();
    audio.tick();
    game.pressInteract();
  };

  // Boot cinematic: ANY input skips the descent (capture phase, so
  // the skip lands before the same tap can do anything else). The
  // skipping tap is marked and the follow handler ignores it — a
  // tap that ends the movie must not also plant a drive target.
  // The cinematic itself is armed when the loading overlay
  // dismisses (see the frame loop's boot block).
  const introSkippedEvents = new WeakSet<object>();
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (game.introRunning) {
        game.skipIntro();
        introSkippedEvents.add(e);
      }
    },
    { capture: true, passive: true },
  );
  window.addEventListener('keydown', () => {
    if (game.introRunning) game.skipIntro();
  });

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyE' && !e.repeat) interact();
    if (e.code === 'KeyR' && !e.repeat) game.pressRestart();
    if (e.code === 'KeyF' && !e.repeat) game.confirmFreeroam();
    // v0.30: Q cycles weapons (on foot; the core ignores it in a car).
    if (e.code === 'KeyQ' && !e.repeat) game.cycleWeapon();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const down = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);

  // v0.27 diagnostics: rolling pointer-event ring buffer, readable
  // via window.__mvtInputLog(). If driving still feels wrong on a
  // real device, one screenshot of the Input readout (below) plus
  // this log shows the ACTUAL input values instead of another round
  // of guessing. Move events are thinned (≥3 px or ≥100 ms per
  // pointer) so the buffer holds minutes, not seconds.
  interface InputLogEntry {
    t: number; type: string; id?: number; x?: number; y?: number;
    target?: string; dx?: number; dy?: number;
  }
  const inputLog: InputLogEntry[] = [];
  let lastStickLogged = { dx: 0, dy: 0 };
  const lastLoggedMove = new Map<number, { x: number; y: number; t: number }>();
  function logPointer(e: PointerEvent): void {
    const now = Math.round(performance.now());
    if (e.type === 'pointermove') {
      const last = lastLoggedMove.get(e.pointerId);
      if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 3 && now - last.t < 100) return;
      lastLoggedMove.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
    }
    const tgt = e.target as HTMLElement | null;
    inputLog.push({
      t: now, type: e.type, id: e.pointerId,
      x: Math.round(e.clientX), y: Math.round(e.clientY),
      target: tgt?.id || (typeof tgt?.className === 'string' ? tgt.className : '') || String(e.target),
    });
    if (inputLog.length > 400) inputLog.splice(0, inputLog.length - 400);
  }
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    window.addEventListener(t, logPointer as EventListener, { capture: true, passive: true });
  }
  (window as unknown as { __mvtInputLog?: () => InputLogEntry[] }).__mvtInputLog = () => inputLog.slice();

  // Analog stick (dynamic origin, left half of the screen).
  const stickZone = el('stick-zone');
  const stickBase = el('stick-base');
  const stickWheel = el('stick-wheel');
  const stick = { id: -1, ox: 0, oy: 0, dx: 0, dy: 0, active: false };
  let lastWheelDeg = 0;
  function setWheelDeg(deg: number): void {
    if (Math.abs(deg - lastWheelDeg) < 0.3) return;
    lastWheelDeg = deg;
    stickWheel.style.transform = `rotate(${deg.toFixed(1)}deg)`;
  }
  function stickVisual(): void {
    // v0.29: the stick IS a steering wheel — it rotates with the
    // (shaped) steer value, ±135° at full lock, and springs back to
    // centre with it. Same v0.27 math underneath; this is the skin.
    setWheelDeg(shapeSteer(stick.dx) * 135);
  }
  function tiltWheelVisual(): void {
    // v0.31: under tilt the wheel is a MIRROR of the sensor steer —
    // no thumb is on it, so it rotates from the tilt value (the
    // normalized deflection; the visible angle matches what the
    // merge will shape it to, same as the stick's display math).
    setWheelDeg(tiltSensor.steer(tiltCfg()) * 135);
  }
  function resetStick(): void {
    stick.id = -1;
    stick.active = false;
    stick.dx = 0;
    stick.dy = 0;
    stickBase.classList.remove('active');
    stickBase.style.left = '';
    stickBase.style.top = '';
    stickBase.style.bottom = '';
    stickVisual();
  }
  stickZone.addEventListener('pointerdown', (e) => {
    if (stick.id !== -1) return;
    // v0.31: driving under tilt — the sensors own steering and the
    // left side must not fight them (CSS also drops pointer events
    // on the zone in this state; this is the same rule in code).
    if (scheme === 'tilt' && game.drivenCar) return;
    // v0.29: a touch that starts on a control button is the button's,
    // never the stick's (the buttons live in a sibling subtree, so
    // this is belt-and-braces — but the wheel must never spawn under
    // a button press).
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    stick.id = e.pointerId;
    stick.ox = e.clientX;
    stick.oy = e.clientY;
    stick.dx = 0;
    stick.dy = 0;
    stick.active = true;
    stickZone.setPointerCapture(e.pointerId);
    stickBase.style.left = `${e.clientX - 59}px`;
    stickBase.style.top = `${e.clientY - 59}px`;
    stickBase.style.bottom = 'auto';
    stickBase.classList.add('active');
    stickVisual();
  });
  stickZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stick.id) return;
    // v0.27: shared stick math (R=32, deadzone 0.04, origin chase) —
    // see platform/stickMath.ts for why: a real thumb ROLLS ~24 px,
    // and the old R=48 linear map turned that into half a wheel.
    const d = stickDeflection(stick.ox, stick.oy, e.clientX, e.clientY);
    if (d.ox !== stick.ox || d.oy !== stick.oy) {
      stick.ox = d.ox;
      stick.oy = d.oy;
      stickBase.style.left = `${stick.ox - 59}px`;
      stickBase.style.top = `${stick.oy - 59}px`;
    }
    stick.dx = d.dx;
    stick.dy = d.dy;
    if (Math.abs(d.dx - lastStickLogged.dx) >= 0.03 || Math.abs(d.dy - lastStickLogged.dy) >= 0.03) {
      lastStickLogged = { dx: d.dx, dy: d.dy };
      inputLog.push({ t: Math.round(performance.now()), type: 'stick', dx: Math.round(d.dx * 100) / 100, dy: Math.round(d.dy * 100) / 100 });
      if (inputLog.length > 400) inputLog.splice(0, inputLog.length - 400);
    }
    stickVisual();
  });
  const stickEnd = (e: PointerEvent): void => {
    if (e.pointerId !== stick.id) return;
    resetStick();
  };
  stickZone.addEventListener('pointerup', stickEnd);
  stickZone.addEventListener('pointercancel', stickEnd);
  // v0.25: if capture is lost without an up/cancel (browser gesture
  // takeover, element teardown), end the stick too — a stale dx would
  // otherwise steer forever, or the stick would silently stay dead.
  stickZone.addEventListener('lostpointercapture', stickEnd);

  // Drag-steer: hold anywhere; the car steers toward the thumb's
  // position relative to screen centre (where the car sits).
  const dragZone = el('drag-zone');
  const drag = { id: -1, x: 0, y: 0, active: false };
  dragZone.addEventListener('pointerdown', (e) => {
    if (drag.id !== -1) return;
    drag.id = e.pointerId;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.active = true;
    dragZone.setPointerCapture(e.pointerId);
  });
  dragZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  const dragEnd = (e: PointerEvent): void => {
    if (e.pointerId !== drag.id) return;
    drag.id = -1;
    drag.active = false;
  };
  dragZone.addEventListener('pointerup', dragEnd);
  dragZone.addEventListener('pointercancel', dragEnd);
  dragZone.addEventListener('lostpointercapture', dragEnd);

  // Follow scheme: tap-to-drive, and (iteration 2) the ONLY control
  // surface — no clusters render in this scheme, so taps carry every
  // action: walk/drive targets, car entry, payphones, shooting, the
  // handbrake and the exit, all disambiguated by WHAT was tapped and
  // the car's speed (platform/followDrive.ts holds the pure rules).
  // Taps are captured at the WINDOW level — the whole screen is the
  // input surface, so a zone div would just fight the chrome
  // stacking (drag-zone's full-screen layer is the cautionary tale).
  // Guards: the press must not start on a button or inside the
  // help/overlay/loading chrome (the same closest('button') rule the
  // stick uses, widened to the containers that own taps). #map has
  // touch-action:none and the MapLibre map is interactive:false, so
  // pointer events stream cleanly off the canvas.
  type FollowTarget =
    | { kind: 'point'; pos: Vec2 }
    | { kind: 'car'; car: CarEntity }
    | { kind: 'phone'; pos: Vec2 };
  let followTarget: FollowTarget | null = null;
  /** Iteration 5: the active route plan for the target (road-graph
   *  waypoints for a far pick, a single point for a near one). */
  let followRoute: RouteFollower | null = null;
  /** Set the frame a ROUTED target is arrived at; the frame loop
   *  turns it into the dive back to street framing. */
  let followArrivedRouted = false;
  let followPointerId = -1;
  /** Double-tap bookkeeping (additive: the tap still lands first). */
  let lastFollowTap: TapStamp | null = null;
  /** Handbrake pulse expiry (performance.now ms) from a double-tap. */
  let followDriftUntil = 0;
  /** Held-tap shooting: the entity under the finger, tracked live. */
  let followFire: { pos: () => Vec2; live: () => boolean } | null = null;
  let followFireDown = false;
  /** A tap too fast to span a frame still fires: latch the trigger
   *  for a few frames after the press. */
  let followFireUntil = 0;
  /** Last rendered frame's camera — taps convert through it. One
   *  frame stale by construction; irrelevant at tap timescales. */
  let lastFollowCam: { camera: Vec2; viewWidthM: number } | null = null;
  const followTargetEl = el('follow-target');

  // --- iteration 5: pinch / wheel map zoom --------------------------------
  // The camera is the game's; these gestures only name a desired
  // view WIDTH. The core clamps it (≥18 m) and chases it in log
  // space (game.ts updateCamera) — the same machinery the boot
  // cinematic descends with. Pinching back in to street level
  // hands framing back to the speed-based camera (override
  // clears); pinching out runs to the whole-map framing the intro
  // starts from. While zoomed out, a tap is a map pick: the
  // follow target lands across town and routes there by road.
  /** The player's chosen view width (the live override), or null. */
  let desiredZoomM: number | null = null;
  /** Arrival dive: after a routed trip ends wide, ease the zoom
   *  override back to street framing over ~2 s. Any pinch, wheel
   *  or fresh tap cancels it (the player's zoom wins). */
  let zoomReturn: { fromView: number; t: number } | null = null;
  const zoomPointers = new Map<number, { x: number; y: number }>();
  let pinchState: { startDist: number; startView: number } | null = null;

  function zoomSurfaceOk(e: PointerEvent | WheelEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t || typeof t.closest !== 'function') return false;
    if (t.closest('button, input, select, textarea, label, a')) return false;
    if (t.closest('#help, #overlay, #loading')) return false;
    return true;
  }
  function applyDesiredZoom(v: number): void {
    zoomReturn = null; // the player's zoom always wins
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const maxV = game.wholeMapFraming(aspect)?.view ?? 2600;
    const clamped = Math.max(24, Math.min(maxV, v));
    if (clamped <= game.streetViewM + 2) {
      desiredZoomM = null;
      game.setZoomView(null);
    } else {
      desiredZoomM = clamped;
      game.setZoomView(clamped);
    }
  }
  window.addEventListener('pointerdown', (e) => {
    if (game.introRunning || !zoomSurfaceOk(e)) return;
    zoomPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zoomPointers.size === 2) {
      const [a, b] = [...zoomPointers.values()];
      pinchState = {
        startDist: Math.max(8, Math.hypot(a.x - b.x, a.y - b.y)),
        startView: desiredZoomM ?? lastFollowCam?.viewWidthM ?? game.streetViewM,
      };
      zoomReturn = null;
      // The second finger makes this a pinch, not a tap: the
      // first finger's tap already landed on its pointerdown
      // (targets are never delayed), but its HOLD ends here — no
      // more drag-retargeting, no held trigger, until it lifts.
      if (followPointerId !== -1) {
        followFireDown = false;
        followPointerId = -1;
      }
    }
  });
  window.addEventListener('pointermove', (e) => {
    const p = zoomPointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pinchState && zoomPointers.size === 2) {
      const [a, b] = [...zoomPointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // Fingers apart = zoom in (narrower view); together = out.
      if (d > 4) applyDesiredZoom(pinchState.startView * (pinchState.startDist / d));
    }
  });
  const zoomPointerEnd = (e: PointerEvent): void => {
    zoomPointers.delete(e.pointerId);
    if (zoomPointers.size < 2) pinchState = null;
  };
  window.addEventListener('pointerup', zoomPointerEnd);
  window.addEventListener('pointercancel', zoomPointerEnd);
  window.addEventListener(
    'wheel',
    (e) => {
      if (game.introRunning || !zoomSurfaceOk(e)) return;
      e.preventDefault();
      const base = desiredZoomM ?? lastFollowCam?.viewWidthM ?? game.streetViewM;
      applyDesiredZoom(base * Math.exp(e.deltaY * 0.0016));
    },
    { passive: false },
  );
  function followTargetPos(): Vec2 | null {
    if (!followTarget) return null;
    return followTarget.kind === 'car' ? followTarget.car.pos : followTarget.pos;
  }
  /**
   * Iteration 5: make sure a route plan exists for the live
   * target, (re)built from `anchor` (the car or the walker) when
   * the target is new or has drifted >6 m from the plan's final
   * point (a dragged pick, a car that rolled). Waypoint skip radii
   * differ by context: a car at speed blows through junction
   * centres; a walker threads them.
   */
  /** The target position the live plan was built for. The plan's
   *  own final point can sit far from it (routableDestination
   *  parks unreachable taps at their road snap), so plan freshness
   *  keys on the TARGET, never on the plan's final point. */
  let followPlannedFor: Vec2 | null = null;
  function ensureFollowRoute(anchor: Vec2, onFoot: boolean): void {
    const target = followTargetPos();
    if (!target) {
      followRoute = null;
      followPlannedFor = null;
      return;
    }
    if (followRoute && followPlannedFor && dist(followPlannedFor, target) <= 6) return;
    followPlannedFor = { ...target };
    const plan = planFollowPoints(game.roadGraph, world, anchor, target);
    followRoute = new RouteFollower(plan.points, {
      routed: plan.routed,
      replan: (from) => planFollowPoints(game.roadGraph, world, from, target).points,
      ...(onFoot
        ? { skipMinM: 5, skipPerSpeedM: 0.55, skipMaxM: 10 }
        : { skipMinM: 7, skipPerSpeedM: 0.35, skipMaxM: 16 }),
    });
  }
  (window as unknown as { __mvtFollow?: () => unknown }).__mvtFollow = () => ({
    scheme,
    intent: followTarget?.kind ?? null,
    target: followTargetPos(),
    firing: !!followFire,
    routed: followRoute?.routed ?? false,
    waypoints: followRoute?.points.length ?? 0,
    wpIndex: followRoute?.idx ?? 0,
    zoomViewM: desiredZoomM,
  });
  function followTapAllowed(e: PointerEvent): boolean {
    if (scheme !== 'follow' || !e.isPrimary || e.button > 0) return false;
    // During the boot cinematic a tap is a SKIP, never a target.
    if (game.introRunning) return false;
    const t = e.target as HTMLElement | null;
    if (!t || typeof t.closest !== 'function') return false;
    if (t.closest('button, input, select, textarea, label, a')) return false;
    if (t.closest('#help, #overlay, #loading')) return false;
    return true;
  }
  function followPointAt(clientX: number, clientY: number): void {
    if (!lastFollowCam) return;
    zoomReturn = null; // a fresh pick outranks the arrival dive
    const w = screenToWorld(
      clientX, clientY, window.innerWidth, window.innerHeight,
      lastFollowCam.camera, lastFollowCam.viewWidthM,
    );
    // Tapping the car (or yourself, on foot) means STOP — clear the
    // target instead of parking it on your own roof.
    const anchor = game.drivenCar ? game.drivenCar.pos : game.playerPos;
    followTarget =
      Math.hypot(w.x - anchor.x, w.z - anchor.z) <= FOLLOW_STOP_TAP_M
        ? null
        : { kind: 'point', pos: w };
  }
  /** What lives under a tap, if anything (screen-space, generous). */
  type FollowHit =
    | { kind: 'ped'; x: number; y: number; r: number; ped: Ped }
    | { kind: 'cop'; x: number; y: number; r: number; cop: CopCar }
    | { kind: 'car'; x: number; y: number; r: number; car: CarEntity }
    | { kind: 'phone'; x: number; y: number; r: number; pos: Vec2 };
  function pickFollowHit(clientX: number, clientY: number): FollowHit | null {
    if (!lastFollowCam) return null;
    const { camera, viewWidthM } = lastFollowCam;
    const pxPerM = window.innerWidth / Math.max(1, viewWidthM);
    const hits: FollowHit[] = [];
    const at = (pos: Vec2) =>
      worldToScreen(pos, window.innerWidth, window.innerHeight, camera, viewWidthM);
    for (const ped of game.peds) {
      if (ped.state === 'down') continue;
      const s = at(ped.pos);
      hits.push({ kind: 'ped', x: s.x, y: s.y, r: 38, ped });
    }
    for (const cop of game.cops) {
      if (cop.health <= 0) continue;
      const s = at(cop.pos);
      hits.push({ kind: 'cop', x: s.x, y: s.y, r: 56, cop });
    }
    for (const car of game.cars) {
      if (car.wrecked) continue;
      const s = at(car.pos);
      hits.push({ kind: 'car', x: s.x, y: s.y, r: Math.max(48, 2.9 * pxPerM), car });
    }
    // Payphones (and an active mission's interact point) are tap
    // targets too: walk over, answer on arrival.
    const step = game.missions.currentStep;
    if (game.missions.active && step?.kind === 'interact' && step.pos) {
      const s = at(step.pos);
      hits.push({ kind: 'phone', x: s.x, y: s.y, r: 46, pos: step.pos });
    } else if (!game.missions.active) {
      for (const m of game.missions.available()) {
        const s = at(m.startPos);
        hits.push({ kind: 'phone', x: s.x, y: s.y, r: 46, pos: m.startPos });
      }
    }
    return nearestScreenHit(hits, clientX, clientY);
  }
  function startFollowFire(ref: { pos: () => Vec2; live: () => boolean }): void {
    followFire = ref;
    followFireDown = true;
    followFireUntil = performance.now() + 130;
    followTarget = null; // shooting replaces any walk order
    followRoute = null;
    haptics.tick();
  }
  /** One follow tap, fully interpreted. */
  function handleFollowTap(clientX: number, clientY: number): void {
    zoomReturn = null; // a fresh pick outranks the arrival dive
    const now = performance.now();
    const dbl = isDoubleTap(lastFollowTap, now, clientX, clientY);
    lastFollowTap = { tMs: now, x: clientX, y: clientY };
    if (game.drivenCar) {
      // Double-tap is the action key in a car: at a standstill it's
      // the door handle, at speed it's the handbrake. The tap ALSO
      // still names a destination (additive — never delayed).
      if (dbl && game.phase === 'play') {
        if (Math.abs(game.drivenCar.speed) <= FOLLOW_EXIT_MAX_SPEED_MPS) {
          followTarget = null;
          lastFollowTap = null;
          interact();
          return; // this tap was the exit, not a destination
        }
        followDriftUntil = now + FOLLOW_DRIFT_PULSE_MS;
        haptics.tick();
      }
      followPointAt(clientX, clientY);
      return;
    }
    // On foot: entities first, bare ground second.
    const hit = pickFollowHit(clientX, clientY);
    if (hit?.kind === 'ped') {
      const ped = hit.ped;
      startFollowFire({ pos: () => ped.pos, live: () => ped.state !== 'down' });
      return;
    }
    if (hit?.kind === 'cop') {
      const cop = hit.cop;
      startFollowFire({ pos: () => cop.pos, live: () => cop.health > 0 });
      return;
    }
    if (hit?.kind === 'car') {
      const car = hit.car;
      const intent = carTapIntent(
        game.loadout.def.id !== 'fists',
        dist(game.playerPos, car.pos),
      );
      if (intent === 'enter-now') {
        followTarget = null;
        lastFollowTap = null;
        interact();
        return;
      }
      if (intent === 'fire') {
        startFollowFire({ pos: () => car.pos, live: () => !car.wrecked });
        return;
      }
      followTarget = { kind: 'car', car };
      return;
    }
    if (hit?.kind === 'phone') {
      followTarget = { kind: 'phone', pos: hit.pos };
      return;
    }
    followPointAt(clientX, clientY);
  }
  window.addEventListener('pointerdown', (e) => {
    if (introSkippedEvents.has(e)) return; // this tap only skipped the intro
    if (followPointerId !== -1 || !followTapAllowed(e)) return;
    followPointerId = e.pointerId;
    handleFollowTap(e.clientX, e.clientY);
  });
  window.addEventListener('pointermove', (e) => {
    // Hold/drag: the target rides under the finger until release;
    // the LAST point stays as the destination (finger-follow).
    // While a fire tap is held the finger is a trigger, not a
    // steering wheel — dragging never retargets a shot.
    if (e.pointerId !== followPointerId || scheme !== 'follow' || followFire) return;
    followPointAt(e.clientX, e.clientY);
  });
  const followTapEnd = (e: PointerEvent): void => {
    if (e.pointerId === followPointerId) {
      followPointerId = -1;
      followFireDown = false;
    }
  };
  window.addEventListener('pointerup', followTapEnd);
  window.addEventListener('pointercancel', followTapEnd);
  /** Is the trigger live this frame? (Held, or inside the tap latch.) */
  function followFireActive(): boolean {
    if (!followFire) return false;
    if (!followFire.live()) {
      followFire = null;
      followFireDown = false;
      return false;
    }
    if (followFireDown) return true;
    if (performance.now() < followFireUntil) return true;
    followFire = null; // released and the tap latch has run out
    return false;
  }
  /** Project the target marker into the corner of the screen it
   *  currently sits in; hidden when there's no target, when another
   *  scheme owns input, or when the point is off-screen. */
  function updateFollowMarker(): void {
    const targetPos = followTargetPos();
    if (scheme !== 'follow' || !targetPos || !lastFollowCam) {
      followTargetEl.hidden = true;
      return;
    }
    const s = worldToScreen(
      targetPos, window.innerWidth, window.innerHeight,
      lastFollowCam.camera, lastFollowCam.viewWidthM,
    );
    if (s.x < -30 || s.y < -30 || s.x > window.innerWidth + 30 || s.y > window.innerHeight + 30) {
      followTargetEl.hidden = true;
      return;
    }
    followTargetEl.hidden = false;
    followTargetEl.style.left = `${s.x}px`;
    followTargetEl.style.top = `${s.y}px`;
  }

  // Hold-buttons (pedals / DRIFT / E) with a visible pressed state.
  const pedal = { gas: false, brk: false };
  let driftTouch = false;
  // v0.30: touch FIRE hold (on-foot shooting).
  let fireTouch = false;
  function holdButton(elm: HTMLElement, on: () => void, off: () => void): void {
    // v0.25: the button is OWNED by the pointer that pressed it. The
    // old wiring ended the hold on ANY pointer's up/cancel, so a
    // second finger tapping the same pedal (or a stray cancel) cut
    // the throttle while the first thumb was still holding it.
    let ownerId = -1;
    elm.addEventListener('pointerdown', (e) => {
      if (ownerId !== -1) return;
      e.preventDefault();
      ownerId = e.pointerId;
      elm.setPointerCapture(e.pointerId);
      elm.classList.add('pressed');
      on();
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== ownerId) return;
      ownerId = -1;
      elm.classList.remove('pressed');
      off();
    };
    elm.addEventListener('pointerup', end);
    elm.addEventListener('pointercancel', end);
    elm.addEventListener('lostpointercapture', end);
  }
  holdButton(el('btn-e'), () => interact(), () => undefined);
  // v0.31: the on-foot cluster has its own E (the car group's E is
  // hidden on foot) — same interact action.
  holdButton(el('btn-e-foot'), () => interact(), () => undefined);
  holdButton(el('btn-drift'), () => { driftTouch = true; }, () => { driftTouch = false; });
  holdButton(el('btn-fire'), () => { fireTouch = true; }, () => { fireTouch = false; });
  holdButton(el('btn-weapon'), () => game.cycleWeapon(), () => undefined);
  holdButton(el('btn-gas'), () => { pedal.gas = true; }, () => { pedal.gas = false; });
  holdButton(el('btn-brk'), () => { pedal.brk = true; }, () => { pedal.brk = false; });

  // Buttons scheme: the legacy binary wiring (keys + interact action).
  document.querySelectorAll<HTMLButtonElement>('#ctl-buttons button').forEach((btn) => {
    const code = btn.dataset.code;
    const action = btn.dataset.action;
    // v0.29: pointer capture, owned like the pedals — a finger that
    // slides off the button mid-hold used to silently cut the input
    // (pointerleave), which for BRK reads as "reverse doesn't work".
    let ownerId = -1;
    btn.addEventListener('pointerdown', (e) => {
      if (ownerId !== -1) return;
      e.preventDefault();
      ownerId = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch { /* older engines */ }
      if (action === 'interact') interact();
      else if (action === 'weapon') game.cycleWeapon();
      else if (code) keys.add(code);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== ownerId) return;
      ownerId = -1;
      if (code) keys.delete(code);
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release as EventListener);
  });

  // Scheme selector + haptics toggle (in the ? overlay, persisted).
  function applyScheme(): void {
    document.querySelectorAll<HTMLElement>('.scheme-el').forEach((elm) => {
      const list = (elm.dataset.schemes ?? '').split(' ');
      elm.hidden = !list.includes(scheme);
    });
    // Follow is gesture-only: NO control clusters render at all
    // while it's the scheme (body class drives the CSS kill).
    document.body.classList.toggle('follow-mode', scheme === 'follow');
    // The first-drive hint teaches the live scheme's vocabulary.
    game.driveHintText = scheme === 'follow' ? FOLLOW_DRIVE_HINT : DRIVE_HINT;
    document.querySelectorAll<HTMLButtonElement>('[data-set-scheme]').forEach((b) => {
      b.classList.toggle('on', b.dataset.setScheme === scheme);
    });
    syncChromeState();
  }

  /** v0.31 contextual chrome: which button group shows depends on
   *  whether the player is in a car (car cluster) or on foot (foot
   *  cluster) — never both, never buttons that can't act — and
   *  whether tilt owns steering while driving (stick zone drops
   *  pointer events; a held stick is reset). Called on scheme
   *  changes and on car enter/exit transitions in the frame loop. */
  function syncChromeState(): void {
    const inCar = !!game.drivenCar;
    const state = inCar ? 'car' : 'foot';
    document.querySelectorAll<HTMLElement>('[data-state-group]').forEach((g) => {
      g.hidden = g.dataset.stateGroup !== state;
    });
    document.querySelectorAll<HTMLElement>('#ctl-buttons [data-state]').forEach((b) => {
      const s = b.dataset.state;
      b.hidden = !(s === 'both' || s === state);
    });
    const tiltDriving = scheme === 'tilt' && inCar;
    document.body.classList.toggle('tilt-driving', tiltDriving);
    if (tiltDriving) resetStick();
  }

  /** v0.31: switch schemes. Tilt must prove the sensors are real
   *  before it may own steering — the permission ask (iOS) is why
   *  this runs from the settings tap, a user gesture. Any failure:
   *  a toast and the player keeps the scheme they had. */
  async function setScheme(next: Scheme): Promise<void> {
    if (next !== 'tilt') {
      tiltSensor.stop();
      scheme = next;
      store.set(SCHEME_STORAGE_KEY, scheme);
      applyScheme();
      return;
    }
    const res: TiltEnableResult = await tiltSensor.enable();
    if (res === 'ok') {
      scheme = 'tilt';
      store.set(SCHEME_STORAGE_KEY, scheme);
      applyScheme();
      chromeToast('🌀 Tilt steering on — the pose you hold is "straight" (Calibrate tilt re-zeros it)');
    } else {
      chromeToast(
        res === 'denied'
          ? 'Tilt permission denied — staying on the wheel'
          : "Tilt isn't available here — staying on the wheel",
      );
      applyScheme(); // scheme unchanged; just refresh the .on markers
    }
  }
  document.querySelectorAll<HTMLButtonElement>('[data-set-scheme]').forEach((b) => {
    b.addEventListener('click', () => {
      void setScheme((b.dataset.setScheme ?? 'stick') as Scheme);
    });
  });
  applyScheme();
  // Tilt sensitivity (Low / Standard / High) + Calibrate.
  function applyTiltSens(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-tilt-sens]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tiltSens === tiltSens);
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-tilt-sens]').forEach((b) => {
    b.addEventListener('click', () => {
      tiltSens = b.dataset.tiltSens ?? TILT_DEFAULT_SENSITIVITY;
      store.set('mvt-tilt-sens', tiltSens);
      applyTiltSens();
    });
  });
  applyTiltSens();
  el('tilt-calibrate').addEventListener('click', () => {
    if (scheme !== 'tilt') {
      chromeToast('Switch to Tilt first, then calibrate');
      return;
    }
    chromeToast(
      tiltSensor.calibrate()
        ? 'Tilt calibrated — this pose is now "straight"'
        : 'No tilt signal yet — hold the phone still a moment',
    );
  });
  // Boot restore: tilt was the saved scheme. Permission can't be
  // requested without a gesture, so gated platforms (iOS) arm a
  // one-time retry on the first touch; open platforms just start
  // listening. If no usable sample shows up either way: toast and
  // fall back to the wheel — never leave dead steering.
  if (scheme === 'tilt') {
    const tiltDead = (): void => {
      if (scheme !== 'tilt') return;
      chromeToast("Tilt isn't available here — back to the wheel");
      void setScheme('stick');
    };
    if (tiltSensor.needsPermission()) {
      window.addEventListener(
        'pointerdown',
        () => {
          void tiltSensor.enable().then((res) => {
            if (res !== 'ok') tiltDead();
          });
        },
        { once: true },
      );
    } else {
      tiltSensor.listen();
      window.setTimeout(() => {
        if (tiltSensor.snapshot().samples === 0) tiltDead();
      }, 1800);
    }
  }
  const hapticsToggle = el('haptics-toggle') as HTMLInputElement;
  hapticsToggle.checked = hapticsOn;
  hapticsToggle.addEventListener('change', () => {
    hapticsOn = hapticsToggle.checked;
    store.set('mvt-haptics', hapticsOn ? 'on' : 'off');
    if (!hapticsOn) haptics.cancel();
  });
  const audioToggle = el('audio-toggle') as HTMLInputElement;
  audioToggle.checked = audioOn;
  audioToggle.addEventListener('change', () => {
    audioOn = audioToggle.checked;
    store.set('mvt-audio', audioOn ? 'on' : 'off');
    if (!audioOn) audio.silence();
    else audio.refreshMaster();
  });
  // Input readout (v0.27): live STEER / THR / WHEEL° / km/h corner
  // box for diagnosing real-device input. Persisted, default OFF.
  let readoutOn = store.get('mvt-input-readout') === 'on';
  const readoutToggle = el('readout-toggle') as HTMLInputElement;
  const readout = el('input-readout');
  readoutToggle.checked = readoutOn;
  readout.hidden = !readoutOn;
  readoutToggle.addEventListener('change', () => {
    readoutOn = readoutToggle.checked;
    store.set('mvt-input-readout', readoutOn ? 'on' : 'off');
    readout.hidden = !readoutOn;
  });

  // Gamepad (standard mapping). A is E (edge), B is a brake fallback,
  // X/Y handbrake, RT/LT analog pedals, left stick steers.
  const padSeen = new Set<string>();
  let padAPrev = false;
  let padYPrev = false;
  interface PadState { steer: number; throttle: number; brake: number; handbrake: boolean; fire: boolean; moveX: number; moveZ: number }
  function pollPad(): PadState | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (!padSeen.has(p.id)) {
        padSeen.add(p.id);
        chromeToast(`🎮 Gamepad connected: ${p.id.slice(0, 48)}`);
      }
      const dz = (v: number): number => (Math.abs(v) < 0.12 ? 0 : v);
      const aPressed = !!p.buttons[0]?.pressed;
      if (aPressed && !padAPrev) interact();
      padAPrev = aPressed;
      // v0.30: Y cycles weapons (it was a second handbrake before —
      // X still is); RT/RB fire on foot (RT stays the pedal in a car).
      const yPressed = !!p.buttons[3]?.pressed;
      if (yPressed && !padYPrev) game.cycleWeapon();
      padYPrev = yPressed;
      return {
        steer: dz(p.axes[0] ?? 0),
        throttle: p.buttons[7]?.value ?? 0,
        brake: Math.max(p.buttons[6]?.value ?? 0, p.buttons[1]?.pressed ? 1 : 0),
        handbrake: !!p.buttons[2]?.pressed,
        fire: (p.buttons[7]?.value ?? 0) > 0.3 || !!p.buttons[5]?.pressed,
        moveX: dz(p.axes[0] ?? 0),
        moveZ: dz(p.axes[1] ?? 0),
      };
    }
    padAPrev = false;
    padYPrev = false;
    return null;
  }

  /** Iteration 5: wall-clock dt for the route follower's stuck
   *  bookkeeping (gatherInputs is called once per frame). */
  let lastGatherMs = performance.now();

  /** Merge keyboard + touch scheme + gamepad into the core inputs. */
  function gatherInputs(): void {
    const nowMs = performance.now();
    const gatherDtS = Math.min(0.1, Math.max(0, (nowMs - lastGatherMs) / 1000));
    lastGatherMs = nowMs;
    const pad = pollPad();
    const maxAbs = (...vals: number[]): number =>
      vals.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    if (game.drivenCar) {
      let steer = maxAbs(
        down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft'),
        pad?.steer ?? 0,
      );
      let throttle = maxAbs(
        down('KeyW', 'ArrowUp') - down('KeyS', 'ArrowDown'),
        pedal.gas ? 1 : pedal.brk ? -1 : 0,
        (pad?.throttle ?? 0) - (pad?.brake ?? 0),
      );
      let handbrake =
        keys.has('Space') || driftTouch || !!pad?.handbrake || performance.now() < followDriftUntil;
      if (scheme === 'stick' && stick.active) {
        steer = maxAbs(steer, stick.dx);
        throttle = maxAbs(throttle, -stick.dy);
      }
      if (scheme === 'drag' && drag.active) {
        const vx = drag.x - window.innerWidth / 2;
        const vy = drag.y - window.innerHeight / 2;
        if (Math.hypot(vx, vy) > 26) {
          const desired = Math.atan2(vy, vx);
          let err = desired - game.drivenCar.heading;
          while (err > Math.PI) err -= Math.PI * 2;
          while (err < -Math.PI) err += Math.PI * 2;
          steer = Math.max(-1, Math.min(1, err * 2.2));
          throttle = pedal.brk ? -1 : 0.85;
          handbrake = handbrake || driftTouch;
        } else {
          // v0.29 fix: this branch used to hard-zero the throttle,
          // silently discarding the BRK pedal — with the drag thumb
          // resting near centre (the natural stopped state) the drag
          // scheme could not reverse AT ALL. BRK always means brake,
          // then reverse at a stop, in every scheme.
          throttle = pedal.brk ? -1 : 0;
        }
      }
      if (scheme === 'tilt') {
        // v0.31: tilt emits a normalized linear deflection like the
        // keyboard does; throttle/handbrake already came from the
        // shared pedal cluster above (pedal.gas/brk, driftTouch).
        steer = maxAbs(steer, tiltSensor.steer(tiltCfg()));
      }
      if (scheme === 'follow') {
        // Follow: the pursuit controller owns steer AND throttle
        // while a target lives (no pedals exist in this scheme);
        // keyboard/pad still merge by maxAbs, so a held S or LT
        // can outvote it. Arrival clears the target — after that
        // the car is simply parked until the next tap.
        // Iteration 5: the target is pursued through its ROUTE —
        // road waypoints for a far (map-pick) target, the point
        // itself for a near one. Intermediate waypoints are
        // pass-throughs (no braking curve, no reverse); only the
        // final point gets the full arrive/reverse treatment.
        const targetPos = followTargetPos();
        if (targetPos) {
          const car = game.drivenCar;
          ensureFollowRoute(car.pos, false);
          const step = followRoute?.update(car.pos, Math.abs(car.speed), gatherDtS) ?? null;
          if (!step) {
            // The route gave up (stuck past re-plan + skip): stop
            // here rather than grind against the world forever.
            followTarget = null;
            followRoute = null;
          } else {
            const out = followCarInput(
              {
                pos: car.pos, heading: car.heading, speed: car.speed,
                topSpeedMps: CAR_CLASSES[car.classId ?? 'standard'].topSpeed,
              },
              step.aim,
              { allowReverse: step.isFinal, through: !step.isFinal, cornerMps: step.cornerMps },
            );
            if (step.isFinal && out.mode === 'arrived') {
              if (followRoute?.routed) followArrivedRouted = true;
              followTarget = null;
              followRoute = null;
            } else {
              steer = maxAbs(steer, out.steer);
              throttle = maxAbs(throttle, out.throttle);
            }
          }
        } else {
          followRoute = null;
        }
      }
      // v0.27: steer response curve (|s|^0.7) — endpoints 0/±1 are
      // exact, so keyboard full-lock and the drive metrics don't
      // move; the mid-range a thumb actually reaches is amplified.
      game.carInput = { throttle, steer: shapeSteer(steer), handbrake };
      game.moveInput = { x: 0, z: 0 };
      game.fireHeld = false; // no drive-by shooting — GTA 1 rules
    } else {
      game.walkSpeedMul = 1; // the follow-jog below may raise it
      let mx = maxAbs(down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft'), pad?.moveX ?? 0);
      let mz = maxAbs(down('KeyS', 'ArrowDown') - down('KeyW', 'ArrowUp'), pad?.moveZ ?? 0);
      // v0.31: under the tilt scheme the stick still walks the
      // player on foot (tilt is a DRIVING scheme — no surveyed game
      // tilts the walker; see docs/CONTROLS-RESEARCH.md).
      if ((scheme === 'stick' || scheme === 'tilt') && stick.active) {
        mx = maxAbs(mx, stick.dx);
        mz = maxAbs(mz, stick.dy);
      }
      if (scheme === 'drag' && drag.active) {
        const vx = drag.x - window.innerWidth / 2;
        const vy = drag.y - window.innerHeight / 2;
        const len = Math.hypot(vx, vy);
        if (len > 14) {
          const m = Math.min(1, len / 90);
          mx = (vx / len) * m;
          mz = (vy / len) * m;
        }
      }
      // Follow gestures on foot: a held tap on an entity is the
      // trigger (it owns the facing and suppresses walking); a
      // car/phone target walks there and interacts on arrival;
      // a point target just walks.
      const followFiring = scheme === 'follow' && followFireActive();
      if (scheme === 'follow') {
        if (followFiring && followFire) {
          const tp = followFire.pos();
          game.playerHeading = Math.atan2(
            tp.z - game.playerPos.z,
            tp.x - game.playerPos.x,
          );
        } else if (followTarget) {
          const targetPos = followTargetPos();
          if (targetPos) {
            // Iteration 5: walk the route like the car drives it —
            // intermediate waypoints at full pace, the final point
            // with the usual arrive/interact semantics.
            ensureFollowRoute(game.playerPos, true);
            const speedMag = Math.hypot(game.playerVel.x, game.playerVel.z);
            const step = followRoute?.update(game.playerPos, speedMag, gatherDtS) ?? null;
            // A long trip ahead → jog, don't stroll (followDrive
            // FOLLOW_JOG_*): cross-town at walk pace reads as
            // wandering, however straight the line.
            if (
              step && followRoute &&
              followRoute.remainingM(game.playerPos) > FOLLOW_JOG_MIN_REMAINING_M
            ) {
              game.walkSpeedMul = FOLLOW_JOG_MUL;
            }
            if (!step) {
              followTarget = null;
              followRoute = null;
            } else if (!step.isFinal) {
              const d = dist(game.playerPos, step.aim);
              if (d > 1e-6) {
                mx = maxAbs(mx, (step.aim.x - game.playerPos.x) / d);
                mz = maxAbs(mz, (step.aim.z - game.playerPos.z) / d);
              }
            } else {
              let arrived = false;
              if (
                followTarget.kind === 'car' &&
                dist(game.playerPos, targetPos) <= FOLLOW_CAR_ENTER_M
              ) {
                arrived = true; // close enough — the door's right there
              } else {
                // Point targets arrive at the PLAN's final point,
                // which routableDestination may have parked at the
                // road snap in front of an unreachable tap (inside
                // a house, across the river) — aiming at the raw
                // tap there grinds the wall forever. Entity targets
                // (car/phone) keep their live positions.
                const destPos = followTarget.kind === 'point' ? step.aim : targetPos;
                const w = followWalkInput(game.playerPos, destPos);
                if (w.arrived) arrived = true;
                else {
                  mx = maxAbs(mx, w.move.x);
                  mz = maxAbs(mz, w.move.z);
                }
              }
              if (arrived) {
                const kind = followTarget.kind;
                if (followRoute?.routed) followArrivedRouted = true;
                followTarget = null;
                followRoute = null;
                if (kind === 'car' || kind === 'phone') interact();
              }
            }
          }
        }
      }
      game.moveInput = { x: mx, z: mz };
      game.carInput = { throttle: 0, steer: 0 };
      // v0.30: FIRE on foot — Space/F keys, the touch FIRE button,
      // or the gamepad trigger. (In a car Space stays handbrake.)
      // Follow adds the tap trigger.
      game.fireHeld =
        keys.has('Space') || keys.has('KeyF') || fireTouch || !!pad?.fire || followFiring;
    }
  }

  el('help-toggle').addEventListener('click', () => {
    const full = el('help-full');
    full.hidden = !full.hidden;
  });
  el('btn-primary').addEventListener('click', () => {
    if (game.phase === 'district-done') game.confirmFreeroam();
    else if (game.phase === 'gameover') game.pressRestart();
  });
  el('btn-restart').addEventListener('click', () => game.pressRestart());

  // --- HUD elements --------------------------------------------------------
  const hudScore = el('hud-score');
  const hudMult = el('hud-mult');
  const hudStars = el('hud-stars');
  const hudLives = el('hud-lives');
  const hudSpeed = el('hud-speed');
  const goalFill = el('goalfill') as HTMLElement;
  const pager = el('pager');
  const hudBrief = el('hud-brief');
  const hudObjective = el('hud-objective');
  const hudTimer = el('hud-timer');
  const hudToast = el('hud-toast');
  const hudGear = el('hud-gear');
  const carBanner = el('car-banner');
  const objArrow = el('obj-arrow');
  let carBannerUntil = 0;
  const stamp = el('stamp');
  const overlay = el('overlay');
  const overlayTitle = el('overlay-title');
  const overlayBody = el('overlay-body');
  const btnPrimary = el('btn-primary');
  let lastHud = '';
  let typedBriefFor = '';
  // Haptics transition trackers.
  let prevInCar = false;
  let prevPhase = 'play';
  let prevStamp = '';
  let prevToast = '';
  let prevBrief = '';
  let prevCarHealth: number | null = null;
  let prevPlayerHealth = 100;
  // v0.30 audio event counters + radio station tracker.
  let prevShots = 0;
  let prevExplosions = 0;
  let prevSplashes = 0;
  let prevPickupsTaken = 0;
  let prevFrenzyStarts = 0;
  let prevStation = -1;

  // Pager brief typing effect.
  let typeTimer = 0;
  function typeBrief(text: string): void {
    window.clearInterval(typeTimer);
    typedBriefFor = text;
    let i = 0;
    hudBrief.textContent = '';
    typeTimer = window.setInterval(() => {
      i += 2;
      hudBrief.textContent = text.slice(0, i);
      if (i >= text.length) window.clearInterval(typeTimer);
    }, 18);
  }

  // --- iteration 4 HUD: car banner + objective edge arrow -------------------

  /** GTA 1 names the car on entry. Body type beats class beats generic. */
  function carDisplayName(body: string | undefined, carClass: string | null): string {
    if (carClass === 'police') return 'Police Cruiser';
    switch (body) {
      case 'taxi': return 'Taxi';
      case 'van': return 'Van';
      case 'pickup': return 'Pickup';
    }
    if (carClass === 'fast') return 'Sports';
    return 'Saloon';
  }

  /**
   * The footage's ever-present goal arrow: while the active target
   * (mission objective → EXIT → job car → chop shop on a live
   * vehicle job → nearest payphone when idle) is OFF-screen, a
   * chevron rides the screen edge pointing at it. On-screen targets
   * keep their in-world markers and the arrow hides. Kill Frenzies
   * have no single target point, so they get no arrow.
   */
  function updateObjectiveArrow(f: RenderFrame, vehJob: boolean): void {
    const prio: Array<RenderMarker['kind']> = ['objective', 'exit', 'vehicle'];
    let target: RenderMarker | undefined;
    for (const k of prio) {
      target = f.markers.find((m) => m.kind === k);
      if (target) break;
    }
    if (!target && vehJob) target = f.markers.find((m) => m.kind === 'chopshop');
    if (!target) {
      // Idle: the goal chain starts at a payphone — aim at the
      // nearest one, like the footage's always-on arrow.
      let best = Infinity;
      for (const m of f.markers) {
        if (m.kind !== 'payphone') continue;
        const d = Math.hypot(m.pos.x - f.camera.x, m.pos.z - f.camera.z);
        if (d < best) { best = d; target = m; }
      }
    }
    if (!target) {
      objArrow.hidden = true;
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ppm = vw / f.viewWidthM;
    const dx = (target.pos.x - f.camera.x) * ppm;
    const dy = (target.pos.z - f.camera.z) * ppm;
    const sx = vw / 2 + dx;
    const sy = vh / 2 + dy;
    if (sx > -12 && sx < vw + 12 && sy > -12 && sy < vh + 12) {
      objArrow.hidden = true; // on-screen: the in-world marker speaks
      return;
    }
    const inset = 30;
    objArrow.hidden = false;
    objArrow.dataset.kind = target.kind;
    objArrow.style.left = `${Math.max(inset, Math.min(vw - inset, sx))}px`;
    objArrow.style.top = `${Math.max(inset, Math.min(vh - inset, sy))}px`;
    objArrow.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(dy, dx)}rad)`;
  }

  // --- loop ---------------------------------------------------------------
  let bootedFlag = false;
  let last = performance.now();
  // Debug/diagnostics handle: accumulated GAME time (post-clamp dt).
  // Lets test harnesses measure behaviour per game-second on hosts
  // whose frame rate differs from real time. Harmless in production.
  let gameTimeS = 0;
  (window as unknown as { __mvtTime?: number }).__mvtTime = 0;
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    gameTimeS += dt;
    (window as unknown as { __mvtTime?: number }).__mvtTime = gameTimeS;

    gatherInputs();
    game.update(dt);
    const frameState: RenderFrame = game.buildFrame();
    renderer.sync(frameState);
    // Follow (preview): taps convert through the frame camera, and
    // the target marker is projected from it every frame.
    lastFollowCam = { camera: frameState.camera, viewWidthM: frameState.viewWidthM };
    updateFollowMarker();

    // Iteration 5: a routed trip that ends while the player is
    // still zoomed out dives back to street framing (~2 s, the
    // intro's ease-out-over-log-zoom profile) so the arrival reads
    // as a landing, not a teleport of attention. A pinch, wheel or
    // fresh tap cancels it instantly (applyDesiredZoom / the tap
    // handlers clear zoomReturn).
    if (followArrivedRouted) {
      followArrivedRouted = false;
      if (desiredZoomM !== null && frameState.viewWidthM > 200) {
        zoomReturn = { fromView: frameState.viewWidthM, t: 0 };
      }
    }
    if (zoomReturn) {
      zoomReturn.t += dt / 2;
      const p = Math.min(1, zoomReturn.t);
      const e = 1 - Math.pow(1 - p, 3);
      const street = game.streetViewM;
      const v = Math.exp(
        Math.log(zoomReturn.fromView) + (Math.log(street) - Math.log(zoomReturn.fromView)) * e,
      );
      if (p >= 1) {
        zoomReturn = null;
        desiredZoomM = null;
        game.setZoomView(null);
      } else {
        game.setZoomView(v);
      }
    }

    // v0.30: the first rendered frame dismisses the loading screen
    // (after a minimum display so the lockup reads as a splash).
    if (!bootedFlag) {
      bootedFlag = true;
      (window as unknown as { __mvtBooted?: boolean }).__mvtBooted = true;
      const wait = Math.max(0, 1200 - (performance.now() - bootStart));
      window.setTimeout(() => {
        setLoading(1, 'GO!');
        const l = document.getElementById('loading');
        if (l) {
          l.classList.add('done');
          window.setTimeout(() => l.remove(), 500);
        }
        // The overlay is going: start the descent from orbit. The
        // camera snaps to the whole-map framing under the fade and
        // glides down onto the spawn over the next ~4 s (any input
        // skips it — see skipIntro above; the demo scenario and
        // restarts never arm it).
        game.beginIntro(window.innerWidth / Math.max(1, window.innerHeight));
      }, wait);
    }

    const hud = game.hud();
    // Haptics + audio: fire on observed state transitions (platform layer).
    if (!prevInCar && hud.inCar) {
      haptics.enterCar();
      audio.enterCar();
      // Iteration 4 (GTA 1): the blue banner names the car as you
      // get in — brief, top-centre, gone in ~2 s.
      const driven = frameState.entities.find((e) => e.kind === 'car-driven');
      carBanner.textContent = carDisplayName(driven?.bodyType, hud.carClass);
      carBanner.hidden = false;
      carBannerUntil = performance.now() + 2100;
    }
    if (!carBanner.hidden && performance.now() > carBannerUntil) carBanner.hidden = true;
    updateObjectiveArrow(frameState, hud.vehJob);
    if (prevInCar && !hud.inCar && hud.phase === 'play') audio.exitCar();
    if (prevInCar !== hud.inCar) {
      syncChromeState();
      // Follow: a target belongs to the context it was tapped in —
      // entering or leaving a car starts fresh, so a stale point
      // can't drag the player (or the new car) across the map.
      // Gesture state resets with it: a tap sequence from the old
      // context must never read as a double-tap in the new one
      // (tap-to-enter, then a quick drive tap, is NOT an exit).
      followTarget = null;
      followRoute = null;
      followFire = null;
      followFireDown = false;
      lastFollowTap = null;
    }
    prevInCar = hud.inCar;
    // v0.31: the wheel mirrors the tilt while tilt-driving.
    if (scheme === 'tilt' && hud.inCar) tiltWheelVisual();
    if (hud.stamp !== prevStamp) {
      if (hud.stamp === 'BUSTED') {
        haptics.busted();
        audio.busted();
      } else if (hud.stamp === 'WASTED') {
        haptics.wasted();
        audio.wasted();
      } else if (prevStamp) haptics.cancel();
      prevStamp = hud.stamp;
    }
    if (hud.phase !== prevPhase) {
      if (hud.phase === 'district-done') audio.districtComplete();
      else if (hud.phase === 'gameover') audio.wasted();
      // Follow: BUSTED/WASTED teleport the player to spawn — a
      // target set across town must not auto-walk the fresh spawn.
      if (hud.phase !== 'play') {
        followTarget = null;
        followRoute = null;
        followFire = null;
        followFireDown = false;
        lastFollowTap = null;
      }
      prevPhase = hud.phase;
    }
    if (hud.toast !== prevToast) {
      if (hud.toast.includes(' complete!')) {
        haptics.missionComplete();
        audio.missionComplete();
      }
      prevToast = hud.toast;
    }
    if (hud.brief && !prevBrief) {
      haptics.payphone();
      audio.payphone();
    }
    prevBrief = hud.brief;
    {
      const carDrop = prevCarHealth !== null && hud.carHealth !== null ? prevCarHealth - hud.carHealth : 0;
      const playerDrop = prevPlayerHealth - game.playerHealth;
      const drop = Math.max(carDrop, playerDrop);
      if (drop >= 2) {
        haptics.collision(Math.min(1, drop / 22));
        audio.collision(Math.min(1, drop / 22));
      }
      prevCarHealth = hud.carHealth;
      prevPlayerHealth = game.playerHealth;
    }
    // v0.30 one-shot audio from HUD counters (the core counts; the
    // platform layer voices).
    if (hud.shotsFired > prevShots) audio.shot(hud.weaponId);
    prevShots = hud.shotsFired;
    if (hud.explosions > prevExplosions) audio.explosion();
    prevExplosions = hud.explosions;
    if (hud.splashes > prevSplashes) audio.splash();
    prevSplashes = hud.splashes;
    if (hud.pickupsTaken > prevPickupsTaken) audio.pickup();
    prevPickupsTaken = hud.pickupsTaken;
    if (hud.frenzyStarts > prevFrenzyStarts) audio.frenzyStart();
    prevFrenzyStarts = hud.frenzyStarts;
    // Audio continuous layers (engine / siren / skid / radio).
    let nearestCopM: number | null = null;
    if (hud.stars >= 1) {
      for (const cop of game.cops) {
        const d = Math.hypot(cop.pos.x - game.playerPos.x, cop.pos.z - game.playerPos.z);
        if (nearestCopM === null || d < nearestCopM) nearestCopM = d;
      }
    }
    // Radio: station follows the car class; entering a car (or a
    // different class) announces it on the toast line.
    const station = hud.inCar ? stationForClass(hud.carClass) : -1;
    if (station !== prevStation) {
      if (station >= 0) chromeToast(`📻 ${STATIONS[station].name}`, 2600);
      prevStation = station;
    }
    audio.update(
      {
        inCar: hud.inCar,
        speedKmh: hud.speedKmh,
        throttle: game.carInput.throttle,
        carClass: game.drivenCar?.classId ?? 'standard',
        slipDeg: game.drivenCar?.slipAngle ?? 0,
        handbrake: !!game.carInput.handbrake,
        stars: hud.stars,
        nearestCopM,
        radioStation: station,
      },
      dt,
    );
    const key = JSON.stringify({ ...hud, brief: hud.brief ? '…' : '' });
    if (key !== lastHud) {
      lastHud = key;
      hudScore.textContent = fmt(hud.score);
      hudMult.textContent = `×${hud.multiplier}`;
      hudStars.textContent = '★'.repeat(hud.stars) + '☆'.repeat(5 - hud.stars);
      hudLives.textContent = '♥'.repeat(Math.max(0, hud.lives));
      hudSpeed.textContent = hud.inCar
        ? `${hud.reversing ? 'R · ' : ''}${hud.speedKmh} km/h${hud.carHealth !== null && hud.carHealth < 45 ? ` · car ${hud.carHealth}%` : ''}`
        : '';
      goalFill.style.width = `${Math.round(hud.goalPct * 100)}%`;
      // Pager: only when it has something to say.
      const showPager = hud.brief !== '' || hud.objective !== '';
      pager.hidden = !showPager;
      if (hud.brief && hud.brief !== typedBriefFor) typeBrief(hud.brief);
      if (!hud.brief) {
        typedBriefFor = '';
        hudBrief.textContent = '';
      }
      hudObjective.textContent = hud.objective;
      if (hud.timerSec !== null) {
        hudTimer.hidden = false;
        const s = Math.max(0, Math.ceil(hud.timerSec));
        hudTimer.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        hudTimer.classList.toggle('low', s <= 15);
      } else {
        hudTimer.hidden = true;
      }
      // Gear line (v0.30): weapon + ammo on foot, armour/card always.
      {
        const bits = [
          hud.inCar
            ? ''
            : `${hud.weaponId === 'fists' ? '👊' : '🔫'} ${hud.weaponName}${hud.ammo !== null ? ` · ${hud.ammo}` : ''}`,
          hud.armour > 0 ? `🛡 ${hud.armour}` : '',
          hud.jailCard ? '🃏 JAIL CARD' : '',
          hud.frenzy ? `💀 ${hud.frenzy.have}/${hud.frenzy.need}` : '',
        ].filter(Boolean);
        hudGear.textContent = bits.join('  ');
        hudGear.hidden = bits.length === 0;
      }
      // Stamp.
      if (hud.stamp) {
        stamp.hidden = false;
        stamp.textContent = hud.stamp;
        stamp.className = hud.stamp.toLowerCase();
      } else {
        stamp.hidden = true;
      }
      // End overlays.
      if (hud.phase === 'district-done') {
        overlay.hidden = false;
        overlayTitle.textContent = 'DISTRICT COMPLETE!';
        overlayBody.textContent =
          `Downtown Fredericton is yours.\nFinal score ${fmt(hud.score)} at ×${hud.multiplier}.\nKeep freeroaming, or start a fresh run.`;
        btnPrimary.textContent = 'Keep freeroaming (F)';
      } else if (hud.phase === 'gameover') {
        overlay.hidden = false;
        overlayTitle.textContent = 'GAME OVER';
        overlayBody.textContent = `Out of lives.\nFinal score ${fmt(hud.score)}.`;
        btnPrimary.textContent = 'New run (R)';
      } else {
        overlay.hidden = true;
      }
    }
    // Toast: a live chrome toast (tilt state, radio station) wins
    // over the core's toast until it expires. Written every frame —
    // the old in-block write raced the station announcement.
    hudToast.textContent = performance.now() < chromeToastUntil ? chromeToastText : hud.toast;
    if (readoutOn) {
      const car = game.drivenCar;
      const tiltBit =
        scheme === 'tilt'
          ? ` · TILT ${tiltSensor.snapshot().gamma?.toFixed(0) ?? '—'}°→${tiltSensor.steer(tiltCfg()).toFixed(2)}`
          : '';
      let followBit = '';
      if (scheme === 'follow') {
        const tp = followRoute?.currentAim ?? followTargetPos();
        if (followFire) followBit = ' · FOLLOW firing';
        else if (!tp) followBit = ' · FOLLOW no target';
        else if (car) {
          const o = followCarInput(
            {
              pos: car.pos, heading: car.heading, speed: car.speed,
              topSpeedMps: CAR_CLASSES[car.classId ?? 'standard'].topSpeed,
            },
            tp,
          );
          followBit = ` · FOLLOW ${o.mode} ${o.distM.toFixed(1)}m${followRoute?.routed ? ` · route ${followRoute.idx + 1}/${followRoute.points.length}` : ''}`;
        } else {
          const w = followWalkInput(game.playerPos, tp);
          followBit = ` · FOLLOW ${followTarget?.kind ?? 'point'} ${w.distM.toFixed(1)}m`;
        }
      }
      readout.textContent = car
        ? `STEER ${game.carInput.steer.toFixed(2)} · THR ${game.carInput.throttle.toFixed(2)} · WHEEL ${((car.steer * 180) / Math.PI).toFixed(1)}° · ${hud.speedKmh} km/h${tiltBit}${followBit}`
        : `MOVE ${game.moveInput.x.toFixed(2)} / ${game.moveInput.z.toFixed(2)} · on foot · stick ${stick.active ? `${stick.dx.toFixed(2)},${stick.dy.toFixed(2)}` : '—'}${tiltBit}${followBit}`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  // Never die behind the loading screen.
  const l = document.getElementById('loading');
  if (l) l.remove();
  el('hud-toast').textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
