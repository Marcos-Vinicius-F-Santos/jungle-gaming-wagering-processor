import { describe, expect, test } from 'bun:test';
import { LoadDataCatalog } from '../load/load-fixtures';
import { buildOutboxPressureMessage } from '../load/scenarios/outbox-pressure';

describe('outbox pressure scenario', () => {
  test('builds valid operations that can produce transactional outbox events', () => {
    const catalog = new LoadDataCatalog('run-outbox', 'outbox-pressure');
    const wallet = catalog.wallet();
    const message = catalog.message(catalog.operation(wallet));
    const envelope = buildOutboxPressureMessage(message) as { type: string; data: { kind: string; walletId: string } };

    expect(envelope.type).toBe('WagerTransactionRequested');
    expect(envelope.data.kind).toBe('BET');
    expect(envelope.data.walletId).toBe(wallet.walletId);
  });
});
