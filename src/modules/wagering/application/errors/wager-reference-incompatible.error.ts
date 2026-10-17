export class WagerReferenceIncompatibleError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly referenceExternalTransactionId: string,
    public readonly reason: 'NOT_PROCESSED_BET' | 'NOT_ALLOWED_KIND' | 'CONTEXT_MISMATCH' | 'AMOUNT_MISMATCH',
  ) {
    super(`wager reference ${providerId}/${referenceExternalTransactionId} is incompatible`);
    this.name = 'WagerReferenceIncompatibleError';
  }
}
