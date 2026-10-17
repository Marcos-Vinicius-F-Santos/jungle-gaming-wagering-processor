export class ReversalConflictError extends Error {
  constructor(
    public readonly referenceTransactionId: string,
  ) {
    super(`wager reference ${referenceTransactionId} already has a direct reversal`);
    this.name = 'ReversalConflictError';
  }
}
