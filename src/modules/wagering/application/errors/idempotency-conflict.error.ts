export class IdempotencyConflictError extends Error {
  constructor(providerId: string, idempotencyKey: string) {
    super(`idempotency key ${providerId}:${idempotencyKey} conflicts with an existing payload`);
    this.name = 'IdempotencyConflictError';
  }
}
