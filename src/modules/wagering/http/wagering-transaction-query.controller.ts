import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  ServiceUnavailableException,
} from '@nestjs/common';

import { InvalidTransactionIdentifierError } from '../application/errors/invalid-transaction-identifier.error';
import { TransactionNotFoundError } from '../application/errors/transaction-not-found.error';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import { toWagerTransactionResponse } from './mappers/wager-transaction-response.mapper';

@Controller()
export class WageringTransactionQueryController {
  constructor(private readonly getWagerTransaction: GetWagerTransactionUseCase) {}

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId', new ParseUUIDPipe()) transactionId: string) {
    try {
      const transaction = await this.getWagerTransaction.executeById(transactionId);
      return toWagerTransactionResponse(transaction);
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    try {
      const transaction = await this.getWagerTransaction.executeByProviderExternalId(
        providerId,
        externalTransactionId,
      );
      return toWagerTransactionResponse(transaction);
    } catch (error) {
      throw this.toHttpError(error);
    }
  }

  private toHttpError(error: unknown): Error {
    if (error instanceof InvalidTransactionIdentifierError) {
      return new BadRequestException({ code: 'INVALID_IDENTIFIER' });
    }
    if (error instanceof TransactionNotFoundError) {
      return new NotFoundException({ code: 'TRANSACTION_NOT_FOUND' });
    }
    return new ServiceUnavailableException({ code: 'READ_UNAVAILABLE' });
  }
}
