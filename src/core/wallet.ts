/** Player money — a miniature of the desktop game's Wallet autoload. */
export class Wallet {
  money = 0;

  add(amount: number): void {
    this.money += amount;
  }

  set(amount: number): void {
    this.money = amount;
  }
}
