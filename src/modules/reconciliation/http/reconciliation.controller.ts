import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';

import { WalletNotFoundError } from '../../wallets/application/errors/wallet-not-found.error';
import { InvalidReconciliationIdentifierError } from '../application/errors/invalid-reconciliation-identifier.error';
import { ReconciliationUnavailableError } from '../application/errors/reconciliation-unavailable.error';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case';
import { toReconciliationResponse } from './mappers/reconciliation-response.mapper';

@Controller('wallets')
export class ReconciliationController {
  constructor(private readonly reconcileWallet: ReconcileWalletUseCase) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param(
      'walletId',
      new ParseUUIDPipe({
        exceptionFactory: () => new BadRequestException({ code: 'INVALID_IDENTIFIER' }),
      }),
    )
    walletId: string,
  ) {
    try {
      const result = await this.reconcileWallet.execute(walletId);
      return toReconciliationResponse(result);
    } catch (error) {
      if (error instanceof InvalidReconciliationIdentifierError) {
        throw new BadRequestException({ code: 'INVALID_IDENTIFIER' });
      }

      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({ code: 'WALLET_NOT_FOUND' });
      }

      if (error instanceof ReconciliationUnavailableError) {
        throw new ServiceUnavailableException({ code: 'RECONCILIATION_UNAVAILABLE' });
      }

      throw new ServiceUnavailableException({ code: 'RECONCILIATION_UNAVAILABLE' });
    }
  }
}
