/**
 * Audio — WebAudio synth layer (v0.26, platform layer).
 *
 * The v0.25 audit's one GAP was that the game had NO audio at all.
 * This is the audit doc's recommendation built: a small synth layer
 * with ZERO audio assets — every sound is oscillators + filtered
 * noise, generated on the fly.
 *
 * Architecture mirrors `src/platform/haptics.ts`: the core stays
 * DOM/audio-free; `src/main.ts` infers events from HUD/state
 * transitions (enter car, toast text, stamp changes, health drops)
 * and drives the continuous layers (engine / siren / skid) with one
 * `update()` call per frame.
 *
 * Autoplay policy: the AudioContext is created lazily on the first
 * user gesture (`unlock()`, wired in main.ts to pointerdown/keydown —
 * the same sticky activation haptics relies on). Before that, every
 * method is a silent no-op. If WebAudio is unavailable, same.
 */

// ---------------------------------------------------------------------------
// Pure mappings (unit-tested seams)
// ---------------------------------------------------------------------------

/** Class top speeds (km/h) from the drive metrics — iteration 3
 *  pace (Follow PR): standard 137, fast 157, police 151 (the v0.21
 *  figures were 113 / 143 / 134). */
const TOP_SPEED_KMH: Record<string, number> = { standard: 137, fast: 157, police: 151 };
/** Frequency character per class: at the same fraction of its rev
 *  range the fast car's pitch sits higher (and its redline tops out
 *  higher); pitch itself is normalized to each class's top speed. */
const CLASS_FREQ_SCALE: Record<string, number> = { standard: 1, fast: 1.12, police: 1.05 };

export const ENGINE_IDLE_HZ = 55;

/**
 * Engine pitch: idle 55 Hz, rising with the speed ratio against the
 * class top speed, plus a throttle-load lift that fades as speed
 * takes over. Monotonic in speed for fixed throttle.
 */
export function engineFreqHz(speedKmh: number, throttle: number, classId: string): number {
  const top = TOP_SPEED_KMH[classId] ?? TOP_SPEED_KMH.standard;
  const s = Math.max(0, Math.min(1, Math.abs(speedKmh) / top));
  const load = Math.max(0, Math.min(1, Math.abs(throttle)));
  const scale = CLASS_FREQ_SCALE[classId] ?? 1;
  return (ENGINE_IDLE_HZ + 150 * s + 28 * load * (1 - s)) * scale;
}

/** Engine loudness: audible idle, modest under load. Master-relative. */
export function engineGainFor(speedKmh: number, throttle: number): number {
  const load = Math.max(Math.min(1, Math.abs(speedKmh) / TOP_SPEED_KMH.standard), Math.abs(throttle) * 0.7);
  return 0.045 + 0.055 * Math.max(0, Math.min(1, load));
}

/** Siren range: silent at/ beyond this distance from the nearest cop. */
export const SIREN_RANGE_M = 120;

/** Siren gain by distance to the nearest cop: full at point-blank, 0 at range. */
export function sirenGainFor(distM: number): number {
  if (!Number.isFinite(distM) || distM >= SIREN_RANGE_M) return 0;
  const t = Math.max(0, 1 - distM / SIREN_RANGE_M);
  return 0.12 * Math.pow(t, 1.4);
}

/**
 * Skid gain: needs speed plus real slip (or the handbrake locked at
 * speed). Mirrors the slip signal that lays skid marks in the core.
 */
export function skidGainFor(slipDeg: number, speedKmh: number, handbrake: boolean): number {
  const v = Math.abs(speedKmh);
  if (v < 15) return 0;
  const slip = Math.abs(slipDeg);
  const m = handbrake ? Math.max(slip, 22) : slip;
  if (m <= 12) return 0;
  return 0.1 * Math.min(1, (m - 12) / 23) * Math.min(1, v / 60);
}

// ---------------------------------------------------------------------------
// Radio (v0.30) — procedural stations, zero audio assets
// ---------------------------------------------------------------------------

export interface RadioStation {
  name: string;
  bpm: number;
  /** 16 eighth-note steps of semitone offsets from A1 (55 Hz); -1 = rest. */
  bass: number[];
  /** Arp semitone offsets, played on alternate steps. */
  arp: number[];
  wave: OscillatorType;
}

