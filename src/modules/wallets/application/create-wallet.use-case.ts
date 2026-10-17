import { Inject, Injectable, Optional } from '@nestjs/common';

import { CLOCK } from '../../../shared/application/ports/clock.port';
import type { Clock } from '../../../shared/application/ports/clock.port';
import { ID_GENERATOR } from '../../../shared/application/ports/id-generator.port';
import type { IdGenerator } from '../../../shared/application/ports/id-generator.port';
import { UNIT_OF_WORK } from '../../../shared/application/ports/unit-of-work.port';
import type { UnitOfWork } from '../../../shared/application/ports/unit-of-work.port';
import { LOGGER } from '../../../shared/application/ports/logger.port';
import type { AppLogger } from '../../../shared/application/ports/logger.port';
import { Money } from '../../../shared/domain/money';
import { WalletAlreadyExistsError } from './errors/wallet-already-exists.error';
import { LEDGER_REPOSITORY } from './ports/ledger-repository.port';
import type { LedgerRepository } from './ports/ledger-repository.port';
import { WALLET_REPOSITORY } from './ports/wallet-repository.port';
import type { WalletRepository } from './ports/wallet-repository.port';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WAGER_TRANSACTION_REPOSITORY } from '../../wagering/application/ports/wager-transaction-repository.port';
import type { WagerTransactionRepository } from '../../wagering/application/ports/wager-transaction-repository.port';
import { LedgerEffectRecorder } from '../../ledger/application/ledger-effect-recorder';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export interface WalletResult {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepository: WalletRepository<Wallet>,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactionRepository: WagerTransactionRepository<WagerTransaction>,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRepository: LedgerRepository<WalletLedgerEntry>,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Optional() private readonly ledgerEffectRecorder?: LedgerEffectRecorder,
  ) {}

  execute(command: CreateWalletCommand): Promise<WalletResult> {
    return this.unitOfWork.execute(async () => {
      const existing = await this.walletRepository.findByPlayerAndCurrency(
        command.playerId,
        command.initialBalance.currency,
      );
      if (existing) {
        this.logger.warn('wallet.create.duplicate', { currency: command.initialBalance.currency });
        throw new WalletAlreadyExistsError(command.playerId, command.initialBalance.currency);
      }

      const now = this.clock.now();
      const wallet = Wallet.open(this.idGenerator.next(), command.playerId, command.initialBalance, now);
      await this.walletRepository.save(wallet);

      if (wallet.balance.isPositive()) {
        const opening = WagerTransaction.opening(
          this.idGenerator.next(),
          wallet.id,
          wallet.playerId,
          wallet.balance,
          now,
        );
        await this.transactionRepository.save(opening);

        const ledgerEntry = WalletLedgerEntry.credit(
          this.idGenerator.next(),
          wallet.id,
          opening.id,
          wallet.balance,
          Money.of('0.00', wallet.currency),
          now,
        );
        await this.ledgerRepository.save(ledgerEntry);
        await this.ledgerEffectRecorder?.record({
          transactionId: opening.id,
          effectType: 'OPENING',
          walletId: wallet.id,
          currency: wallet.currency,
          amount: wallet.balance,
          occurredAt: now,
        });
      }

      const result = {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
      this.logger.info('wallet.created', {
        walletId: wallet.id,
        currency: wallet.currency,
        openingCreated: wallet.balance.isPositive(),
        version: wallet.version,
      });
      return result;
    });
  }
}
