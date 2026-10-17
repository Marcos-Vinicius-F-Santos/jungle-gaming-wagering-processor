export class InvalidTransactionIdentifierError extends Error {
  constructor() {
    super('INVALID_IDENTIFIER');
    this.name = 'InvalidTransactionIdentifierError';
  }
}
