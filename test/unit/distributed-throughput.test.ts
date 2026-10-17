import { describe, expect, test } from 'bun:test';
import { LoadDataCatalog } from '../load/load-fixtures';
import { buildDistributedMessage } from '../load/scenarios/distributed-throughput';

describe('distributed throughput scenario', () => {
  test('builds a valid SQS envelope without changing the business operation', () => {
    const catalog = new LoadDataCatalog('run-envelope', 'distributed-throughput');
    const wallet = catalog.wallet();
    const operation = catalog.operation(wallet);
    const message = catalog.message(operation);
    const envelope = buildDistributedMessage(message) as { type: string; messageId: string; data: typeof operation };

    expect(envelope.type).toBe('WagerTransactionRequested');
    expect(envelope.messageId).toBe(message.messageId);
    expect(envelope.data).toEqual(operation);
    expect(JSON.stringify(envelope)).not.toContain('payloadHash');
  });
});
