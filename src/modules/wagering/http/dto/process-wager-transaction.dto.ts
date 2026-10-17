import 'reflect-metadata';

import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsNotEmpty,
  ValidateIf,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import type { ProcessWagerTransactionCommand } from '../../application/process-wager-transaction.use-case';
import { IsIso4217Currency } from '../../../wallets/http/validators/is-iso4217-currency.validator';

const NON_EMPTY_SAFE_TEXT = /^(?=.*\S)[^\u0000-\u001F\u007F]+$/;
const POSITIVE_DECIMAL = /^(?!0(?:\.0{1,2})?$)(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export class WagerMoneyDto {
  @IsDefined()
  @IsString()
  @Matches(POSITIVE_DECIMAL)
  amount!: string;

  @IsDefined()
  @IsString()
  @IsIso4217Currency()
  @Transform(({ value }) => typeof value === 'string' ? value.toUpperCase() : value)
  currency!: string;
}

export class ProcessWagerTransactionDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @Matches(NON_EMPTY_SAFE_TEXT)
  @MaxLength(64)
  providerId!: string;

  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @Matches(NON_EMPTY_SAFE_TEXT)
  @MaxLength(255)
  externalTransactionId!: string;

  @IsDefined()
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @IsUUID()
  walletId!: string;

  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @Matches(NON_EMPTY_SAFE_TEXT)
  @MaxLength(128)
  roundId!: string;

  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @Matches(NON_EMPTY_SAFE_TEXT)
  @MaxLength(128)
  gameId!: string;

  @IsDefined()
  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @ValidateIf((dto: ProcessWagerTransactionDto) =>
    dto.referenceExternalTransactionId !== undefined
    || dto.kind === 'REFUND'
    || dto.kind === 'ROLLBACK',
  )
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @Matches(NON_EMPTY_SAFE_TEXT)
  @MaxLength(255)
  referenceExternalTransactionId?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerMoneyDto)
  money!: WagerMoneyDto;

  toCommand(idempotencyKey: string): ProcessWagerTransactionCommand {
    return {
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey,
      playerId: this.playerId,
      walletId: this.walletId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      money: {
        amount: this.money.amount,
        currency: this.money.currency,
      },
    };
  }
}
