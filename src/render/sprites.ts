/**
 * Top-down sprite factory: every dynamic entity is drawn from a small
 * offscreen canvas generated once and cached — car bodies with roof,
 * windshield and headlights; police with a lightbar (two blink phases);
 * wrecks; little people with a direction cue. Sprites are drawn with
 * forward = +X so a plain ctx.rotate(heading) aims them, in BOTH
 * renderers (core heading is clockwise-positive with +Z south, which
 * matches canvas rotation with its y-down axes).
 *
 * Why sprites on a canvas overlay instead of MapLibre GeoJSON layers
 * (the v0 approach): exact metre sizing, per-part colours, rotation and
 * screen-pixel markers with zero per-frame GeoJSON rebuilds — and the
 * identical draw code serves the Route C canvas renderer.
 */

export interface Sprite {
  img: HTMLCanvasElement;
  /** Footprint in metres the image represents. */
  wM: number;
  hM: number;
}

const CAR_LEN = 4.4;
const CAR_WID = 1.9;
const PERSON_M = 1.15;

const cache = new Map<string, Sprite>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for sprite');
  return [c, ctx];
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const PPM = 44; // sprite resolution, px per metre

export function carSprite(color: string, opts: { police?: boolean; wrecked?: boolean; lightPhase?: 0 | 1 } = {}): Sprite {
  const key = `car|${color}|${opts.police ? 'p' + (opts.lightPhase ?? 0) : ''}|${opts.wrecked ? 'w' : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const W = Math.round(CAR_LEN * PPM);
  const H = Math.round(CAR_WID * PPM);
  const [c, ctx] = canvas(W, H);
  const body = opts.wrecked ? '#3a3d40' : color;

  // Wheels (peek out at the corners).
  ctx.fillStyle = '#15161a';
  const ww = 0.72 * PPM, wh = 0.3 * PPM;
  for (const [wx, wy] of [
    [0.55 * PPM, -wh * 0.35], [0.55 * PPM, H - wh * 0.65],
    [W - 0.55 * PPM - ww, -wh * 0.35], [W - 0.55 * PPM - ww, H - wh * 0.65],
  ]) {
    rr(ctx, wx, wy, ww, wh, 3);
    ctx.fill();
  }
  // Body.
  rr(ctx, 1, 3, W - 2, H - 6, 10);
  ctx.fillStyle = body;
  ctx.fill();
  // v0.23: a real outline — GTA 1 sprites are inked, not pastel.
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = 'rgba(8,8,12,0.88)';
  ctx.stroke();
  // Hood shading (front = +X).
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  rr(ctx, W * 0.68, 5, W * 0.29, H - 10, 7);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  rr(ctx, W * 0.03, 5, W * 0.2, H - 10, 7);
  ctx.fill();
  if (opts.police) {
    // Navy side bands.
    ctx.fillStyle = '#1d2f57';
    ctx.fillRect(W * 0.06, H * 0.06, W * 0.88, H * 0.16);
    ctx.fillRect(W * 0.06, H * 0.78, W * 0.88, H * 0.16);
  }
  // Windshield + rear window.
  ctx.fillStyle = opts.wrecked ? '#5c6468' : 'rgba(196,228,245,0.95)';
  rr(ctx, W * 0.56, H * 0.14, W * 0.09, H * 0.72, 4);
  ctx.fill();
  if (!opts.wrecked) {
    // Windshield glare: a diagonal slash of sky reflection.
    ctx.save();
    rr(ctx, W * 0.56, H * 0.14, W * 0.09, H * 0.72, 4);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.moveTo(W * 0.545, H * 0.95);
    ctx.lineTo(W * 0.6, H * 0.05);
    ctx.lineTo(W * 0.635, H * 0.05);
    ctx.lineTo(W * 0.58, H * 0.95);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = opts.wrecked ? '#4a5054' : 'rgba(140,180,205,0.9)';
  rr(ctx, W * 0.3, H * 0.16, W * 0.07, H * 0.68, 4);
  ctx.fill();
  // Roof, with a lengthwise highlight so the panel reads as a surface.
  rr(ctx, W * 0.375, H * 0.15, W * 0.175, H * 0.7, 6);
  ctx.fillStyle = shade(body === '#f2f3f5' ? '#dfe3e8' : body, 1.18);
  ctx.fill();
  if (!opts.wrecked) {
    ctx.save();
    rr(ctx, W * 0.375, H * 0.15, W * 0.175, H * 0.7, 6);
    ctx.clip();
    const grad = ctx.createLinearGradient(0, H * 0.15, 0, H * 0.85);
    grad.addColorStop(0, 'rgba(255,255,255,0.20)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.02)');
    grad.addColorStop(1, 'rgba(0,0,0,0.14)');
    ctx.fillStyle = grad;
    ctx.fillRect(W * 0.375, H * 0.15, W * 0.175, H * 0.7);
    ctx.restore();
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(10,10,14,0.35)';
  ctx.stroke();
  if (opts.police) {
    // Lightbar on the roof front: red/blue halves, phase swaps them.
    const phase = opts.lightPhase ?? 0;
    const lx = W * 0.47, lw = W * 0.075, ly = H * 0.2, lh = H * 0.6;
    ctx.save();
    ctx.shadowBlur = 9;
    ctx.fillStyle = phase === 0 ? '#ff3b30' : '#7a1610';
    ctx.shadowColor = ctx.fillStyle;
    rr(ctx, lx, ly, lw, lh / 2 - 1, 3);
    ctx.fill();
    ctx.fillStyle = phase === 0 ? '#1450c8' : '#3b82f6';
    ctx.shadowColor = ctx.fillStyle;
    rr(ctx, lx, ly + lh / 2 + 1, lw, lh / 2 - 1, 3);
    ctx.fill();
    ctx.restore();
  }
  // Lights.
  if (!opts.wrecked) {
    ctx.fillStyle = '#fff3ae';
    for (const ly of [H * 0.14, H * 0.86]) {
      ctx.beginPath();
      ctx.arc(W - 3, ly, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#e0342b';
    for (const ly of [H * 0.14, H * 0.86]) {
      ctx.beginPath();
      ctx.arc(3, ly, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Cracked windshield strokes for the wreck.
    ctx.strokeStyle = 'rgba(230,240,245,0.7)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(W * 0.57, H * 0.2);
    ctx.lineTo(W * 0.63, H * 0.5);
    ctx.lineTo(W * 0.58, H * 0.8);
    ctx.stroke();
  }

  const sprite = { img: c, wM: CAR_LEN, hM: CAR_WID };
  cache.set(key, sprite);
  return sprite;
}

export function personSprite(color: string, opts: { player?: boolean; down?: boolean } = {}): Sprite {
  const key = `person|${color}|${opts.player ? 'P' : ''}|${opts.down ? 'd' : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const S = Math.round(PERSON_M * PPM);
  const [c, ctx] = canvas(S, S);
  const cx = S / 2, cy = S / 2;

  if (opts.down) {
    // Lying flat: elongated torso along +X, head at the front end.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy, S * 0.4, S * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(10,10,14,0.55)';
    ctx.stroke();
    ctx.fillStyle = '#e8b88a';
    ctx.beginPath();
    ctx.arc(cx + S * 0.42, cy, S * 0.11, 0, Math.PI * 2);
    ctx.fill();
    const sprite = { img: c, wM: PERSON_M, hM: PERSON_M };
    cache.set(key, sprite);
    return sprite;
  }

  if (opts.player) {
    // Readability ring — part of the sprite, thin and tight, not the
    // v0 metre-radius circle layer.
    ctx.beginPath();
    ctx.arc(cx, cy, S * 0.47, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
  }
  // Feet (direction cue: they lead).
  ctx.fillStyle = '#22242a';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + S * 0.2, cy + s * S * 0.16, S * 0.1, S * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Torso / shoulders.
  ctx.beginPath();
  ctx.ellipse(cx - S * 0.03, cy, S * 0.3, S * 0.34, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(10,10,14,0.55)';
  ctx.stroke();
  // Head.
  ctx.beginPath();
  ctx.arc(cx + S * 0.05, cy, S * 0.155, 0, Math.PI * 2);
  ctx.fillStyle = '#e8b88a';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + S * 0.02, cy, S * 0.15, Math.PI * 0.6, Math.PI * 1.7);
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = '#2e2119';
  ctx.stroke();

  const sprite = { img: c, wM: PERSON_M, hM: PERSON_M };
  cache.set(key, sprite);
  return sprite;
}

/**
 * Draw a sprite centred at (px,py), rotated, sized by px-per-metre.
 * v0.23: every sprite first stamps a soft drop shadow offset to the
 * screen south-east (unrotated light, rotated body — the shadow keeps
 * the sprite's silhouette but is shifted +x/+y in SCREEN space, like
 * the building shadows in dressing.ts), so cars and peds sit ON the
 * street instead of floating over it.
 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  px: number,
  py: number,
  ppm: number,
  heading: number,
  minPx = 0,
): void {
  const w = Math.max(sprite.wM * ppm, minPx);
  const h = Math.max(sprite.hM * ppm, minPx * (sprite.hM / sprite.wM));
  // Shadow pass.
  ctx.save();
  ctx.translate(px + w * 0.07 + 1.5, py + h * 0.16 + 2);
  ctx.rotate(heading);
  ctx.beginPath();
  if (sprite.wM > sprite.hM * 1.6) {
    ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(8, h * 0.3));
  } else {
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  }
  ctx.fillStyle = 'rgba(12,12,16,0.34)';
  ctx.fill();
  ctx.restore();
  // Sprite pass.
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(heading);
  ctx.drawImage(sprite.img, -w / 2, -h / 2, w, h);
  ctx.restore();
}
