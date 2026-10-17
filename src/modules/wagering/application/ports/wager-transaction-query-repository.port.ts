import type { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';

export interface WagerTransactionReadModel {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly pendingSince: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly pendingAttempts: number;
  readonly kind: WagerTransactionKind;
  readonly amount: string;
  readonly currency: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly resultBalanceAmount: string | null;
  readonly resultBalanceCurrency: string | null;
  readonly createdAt: Date;
  readonly processedAt: Date | null;
}

export interface WagerTransactionQueryRepository {
  findById(transactionId: string): Promise<WagerTransactionReadModel | null>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionReadModel | null>;
}

export const WAGER_TRANSACTION_QUERY_REPOSITORY = Symbol('WAGER_TRANSACTION_QUERY_REPOSITORY');
