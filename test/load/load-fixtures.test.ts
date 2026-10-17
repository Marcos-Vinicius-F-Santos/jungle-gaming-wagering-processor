import { describe, expect, test } from 'bun:test';
import { LoadDataCatalog } from './load-fixtures';

describe('load data catalog', () => {
  test('isolates two run ids and keeps replay keys stable', () => {
    const first = new LoadDataCatalog('run-a', 'distributed-throughput');
    const second = new LoadDataCatalog('run-b', 'distributed-throughput');
    const firstWallet = first.wallet();
    const secondWallet = second.wallet();
    const firstOperation = first.operation(firstWallet);
    const replay = first.replay(firstOperation);
    const secondOperation = second.operation(secondWallet);

    expect(firstWallet.walletId).not.toBe(secondWallet.walletId);
    expect(firstOperation.providerId).not.toBe(secondOperation.providerId);
    expect(firstOperation.idempotencyKey).toBe(replay.idempotencyKey);
    expect(firstOperation.externalTransactionId).toBe(replay.externalTransactionId);
    expect(firstOperation.walletId).toBe(replay.walletId);
    expect(first.message(firstOperation).messageId).not.toBe(second.message(secondOperation).messageId);
  });

  test('rejects an unsafe run id before generating data', () => {
    expect(() => new LoadDataCatalog('../outside', 'hot-wallet')).toThrow();
  });
});
