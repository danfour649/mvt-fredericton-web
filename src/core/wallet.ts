/**
 * Score — in GTA 1 terms the score IS the money: one meter, denominated
 * in $, and the multiplier is the real progression. Every gain runs
 * through earn() and is multiplied. Completing a mission raises the
 * multiplier by 1. Getting busted halves it (floor x1) and costs a flat
 * fine. (Kept in wallet.ts — the v0 Wallet grew up into this.)
 */

export const BUSTED_FINE = 1000;
export const HOSPITAL_FEE = 500;

export class Wallet {
  /** Current score / money. */
  money = 0;
  /** Score multiplier, x1 at the start of a run. */
  multiplier = 1;

  /** Gain `base` points, multiplied. Returns the amount actually gained. */
  earn(base: number): number {
    const gained = Math.round(base * this.multiplier);
    this.money += gained;
    return gained;
  }

  /** Pay up to `amount` (never below $0). Returns the amount paid. */
  spend(amount: number): number {
    const paid = Math.max(0, Math.min(this.money, amount));
    this.money -= paid;
    return paid;
  }

  /** A completed mission bumps the multiplier for everything after it. */
  missionCompleted(): void {
    this.multiplier += 1;
  }

  /**
   * BUSTED: flat fine confiscated and the multiplier is halved
   * (rounded down, never below x1). Returns the fine paid.
   */
  bustedPenalty(): number {
    const fine = this.spend(BUSTED_FINE);
    this.multiplier = Math.max(1, Math.floor(this.multiplier / 2));
    return fine;
  }

  set(amount: number): void {
    this.money = amount;
  }
}
