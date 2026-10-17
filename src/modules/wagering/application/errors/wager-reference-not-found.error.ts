export class WagerReferenceNotFoundError extends Error {
  constructor(public readonly providerId: string, public readonly referenceExternalTransactionId: string) {
    super(`wager reference ${providerId}/${referenceExternalTransactionId} was not found`);
    this.name = 'WagerReferenceNotFoundError';
  }
}
