import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { v4 } from 'uuid';

import { InvalidLedgerCursorError } from '../../src/modules/wallets/application/ledger-cursor.codec';
import { WalletNotFoundError } from '../../src/modules/wallets/application/errors/wallet-not-found.error';
import type { ListLedgerUseCase } from '../../src/modules/wallets/application/list-ledger.use-case';
import { LedgerQueryDto } from '../../src/modules/wallets/http/dto/ledger-query.dto';
import { WalletsController } from '../../src/modules/wallets/http/wallets.controller';
import type { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import type { GetWalletUseCase } from '../../src/modules/wallets/application/get-wallet.use-case';

const walletId = v4();

function controller(listLedger: ListLedgerUseCase['execute']): WalletsController {
  return new WalletsController(
    {} as CreateWalletUseCase,
    {} as GetWalletUseCase,
    { execute: listLedger } as ListLedgerUseCase,
  );
}

describe('WalletsController ledger endpoint', () => {
  test('maps the read model and preserves a nullable next cursor', async () => {
    const response = await controller(async () => ({
      walletId,
      items: [{
        id: v4(),
        transactionId: v4(),
        walletId,
        direction: 'DEBIT' as const,
        amount: '25.00',
        currency: 'BRL',
        balanceBefore: '100.00',
        balanceAfter: '75.00',
        createdAt: new Date('2026-10-16T12:00:00.000Z'),
      }],
      nextCursor: null,
    })).ledger(walletId, Object.assign(new LedgerQueryDto(), { limit: 1 }));

    expect(response.walletId).toBe(walletId);
    expect(response.items[0]?.amount).toBe('25.00');
    expect(response.items[0]?.createdAt).toBe('2026-10-16T12:00:00.000Z');
    expect(response.nextCursor).toBeNull();
  });

  test('maps invalid cursor, missing wallet and infrastructure failures to safe HTTP errors', async () => {
    await expect(controller(async () => { throw new InvalidLedgerCursorError(); })
      .ledger(walletId, new LedgerQueryDto())).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(async () => { throw new WalletNotFoundError(walletId); })
      .ledger(walletId, new LedgerQueryDto())).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller(async () => { throw new Error('database details'); })
      .ledger(walletId, new LedgerQueryDto())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
