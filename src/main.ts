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
import { Game } from './core/game';
import type { Renderer, RenderFrame } from './core/renderer';
import type { Vec2 } from './core/geo';
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
  followCarInput,
  followWalkInput,
  screenToWorld,
  worldToScreen,
  FOLLOW_STOP_TAP_M,
} from './platform/followDrive';

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
  type Scheme = 'stick' | 'drag' | 'buttons' | 'tilt' | 'follow';
  let scheme: Scheme = (['stick', 'drag', 'buttons', 'tilt', 'follow'].includes(store.get('mvt-input-scheme') ?? '')
    ? store.get('mvt-input-scheme')
    : 'stick') as Scheme;
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

  // Follow scheme (preview): tap-to-drive. Taps are captured at the
  // WINDOW level — the whole screen is the input surface, so a zone
  // div would just fight the chrome stacking (drag-zone's full-screen
  // layer is the cautionary tale). Guards: the press must not start
  // on a button or inside the help/overlay/loading chrome (the same
  // closest('button') rule the stick uses, widened to the containers
  // that own taps). #map has touch-action:none and the MapLibre map
  // is interactive:false, so pointer events stream cleanly off the
  // canvas. The controller itself is platform/followDrive.ts (pure,
  // unit-tested against the real physics).
  let followTarget: Vec2 | null = null;
  let followPointerId = -1;
  /** Last rendered frame's camera — taps convert through it. One
   *  frame stale by construction; irrelevant at tap timescales. */
  let lastFollowCam: { camera: Vec2; viewWidthM: number } | null = null;
  const followTargetEl = el('follow-target');
  (window as unknown as { __mvtFollow?: () => unknown }).__mvtFollow = () => ({
    scheme,
    target: followTarget,
  });
  function followTapAllowed(e: PointerEvent): boolean {
    if (scheme !== 'follow' || !e.isPrimary || e.button > 0) return false;
    const t = e.target as HTMLElement | null;
    if (!t || typeof t.closest !== 'function') return false;
    if (t.closest('button, input, select, textarea, label, a')) return false;
    if (t.closest('#help, #overlay, #loading')) return false;
    return true;
  }
  function followPointAt(clientX: number, clientY: number): void {
    if (!lastFollowCam) return;
    const w = screenToWorld(
      clientX, clientY, window.innerWidth, window.innerHeight,
      lastFollowCam.camera, lastFollowCam.viewWidthM,
    );
    // Tapping the car (or yourself, on foot) means STOP — clear the
    // target instead of parking it on your own roof.
    const anchor = game.drivenCar ? game.drivenCar.pos : game.playerPos;
    followTarget =
      Math.hypot(w.x - anchor.x, w.z - anchor.z) <= FOLLOW_STOP_TAP_M ? null : w;
  }
  window.addEventListener('pointerdown', (e) => {
    if (followPointerId !== -1 || !followTapAllowed(e)) return;
    followPointerId = e.pointerId;
    followPointAt(e.clientX, e.clientY);
  });
  window.addEventListener('pointermove', (e) => {
    // Hold/drag: the target rides under the finger until release;
    // the LAST point stays as the destination (finger-follow).
    if (e.pointerId !== followPointerId || scheme !== 'follow') return;
    followPointAt(e.clientX, e.clientY);
  });
  const followTapEnd = (e: PointerEvent): void => {
    if (e.pointerId === followPointerId) followPointerId = -1;
  };
  window.addEventListener('pointerup', followTapEnd);
  window.addEventListener('pointercancel', followTapEnd);
  /** Project the target marker into the corner of the screen it
   *  currently sits in; hidden when there's no target, when another
   *  scheme owns input, or when the point is off-screen. */
  function updateFollowMarker(): void {
    if (scheme !== 'follow' || !followTarget || !lastFollowCam) {
      followTargetEl.hidden = true;
      return;
    }
    const s = worldToScreen(
      followTarget, window.innerWidth, window.innerHeight,
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
    // Follow owns the throttle: GAS/BRK hide while it's the scheme.
    document.body.classList.toggle('follow-controls', scheme === 'follow');
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
      store.set('mvt-input-scheme', scheme);
      applyScheme();
      return;
    }
    const res: TiltEnableResult = await tiltSensor.enable();
    if (res === 'ok') {
      scheme = 'tilt';
      store.set('mvt-input-scheme', scheme);
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

  /** Merge keyboard + touch scheme + gamepad into the core inputs. */
  function gatherInputs(): void {
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
      let handbrake = keys.has('Space') || driftTouch || !!pad?.handbrake;
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
      if (scheme === 'follow' && followTarget) {
        // Follow (preview): the pursuit controller owns steer AND
        // throttle while a target lives (the pedals are hidden);
        // keyboard/pad still merge by maxAbs, so a held S or LT
        // can outvote it. Arrival clears the target — after that
        // the car is simply parked until the next tap.
        const car = game.drivenCar;
        const out = followCarInput(
          { pos: car.pos, heading: car.heading, speed: car.speed },
          followTarget,
        );
        if (out.mode === 'arrived') {
          followTarget = null;
        } else {
          steer = maxAbs(steer, out.steer);
          throttle = maxAbs(throttle, out.throttle);
        }
      }
      // v0.27: steer response curve (|s|^0.7) — endpoints 0/±1 are
      // exact, so keyboard full-lock and the drive metrics don't
      // move; the mid-range a thumb actually reaches is amplified.
      game.carInput = { throttle, steer: shapeSteer(steer), handbrake };
      game.moveInput = { x: 0, z: 0 };
      game.fireHeld = false; // no drive-by shooting — GTA 1 rules
    } else {
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
      if (scheme === 'follow' && followTarget) {
        // Follow on foot: the same tapped point is a walk target;
        // arrival clears it and the player stops there.
        const w = followWalkInput(game.playerPos, followTarget);
        if (w.arrived) {
          followTarget = null;
        } else {
          mx = maxAbs(mx, w.move.x);
          mz = maxAbs(mz, w.move.z);
        }
      }
      game.moveInput = { x: mx, z: mz };
      game.carInput = { throttle: 0, steer: 0 };
      // v0.30: FIRE on foot — Space/F keys, the touch FIRE button,
      // or the gamepad trigger. (In a car Space stays handbrake.)
      game.fireHeld = keys.has('Space') || keys.has('KeyF') || fireTouch || !!pad?.fire;
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
      }, wait);
    }

    const hud = game.hud();
    // Haptics + audio: fire on observed state transitions (platform layer).
    if (!prevInCar && hud.inCar) {
      haptics.enterCar();
      audio.enterCar();
    }
    if (prevInCar && !hud.inCar && hud.phase === 'play') audio.exitCar();
    if (prevInCar !== hud.inCar) {
      syncChromeState();
      // Follow: a target belongs to the context it was tapped in —
      // entering or leaving a car starts fresh, so a stale point
      // can't drag the player (or the new car) across the map.
      followTarget = null;
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
      if (hud.phase !== 'play') followTarget = null;
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
        if (!followTarget) followBit = ' · FOLLOW no target';
        else if (car) {
          const o = followCarInput(
            { pos: car.pos, heading: car.heading, speed: car.speed },
            followTarget,
          );
          followBit = ` · FOLLOW ${o.mode} ${o.distM.toFixed(1)}m`;
        } else {
          const w = followWalkInput(game.playerPos, followTarget);
          followBit = ` · FOLLOW walk ${w.distM.toFixed(1)}m`;
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
