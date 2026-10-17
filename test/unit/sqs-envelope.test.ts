import { describe, expect, test } from 'bun:test';

import { CanonicalPayloadHasher } from '../../src/modules/wagering/application/canonical-payload-hasher';
import { WagerTransactionRequestedEnvelope } from '../../src/modules/messaging/sqs/application/wager-transaction-requested.envelope';

const body = {
  messageId: 'message-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-16T10:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'external-a',
    idempotencyKey: 'provider-a:external-a',
    playerId: 'player-a',
    walletId: 'wallet-a',
    roundId: 'round-a',
    gameId: 'game-a',
    kind: 'BET',
    money: { amount: '25.00', currency: 'brl' },
  },
};

describe('WagerTransactionRequestedEnvelope', () => {
  test('validates and maps the SQS envelope to the existing command', () => {
    const envelope = WagerTransactionRequestedEnvelope.parse(JSON.stringify(body));
    expect(envelope.messageId).toBe('message-1');
    expect(envelope.toCommand()).toMatchObject({
      providerId: 'provider-a',
      idempotencyKey: 'provider-a:external-a',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(envelope.payloadHash(new CanonicalPayloadHasher())).toMatch(/^[a-f0-9]{64}$/);
  });

  test('keeps an optional correlation id out of the business command', () => {
    const envelope = WagerTransactionRequestedEnvelope.parse(JSON.stringify({
      type: 'WagerTransactionRequested',
      messageId: 'message-123',
      correlationId: 'correlation-123',
      occurredAt: '2026-10-16T00:00:00.000Z',
      data: body.data,
    }));

    expect(envelope.correlationId).toBe('correlation-123');
    expect(envelope.toCommand()).not.toHaveProperty('correlationId');
  });

  test('rejects an unsupported type and missing reversal reference', () => {
    expect(() => WagerTransactionRequestedEnvelope.parse(JSON.stringify({ ...body, type: 'Other' })))
      .toThrow('SQS_ENVELOPE_UNSUPPORTED_TYPE');
    expect(() => WagerTransactionRequestedEnvelope.parse(JSON.stringify({
      ...body,
      data: { ...body.data, kind: 'ROLLBACK' },
    }))).toThrow('SQS_ENVELOPE_REFERENCE_REQUIRED');
  });
});
