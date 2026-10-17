import { describe, expect, test } from 'bun:test';

import { MikroOrmReconciliationQueryRepository } from '../../src/modules/reconciliation/infrastructure/persistence/mikro-orm-reconciliation-query.repository';

describe('MikroOrmReconciliationQueryRepository', () => {
  test('maps only wallet and raw ledger fields in deterministic order', async () => {
    const calls: unknown[] = [];
    const manager = {
      async findOne(...args: unknown[]) {
        calls.push(args);
        return { id: 'wallet-1', currency: 'BRL', balanceAmount: '95.00' };
      },
      async find(...args: unknown[]) {
        calls.push(args);
        return [{
          id: 'entry-1',
          direction: 'CREDIT',
          amount: '100.00',
          currency: 'BRL',
          balanceBefore: '0.00',
          balanceAfter: '100.00',
          createdAt: new Date('2026-10-16T12:00:00.000Z'),
        }];
      },
    };
    const entityManager = {
      transactional: async (work: (transactionManager: typeof manager) => Promise<unknown>, options: unknown) => {
        calls.push(options);
        return work(manager);
      },
    } as never;
    const repository = new MikroOrmReconciliationQueryRepository(entityManager);

    const snapshot = await repository.findSnapshot('wallet-1');

    expect(snapshot).toEqual({
      walletId: 'wallet-1',
      currency: 'BRL',
      storedBalance: '95.00',
      entries: [{
        id: 'entry-1',
        direction: 'CREDIT',
        amount: '100.00',
        currency: 'BRL',
        balanceBefore: '0.00',
        balanceAfter: '100.00',
        createdAt: new Date('2026-10-16T12:00:00.000Z'),
      }],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ isolationLevel: 'repeatable read', readOnly: true });
  });

  test('returns null without querying the ledger when the wallet is absent', async () => {
    let ledgerRead = false;
    const manager = {
      async findOne() {
        return null;
      },
      async find() {
        ledgerRead = true;
        return [];
      },
    };
    const repository = new MikroOrmReconciliationQueryRepository({
      transactional: async (work: (transactionManager: typeof manager) => Promise<unknown>) => work(manager),
    } as never);

    await expect(repository.findSnapshot('missing')).resolves.toBeNull();
    expect(ledgerRead).toBe(false);
  });
});
