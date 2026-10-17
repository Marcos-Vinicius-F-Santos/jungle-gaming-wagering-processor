import type { ProcessWagerTransactionCommand } from '../../../wagering/application/process-wager-transaction.use-case';
import type { PayloadHasher, WagerBusinessPayload } from '../../../wagering/application/ports/payload-hasher.port';

export interface WagerTransactionRequestedData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  referenceExternalTransactionId?: string;
  money: { amount: string; currency: string };
}

export class WagerTransactionRequestedEnvelope {
  private constructor(
    readonly messageId: string,
    readonly occurredAt: Date,
    readonly data: WagerTransactionRequestedData,
    readonly correlationId?: string,
  ) {}

  static parse(raw: string): WagerTransactionRequestedEnvelope {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('SQS_ENVELOPE_INVALID_JSON');
    }

    if (!isRecord(value) || value.type !== 'WagerTransactionRequested') {
      throw new Error('SQS_ENVELOPE_UNSUPPORTED_TYPE');
    }
    const messageId = requiredText(value.messageId, 'messageId');
    const correlationId = optionalText(value.correlationId);
    const occurredAtText = requiredText(value.occurredAt, 'occurredAt');
    const occurredAt = new Date(occurredAtText);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error('SQS_ENVELOPE_INVALID_OCCURRED_AT');
    }
    if (!isRecord(value.data)) {
      throw new Error('SQS_ENVELOPE_INVALID_DATA');
    }

    const data = parseData(value.data);
    return new WagerTransactionRequestedEnvelope(messageId, occurredAt, data, correlationId);
  }

  toCommand(): ProcessWagerTransactionCommand {
    return { ...this.data, money: { ...this.data.money } };
  }

  toBusinessPayload(): WagerBusinessPayload {
    return {
      providerId: this.data.providerId,
      externalTransactionId: this.data.externalTransactionId,
      idempotencyKey: this.data.idempotencyKey,
      playerId: this.data.playerId,
      walletId: this.data.walletId,
      roundId: this.data.roundId,
      gameId: this.data.gameId,
      kind: this.data.kind,
      referenceExternalTransactionId: this.data.referenceExternalTransactionId,
      money: { ...this.data.money },
    };
  }

  payloadHash(hasher: PayloadHasher): string {
    return hasher.hash(this.toBusinessPayload());
  }
}

function parseData(value: Record<string, unknown>): WagerTransactionRequestedData {
  const kind = requiredText(value.kind, 'kind');
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind)) {
    throw new Error('SQS_ENVELOPE_INVALID_KIND');
  }
  if (!isRecord(value.money)) {
    throw new Error('SQS_ENVELOPE_INVALID_MONEY');
  }
  const reference = value.referenceExternalTransactionId === undefined
    ? undefined
    : requiredText(value.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && !reference) {
    throw new Error('SQS_ENVELOPE_REFERENCE_REQUIRED');
  }

  return {
    providerId: requiredText(value.providerId, 'providerId'),
    externalTransactionId: requiredText(value.externalTransactionId, 'externalTransactionId'),
    idempotencyKey: requiredText(value.idempotencyKey, 'idempotencyKey'),
    playerId: requiredText(value.playerId, 'playerId'),
    walletId: requiredText(value.walletId, 'walletId'),
    roundId: requiredText(value.roundId, 'roundId'),
    gameId: requiredText(value.gameId, 'gameId'),
    kind: kind as WagerTransactionRequestedData['kind'],
    referenceExternalTransactionId: reference,
    money: {
      amount: requiredText(value.money.amount, 'money.amount'),
      currency: requiredText(value.money.currency, 'money.currency').toUpperCase(),
    },
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) {
    throw new Error(`SQS_ENVELOPE_INVALID_${field.replaceAll('.', '_').toUpperCase()}`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
