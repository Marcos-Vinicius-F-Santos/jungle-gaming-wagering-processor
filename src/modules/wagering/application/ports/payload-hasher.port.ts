export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey?: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  referenceExternalTransactionId?: string;
  money: {
    amount: string;
    currency: string;
  };
}

export interface PayloadHasher {
  hash(payload: WagerBusinessPayload): string;
}

export const PAYLOAD_HASHER = Symbol('PAYLOAD_HASHER');
