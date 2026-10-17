import { describe, expect, test } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { v4 } from 'uuid';

import { CreateWalletDto } from '../../src/modules/wallets/http/dto/create-wallet.dto';
import { WalletsController } from '../../src/modules/wallets/http/wallets.controller';
import type { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import type { GetWalletUseCase } from '../../src/modules/wallets/application/get-wallet.use-case';
import type { ListLedgerUseCase } from '../../src/modules/wallets/application/list-ledger.use-case';

describe('WalletsController', () => {
  test('maps an unconfirmed infrastructure failure to 503', async () => {
    const controller = new WalletsController(
      { execute: async () => { throw new Error('database timeout'); } } as unknown as CreateWalletUseCase,
      { execute: async () => { throw new Error('not used'); } } as unknown as GetWalletUseCase,
      { execute: async () => { throw new Error('not used'); } } as unknown as ListLedgerUseCase,
    );
    const dto = Object.assign(new CreateWalletDto(), {
      playerId: v4(),
      initialBalance: { amount: '1.00', currency: 'USD' },
    });

    try {
      await controller.create(dto);
      throw new Error('expected controller to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    }
  });
});
