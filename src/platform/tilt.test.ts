/**
 * Tilt steering tests (v0.31): the pure angle→steer math and the
 * sensor seam, driven through the same handler path real
 * DeviceOrientationEvents use (handleEvent → onEvent → steer).
 */
import { describe, expect, it } from 'vitest';
import {
  TiltSensor,
  tiltConfigFor,
  tiltSteer,
  wrapDeg,
  TILT_SENSITIVITIES,
} from './tilt';

const STD = tiltConfigFor('standard'); // 30° full lock, 2° dead zone

describe('wrapDeg', () => {
  it('keeps in-range angles untouched', () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(45)).toBe(45);
    expect(wrapDeg(-90)).toBe(-90);
    expect(wrapDeg(180)).toBe(180);
  });
  it('wraps past the seam instead of reading as a yank', () => {
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(540)).toBe(180);
  });
});

describe('tiltSteer — the pure mapping', () => {
  it('is 0 at neutral and throughout the dead zone', () => {
    expect(tiltSteer(10, 10, STD)).toBe(0);
    expect(tiltSteer(12, 10, STD)).toBe(0); // exactly +2°: still dead
    expect(tiltSteer(8, 10, STD)).toBe(0);
  });
  it('positive roll (right edge down) steers right (positive)', () => {
    expect(tiltSteer(26, 10, STD)).toBeGreaterThan(0);
    expect(tiltSteer(-6, 10, STD)).toBeLessThan(0);
  });
  it('is linear between dead zone and full lock', () => {
    // 16° over neutral = 14° past the 2° dead zone of a 28° span → 0.5
    expect(tiltSteer(26, 10, STD)).toBeCloseTo(0.5, 6);
    expect(tiltSteer(-6, 10, STD)).toBeCloseTo(-0.5, 6);
  });
  it('reaches exactly ±1 at full lock and clamps beyond', () => {
    expect(tiltSteer(40, 10, STD)).toBe(1);
    expect(tiltSteer(85, 10, STD)).toBe(1);
    expect(tiltSteer(-20, 10, STD)).toBe(-1);
    expect(tiltSteer(-80, 10, STD)).toBe(-1);
  });
  it('calibration offset moves the whole map', () => {
    // A player who holds the phone rolled 12° right at rest:
    // their 12° IS straight, and 12+30 is their full lock.
    expect(tiltSteer(12, 12, STD)).toBe(0);
    expect(tiltSteer(42, 12, STD)).toBe(1);
    expect(tiltSteer(27, 12, STD)).toBeCloseTo((15 - 2) / 28, 6);
  });
  it('wraps differences instead of spiking across the seam', () => {
    expect(Math.abs(tiltSteer(-170, 170, STD))).toBeLessThanOrEqual(1);
  });
  it('sensitivity presets order the full-lock range', () => {
    expect(TILT_SENSITIVITIES.high.fullLockDeg).toBeLessThan(TILT_SENSITIVITIES.standard.fullLockDeg);
    expect(TILT_SENSITIVITIES.standard.fullLockDeg).toBeLessThan(TILT_SENSITIVITIES.low.fullLockDeg);
    // Same physical roll, more steer on High than on Low.
    const roll = 24;
    expect(tiltSteer(roll, 0, tiltConfigFor('high'))).toBeGreaterThan(
      tiltSteer(roll, 0, tiltConfigFor('low')),
    );
    expect(tiltSteer(roll, 0, tiltConfigFor('bogus'))).toBe(tiltSteer(roll, 0, STD));
  });
});

describe('TiltSensor — the seam', () => {
  function fakeTarget() {
    const listeners = new Map<string, Set<EventListener>>();
    return {
      addEventListener(type: string, fn: EventListener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: EventListener) {
        listeners.get(type)?.delete(fn);
      },
      fire(gamma: number | null) {
        const e = { gamma } as unknown as DeviceOrientationEvent;
        for (const fn of listeners.get('deviceorientation') ?? []) fn(e as unknown as Event);
      },
      count() {
        return listeners.get('deviceorientation')?.size ?? 0;
      },
    };
  }

  it('captures the neutral from the first samples after listen', () => {
    const s = new TiltSensor(fakeTarget(), null);
    s.listen();
    for (let i = 0; i < 8; i++) s.handleEvent({ gamma: 15 });
    expect(s.snapshot().neutral).toBe(15);
    expect(s.steer(STD)).toBe(0); // holding the calibrated pose = straight
  });

  it('steers relative to the captured neutral, through the handler path', () => {
    const s = new TiltSensor(fakeTarget(), null);
    s.listen();
    for (let i = 0; i < 8; i++) s.handleEvent({ gamma: 0 });
    for (let i = 0; i < 30; i++) s.handleEvent({ gamma: 32 }); // let the EMA settle
    expect(s.steer(STD)).toBe(1);
    for (let i = 0; i < 30; i++) s.handleEvent({ gamma: -32 });
    expect(s.steer(STD)).toBe(-1);
  });

  it('ignores null-angle events (the desktop no-sensor case)', () => {
    const s = new TiltSensor(fakeTarget(), null);
    s.listen();
    s.handleEvent({ gamma: null });
    expect(s.snapshot().samples).toBe(0);
    expect(s.snapshot().live).toBe(false);
    expect(s.steer(STD)).toBe(0);
  });

  it('calibrate() re-zeros at the current pose', () => {
    const s = new TiltSensor(fakeTarget(), null);
    s.listen();
    for (let i = 0; i < 8; i++) s.handleEvent({ gamma: 0 });
    for (let i = 0; i < 30; i++) s.handleEvent({ gamma: 20 });
    expect(s.steer(STD)).toBeGreaterThan(0.5);
    expect(s.calibrate()).toBe(true);
    expect(s.steer(STD)).toBe(0);
  });

  it('enable() resolves silent when no usable sample arrives', async () => {
    const s = new TiltSensor(fakeTarget(), null);
    await expect(s.enable(60)).resolves.toBe('silent');
  });

  it('enable() resolves ok once samples flow', async () => {
    const s = new TiltSensor(fakeTarget(), null);
    const p = s.enable(800);
    s.handleEvent({ gamma: 3 });
    await expect(p).resolves.toBe('ok');
  });

  it('enable() maps a refused permission to denied and never listens', async () => {
    const t = fakeTarget();
    const s = new TiltSensor(t, async () => 'denied');
    await expect(s.enable(10)).resolves.toBe('denied');
    expect(t.count()).toBe(0);
  });

  it('stop() detaches the listener', () => {
    const t = fakeTarget();
    const s = new TiltSensor(t, null);
    s.listen();
    expect(t.count()).toBe(1);
    s.stop();
    expect(t.count()).toBe(0);
  });
});
