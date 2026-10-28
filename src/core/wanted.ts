/**
 * Wanted level, 0-5 stars — a miniature of the desktop game's Wanted
 * autoload (single source of heat). Heat is continuous; stars are the
 * floored display value. Heat decays over time.
 *
 * v0.30 (GTA 1 teeth): decay slowed to one star per 60 s, and the
 * GAME only calls update() while no cop has eyes on the player (a
 * cop within sight range pauses decay entirely) — hiding has to
 * actually break contact now, not just wait out a 20 s melt.
 * Iteration 3 mayhem dial: decay slows again, 60 s → 90 s per star
 * — heat is stickier; shaking a wanted level is a drive, not a
 * pause.
 */
export class Wanted {
  /** 0..5 continuous heat. */
  heat = 0;
  private decayPerSec = 1 / 90; // iteration 3: one star per 90 s of staying clean AND unseen

  get stars(): number {
    // All heat sources add whole stars, so display rounds: a fresh
    // 2-star heat reads 2 until decay has eaten half a star (floor()
    // would drop it to 1 the instant decay starts).
    return Math.max(0, Math.min(5, Math.round(this.heat)));
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
