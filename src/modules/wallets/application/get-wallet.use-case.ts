import { Inject, Injectable } from '@nestjs/common';
import { LOGGER } from '../../../shared/application/ports/logger.port';
import type { AppLogger } from '../../../shared/application/ports/logger.port';

import { WALLET_REPOSITORY } from './ports/wallet-repository.port';
import type { WalletRepository } from './ports/wallet-repository.port';
import { WalletNotFoundError } from './errors/wallet-not-found.error';
import { Wallet } from '../domain/wallet';
import type { WalletResult } from './create-wallet.use-case';

@Injectable()
export class GetWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepository: WalletRepository<Wallet>,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<WalletResult> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      this.logger.warn('wallet.read.not_found', { walletId });
      throw new WalletNotFoundError(walletId);
    }

    const result = {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
    this.logger.info('wallet.read', { walletId: wallet.id, currency: wallet.currency, version: wallet.version });
    return result;
  }
}
