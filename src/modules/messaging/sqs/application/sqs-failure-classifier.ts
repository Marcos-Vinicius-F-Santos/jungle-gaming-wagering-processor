import { UniqueConstraintViolationException } from '@mikro-orm/core';

import { WalletNotFoundError } from '../../../wallets/application/errors/wallet-not-found.error';
import { ExternalTransactionConflictError } from '../../../wagering/application/errors/external-transaction-conflict.error';
import { IdempotencyConflictError } from '../../../wagering/application/errors/idempotency-conflict.error';
import { OptimisticLockRetryExhaustedError } from '../../../wagering/application/errors/optimistic-lock-retry-exhausted.error';
import { ReversalConflictError } from '../../../wagering/application/errors/reversal-conflict.error';
import { WagerReferenceIncompatibleError } from '../../../wagering/application/errors/wager-reference-incompatible.error';
import { InsufficientWalletBalanceError } from '../../../wallets/domain/errors/insufficient-wallet-balance.error';

export type SqsFailureClassification = 'TRANSIENT' | 'PERMANENT';

export function classifySqsFailure(error: unknown): SqsFailureClassification {
  if (
    error instanceof WalletNotFoundError
    || error instanceof ExternalTransactionConflictError
    || error instanceof IdempotencyConflictError
    || error instanceof ReversalConflictError
    || error instanceof WagerReferenceIncompatibleError
    || error instanceof InsufficientWalletBalanceError
  ) {
    return 'PERMANENT';
  }
  if (error instanceof UniqueConstraintViolationException || error instanceof OptimisticLockRetryExhaustedError) {
    return 'TRANSIENT';
  }
  if (isPostgresTransientError(error)) {
    return 'TRANSIENT';
  }
  if (error instanceof Error && /must be|must not|required|invalid|unsupported/i.test(error.message)) {
    return 'PERMANENT';
  }
  return 'TRANSIENT';
}

export function failureCode(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== 'Error') {
    return error.name.slice(0, 100);
  }
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 100).replaceAll(/\s+/g, '_').toUpperCase();
  }
  return 'SQS_PROCESSING_FAILED';
}

function isPostgresTransientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return ['40001', '40P01', '08000', '08001', '08003', '08006', '57P01'].includes(
    String((error as { code?: unknown }).code),
  );
}
