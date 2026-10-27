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
import type { Renderer } from './core/renderer';
import type { StorageAdapter } from './core/save';
import { MapLibreRenderer } from './render/maplibre/MapLibreRenderer';
import { CanvasRenderer } from './render/canvas/CanvasRenderer';
import { Haptics } from './platform/haptics';
import { GameAudio, type AudioStateSnapshot } from './platform/audio';
import { shapeSteer, stickDeflection } from './platform/stickMath';

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

async function boot(): Promise<void> {
  const container = el('map');
  const params = new URLSearchParams(window.location.search);
  const rendererParam = params.get('renderer');

  const res = await fetch(`${import.meta.env.BASE_URL}data/downtown.json`);
  if (!res.ok) throw new Error(`downtown.json: HTTP ${res.status}`);
  const world = loadWorld(await res.json());

  const game = new Game(world, localStorageAdapter);
  if (params.get('scenario') === 'demo') game.applyDemoScenario();
  // Screenshot/testing hook: harmless, exposes the running game.
  (window as unknown as { __game?: Game }).__game = game;

  const renderer: Renderer =
    rendererParam === 'canvas' ? new CanvasRenderer(container) : new MapLibreRenderer(container);
  el('renderer-name').textContent = renderer.name === 'canvas' ? 'Canvas 2D (Route C)' : 'MapLibre (Route A)';
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
  type Scheme = 'stick' | 'drag' | 'buttons';
  let scheme: Scheme = (['stick', 'drag', 'buttons'].includes(store.get('mvt-input-scheme') ?? '')
    ? store.get('mvt-input-scheme')
    : 'stick') as Scheme;
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
  function stickVisual(): void {
    // v0.29: the stick IS a steering wheel — it rotates with the
    // (shaped) steer value, ±135° at full lock, and springs back to
    // centre with it. Same v0.27 math underneath; this is the skin.
    const deg = shapeSteer(stick.dx) * 135;
    stickWheel.style.transform = `rotate(${deg.toFixed(1)}deg)`;
  }
  stickZone.addEventListener('pointerdown', (e) => {
    if (stick.id !== -1) return;
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
    stick.id = -1;
    stick.active = false;
    stick.dx = 0;
    stick.dy = 0;
    stickBase.classList.remove('active');
    stickBase.style.left = '';
    stickBase.style.top = '';
    stickBase.style.bottom = '';
    stickVisual();
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

  // Hold-buttons (pedals / DRIFT / E) with a visible pressed state.
  const pedal = { gas: false, brk: false };
  let driftTouch = false;
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
  holdButton(el('btn-drift'), () => { driftTouch = true; }, () => { driftTouch = false; });
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
    document.querySelectorAll<HTMLButtonElement>('[data-set-scheme]').forEach((b) => {
      b.classList.toggle('on', b.dataset.setScheme === scheme);
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-set-scheme]').forEach((b) => {
    b.addEventListener('click', () => {
      scheme = (b.dataset.setScheme ?? 'stick') as Scheme;
      store.set('mvt-input-scheme', scheme);
      applyScheme();
    });
  });
  applyScheme();
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
  interface PadState { steer: number; throttle: number; brake: number; handbrake: boolean; moveX: number; moveZ: number }
  function pollPad(): PadState | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (!padSeen.has(p.id)) {
        padSeen.add(p.id);
        el('hud-toast').textContent = `🎮 Gamepad connected: ${p.id.slice(0, 48)}`;
      }
      const dz = (v: number): number => (Math.abs(v) < 0.12 ? 0 : v);
      const aPressed = !!p.buttons[0]?.pressed;
      if (aPressed && !padAPrev) interact();
      padAPrev = aPressed;
      return {
        steer: dz(p.axes[0] ?? 0),
        throttle: p.buttons[7]?.value ?? 0,
        brake: Math.max(p.buttons[6]?.value ?? 0, p.buttons[1]?.pressed ? 1 : 0),
        handbrake: !!(p.buttons[2]?.pressed || p.buttons[3]?.pressed),
        moveX: dz(p.axes[0] ?? 0),
        moveZ: dz(p.axes[1] ?? 0),
      };
    }
    padAPrev = false;
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
      // v0.27: steer response curve (|s|^0.7) — endpoints 0/±1 are
      // exact, so keyboard full-lock and the drive metrics don't
      // move; the mid-range a thumb actually reaches is amplified.
      game.carInput = { throttle, steer: shapeSteer(steer), handbrake };
      game.moveInput = { x: 0, z: 0 };
    } else {
      let mx = maxAbs(down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft'), pad?.moveX ?? 0);
      let mz = maxAbs(down('KeyS', 'ArrowDown') - down('KeyW', 'ArrowUp'), pad?.moveZ ?? 0);
      if (scheme === 'stick' && stick.active) {
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
      game.moveInput = { x: mx, z: mz };
      game.carInput = { throttle: 0, steer: 0 };
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
    renderer.sync(game.buildFrame());

    const hud = game.hud();
    // Haptics + audio: fire on observed state transitions (platform layer).
    if (!prevInCar && hud.inCar) {
      haptics.enterCar();
      audio.enterCar();
    }
    if (prevInCar && !hud.inCar && hud.phase === 'play') audio.exitCar();
    prevInCar = hud.inCar;
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
    // Audio continuous layers (engine / siren / skid) for this frame.
    let nearestCopM: number | null = null;
    if (hud.stars >= 1) {
      for (const cop of game.cops) {
        const d = Math.hypot(cop.pos.x - game.playerPos.x, cop.pos.z - game.playerPos.z);
        if (nearestCopM === null || d < nearestCopM) nearestCopM = d;
      }
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
      hudToast.textContent = hud.toast;
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
    if (readoutOn) {
      const car = game.drivenCar;
      readout.textContent = car
        ? `STEER ${game.carInput.steer.toFixed(2)} · THR ${game.carInput.throttle.toFixed(2)} · WHEEL ${((car.steer * 180) / Math.PI).toFixed(1)}° · ${hud.speedKmh} km/h`
        : `MOVE ${game.moveInput.x.toFixed(2)} / ${game.moveInput.z.toFixed(2)} · on foot · stick ${stick.active ? `${stick.dx.toFixed(2)},${stick.dy.toFixed(2)}` : '—'}`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  el('hud-toast').textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
