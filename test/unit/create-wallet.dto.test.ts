import { describe, expect, test } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { v4 } from 'uuid';

import { CreateWalletDto } from '../../src/modules/wallets/http/dto/create-wallet.dto';

describe('CreateWalletDto', () => {
  test('normalizes a valid lowercase currency before validation', async () => {
    const dto = plainToInstance(CreateWalletDto, {
      playerId: v4(),
      initialBalance: { amount: '10.00', currency: 'bRl' },
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.initialBalance.currency).toBe('BRL');
  });

  test('rejects invalid UUID, numeric amount, scientific notation and invalid currency', async () => {
    const dto = plainToInstance(CreateWalletDto, {
      playerId: 'not-a-uuid',
      initialBalance: { amount: 1e2, currency: 'XYZ' },
    });

    expect(await validate(dto)).not.toHaveLength(0);

    const scientificDto = plainToInstance(CreateWalletDto, {
      playerId: v4(),
      initialBalance: { amount: '1e2', currency: 'BRL' },
    });
    expect(await validate(scientificDto)).not.toHaveLength(0);
  });
});
