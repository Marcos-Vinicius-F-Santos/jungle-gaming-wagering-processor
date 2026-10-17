import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  NotFoundException,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';

import { ExternalTransactionConflictError } from '../application/errors/external-transaction-conflict.error';
import { IdempotencyConflictError } from '../application/errors/idempotency-conflict.error';
import { OptimisticLockRetryExhaustedError } from '../application/errors/optimistic-lock-retry-exhausted.error';
import { ReversalConflictError } from '../application/errors/reversal-conflict.error';
import { WagerReferenceIncompatibleError } from '../application/errors/wager-reference-incompatible.error';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case';
import { WalletNotFoundError } from '../../wallets/application/errors/wallet-not-found.error';
import { InsufficientWalletBalanceError } from '../../wallets/domain/errors/insufficient-wallet-balance.error';
import { ProcessWagerTransactionDto } from './dto/process-wager-transaction.dto';

const IDEMPOTENCY_KEY_PATTERN = /^(?=.*\S)[^\u0000-\u001F\u007F]+$/;

interface HttpResponseStatus {
  statusCode: number;
}

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processWagerTransaction: ProcessWagerTransactionUseCase) {}

  @Post()
  async process(
    @Body() dto: ProcessWagerTransactionDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponseStatus,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 255 || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a non-empty value of at most 255 characters');
    }

    try {
      const result = await this.processWagerTransaction.execute(dto.toCommand(idempotencyKey));
      if (result.idempotentReplay) {
        response.statusCode = 200;
      } else if (result.status === 'PENDING_REFERENCE') {
        response.statusCode = 202;
      } else if (result.status === 'REJECTED') {
        response.statusCode = 422;
      } else {
        response.statusCode = 201;
      }
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError || error instanceof ExternalTransactionConflictError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof ReversalConflictError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException('wallet not found');
      }
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException('wager transaction conflicts with an existing operation');
      }
      if (error instanceof OptimisticLockRetryExhaustedError) {
        throw new ServiceUnavailableException('wager transaction could not be confirmed');
      }
      if (error instanceof WagerReferenceIncompatibleError) {
        throw new UnprocessableEntityException(error.message);
      }
      if (error instanceof Error && (
        error.message.startsWith('money ') ||
        error.message.includes('must be') ||
        error.message.includes('must not') ||
        error.message.includes('is required')
      )) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof InsufficientWalletBalanceError) {
        throw new UnprocessableEntityException(error.message);
      }
      throw new ServiceUnavailableException('wager transaction could not be confirmed');
    }
  }
}
