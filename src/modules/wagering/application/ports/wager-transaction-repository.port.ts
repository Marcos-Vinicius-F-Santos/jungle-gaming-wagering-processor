export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string | null;
  payloadHash: string | null;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  pendingSince?: Date | null;
  nextAttemptAt?: Date | null;
  pendingAttempts?: number;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  failureCode: string | null;
  resultBalanceAmount: string | null;
  resultBalanceCurrency: string | null;
  createdAt: Date;
  processedAt: Date | null;
}

export interface WagerTransactionRepository<TTransaction = unknown> {
  save(transaction: TTransaction): Promise<void>;
  findById(transactionId: string): Promise<TTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransactionRecord | null>;
  findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRecord | null>;
  findDirectReversal(referenceTransactionId: string): Promise<WagerTransactionRecord | null>;
  findPendingReferenceDue(now: Date, limit: number): Promise<WagerTransactionRecord[]>;
  findPendingReferenceDueForUpdate(now: Date, limit: number): Promise<WagerTransactionRecord[]>;
  findPendingReferenceForUpdate(
    transactionId: string,
    now: Date,
  ): Promise<WagerTransactionRecord | null>;
  update(transaction: TTransaction): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
