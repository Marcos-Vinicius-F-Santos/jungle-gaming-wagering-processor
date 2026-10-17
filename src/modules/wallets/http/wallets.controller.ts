import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Get,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';

import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { WalletAlreadyExistsError } from '../application/errors/wallet-already-exists.error';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import { ListLedgerUseCase } from '../application/list-ledger.use-case';
import { InvalidLedgerCursorError } from '../application/ledger-cursor.codec';
import { InvalidLedgerLimitError } from '../application/errors/invalid-ledger-limit.error';
import { WalletNotFoundError } from '../application/errors/wallet-not-found.error';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import { toLedgerEntryResponse } from './mappers/ledger-response.mapper';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListLedgerUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateWalletDto) {
    try {
      return await this.createWallet.execute(dto.toCommand());
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError || error instanceof UniqueConstraintViolationException) {
        throw new ConflictException('wallet already exists for this player and currency');
      }

      if (error instanceof Error && error.message.startsWith('money ')) {
        throw new BadRequestException(error.message);
      }

      throw new ServiceUnavailableException('wallet creation could not be confirmed');
    }
  }

  @Get(':walletId')
  async get(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    try {
      return await this.getWallet.execute(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException('wallet not found');
      }

      throw new ServiceUnavailableException('wallet could not be read');
    }
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query() query: LedgerQueryDto,
  ) {
    try {
      const result = await this.listLedger.execute({
        walletId,
        cursor: query.cursor,
        limit: query.limit,
      });
      return {
        walletId: result.walletId,
        items: result.items.map(toLedgerEntryResponse),
        nextCursor: result.nextCursor,
      };
    } catch (error) {
      if (error instanceof InvalidLedgerCursorError || error instanceof InvalidLedgerLimitError) {
        throw new BadRequestException({ code: error.message });
      }

      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
      }

      throw new ServiceUnavailableException({ code: 'READ_UNAVAILABLE' });
    }
  }
}
