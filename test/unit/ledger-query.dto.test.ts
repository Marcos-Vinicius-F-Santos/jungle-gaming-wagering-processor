import { describe, expect, test } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  DEFAULT_LEDGER_LIMIT,
  LedgerQueryDto,
  MAX_LEDGER_LIMIT,
} from '../../src/modules/wallets/http/dto/ledger-query.dto';

async function errorsFor(limit: unknown) {
  const dto = plainToInstance(LedgerQueryDto, { limit });
  return validate(dto);
}

describe('LedgerQueryDto', () => {
  test('defaults limit to 50 and accepts the inclusive range 1..100', async () => {
    const defaultDto = plainToInstance(LedgerQueryDto, {});
    const minimumDto = plainToInstance(LedgerQueryDto, { limit: '1' });
    const maximumDto = plainToInstance(LedgerQueryDto, { limit: String(MAX_LEDGER_LIMIT) });

    expect(defaultDto.limit).toBe(DEFAULT_LEDGER_LIMIT);
    expect((await validate(defaultDto))).toHaveLength(0);
    expect((await validate(minimumDto))).toHaveLength(0);
    expect((await validate(maximumDto))).toHaveLength(0);
  });

  test('rejects zero, negative, decimal, text and values above the maximum', async () => {
    for (const invalid of ['0', '-1', '1.5', 'abc', '101']) {
      expect(await errorsFor(invalid)).not.toHaveLength(0);
    }
  });

  test('does not coerce an omitted limit into an invalid value', async () => {
    const dto = plainToInstance(LedgerQueryDto, { cursor: 'opaque-cursor' });

    expect(dto.limit).toBe(DEFAULT_LEDGER_LIMIT);
    expect((await validate(dto))).toHaveLength(0);
  });
});
