export class TransactionNotFoundError extends Error {
  constructor() {
    super('TRANSACTION_NOT_FOUND');
    this.name = 'TransactionNotFoundError';
  }
}
