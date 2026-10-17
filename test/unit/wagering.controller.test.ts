import { describe, expect, test } from 'bun:test';
import { UnprocessableEntityException } from '@nestjs/common';
import { v4 } from 'uuid';

import { WagerReferenceIncompatibleError } from '../../src/modules/wagering/application/errors/wager-reference-incompatible.error';
import type { ProcessWagerTransactionUseCase } from '../../src/modules/wagering/application/process-wager-transaction.use-case';
import { ProcessWagerTransactionDto } from '../../src/modules/wagering/http/dto/process-wager-transaction.dto';
import { WageringController } from '../../src/modules/wagering/http/wagering.controller';

function dto(): ProcessWagerTransactionDto {
  return Object.assign(new ProcessWagerTransactionDto(), {
    providerId: 'provider-a',
    externalTransactionId: 'external-a',
    playerId: v4(),
    walletId: v4(),
    roundId: 'round-a',
    gameId: 'game-a',
    kind: 'WIN' as const,
    money: { amount: '25.00', currency: 'BRL' },
  });
}

describe('WageringController', () => {
  test('maps pending references to 202', async () => {
    const controller = new WageringController({
      execute: async () => ({
        transactionId: v4(),
        status: 'PENDING_REFERENCE' as const,
        nextAttemptAt: '2026-10-15T20:00:30.000Z',
        idempotentReplay: false,
      }),
    } as unknown as ProcessWagerTransactionUseCase);
    const response = { statusCode: 0 };

    await controller.process(dto(), 'key-a', response);

    expect(response.statusCode).toBe(202);
  });

  test('maps incompatible references to 422', async () => {
    const controller = new WageringController({
      execute: async () => { throw new WagerReferenceIncompatibleError('provider-a', 'bet-a', 'CONTEXT_MISMATCH'); },
    } as unknown as ProcessWagerTransactionUseCase);

    await expect(controller.process(dto(), 'key-a', { statusCode: 0 })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
