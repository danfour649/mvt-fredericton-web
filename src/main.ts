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

  // --- input -------------------------------------------------------------
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyE' && !e.repeat) game.pressInteract();
    if (e.code === 'KeyR' && !e.repeat) game.pressRestart();
    if (e.code === 'KeyF' && !e.repeat) game.confirmFreeroam();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const down = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);

  // Touch controls feed the same key set / interact path.
  document.querySelectorAll<HTMLButtonElement>('#touch button').forEach((btn) => {
    const code = btn.dataset.code;
    const action = btn.dataset.action;
    const press = (e: Event) => {
      e.preventDefault();
      if (action === 'interact') game.pressInteract();
      else if (code) keys.add(code);
    };
    const release = () => {
      if (code) keys.delete(code);
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

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
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (game.drivenCar) {
      game.carInput = {
        throttle: down('KeyW', 'ArrowUp') - down('KeyS', 'ArrowDown'),
        steer: down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft'),
        handbrake: keys.has('Space'),
      };
      game.moveInput = { x: 0, z: 0 };
    } else {
      game.moveInput = {
        x: down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft'),
        z: down('KeyS', 'ArrowDown') - down('KeyW', 'ArrowUp'),
      };
      game.carInput = { throttle: 0, steer: 0 };
    }
    game.update(dt);
    renderer.sync(game.buildFrame());

    const hud = game.hud();
    const key = JSON.stringify({ ...hud, brief: hud.brief ? '…' : '' });
    if (key !== lastHud) {
      lastHud = key;
      hudScore.textContent = fmt(hud.score);
      hudMult.textContent = `×${hud.multiplier}`;
      hudStars.textContent = '★'.repeat(hud.stars) + '☆'.repeat(5 - hud.stars);
      hudLives.textContent = '♥'.repeat(Math.max(0, hud.lives));
      hudSpeed.textContent = hud.inCar
        ? `${hud.speedKmh} km/h${hud.carHealth !== null && hud.carHealth < 45 ? ` · car ${hud.carHealth}%` : ''}`
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
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  el('hud-toast').textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
