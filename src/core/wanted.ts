/**
 * Wanted level, 0-5 stars — a miniature of the desktop game's Wanted
 * autoload (single source of heat). Heat is continuous; stars are the
 * floored display value. Heat decays over time.
 */
export class Wanted {
  /** 0..5 continuous heat. */
  heat = 0;
  private decayPerSec = 1 / 20; // one star per 20 s of staying clean

  get stars(): number {
    return Math.max(0, Math.min(5, Math.floor(this.heat + 1e-9)));
  }

  /** Add heat (e.g. hitting another car = +1). Clamped to 5. */
  add(amount: number): void {
    this.heat = Math.max(0, Math.min(5, this.heat + amount));
  }

  update(dt: number): void {
    if (this.heat > 0) this.heat = Math.max(0, this.heat - this.decayPerSec * dt);
  }

  reset(): void {
    this.heat = 0;
  }
}
