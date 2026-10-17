import { describe, expect, test } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { v4 } from 'uuid';

import { ProcessWagerTransactionDto } from '../../src/modules/wagering/http/dto/process-wager-transaction.dto';

function payload(
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
  referenceExternalTransactionId?: string,
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'external-a',
    playerId: v4(),
    walletId: v4(),
    roundId: 'round-a',
    gameId: 'game-a',
    kind,
    referenceExternalTransactionId,
    money: { amount: '25.00', currency: 'bRl' },
  };
}

describe('ProcessWagerTransactionDto', () => {
  test('accepts BET, WIN and LOSS and normalizes the currency', async () => {
    for (const kind of ['BET', 'WIN', 'LOSS'] as const) {
      const dto = plainToInstance(ProcessWagerTransactionDto, payload(kind, kind === 'WIN' ? 'bet-a' : undefined));
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.money.currency).toBe('BRL');
      expect(dto.toCommand('key-a').kind).toBe(kind);
    }
  });

  test('rejects invalid reference values', async () => {
    const dto = plainToInstance(ProcessWagerTransactionDto, payload('WIN', ''));
    expect(await validate(dto)).not.toHaveLength(0);
  });

  test('requires a reference for REFUND and ROLLBACK', async () => {
    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      const dto = plainToInstance(ProcessWagerTransactionDto, payload(kind));
      expect(await validate(dto)).not.toHaveLength(0);
    }
  });

  test('accepts valid REFUND and ROLLBACK payloads', async () => {
    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      const dto = plainToInstance(ProcessWagerTransactionDto, payload(kind, 'reference-a'));
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.toCommand('key-a').kind).toBe(kind);
    }
  });
});
