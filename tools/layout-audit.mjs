#!/usr/bin/env node
/**
 * Layout audit (v0.31) — mechanical proof of the touch-control
 * geometry, replacing eyeballing. Loads the game headlessly at two
 * phone sizes × two player states × the two distinct cluster DOMs
 * (stick-family and buttons scheme; the tilt scheme shares the
 * stick family's containers exactly), collects every VISIBLE
 * control's bounding box, and asserts the v0.31 layout rules:
 *
 *   - every touch target ≥ 56×56 px
 *   - every pair of controls separated by ≥ 12 px (no overlap, ever)
 *   - no control overlaps the pager or the HUD gear line
 *   - every control fully inside the viewport
 *
 * Usage: [CHROME_BIN=/path/to/chrome] node tools/layout-audit.mjs [url]
 *   url defaults to the production site. Exit code 0 = all pass.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';

const BASE = process.argv[2] ?? 'https://www.mvtfredericton.ca/';
const HOST = new URL(BASE).hostname;
const LOCAL = HOST === '127.0.0.1' || HOST === 'localhost';
const RELAY_PORT = 8899;

// --- egress relay (this VM reaches public hosts only via a proxy;
// CONNECT through it for the audited host, like the proof rigs do).
// Plain-HTTP requests are also forwarded: Chrome's Local Network
// Access checks block direct loopback navigations (Chromium 152),
// but a proxy-mediated fetch of the same local preview is allowed —
// so local audits go through this relay too. Binds loopback only.
const relay = http.createServer((req, res) => {
  try {
    const u = new URL(req.url ?? '');
    const fwd = http.request({
      host: u.hostname,
      port: parseInt(u.port ?? '80', 10),
      path: u.pathname + u.search,
      method: req.method,
      headers: { ...req.headers, host: u.host },
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    fwd.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
  } catch { res.writeHead(502); res.end(); }
});
relay.on('connect', (req, socket) => {
  try {
    const [host, portS] = (req.url ?? '').split(':');
    const port = parseInt(portS ?? '443', 10);
    const envProxy = process.env.https_proxy || process.env.HTTPS_PROXY || '';
    let upHost = host; let upPort = port; let auth = '';
    try {
      const u = new URL(envProxy);
      upHost = u.hostname; upPort = parseInt(u.port ?? '3128', 10);
      if (u.username) auth = 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64') + '\r\n';
    } catch { /* direct */ }
    const up = net.connect(upPort, upHost, () => {
      up.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.subarray(0, idx).toString('latin1');
      const rest = buf.subarray(idx + 4);
      up.removeListener('data', onData);
      if (!/ 200/.test(head)) { socket.destroy(); up.destroy(); return; }
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
      if (rest.length) socket.write(rest);
      up.pipe(socket); socket.pipe(up);
    };
    up.on('data', onData);
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  } catch { socket.destroy(); }
});
relay.on('error', () => { /* keep serving */ });

// --- CDP plumbing (same pattern as the version proof rigs) --------
const DBG_PORT = 9345;
let chrome;
let ws;
const pending = new Map();
const eventHandlers = new Map();
let msgId = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`);
      const j = await r.json();
      const page = j.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('chrome debug endpoint never came up');
}
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function onEvent(method, fn) {
  if (!eventHandlers.has(method)) eventHandlers.set(method, []);
  eventHandlers.get(method).push(fn);
}
async function connect() {
  const profile = mkdtempSync(join(tmpdir(), 'chr-layout-'));
  const args = [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader', '--hide-scrollbars', '--ignore-certificate-errors',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ];
  // Always via the relay: for public hosts it chains the egress
  // proxy; for loopback targets it forwards the plain HTTP request,
  // which is what lets Chrome load a local preview at all (direct
  // loopback navigation is blocked by Local Network Access checks).
  args.splice(4, 0, `--proxy-server=http://127.0.0.1:${RELAY_PORT}`);
  chrome = spawn(process.env.CHROME_BIN ?? '/opt/meta-chromium/chrome', args, { stdio: 'ignore' });
  ws = new WebSocket(await wsUrl());
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev2) => {
    const msg = JSON.parse(ev2.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    } else if (msg.method && eventHandlers.has(msg.method)) {
      for (const fn of eventHandlers.get(msg.method)) fn(msg.params);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}
async function ev(expr) {
  const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error('evaluate failed: ' + (out.exceptionDetails.exception?.description ?? JSON.stringify(out.exceptionDetails)));
  return out.result?.value;
}
async function navigate(url) {
  const loaded = new Promise((r) => onEvent('Page.loadEventFired', r));
  await send('Page.navigate', { url });
  await loaded;
}
async function waitGame(timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const ok = await ev(`!!window.__game && document.querySelectorAll('canvas').length > 0`).catch(() => false);
    if (ok) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (Buffer.byteLength(shot.data, 'base64') > 60000) return;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('game never painted');
    await sleep(400);
  }
}

