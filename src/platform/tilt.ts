/**
 * Tilt steering — pure math + the sensor seam (v0.31).
 *
 * Why this exists: Daniel's v0.30 verdict — the thumb wheel "isn't
 * working for me", and he remembers steering a free mobile racer by
 * tilting the phone ~15 years ago. The research survey
 * (docs/CONTROLS-RESEARCH.md) says the same thing the memory does:
 * every serious mobile driving game offers tilt as a peer scheme,
 * the sim-leaning ones (Real Racing 3, GRID Autosport) DEFAULT to
 * it, and they all calibrate the player's neutral pose rather than
 * assuming one.
 *
 * Mapping (portrait play): DeviceOrientationEvent.gamma is the
 * left–right roll (−90…90°). Rolling the phone like a wheel —
 * right edge down — gives positive gamma and must steer right
 * (positive steer, same sign convention as KeyD / stick dx).
 *
 * The pure function emits a NORMALIZED LINEAR deflection, exactly
 * like the keyboard and the stick's raw dx do; the response curve
 * stays owned by the shared merge in main.ts (shapeSteer |s|^0.7),
 * so tilt gets the identical feel pipeline and the v0.27 stick
 * behaviour / drive metrics are untouched. What lives here:
 * calibration offset, angle wrap, dead zone, full-lock range,
 * clamping — the parts that are tilt-specific.
 */

export interface TiltConfig {
  /** Roll (degrees from neutral) that reaches full lock. */
  fullLockDeg: number;
  /** Rolls within ±this of neutral read as 0. */
  deadZoneDeg: number;
}

export const TILT_FULL_LOCK_DEG = 30;
export const TILT_DEAD_ZONE_DEG = 2;

/** Sensitivity presets (settings: Low / Standard / High). Higher
 *  sensitivity = LESS roll to full lock. */
export const TILT_SENSITIVITIES: Record<string, TiltConfig> = {
  low: { fullLockDeg: 38, deadZoneDeg: TILT_DEAD_ZONE_DEG },
  standard: { fullLockDeg: TILT_FULL_LOCK_DEG, deadZoneDeg: TILT_DEAD_ZONE_DEG },
  high: { fullLockDeg: 22, deadZoneDeg: TILT_DEAD_ZONE_DEG },
};
export const TILT_DEFAULT_SENSITIVITY = 'standard';

export function tiltConfigFor(sensitivity: string): TiltConfig {
  return TILT_SENSITIVITIES[sensitivity] ?? TILT_SENSITIVITIES[TILT_DEFAULT_SENSITIVITY];
}

/** Wrap an angle difference into (−180, 180]. Gamma itself only
 *  spans ±90, but a neutral captured near an edge (or a beta-flip
 *  pose) can push the difference past a seam — never let a wrap
 *  read as a full-lock yank. */
export function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Normalized steer deflection (−1…1) for a raw gamma sample.
 * 0 inside the dead zone, ±1 at (and beyond) full lock, linear in
 * between; the merge applies the response curve, as for every
 * other input source.
 */
export function tiltSteer(rawGamma: number, neutralGamma: number, cfg: TiltConfig): number {
  const rel = wrapDeg(rawGamma - neutralGamma);
  const a = Math.abs(rel);
  if (a <= cfg.deadZoneDeg) return 0;
  const span = Math.max(1, cfg.fullLockDeg - cfg.deadZoneDeg);
  const t = Math.min(1, (a - cfg.deadZoneDeg) / span);
  return Math.sign(rel) * t;
}

export type TiltEnableResult = 'ok' | 'unsupported' | 'denied' | 'silent';

export interface TiltSnapshot {
  /** Listener attached and at least one usable sample received. */
  live: boolean;
  /** Smoothed gamma (degrees), null before the first sample. */
  gamma: number | null;
  /** Calibrated neutral gamma (degrees). */
  neutral: number;
  /** Usable (non-null gamma) samples received since enable. */
  samples: number;
  /** ms since the last usable sample, or null if none yet. */
  ageMs: number | null;
}

interface OrientationEventLike {
  gamma: number | null;
}

type OrientationTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * The sensor seam. Platform realities handled here (research doc):
 * iOS 13+ gates the events behind DeviceOrientationEvent
 * .requestPermission(), which must be called from a user gesture;
 * Android Chrome on HTTPS delivers them freely; desktops may fire
 * events whose angles are all null — so "available" is decided by
 * actual non-null samples arriving, never by API presence.
 */
