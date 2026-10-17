import 'reflect-metadata';

import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 100;

export class LedgerQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LEDGER_LIMIT)
  limit = DEFAULT_LEDGER_LIMIT;

  @IsOptional()
  cursor?: string;
}
