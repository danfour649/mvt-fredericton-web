/**
 * v0.26: WebAudio synth layer, asserted against a fake AudioContext
 * that records every node and param call. The seam points are the
 * same ones the production rig reads via window.__mvtAudio:
 * engine freq/gain targets, siren gain/tone, skid gain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GameAudio,
  engineFreqHz,
  engineGainFor,
  sirenGainFor,
  skidGainFor,
  SIREN_RANGE_M,
  type AudioUpdateState,
} from './audio';

// --- fake WebAudio ----------------------------------------------------------

class FakeParam {
  value: number;
  calls: [string, ...number[]][] = [];
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number): void {
    this.calls.push(['setValueAtTime', v, t]);
    this.value = v;
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.calls.push(['linearRampToValueAtTime', v, t]);
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number, t: number): void {
    this.calls.push(['exponentialRampToValueAtTime', v, t]);
    this.value = v;
  }
  setTargetAtTime(v: number, t: number, tau: number): void {
    this.calls.push(['setTargetAtTime', v, t, tau]);
    this.value = v;
  }
}

class FakeNode {
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}
class FakeOsc extends FakeNode {
  type: OscillatorType = 'sine';
  frequency = new FakeParam(440);
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}
class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(0.0001);
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  playbackRate = new FakeParam(1);
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeCtx {
  currentTime = 0;
  sampleRate = 44100;
  state = 'running';
  destination = new FakeNode();
  gains: FakeGain[] = [];
  oscs: FakeOsc[] = [];
  filters: FakeFilter[] = [];
  sources: FakeSource[] = [];
  resumeCalls = 0;
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator(): FakeOsc {
    const o = new FakeOsc();
    this.oscs.push(o);
    return o;
  }
  createBiquadFilter(): FakeFilter {
    const f = new FakeFilter();
    this.filters.push(f);
    return f;
  }
  createBuffer(_ch: number, len: number): { getChannelData: () => Float32Array } {
    return { getChannelData: () => new Float32Array(len) };
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }
}

const baseUpdate: AudioUpdateState = {
  inCar: false,
  speedKmh: 0,
  throttle: 0,
  carClass: 'standard',
  slipDeg: 0,
  handbrake: false,
  stars: 0,
  nearestCopM: null,
};

// --- pure mappings ----------------------------------------------------------

describe('audio: pure mappings', () => {
  it('engine pitch maps speed → frequency monotonically, idle 55 Hz', () => {
    expect(engineFreqHz(0, 0, 'standard')).toBe(55);
    let prev = -Infinity;
    for (const v of [0, 20, 40, 60, 80, 100, 113]) {
      const f = engineFreqHz(v, 0.5, 'standard');
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
    // Beyond the class top speed the ratio clamps — pitch saturates.
    expect(engineFreqHz(140, 0.5, 'standard')).toBeCloseTo(engineFreqHz(113, 0.5, 'standard'), 5);
    // Top of the standard class: 55 + 150 + no load lift left.
    expect(engineFreqHz(113, 0, 'standard')).toBeCloseTo(205, 5);
    // Throttle load lifts pitch at low speed, not at top speed.
    expect(engineFreqHz(0, 1, 'standard')).toBeGreaterThan(engineFreqHz(0, 0, 'standard'));
    expect(engineFreqHz(113, 1, 'standard')).toBeCloseTo(engineFreqHz(113, 0, 'standard'), 5);
    // Class character: at the same fraction of its rev range the fast
    // car sits higher, and its redline pitch tops the standard car's.
    expect(engineFreqHz(0.8 * 143, 0, 'fast')).toBeGreaterThan(engineFreqHz(0.8 * 113, 0, 'standard'));
    expect(engineFreqHz(143, 0, 'fast')).toBeGreaterThan(engineFreqHz(113, 0, 'standard'));
    expect(engineGainFor(0, 0)).toBeGreaterThan(0);
  });

  it('siren gain falls off with cop distance, 0 at/over range', () => {
    expect(sirenGainFor(0)).toBeCloseTo(0.12, 5);
    expect(sirenGainFor(SIREN_RANGE_M)).toBe(0);
    expect(sirenGainFor(SIREN_RANGE_M + 40)).toBe(0);
    expect(sirenGainFor(60)).toBeGreaterThan(sirenGainFor(100));
    expect(sirenGainFor(100)).toBeGreaterThan(0);
  });

  it('skid gain needs speed + slip (or a handbrake lock)', () => {
    expect(skidGainFor(30, 60, false)).toBeGreaterThan(0.07);
    expect(skidGainFor(5, 60, false)).toBe(0);
    expect(skidGainFor(30, 10, false)).toBe(0);
    expect(skidGainFor(0, 40, true)).toBeGreaterThan(0);
    expect(skidGainFor(0, 40, false)).toBe(0);
  });
});

// --- the engine ---------------------------------------------------------------

describe('audio: GameAudio against a fake AudioContext', () => {
  let fake: FakeCtx;
  let factoryCalls = 0;
  let enabled = true;
  let nowMs = 1000;

  const make = (): GameAudio =>
    new GameAudio(
      () => enabled,
      () => {
        factoryCalls++;
        return fake as unknown as AudioContext;
      },
    );

  beforeEach(() => {
    fake = new FakeCtx();
    factoryCalls = 0;
    enabled = true;
    nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a silent no-op before the first gesture (context never created)', () => {
    const a = make();
    a.tick();
    a.enterCar();
    a.payphone();
    a.update({ ...baseUpdate, inCar: true, speedKmh: 80 }, 0.016);
    expect(factoryCalls).toBe(0);
    expect(a.state().unlocked).toBe(false);
    expect(a.state().ctxState).toBe('none');
    expect(a.state().engineRunning).toBe(false);
  });

  it('unlock creates the context + master gain; suspended ctx is resumed', () => {
    fake.state = 'suspended';
    const a = make();
    a.unlock();
    expect(factoryCalls).toBe(1);
    expect(fake.resumeCalls).toBe(1);
    expect(a.state().unlocked).toBe(true);
    expect(a.state().ctxState).toBe('running');
    // Master gain exists and sits at the master level.
    expect(fake.gains.length).toBe(1);
    expect(fake.gains[0].gain.value).toBeCloseTo(0.9, 5);
    // Unlocking again is a no-op.
    a.unlock();
    expect(factoryCalls).toBe(1);
  });

  it('engine starts in a car, pitch tracks speed, stops on exit', () => {
    const a = make();
    a.unlock();
    a.update({ ...baseUpdate, inCar: true, speedKmh: 0, throttle: 0 }, 0.016);
    expect(a.state().engineRunning).toBe(true);
    expect(a.state().engineFreqHz).toBeCloseTo(55, 0);
    const osc = fake.oscs[0];
    expect(osc.type).toBe('sawtooth');
    expect(osc.started).toBe(true);
    a.update({ ...baseUpdate, inCar: true, speedKmh: 56.5, throttle: 0 }, 0.016);
    expect(a.state().engineFreqHz).toBeCloseTo(130, 0);
    a.update({ ...baseUpdate, inCar: true, speedKmh: 113, throttle: 0 }, 0.016);
    expect(a.state().engineFreqHz).toBeCloseTo(205, 0);
    // Still the same single engine oscillator throughout.
    expect(fake.oscs.length).toBe(1);
    a.update({ ...baseUpdate, inCar: false }, 0.016);
    expect(a.state().engineRunning).toBe(false);
    expect(osc.stopped).toBe(true);
  });

  it('siren follows stars + nearest-cop distance and alternates tone', () => {
    const a = make();
    a.unlock();
    // No stars: silent even with a cop alongside.
    a.update({ ...baseUpdate, stars: 0, nearestCopM: 10 }, 0.016);
    expect(a.state().sirenGain).toBe(0);
    // Stars but cop out of range: silent.
    a.update({ ...baseUpdate, stars: 2, nearestCopM: 200 }, 0.016);
    expect(a.state().sirenGain).toBe(0);
    // Cop at 60 m: gain matches the mapping.
    a.update({ ...baseUpdate, stars: 1, nearestCopM: 60 }, 0.016);
    expect(a.state().sirenActive).toBe(true);
    expect(a.state().sirenGain).toBeCloseTo(sirenGainFor(60), 3);
    // Tone alternates 720 → 960 as phase accumulates.
    expect(a.state().sirenToneHz).toBe(720);
    a.update({ ...baseUpdate, stars: 1, nearestCopM: 60 }, 0.4);
    expect(a.state().sirenToneHz).toBe(960);
    // Closer cop = louder.
    a.update({ ...baseUpdate, stars: 1, nearestCopM: 20 }, 0.016);
    expect(a.state().sirenGain).toBeGreaterThan(sirenGainFor(60));
    // Heat gone: gain back to 0.
    a.update({ ...baseUpdate, stars: 0, nearestCopM: 20 }, 0.016);
    expect(a.state().sirenGain).toBe(0);
  });

  it('skid layer tracks slip and dies with the car', () => {
    const a = make();
    a.unlock();
    a.update({ ...baseUpdate, inCar: true, speedKmh: 60, slipDeg: 30 }, 0.016);
    expect(a.state().skidGain).toBeCloseTo(skidGainFor(30, 60, false), 3);
    expect(fake.sources.length).toBe(1);
    expect(fake.sources[0].loop).toBe(true);
    a.update({ ...baseUpdate, inCar: true, speedKmh: 60, slipDeg: 2 }, 0.016);
    expect(a.state().skidGain).toBe(0);
    a.update({ ...baseUpdate, inCar: false }, 0.016);
    expect(fake.sources[0].stopped).toBe(true);
  });

  it('one-shots build the expected synths', () => {
    const a = make();
    a.unlock();
    const oscCount = () => fake.oscs.length;

    a.tick();
    expect(fake.oscs.at(-1)?.type).toBe('square');
    expect(fake.oscs.at(-1)?.frequency.value).toBe(1250);

    a.payphone();
    const beeps = fake.oscs.slice(-2);
    expect(beeps.every((o) => o.type === 'square' && o.frequency.value === 1046)).toBe(true);

    const before = oscCount();
    a.missionComplete();
    const sting = fake.oscs.slice(before);
    expect(sting.length).toBe(4);
    expect(sting.map((o) => o.frequency.value)).toEqual([523.25, 659.25, 783.99, 1046.5]);

    a.busted();
    const bust = fake.oscs.at(-2);
    expect(bust?.type).toBe('sawtooth');
    expect(bust?.frequency.calls).toContainEqual(['exponentialRampToValueAtTime', 78, expect.any(Number)]);

    a.wasted();
    const sink = fake.oscs.at(-2);
    expect(sink?.type).toBe('sine');
    expect(sink?.frequency.calls).toContainEqual(['exponentialRampToValueAtTime', 38, expect.any(Number)]);

    a.enterCar();
    expect(fake.sources.length).toBeGreaterThan(0); // door thunk = noise burst
    a.exitCar();
    expect(fake.sources.length).toBeGreaterThan(1);
  });

  it('collision thud scales and throttles like haptics (≥120 ms)', () => {
    const a = make();
    a.unlock();
    a.collision(0.5);
    const after1 = fake.sources.length;
    expect(after1).toBe(1);
    a.collision(1); // same instant: throttled away
    expect(fake.sources.length).toBe(after1);
    nowMs += 200;
    const oscsBefore = fake.oscs.length;
    a.collision(1);
    expect(fake.sources.length).toBe(after1 + 1); // the noise burst
    expect(fake.oscs.length).toBe(oscsBefore + 1); // + low body tone for a big hit
  });

  it('toggle off silences everything: loops stopped, master parked, one-shots muted', () => {
    const a = make();
    a.unlock();
    a.update({ ...baseUpdate, inCar: true, speedKmh: 50, stars: 1, nearestCopM: 30 }, 0.016);
    expect(a.state().engineRunning).toBe(true);
    const master = fake.gains[0];

    enabled = false;
    a.silence();
    expect(a.state().engineRunning).toBe(false);
    expect(a.state().sirenGain).toBe(0);
    expect(master.gain.calls).toContainEqual(['setTargetAtTime', 0, expect.any(Number), expect.any(Number)]);

    // One-shots and updates make nothing while off.
    const oscs = fake.oscs.length;
    a.tick();
    a.busted();
    a.update({ ...baseUpdate, inCar: true, speedKmh: 50 }, 0.016);
    expect(fake.oscs.length).toBe(oscs);
    expect(a.state().engineRunning).toBe(false);

    // Back on: master restored, engine can start again.
    enabled = true;
    a.refreshMaster();
    expect(master.gain.calls).toContainEqual(['setTargetAtTime', 0.9, expect.any(Number), expect.any(Number)]);
    a.update({ ...baseUpdate, inCar: true, speedKmh: 50 }, 0.016);
    expect(a.state().engineRunning).toBe(true);
  });

  it('unavailable WebAudio (factory → null) never throws and stays silent', () => {
    const a = new GameAudio(() => true, () => null);
    expect(() => {
      a.unlock();
      a.tick();
      a.busted();
      a.update({ ...baseUpdate, inCar: true, speedKmh: 90, stars: 3, nearestCopM: 5 }, 0.016);
      a.silence();
    }).not.toThrow();
    expect(a.state().ctxState).toBe('none');
    expect(a.state().engineRunning).toBe(false);
  });
});
