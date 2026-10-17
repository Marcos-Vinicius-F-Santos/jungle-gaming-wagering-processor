import type { WagerTransactionReadModel } from '../../application/ports/wager-transaction-query-repository.port';

export interface TransactionBalanceResponse {
  readonly amount: string;
  readonly currency: string;
}

export interface WagerTransactionResponse {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly pendingSince: string | null;
  readonly nextAttemptAt: string | null;
  readonly pendingAttempts: number;
  readonly kind: WagerTransactionReadModel['kind'];
  readonly amount: string;
  readonly currency: string;
  readonly status: WagerTransactionReadModel['status'];
  readonly failureCode: WagerTransactionReadModel['failureCode'];
  readonly resultBalance: TransactionBalanceResponse | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

export function toWagerTransactionResponse(
  transaction: WagerTransactionReadModel,
): WagerTransactionResponse {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    pendingSince: toIsoOrNull(transaction.pendingSince),
    nextAttemptAt: toIsoOrNull(transaction.nextAttemptAt),
    pendingAttempts: transaction.pendingAttempts,
    kind: transaction.kind,
    amount: transaction.amount,
    currency: transaction.currency,
    status: transaction.status,
    failureCode: transaction.failureCode,
    resultBalance: transaction.resultBalanceAmount !== null && transaction.resultBalanceCurrency !== null
      ? {
          amount: transaction.resultBalanceAmount,
          currency: transaction.resultBalanceCurrency,
        }
      : null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: toIsoOrNull(transaction.processedAt),
  };
}

function toIsoOrNull(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
