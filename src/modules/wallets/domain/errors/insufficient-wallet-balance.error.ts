export class InsufficientWalletBalanceError extends Error {
  constructor() {
    super('wallet balance is insufficient');
    this.name = 'InsufficientWalletBalanceError';
  }
}
