import { describe, expect, test } from 'bun:test';
import { v4 } from 'uuid';

import { PendingReferenceWorker } from '../../src/modules/wagering/application/pending-reference.worker';
import type { WagerTransactionRecord } from '../../src/modules/wagering/application/ports/wager-transaction-repository.port';
import { InMemoryMetrics } from '../../src/shared/infrastructure/metrics/in-memory-metrics';

const record: WagerTransactionRecord = {
  id: v4(),
  providerId: 'provider-a',
  externalTransactionId: 'win-a',
  idempotencyKey: 'key-a',
  payloadHash: 'hash-a',
  walletId: v4(),
  playerId: v4(),
  roundId: 'round-a',
  gameId: 'game-a',
  referenceExternalTransactionId: 'bet-a',
  pendingSince: new Date('2026-10-15T20:00:00.000Z'),
  nextAttemptAt: new Date('2026-10-15T20:00:30.000Z'),
  pendingAttempts: 0,
  kind: 'WIN',
  amount: '80.00',
  currency: 'BRL',
  status: 'PENDING_REFERENCE',
  failureCode: null,
  resultBalanceAmount: null,
  resultBalanceCurrency: null,
  createdAt: new Date('2026-10-15T20:00:00.000Z'),
  processedAt: null,
};

describe('PendingReferenceWorker', () => {
  test('reprocesses due records through the existing use case', async () => {
    const processed: string[] = [];
    let next = true;
    const metrics = new InMemoryMetrics();
    const worker = new PendingReferenceWorker(
      {
        reprocessNextPendingReference: async () => {
          if (!next) {
            return null;
          }
          next = false;
          processed.push(record.id);
          return { transactionId: record.id, status: 'PENDING_REFERENCE', nextAttemptAt: record.nextAttemptAt!.toISOString(), idempotentReplay: false };
        },
      } as never,
      metrics,
    );

    await worker.runOnce();

    expect(processed).toEqual([record.id]);
    expect(metrics.snapshot().get('wager.pending_reference.scan')).toBe(1);
    expect(metrics.snapshot().get('wager.pending_reference.pending_reference{failureCode=none}')).toBe(1);
    expect(metrics.observationsSnapshot().get('processing_duration_ms{operation=REFERENCE_REPROCESS,source=REFERENCE_WORKER}')?.length).toBe(1);
  });
});