export const STATIONS: RadioStation[] = [
  {
    name: 'Queen City Radio 98.7',
    bpm: 104,
    bass: [0, -1, 0, -1, 3, -1, 0, -1, 5, -1, 3, -1, 0, -1, -2, -1],
    arp: [12, 15, 19, 15, 12, 15, 19, 22],
    wave: 'triangle',
  },
  {
    name: 'Velocity FM 103.3',
    bpm: 132,
    bass: [0, 0, -1, 0, 0, -1, 0, 3, 0, 0, -1, 0, 5, 3, 2, -1],
    arp: [24, 19, 15, 19, 24, 19, 15, 12],
    wave: 'sawtooth',
  },
];

/** Station index by vehicle class: fast cars get the fast station. */
export function stationForClass(classId: string | null | undefined): number {
  if (!classId) return -1;
  return classId === 'fast' ? 1 : 0;
}

/** Semitone offset → frequency from a root. */
export function noteHz(rootHz: number, semitones: number): number {
  return rootHz * Math.pow(2, semitones / 12);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface AudioUpdateState {
  inCar: boolean;
  speedKmh: number;
  throttle: number;
  carClass: string;
  slipDeg: number;
  handbrake: boolean;
  stars: number;
  /** Distance to the nearest cop in metres, or null when there are none. */
  nearestCopM: number | null;
  /** v0.30: radio station index (see STATIONS), or -1 for off. */
  radioStation?: number;
}

export interface AudioStateSnapshot {
  supported: boolean;
  unlocked: boolean;
  ctxState: string;
  enabled: boolean;
  engineRunning: boolean;
  engineFreqHz: number;
  engineGain: number;
  sirenActive: boolean;
  sirenGain: number;
  sirenToneHz: number;
  skidGain: number;
  /** v0.30: station index currently sequenced (-1 = radio off). */
  radioStation: number;
  /** v0.30: current sequencer step 0..15. */
  radioStep: number;
}

type CtxFactory = () => AudioContext | null;

function defaultFactory(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AC = w.AudioContext ?? w.webkitAudioContext;
  if (!AC) return null;
  try {
    return new AC();
  } catch {
    return null;
  }
}

function defaultSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof w.AudioContext === 'function' || typeof w.webkitAudioContext === 'function';
}

const MASTER_LEVEL = 0.9;
const TAU = 0.06; // setTargetAtTime smoothing for continuous params

interface LoopNodes {
  gain: GainNode;
  stop: () => void;
}

export class GameAudio {
  readonly supported: boolean;
  private enabledFn: () => boolean;
  private factory: CtxFactory;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  private engine: (LoopNodes & { osc: OscillatorNode; filter: BiquadFilterNode }) | null = null;
  private siren: (LoopNodes & { osc: OscillatorNode }) | null = null;
  private skid: LoopNodes | null = null;

  // JS-side mirrors of the live params (what state() reports and the
  // rig asserts against — actual node params chase these values).
  private curEngineFreq = 0;
  private curEngineGain = 0;
  private curSirenGain = 0;
  private curSirenTone = 0;
  private sirenPhase = 0;
  private curSkidGain = 0;

  // v0.30 radio sequencer state.
  private radioStep = 0;
  private radioAcc = 0;
  private curStation = -1;

  private lastCollisionAt = 0;

  constructor(enabledFn: () => boolean, factory?: CtxFactory) {
    this.enabledFn = enabledFn;
    this.factory = factory ?? defaultFactory;
    this.supported = factory ? true : defaultSupported();
  }

  // --- lifecycle -----------------------------------------------------------

