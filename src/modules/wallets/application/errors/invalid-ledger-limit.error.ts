export class InvalidLedgerLimitError extends Error {
  constructor() {
    super('INVALID_LIMIT');
    this.name = 'InvalidLedgerLimitError';
  }
}
