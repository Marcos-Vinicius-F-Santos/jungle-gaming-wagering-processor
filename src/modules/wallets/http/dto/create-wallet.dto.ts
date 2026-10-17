import 'reflect-metadata';

import { Transform, Type } from 'class-transformer';
import { IsDefined, IsString, IsUUID, Matches, Validate, ValidateNested } from 'class-validator';

import { Money } from '../../../../shared/domain/money';
import type { CreateWalletCommand } from '../../application/create-wallet.use-case';
import { IsIso4217Currency } from '../validators/is-iso4217-currency.validator';

export class InitialBalanceDto {
  @IsDefined()
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  amount!: string;

  @IsDefined()
  @IsString()
  @IsIso4217Currency()
  @Transform(({ value }) => typeof value === 'string' ? value.toUpperCase() : value)
  currency!: string;
}

export class CreateWalletDto {
  @IsDefined()
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => InitialBalanceDto)
  initialBalance!: InitialBalanceDto;

  toCommand(): CreateWalletCommand {
    return {
      playerId: this.playerId,
      initialBalance: Money.of(this.initialBalance.amount, this.initialBalance.currency),
    };
  }
}