  /** Create/resume the context. Call on every user gesture (cheap). */
  unlock(): void {
    if (!this.supported) return;
    try {
      if (!this.ensureCtx()) return;
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => undefined);
      }
      this.refreshMaster();
    } catch {
      /* audio is garnish — never take the game down */
    }
  }

  private ensureCtx(): boolean {
    if (this.ctx) return true;
    let ctx: AudioContext | null = null;
    try {
      ctx = this.factory();
    } catch {
      ctx = null;
    }
    if (!ctx) return false;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_LEVEL;
    this.master.connect(ctx.destination);
    // 1 s of white noise, reused by skid/collision/door synths.
    const len = Math.max(1, Math.floor(ctx.sampleRate));
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  /**
   * Re-apply the master level for the current enabled state (silence()
   * parks the master at 0; the toggle handler calls this on re-enable,
   * and unlock() calls it on every gesture — harmless when already set).
   */
  refreshMaster(): void {
    if (!this.ctx || !this.master) return;
    try {
      this.master.gain.setTargetAtTime(this.enabledFn() ? MASTER_LEVEL : 0, this.ctx.currentTime, 0.02);
    } catch {
      /* no-op */
    }
  }

  /** Ready to make noise: context exists, running, and setting is on. */
  private live(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && this.enabledFn();
  }

  /** Toggle off: kill every loop NOW and silence the master. */
  silence(): void {
    this.stopLoops();
    if (this.ctx && this.master) {
      try {
        this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      } catch {
        /* no-op */
      }
    }
  }

  /** Snapshot for the debug handle / rig. */
  state(): AudioStateSnapshot {
    return {
      supported: this.supported,
      unlocked: !!this.ctx,
      ctxState: this.ctx ? this.ctx.state : 'none',
      enabled: this.enabledFn(),
      engineRunning: !!this.engine,
      engineFreqHz: Math.round(this.curEngineFreq * 10) / 10,
      engineGain: Math.round(this.curEngineGain * 1000) / 1000,
      sirenActive: this.curSirenGain > 0,
      sirenGain: Math.round(this.curSirenGain * 1000) / 1000,
      sirenToneHz: this.curSirenTone,
      skidGain: Math.round(this.curSkidGain * 1000) / 1000,
      radioStation: this.curStation,
      radioStep: this.radioStep,
    };
  }

  // --- continuous layers -----------------------------------------------------

  /** One call per frame from main.ts (after gatherInputs/hud). */
  update(s: AudioUpdateState, dt: number): void {
    if (!this.ctx) return;
    if (!this.enabledFn() || this.ctx.state !== 'running') {
      if (this.engine || this.siren || this.skid) this.stopLoops();
      return;
    }
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Engine.
    if (s.inCar) {
      if (!this.engine) this.startEngine();
      if (this.engine) {
        this.curEngineFreq = engineFreqHz(s.speedKmh, s.throttle, s.carClass);
        this.curEngineGain = engineGainFor(s.speedKmh, s.throttle);
        const top = TOP_SPEED_KMH[s.carClass] ?? TOP_SPEED_KMH.standard;
        const sr = Math.max(0, Math.min(1, Math.abs(s.speedKmh) / top));
        try {
          this.engine.osc.frequency.setTargetAtTime(this.curEngineFreq, t, TAU);
          this.engine.gain.gain.setTargetAtTime(this.curEngineGain, t, TAU);
          this.engine.filter.frequency.setTargetAtTime(320 + 950 * sr, t, TAU);
        } catch { /* no-op */ }
      }
    } else if (this.engine) {
      this.stopEngine();
    }

    // Siren: same distance rule on foot or in a car.
    const wantSiren = s.stars >= 1 && s.nearestCopM !== null ? sirenGainFor(s.nearestCopM) : 0;
    if (wantSiren > 0) {
      if (!this.siren) this.startSiren();
      if (this.siren) {
        this.sirenPhase += dt;
        const tone = this.sirenPhase % 0.72 < 0.36 ? 720 : 960;
        if (tone !== this.curSirenTone) {
          this.curSirenTone = tone;
          try {
            this.siren.osc.frequency.setTargetAtTime(tone, t, 0.02);
          } catch { /* no-op */ }
        }
        this.curSirenGain = wantSiren;
        try {
          this.siren.gain.gain.setTargetAtTime(wantSiren, t, 0.09);
        } catch { /* no-op */ }
      }
    } else if (this.siren) {
      this.curSirenGain = 0;
      try {
        this.siren.gain.gain.setTargetAtTime(0, t, 0.05);
      } catch { /* no-op */ }
    }

    // Skid (lives and dies with the car, unlike the siren).
    const wantSkid = s.inCar ? skidGainFor(s.slipDeg, s.speedKmh, s.handbrake) : 0;
    if (!s.inCar && this.skid) {
      this.skid.stop();
      this.skid = null;
      this.curSkidGain = 0;
    } else if (wantSkid > 0) {
      if (!this.skid) this.startSkid();
      if (this.skid) {
        this.curSkidGain = wantSkid;
        try {
          this.skid.gain.gain.setTargetAtTime(wantSkid, t, 0.03);
        } catch { /* no-op */ }
      }
    } else if (this.skid) {
      this.curSkidGain = 0;
      try {
        this.skid.gain.gain.setTargetAtTime(0, t, 0.03);
      } catch { /* no-op */ }
    }

    // Radio (v0.30): a 16-step eighth-note sequencer, scheduled as
    // one-shot notes (so silence()/toggle-off needs no bookkeeping —
    // the master gain parks and the sequencer stops advancing).
    const wantStation = s.radioStation ?? -1;
    if (s.inCar && wantStation >= 0 && wantStation < STATIONS.length) {
      if (wantStation !== this.curStation) {
        this.curStation = wantStation;
        this.radioStep = 0;
        this.radioAcc = 0;
      }
      const st = STATIONS[this.curStation];
      const stepDur = 60 / st.bpm / 2;
      this.radioAcc += dt;
      while (this.radioAcc >= stepDur) {
        this.radioAcc -= stepDur;
        const step = this.radioStep;
        this.radioStep = (this.radioStep + 1) % 16;
        const bassNote = st.bass[step];
        if (bassNote >= 0) {
          this.tone({ type: st.wave, f0: noteHz(55, bassNote), dur: stepDur * 0.92, gain: 0.13 });
        }
        if (step % 2 === 0) {
          const arpNote = st.arp[(step / 2) % st.arp.length];
          this.tone({ type: 'triangle', f0: noteHz(55, arpNote), dur: stepDur * 0.8, gain: 0.045 });
        } else {
          // Hat tick on the off-steps.
          this.noiseHit({ dur: 0.03, gain: 0.035, freq: 7000 });
        }
      }
    } else {
      this.curStation = -1;
      this.radioAcc = 0;
    }
  }

  private startEngine(): void {
    if (!this.ctx || !this.master || this.engine) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = ENGINE_IDLE_HZ;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 1.1;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start();
    this.engine = {
      osc,
      filter,
      gain,
      stop: () => {
        try { osc.stop(); } catch { /* already stopped */ }
        try { osc.disconnect(); filter.disconnect(); gain.disconnect(); } catch { /* no-op */ }
      },
    };
    this.curEngineFreq = ENGINE_IDLE_HZ;
  }

  private stopEngine(): void {
    this.engine?.stop();
    this.engine = null;
    this.curEngineFreq = 0;
    this.curEngineGain = 0;
  }

  private startSiren(): void {
    if (!this.ctx || !this.master || this.siren) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 720;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(this.master);
    osc.start();
    this.curSirenTone = 720;
    this.sirenPhase = 0;
    this.siren = {
      osc,
      gain,
      stop: () => {
        try { osc.stop(); } catch { /* already stopped */ }
        try { osc.disconnect(); gain.disconnect(); } catch { /* no-op */ }
      },
    };
  }

  private startSkid(): void {
    if (!this.ctx || !this.master || !this.noiseBuf || this.skid) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 850;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    this.skid = {
      gain,
      stop: () => {
        try { src.stop(); } catch { /* already stopped */ }
        try { src.disconnect(); filter.disconnect(); gain.disconnect(); } catch { /* no-op */ }
      },
    };
  }

  private stopLoops(): void {
    this.stopEngine();
    this.siren?.stop();
    this.siren = null;
    this.curSirenGain = 0;
    this.curSirenTone = 0;
    this.skid?.stop();
    this.skid = null;
    this.curSkidGain = 0;
  }

  // --- one-shot helpers ------------------------------------------------------

  /** A single oscillator note with an attack/decay envelope. */
  private tone(opts: {
    type: OscillatorType;
    f0: number;
    f1?: number;
    dur: number;
    gain: number;
    delay?: number;
  }): void {
    if (!this.live() || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(Math.max(20, opts.f0), t0);
    if (opts.f1 !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t0 + opts.dur);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(opts.gain, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + opts.dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.05);
  }

  /** A filtered noise burst (thuds, door slams, impacts). */
  private noiseHit(opts: { dur: number; gain: number; freq: number; delay?: number }): void {
    if (!this.live() || !this.ctx || !this.master || !this.noiseBuf) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = opts.freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(opts.gain, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + opts.dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t0);
    src.stop(t0 + opts.dur + 0.05);
  }

  // --- one-shot events (mirror the haptics table) ----------------------------

  /** Tiny tick for UI presses / E. */
  tick(): void {
    this.tone({ type: 'square', f0: 1250, dur: 0.035, gain: 0.05 });
  }

  /** Door thunk + a little starter-motor blip as the engine catches. */
  enterCar(): void {
    this.noiseHit({ dur: 0.11, gain: 0.22, freq: 500 });
    this.tone({ type: 'sawtooth', f0: 42, f1: 88, dur: 0.28, gain: 0.06, delay: 0.05 });
  }

  /** Softer door thunk getting out. */
  exitCar(): void {
    this.noiseHit({ dur: 0.09, gain: 0.12, freq: 420 });
  }

  /** Collision thud scaled by impact; throttled ≥120 ms, like haptics. */
  collision(strength01: number): void {
    const now = performance.now();
    if (now - this.lastCollisionAt < 120) return;
    this.lastCollisionAt = now;
    const s = Math.max(0, Math.min(1, strength01));
    this.noiseHit({ dur: 0.08 + 0.16 * s, gain: 0.12 + 0.3 * s, freq: 300 + 500 * s });
    if (s > 0.55) this.tone({ type: 'sine', f0: 120, f1: 45, dur: 0.22, gain: 0.12 });
  }

  /** Payphone answered: two quick pager beeps. */
  payphone(): void {
    this.tone({ type: 'square', f0: 1046, dur: 0.07, gain: 0.07 });
    this.tone({ type: 'square', f0: 1046, dur: 0.09, gain: 0.07, delay: 0.13 });
  }

  /** Mission complete: short rising arpeggio. */
  missionComplete(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.16, gain: 0.09, delay: i * 0.085 }));
  }

  /** District complete: the mission sting, one note higher and held. */
  districtComplete(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) =>
      this.tone({ type: 'triangle', f0: f, dur: i === notes.length - 1 ? 0.42 : 0.16, gain: 0.1, delay: i * 0.09 }),
    );
  }

  /** BUSTED: harsh descending buzz. */
  busted(): void {
    this.tone({ type: 'sawtooth', f0: 300, f1: 78, dur: 0.55, gain: 0.15 });
    this.tone({ type: 'square', f0: 150, f1: 55, dur: 0.55, gain: 0.07 });
  }

  /** WASTED (and game over): low sinking tone. */
  wasted(): void {
    this.tone({ type: 'sine', f0: 220, f1: 38, dur: 0.95, gain: 0.17 });
    this.tone({ type: 'triangle', f0: 110, f1: 30, dur: 0.95, gain: 0.1 });
  }

  // --- v0.30 combat / world one-shots ---------------------------------------

  /** A shot, voiced per weapon. The MG fires ~11×/s — kept short. */
  shot(weaponId: string): void {
    switch (weaponId) {
      case 'mg':
        this.noiseHit({ dur: 0.05, gain: 0.2, freq: 2300 });
        this.tone({ type: 'square', f0: 170, f1: 70, dur: 0.045, gain: 0.06 });
        break;
      case 'rocket':
        this.noiseHit({ dur: 0.5, gain: 0.3, freq: 900 });
        this.tone({ type: 'sawtooth', f0: 95, f1: 42, dur: 0.5, gain: 0.14 });
        break;
      case 'flame':
        this.noiseHit({ dur: 0.11, gain: 0.13, freq: 850 });
        break;
      case 'fists':
        this.noiseHit({ dur: 0.05, gain: 0.1, freq: 380 });
        break;
      default: // pistol
        this.noiseHit({ dur: 0.08, gain: 0.3, freq: 2600 });
        this.tone({ type: 'square', f0: 190, f1: 60, dur: 0.07, gain: 0.09 });
    }
  }

  /** The big one: sub thump + crack + a rumble tail. */
  explosion(): void {
    this.noiseHit({ dur: 0.7, gain: 0.5, freq: 240 });
    this.tone({ type: 'sine', f0: 95, f1: 26, dur: 0.85, gain: 0.42 });
    this.noiseHit({ dur: 0.5, gain: 0.22, freq: 110, delay: 0.09 });
  }

  /** Water entry: a bright splash wash. */
  splash(): void {
    this.noiseHit({ dur: 0.38, gain: 0.26, freq: 1500 });
    this.tone({ type: 'sine', f0: 320, f1: 85, dur: 0.32, gain: 0.06 });
  }

  /** Pickup collected: a two-note lift. */
  pickup(): void {
    this.tone({ type: 'square', f0: 880, dur: 0.06, gain: 0.07 });
    this.tone({ type: 'square', f0: 1318, dur: 0.09, gain: 0.07, delay: 0.06 });
  }

  /** Kill Frenzy start: a fast rising alarm of square notes. */
  frenzyStart(): void {
    const notes = [392, 523.25, 659.25, 783.99];
    notes.forEach((f, i) => this.tone({ type: 'square', f0: f, dur: 0.09, gain: 0.08, delay: i * 0.07 }));
  }
}
