export class ReconciliationUnavailableError extends Error {
  constructor() {
    super('reconciliation could not be confirmed');
    this.name = 'ReconciliationUnavailableError';
  }
}