export class TiltSensor {
  private target: OrientationTarget;
  private permissionFn: (() => Promise<string>) | null;
  /** True when deps were injected (tests) — API presence is then
   *  the caller's fixture, not the global window's. */
  private injected: boolean;
  private listening = false;
  private gamma: number | null = null;
  private neutralSum = 0;
  private neutralCount = 0;
  neutral = 0;
  samples = 0;
  private lastSampleAt = 0;
  /** Samples averaged into the neutral on enable (the RR3 ritual:
   *  hold your pose, the game zeroes on it). */
  private static NEUTRAL_SAMPLES = 8;
  private calibrating = 0;

  constructor(
    target?: OrientationTarget,
    permissionFn?: (() => Promise<string>) | null,
  ) {
    this.injected = target !== undefined || permissionFn !== undefined;
    this.target = target ?? window;
    if (permissionFn !== undefined) {
      this.permissionFn = permissionFn;
    } else {
      const DOE = (window as unknown as {
        DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
      }).DeviceOrientationEvent;
      this.permissionFn =
        DOE && typeof DOE.requestPermission === 'function'
          ? () => DOE.requestPermission!()
          : null;
    }
  }

  /** True when this platform gates events behind a permission ask. */
  needsPermission(): boolean {
    return this.permissionFn !== null;
  }

  static supported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  private onEvent = (e: OrientationEventLike): void => {
    if (e.gamma === null || e.gamma === undefined || Number.isNaN(e.gamma)) return;
    // EMA smoothing (α 0.35): the research consensus is a low-pass
    // over raw samples so tremor doesn't become steering, with the
    // dead zone sized for what smoothing can't remove.
    this.gamma = this.gamma === null ? e.gamma : this.gamma + 0.35 * (e.gamma - this.gamma);
    this.samples += 1;
    this.lastSampleAt = performance.now();
    if (this.calibrating > 0) {
      this.neutralSum += e.gamma;
      this.neutralCount += 1;
      this.calibrating -= 1;
      if (this.calibrating === 0 && this.neutralCount > 0) {
        this.neutral = this.neutralSum / this.neutralCount;
      }
    }
  };

  /** Attach the listener (idempotent). Does NOT ask permission —
   *  on iOS that needs a gesture; use enable() from the tap. */
  listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.calibrating = TiltSensor.NEUTRAL_SAMPLES;
    this.neutralSum = 0;
    this.neutralCount = 0;
    this.target.addEventListener('deviceorientation', this.onEvent as unknown as EventListener);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.target.removeEventListener('deviceorientation', this.onEvent as unknown as EventListener);
  }

  /**
   * Full enable flow, from a user gesture: permission (when the
   * platform requires it) → listen → wait briefly for real samples.
   * 'silent' means the API exists but no usable angle arrived —
   * the caller must fall back rather than leave dead steering.
   */
  async enable(waitMs = 1500): Promise<TiltEnableResult> {
    if (!this.injected && !TiltSensor.supported()) return 'unsupported';
    if (this.permissionFn) {
      let res: string;
      try {
        res = await this.permissionFn();
      } catch {
        return 'denied';
      }
      if (res !== 'granted') return 'denied';
    }
    this.listen();
    const t0 = Date.now();
    while (this.samples === 0 && Date.now() - t0 < waitMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.samples > 0 ? 'ok' : 'silent';
  }

  /** Re-zero the neutral at the CURRENT pose (Calibrate button):
   *  instant when samples are flowing — the pose you're holding is
   *  the pose that should go straight. */
  calibrate(): boolean {
    if (this.gamma === null) return false;
    this.neutral = this.gamma;
    return true;
  }

  /** Route the auto-capture (first samples after listen) manually
   *  in tests: feed one event through the real handler path. */
  handleEvent(e: OrientationEventLike): void {
    this.onEvent(e);
  }

  snapshot(): TiltSnapshot {
    return {
      live: this.listening && this.samples > 0,
      gamma: this.gamma,
      neutral: Math.round(this.neutral * 10) / 10,
      samples: this.samples,
      ageMs: this.samples > 0 ? Math.round(performance.now() - this.lastSampleAt) : null,
    };
  }

  /** Current normalized steer deflection for the merge. 0 unless
   *  samples are fresh (<600 ms) — a sensor that went quiet must
   *  never hold a steering angle hostage. */
  steer(cfg: TiltConfig): number {
    if (this.gamma === null || this.samples === 0) return 0;
    if (performance.now() - this.lastSampleAt > 600) return 0;
    return tiltSteer(this.gamma, this.neutral, cfg);
  }
}
