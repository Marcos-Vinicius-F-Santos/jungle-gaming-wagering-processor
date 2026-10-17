export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`wallet already exists for player ${playerId} and currency ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}
