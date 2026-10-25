/**
 * Boot + wiring only: fetch the world data, build the core Game, pick a
 * renderer (Route A MapLibre by default; Route C canvas with
 * ?renderer=canvas), translate keyboard input into core inputs, and copy
 * the core HUD state into the DOM each frame. All game logic is in
 * src/core — this file knows nothing about missions or physics.
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

async function boot(): Promise<void> {
  const container = el('map');
  const rendererParam = new URLSearchParams(window.location.search).get('renderer');

  const res = await fetch(`${import.meta.env.BASE_URL}data/downtown.json`);
  if (!res.ok) throw new Error(`downtown.json: HTTP ${res.status}`);
  const world = loadWorld(await res.json());

  const game = new Game(world, localStorageAdapter);

  const renderer: Renderer =
    rendererParam === 'canvas' ? new CanvasRenderer(container) : new MapLibreRenderer(container);
  el('renderer-name').textContent = renderer.name === 'canvas' ? 'Canvas 2D (Route C)' : 'MapLibre (Route A)';
  await renderer.init(world);

  // --- input -------------------------------------------------------------
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyE' && !e.repeat) game.pressInteract();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  const down = (...codes: string[]) => codes.some((c) => keys.has(c)) ? 1 : 0;

  const hudMoney = el('hud-money');
  const hudStars = el('hud-stars');
  const hudObjective = el('hud-objective');
  const hudToast = el('hud-toast');
  const hudSpeed = el('hud-speed');
  let lastHud = '';

  // --- loop ---------------------------------------------------------------
  let last = performance.now();
  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (game.drivenCar) {
      game.carInput = {
        throttle: down('KeyW', 'ArrowUp') - down('KeyS', 'ArrowDown'),
        steer: down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft'),
      };
    } else {
      game.moveInput = {
        x: down('KeyD', 'ArrowRight') - down('KeyA', 'ArrowLeft'),
        z: down('KeyS', 'ArrowDown') - down('KeyW', 'ArrowUp'),
      };
    }
    game.update(dt);
    renderer.sync(game.buildFrame());

    const hud = game.hud();
    const key = JSON.stringify(hud);
    if (key !== lastHud) {
      lastHud = key;
      hudMoney.textContent = `$${hud.money}`;
      hudStars.textContent = '★★★★★'.slice(0, hud.stars) + '☆☆☆☆☆'.slice(0, 5 - hud.stars);
      hudObjective.textContent = hud.objective;
      hudToast.textContent = hud.toast;
      hudSpeed.textContent = hud.inCar ? `${hud.speedKmh} km/h` : '';
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  el('hud-toast').textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
