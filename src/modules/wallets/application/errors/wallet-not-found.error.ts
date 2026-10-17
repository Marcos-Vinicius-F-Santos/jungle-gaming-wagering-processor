export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`wallet ${walletId} was not found`);
    this.name = 'WalletNotFoundError';
  }
}