// --- the audit itself ----------------------------------------------
const COLLECT = `(() => {
  const out = [];
  for (const b of document.querySelectorAll('#touch button')) {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
      out.push({
        id: b.id || (b.textContent ?? '').trim(),
        x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
      });
    }
  }
  const extra = {};
  for (const id of ['pager', 'hud-gear']) {
    const e = document.getElementById(id);
    if (e && !e.hidden) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        extra[id] = { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      }
    }
  }
  return {
    controls: out, extra,
    vw: window.innerWidth, vh: window.innerHeight,
    inCar: !!window.__game?.drivenCar,
  };
})()`;

const ENTER_CAR = `(() => {
  const g = window.__game;
  if (!g || g.drivenCar) return !!g?.drivenCar;
  const cars = [...g.cars].filter((c) => !c.wrecked)
    .sort((a, b) => Math.hypot(a.pos.x - g.playerPos.x, a.pos.z - g.playerPos.z)
                  - Math.hypot(b.pos.x - g.playerPos.x, b.pos.z - g.playerPos.z));
  if (!cars.length) return false;
  const c = cars[0];
  g.playerPos = { x: c.pos.x + 1, z: c.pos.z };
  g.pressInteract();
  return !!g.drivenCar;
})()`;

function gapBetween(a, b) {
  const dx = Math.max(0, Math.max(a.x - b.right, b.x - a.right));
  const dy = Math.max(0, Math.max(a.y - b.bottom, b.y - a.bottom));
  if (dx === 0 && dy === 0) return -1; // overlap
  if (dx === 0) return dy;
  if (dy === 0) return dx;
  return Math.hypot(dx, dy);
}

function auditConfig(label, data) {
  const fails = [];
  const { controls, extra, vw, vh } = data;
  if (controls.length < 3) fails.push(`only ${controls.length} visible controls (expected ≥3)`);
  for (const c of controls) {
    if (c.w < 56 || c.h < 56) fails.push(`${c.id}: target ${c.w}×${c.h} < 56×56`);
    if (c.x < -0.5 || c.y < -0.5 || c.right > vw + 0.5 || c.bottom > vh + 0.5) {
      fails.push(`${c.id}: escapes viewport (${c.x},${c.y})–(${c.right},${c.bottom}) of ${vw}×${vh}`);
    }
  }
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const g = gapBetween(controls[i], controls[j]);
      if (g < 0) fails.push(`${controls[i].id} OVERLAPS ${controls[j].id}`);
      else if (g < 11.5) fails.push(`${controls[i].id} ↔ ${controls[j].id}: gap ${g.toFixed(1)}px < 12`);
    }
  }
  for (const c of controls) {
    for (const [name, r] of Object.entries(extra)) {
      if (gapBetween(c, r) < 0) fails.push(`${c.id} OVERLAPS ${name}`);
    }
  }
  return {
    label,
    controls: controls.map((c) => `${c.id} ${Math.round(c.w)}×${Math.round(c.h)} @${Math.round(c.x)},${Math.round(c.y)}`),
    minTarget: controls.length ? Math.min(...controls.map((c) => Math.min(c.w, c.h))) : 0,
    minGap: (() => {
      let m = Infinity;
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) m = Math.min(m, gapBetween(controls[i], controls[j]));
      }
      return m === Infinity ? null : Math.round(m * 10) / 10;
    })(),
    fails,
  };
}

async function main() {
  await new Promise((r) => relay.listen(RELAY_PORT, r));
  await connect();
  const results = [];
  const sizes = [
    { w: 390, h: 844 },
    { w: 360, h: 740 },
  ];
  for (const scheme of ['stick', 'buttons']) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('mvt-input-scheme', '${scheme}'); } catch (e) {}`,
    });
    for (const size of sizes) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: size.w, height: size.h, deviceScaleFactor: 1, mobile: true,
      });
      await navigate(BASE);
      await waitGame();
      await sleep(600);
      const foot = await ev(COLLECT);
      results.push(auditConfig(`${scheme} ${size.w}×${size.h} FOOT`, foot));
      const entered = await ev(ENTER_CAR);
      if (!entered) {
        results.push({ label: `${scheme} ${size.w}×${size.h} CAR`, controls: [], minTarget: 0, minGap: null, fails: ['rig could not enter a car'] });
      } else {
        await sleep(400);
        const car = await ev(COLLECT);
        results.push(auditConfig(`${scheme} ${size.w}×${size.h} CAR`, car));
      }
    }
  }
  let failed = 0;
  for (const r of results) {
    const ok = r.fails.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.label}  (controls: ${r.controls.length}, min target ${r.minTarget}px, min gap ${r.minGap}px)`);
    for (const c of r.controls) console.log(`      ${c}`);
    for (const f of r.fails) console.log(`      ✗ ${f}`);
  }
  console.log(failed === 0 ? '\nLAYOUT AUDIT: ALL PASS' : `\nLAYOUT AUDIT: ${failed} CONFIG(S) FAILED`);
  chrome?.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('audit error:', e.message);
  chrome?.kill();
  process.exit(2);
});
