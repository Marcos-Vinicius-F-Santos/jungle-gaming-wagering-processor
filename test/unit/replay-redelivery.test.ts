import { describe, expect, test } from 'bun:test';
import { LoadDataCatalog } from '../load/load-fixtures';
import { buildReplayMessage } from '../load/scenarios/replay-redelivery';

describe('replay redelivery scenario', () => {
  test('reuses the same message id and business payload for every replay', () => {
    const catalog = new LoadDataCatalog('run-replay', 'replay-redelivery');
    const wallet = catalog.wallet();
    const message = catalog.message(catalog.operation(wallet));
    const first = buildReplayMessage(message) as { messageId: string; data: Record<string, unknown> };
    const second = buildReplayMessage(message) as { messageId: string; data: Record<string, unknown> };

    expect(first.messageId).toBe(second.messageId);
    expect(first.data).toEqual(second.data);
  });
});
