import { describe, expect, test } from 'bun:test';

import { InvalidLedgerCursorError, LedgerCursorCodec } from '../../src/modules/wallets/application/ledger-cursor.codec';
import { InvalidLedgerLimitError } from '../../src/modules/wallets/application/errors/invalid-ledger-limit.error';
import { ListLedgerUseCase } from '../../src/modules/wallets/application/list-ledger.use-case';
import type { Wallet } from '../../src/modules/wallets/domain/wallet';
import type { LedgerQueryRepository } from '../../src/modules/wallets/application/ports/ledger-query-repository.port';
import type { WalletRepository } from '../../src/modules/wallets/application/ports/wallet-repository.port';

const walletId = '018f0000-0000-7000-8000-000000000001';
const otherWalletId = '018f0000-0000-7000-8000-000000000002';
const entry = {
  id: '018f0000-0000-7000-8000-000000000003',
  transactionId: '018f0000-0000-7000-8000-000000000004',
  walletId,
  direction: 'CREDIT' as const,
  amount: '10.00',
  currency: 'BRL',
  balanceBefore: '0.00',
  balanceAfter: '10.00',
  createdAt: new Date('2026-10-16T12:00:00.000Z'),
};

function useCase(page = { items: [entry], hasNextPage: true }, overrides?: {
  wallet?: string;
  findPage?: LedgerQueryRepository['findPage'];
}) {
  const repository: WalletRepository = {
    findById: async (id) => id === (overrides?.wallet ?? walletId) ? {} : null,
    findByPlayerAndCurrency: async () => null,
    save: async () => undefined,
    updateBalanceIfVersion: async () => true,
  };
  const query: LedgerQueryRepository = {
    findPage: overrides?.findPage ?? (async () => page),
  };
  return new ListLedgerUseCase(repository as WalletRepository<Wallet>, query, new LedgerCursorCodec());
}

describe('ListLedgerUseCase', () => {
  test('returns a next cursor only when the query has another page', async () => {
    const result = await useCase().execute({ walletId, limit: 1 });
    const decoded = new LedgerCursorCodec().decode(result.nextCursor, walletId);

    expect(result.walletId).toBe(walletId);
    expect(result.items).toEqual([entry]);
    expect(decoded.id).toBe(entry.id);
    expect(decoded.createdAt).toEqual(entry.createdAt);
  });

  test('returns an empty final page without a cursor', async () => {
    const result = await useCase({ items: [], hasNextPage: false }).execute({ walletId });

    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  test('rejects invalid limits before executing the query', async () => {
    let calls = 0;
    const service = useCase(undefined, {
      findPage: async () => {
        calls += 1;
        return { items: [], hasNextPage: false };
      },
    });

    await expect(service.execute({ walletId, limit: 101 })).rejects.toBeInstanceOf(InvalidLedgerLimitError);
    expect(calls).toBe(0);
  });

  test('rejects an incompatible cursor before executing the query', async () => {
    const codec = new LedgerCursorCodec();
    const cursor = codec.encode({ walletId: otherWalletId, createdAt: entry.createdAt, id: entry.id });
    let calls = 0;
    const service = useCase(undefined, {
      findPage: async () => {
        calls += 1;
        return { items: [], hasNextPage: false };
      },
    });

    await expect(service.execute({ walletId, cursor })).rejects.toBeInstanceOf(InvalidLedgerCursorError);
    expect(calls).toBe(0);
  });
});
