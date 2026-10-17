export class InvalidReconciliationIdentifierError extends Error {
  constructor(walletId: string) {
    super(`wallet identifier ${walletId} is invalid`);
    this.name = 'InvalidReconciliationIdentifierError';
  }
}
