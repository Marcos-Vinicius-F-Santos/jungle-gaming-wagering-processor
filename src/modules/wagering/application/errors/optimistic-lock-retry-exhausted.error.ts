export class OptimisticLockRetryExhaustedError extends Error {
  constructor(walletId: string, attempts: number) {
    super(`optimistic locking retries exhausted for wallet ${walletId} after ${attempts} attempts`);
    this.name = 'OptimisticLockRetryExhaustedError';
  }
}
