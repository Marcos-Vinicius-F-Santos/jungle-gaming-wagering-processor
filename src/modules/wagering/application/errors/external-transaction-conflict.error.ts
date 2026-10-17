export class ExternalTransactionConflictError extends Error {
  constructor(providerId: string, externalTransactionId: string) {
    super(`external transaction ${providerId}:${externalTransactionId} conflicts with an existing payload`);
    this.name = 'ExternalTransactionConflictError';
  }
}
