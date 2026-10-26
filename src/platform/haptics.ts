/**
 * Haptics — Vibration API event engine (v0.21, platform layer).
 *
 * Lives OUTSIDE the core on purpose: the core stays DOM-free and the
 * events are inferred in src/main.ts from HUD/state transitions (enter
 * car, toast text, stamp changes, health drops).
 *
 * Platform reality: `navigator.vibrate` works in Android Chrome
 * (Daniel's Pixel) after the first user interaction; it has NO
 * amplitude control, so intensity is simulated with pulse duration /
 * pattern density. iOS Safari does not implement it at all — every
 * call here degrades to a silent no-op.
 */
export class Haptics {
  readonly supported: boolean;
  private enabledFn: () => boolean;
  private lastPulseAt = 0;

  constructor(enabledFn: () => boolean) {
    this.enabledFn = enabledFn;
    this.supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  private fire(pattern: number | number[]): void {
    if (!this.supported || !this.enabledFn()) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* some browsers throw outside a user gesture — haptics are garnish */
    }
  }

  /** Tiny tick for UI presses / E. */
  tick(): void {
    this.fire(12);
  }

  /** Getting into a car. */
  enterCar(): void {
    this.fire(20);
  }

  /** Collision pulse scaled by impact size; throttled to ≥120 ms apart. */
  collision(strength01: number): void {
    const now = performance.now();
    if (now - this.lastPulseAt < 120) return;
    this.lastPulseAt = now;
    const ms = Math.round(15 + Math.max(0, Math.min(1, strength01)) * 65); // 15–80 ms
    this.fire(ms);
  }

  /** Mission complete. */
  missionComplete(): void {
    this.fire([40, 60, 40]);
  }

  /** Payphone answered / mission started. */
  payphone(): void {
    this.fire([25, 40, 25]);
  }

  busted(): void {
    this.fire([90, 60, 90, 60, 180]);
  }

  wasted(): void {
    this.fire([200, 80, 200]);
  }

  /** Stop any running pattern (stamp screens ending, toggle off). */
  cancel(): void {
    if (!this.supported) return;
    try {
      navigator.vibrate(0);
    } catch {
      /* no-op */
    }
  }
}
