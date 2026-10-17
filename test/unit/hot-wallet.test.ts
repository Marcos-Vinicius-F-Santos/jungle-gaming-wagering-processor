import { describe, expect, test } from 'bun:test';
import { LoadDataCatalog } from '../load/load-fixtures';
import { buildHotWalletMessage } from '../load/scenarios/hot-wallet';

describe('hot wallet scenario', () => {
  test('uses distinct FIFO groups while preserving the same wallet', () => {
    const catalog = new LoadDataCatalog('run-hot', 'hot-wallet');
    const wallet = catalog.wallet();
    const first = catalog.message(catalog.operation(wallet));
    const second = catalog.message(catalog.operation(wallet));
    const firstEnvelope = buildHotWalletMessage(first) as { messageId: string; data: { walletId: string } };
    const secondEnvelope = buildHotWalletMessage(second) as { messageId: string; data: { walletId: string } };

    expect(firstEnvelope.data.walletId).toBe(secondEnvelope.data.walletId);
    expect(firstEnvelope.messageId).not.toBe(secondEnvelope.messageId);
  });
});
