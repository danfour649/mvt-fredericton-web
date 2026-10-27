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
/** Person sprite canvas extent (m). The BODY inside is ~0.9 m long /
 *  0.55 m wide (v0.29 spec); the canvas keeps a little air around it
 *  for the player ring and the drop shadow. */
const PERSON_M = 1.0;

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

export type CarBody = 'car' | 'taxi' | 'van' | 'pickup';

export function carSprite(color: string, opts: { police?: boolean; wrecked?: boolean; lightPhase?: 0 | 1; reverseLights?: boolean; body?: CarBody } = {}): Sprite {
  const bodyKind: CarBody = opts.body ?? 'car';
  const key = `car|${color}|${opts.police ? 'p' + (opts.lightPhase ?? 0) : ''}|${opts.wrecked ? 'w' : ''}|${opts.reverseLights ? 'R' : ''}|${bodyKind}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // v0.30 body variety: vans and pickups run a touch longer/wider.
  const lenM = bodyKind === 'van' ? 5.2 : bodyKind === 'pickup' ? 5.0 : CAR_LEN;
  const widM = bodyKind === 'van' ? 2.15 : bodyKind === 'pickup' ? 2.0 : CAR_WID;
  const W = Math.round(lenM * PPM);
  const H = Math.round(widM * PPM);
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
  if (bodyKind === 'van') {
    // Panel-van cargo box over the rear two-thirds: flat sides,
    // panel seams, no rear glass.
    ctx.fillStyle = shade(body, 0.94);
    rr(ctx, W * 0.02, 4, W * 0.52, H - 8, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,10,14,0.4)';
    ctx.lineWidth = 1.6;
    for (const fx of [0.18, 0.34, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(W * fx, 6);
      ctx.lineTo(W * fx, H - 6);
      ctx.stroke();
    }
  }
  if (bodyKind === 'pickup') {
    // Open bed behind the cab: dark floor, rail lines.
    ctx.fillStyle = opts.wrecked ? '#2c2e30' : '#26282d';
    rr(ctx, W * 0.03, H * 0.09, W * 0.32, H * 0.82, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1.4;
    for (const fy of [0.3, 0.5, 0.7]) {
      ctx.beginPath();
      ctx.moveTo(W * 0.05, H * fy);
      ctx.lineTo(W * 0.33, H * fy);
      ctx.stroke();
    }
  }
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
  if (bodyKind === 'taxi' && !opts.wrecked) {
    // The roof sign — the whole point of a taxi sprite.
    ctx.fillStyle = '#ffd23f';
    rr(ctx, W * 0.415, H * 0.3, W * 0.1, H * 0.4, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,10,14,0.6)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = '#191a1e';
    ctx.font = `bold ${Math.round(H * 0.17)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(W * 0.465, H * 0.5);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('TAXI', 0, 0);
    ctx.restore();
  }
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
    if (opts.reverseLights) {
      // v0.29: bright white reverse lamps at the rear corners, with
      // a halo — reversing must be visible at a glance, not inferred.
      ctx.save();
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#ffffff';
      ctx.fillStyle = '#ffffff';
      for (const ly of [H * 0.14, H * 0.86]) {
        ctx.beginPath();
        ctx.arc(4.5, ly, 3.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
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

  const sprite = { img: c, wM: lenM, hM: widM };
  cache.set(key, sprite);
  return sprite;
}

/**
 * v0.24 spawn anchor: a soft pulsing ring under the player, drawn by
 * both renderers until the player's first car entry (core flags the
 * player entity with `anchor`). One steady ring keeps it findable; an
 * expanding ring pulses outward and fades. All in world metres so it
 * sits on the street, not the screen.
 */
export function drawAnchorRing(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ppm: number,
  t: number,
): void {
  const phase = (t * 0.8) % 1;
  ctx.beginPath();
  ctx.arc(px, py, (1.35 + phase * 1.7) * ppm, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,210,63,${(0.5 * (1 - phase)).toFixed(3)})`;
  ctx.lineWidth = Math.max(1.5, ppm * 0.06);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px, py, 1.3 * ppm, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,210,63,0.85)';
  ctx.lineWidth = Math.max(1.5, ppm * 0.05);
  ctx.stroke();
}

/** Hair palette for the person sprites — peds pick by id hash so a
 *  given walker always wears the same hair. */
export const HAIR_COLORS = ['#241a12', '#0f0d0b', '#4a3220', '#6e5136', '#8f9096', '#c8c9cc', '#7a3b14', '#2e2119'];

/** Deterministic hair colour for an entity id (pure — unit-tested). */
export function hairFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return HAIR_COLORS[h % HAIR_COLORS.length];
}

/** The player's hair — constant, pairs with the gold shirt. */
export const PLAYER_HAIR = '#1c1410';

/**
 * Walk-cycle frame from a distance-driven phase (pure — unit-tested).
 * Frame 0 is the neutral stance (feet together); while moving, the
 * cycle runs stride-A → passing → stride-B → passing, so the feet
 * alternate in step with distance covered, never with wall time.
 */
export function walkFrame(phase: number, moving: boolean): 0 | 1 | 2 | 3 {
  if (!moving) return 0;
  const p = ((phase % 1) + 1) % 1;
  const idx = Math.floor(p * 4) % 4;
  return [1, 2, 3, 2][idx] as 0 | 1 | 2 | 3;
}

/** Foot specks per walk frame: [x, z] offsets in metres from the
 *  body centre, facing = +X. Feet trail the torso and alternate. */
const FEET: Record<number, [number, number][]> = {
  0: [[-0.14, -0.13], [-0.14, 0.13]],
  1: [[-0.01, -0.14], [-0.28, 0.14]],
  2: [[-0.14, -0.07], [-0.14, 0.07]],
  3: [[-0.28, -0.14], [-0.01, 0.14]],
};

/**
 * The person (v0.29 — Daniel: "the dot should be a person"). A GTA 1
 * top-down walker, ~0.9 m long / ~0.55 m wide inside a 1 m canvas:
 * HAIR-coloured head disc (top-down you mostly see hair) with a skin
 * crescent at the face edge, a shirt-coloured shoulder/torso mass,
 * and dark foot specks that alternate through the walk cycle. Bold
 * shapes + dark ink outline so it still reads as a person at the
 * real on-foot framing (~13–15 px on a phone), not a blob.
 */
export function personSprite(
  color: string,
  opts: { player?: boolean; down?: boolean; frame?: number; hair?: string } = {},
): Sprite {
  const frame = opts.down ? 0 : (opts.frame ?? 0);
  const hair = opts.hair ?? '#2e2119';
  const key = `person|${color}|${hair}|${opts.player ? 'P' : ''}|${opts.down ? 'd' : ''}|f${frame}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const S = Math.round(PERSON_M * PPM);
  const [c, ctx] = canvas(S, S);
  const cx = S / 2, cy = S / 2;
  const M = PPM; // px per metre in sprite space

  if (opts.down) {
    // Lying flat: elongated torso along +X, head at the front end.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 0.4 * M, 0.16 * M, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(10,10,14,0.55)';
    ctx.stroke();
    // Head: hair disc with a skin crescent, same as standing.
    ctx.fillStyle = '#e8b88a';
    ctx.beginPath();
    ctx.arc(cx + 0.44 * M, cy, 0.1 * M, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.arc(cx + 0.415 * M, cy, 0.115 * M, 0, Math.PI * 2);
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
  // Feet (behind the torso, alternating with the walk frame).
  ctx.fillStyle = '#211d19';
  for (const [fx, fz] of FEET[frame] ?? FEET[0]) {
    ctx.beginPath();
    ctx.ellipse(cx + fx * M, cy + fz * M, 0.085 * M, 0.055 * M, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Torso / shoulders: the shirt-coloured mass.
  ctx.beginPath();
  ctx.ellipse(cx, cy, 0.295 * M, 0.27 * M, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(10,10,14,0.6)';
  ctx.stroke();
  // Rear shading so the mass has a front and a back.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, 0.295 * M, 0.27 * M, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(cx - 0.3 * M, cy - 0.28 * M, 0.13 * M, 0.56 * M);
  ctx.restore();
  // Head: skin disc first, hair disc over it — a skin crescent of
  // forehead survives at the face edge; from above it's mostly hair.
  ctx.beginPath();
  ctx.arc(cx + 0.345 * M, cy, 0.105 * M, 0, Math.PI * 2);
  ctx.fillStyle = '#e8b88a';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + 0.3 * M, cy, 0.12 * M, 0, Math.PI * 2);
  ctx.fillStyle = hair;
  ctx.fill();

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
