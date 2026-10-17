import { Inject, Injectable, Optional } from '@nestjs/common';
import { validate as isUuid } from 'uuid';

import { WalletNotFoundError } from '../../wallets/application/errors/wallet-not-found.error';
import { RECONCILIATION_QUERY_REPOSITORY } from './ports/reconciliation-query-repository.port';
import type {
  ReconciliationQueryRepository,
  ReconciliationResult,
} from './ports/reconciliation-query-repository.port';
import { ReconciliationCalculator } from './reconciliation-calculator';
import { InvalidReconciliationIdentifierError } from './errors/invalid-reconciliation-identifier.error';
import { ReconciliationUnavailableError } from './errors/reconciliation-unavailable.error';
import { LOGGER } from '../../../shared/application/ports/logger.port';
import type { AppLogger } from '../../../shared/application/ports/logger.port';
import { METRICS } from '../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../shared/application/ports/metrics.port';

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(RECONCILIATION_QUERY_REPOSITORY)
    private readonly queryRepository: ReconciliationQueryRepository,
    private readonly calculator: ReconciliationCalculator,
    @Optional() @Inject(METRICS) private readonly metrics?: Metrics,
    @Optional() @Inject(LOGGER) private readonly logger?: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const startedAt = Date.now();
    let outcome: 'consistent' | 'inconsistent' | 'not_found' | 'unavailable' | 'invalid_input' = 'consistent';
    if (!isUuid(walletId)) {
      outcome = 'invalid_input';
      this.recordMetrics(outcome, Date.now() - startedAt, 0);
      throw new InvalidReconciliationIdentifierError(walletId);
    }

    let snapshot;
    try {
      snapshot = await this.queryRepository.findSnapshot(walletId);
    } catch {
      outcome = 'unavailable';
      this.logger?.error('wallet.reconciliation.unavailable', { walletId, errorCode: 'RECONCILIATION_UNAVAILABLE' });
      this.recordMetrics(outcome, Date.now() - startedAt, 0);
      throw new ReconciliationUnavailableError();
    }

    if (!snapshot) {
      outcome = 'not_found';
      this.logger?.warn('wallet.reconciliation.not_found', { walletId });
      this.recordMetrics(outcome, Date.now() - startedAt, 0);
      throw new WalletNotFoundError(walletId);
    }

    try {
      const result = this.calculator.calculate(snapshot);
      outcome = result.consistent ? 'consistent' : 'inconsistent';
      if (result.consistent) {
        this.logger?.info('wallet.reconciliation.consistent', {
          walletId,
          checkedEntries: result.checkedEntries,
        });
      } else {
        this.logger?.warn('wallet.reconciliation.inconsistent', {
          walletId,
          checkedEntries: result.checkedEntries,
          issues: result.issues,
        });
      }
      this.recordMetrics(outcome, Date.now() - startedAt, result.checkedEntries);
      return result;
    } catch {
      outcome = 'unavailable';
      this.logger?.error('wallet.reconciliation.unavailable', { walletId, errorCode: 'RECONCILIATION_UNAVAILABLE' });
      this.recordMetrics(outcome, Date.now() - startedAt, snapshot.entries.length);
      throw new ReconciliationUnavailableError();
    }
  }

  private recordMetrics(
    outcome: 'consistent' | 'inconsistent' | 'not_found' | 'unavailable' | 'invalid_input',
    durationMs: number,
    checkedEntries: number,
  ): void {
    try {
      const tags = { outcome };
      this.metrics?.increment('wallet_reconciliations_total', tags);
      this.metrics?.observe?.('wallet_reconciliation_duration_ms', durationMs, tags);
      for (let index = 0; index < checkedEntries; index += 1) {
        this.metrics?.increment('wallet_reconciliation_entries_checked_total', tags);
      }
    } catch {
      // Observability failures must not change the reconciliation result.
    }
  }
}
