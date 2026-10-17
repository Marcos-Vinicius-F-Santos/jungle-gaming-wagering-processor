import { Inject, Injectable, Optional } from '@nestjs/common';
import { validate as isUuid } from 'uuid';

import { InvalidTransactionIdentifierError } from './errors/invalid-transaction-identifier.error';
import { TransactionNotFoundError } from './errors/transaction-not-found.error';
import {
  WAGER_TRANSACTION_QUERY_REPOSITORY,
} from './ports/wager-transaction-query-repository.port';
import type {
  WagerTransactionQueryRepository,
  WagerTransactionReadModel,
} from './ports/wager-transaction-query-repository.port';
import { METRICS } from '../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../shared/application/ports/metrics.port';

const SAFE_PROVIDER_TEXT = /^(?=.*\S)[^\u0000-\u001F\u007F]+$/;

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_QUERY_REPOSITORY)
    private readonly transactionQuery: WagerTransactionQueryRepository,
    @Optional() @Inject(METRICS) private readonly metrics?: Metrics,
  ) {}

  executeById(transactionId: string): Promise<WagerTransactionReadModel> {
    return this.read('TRANSACTION_BY_ID', async () => {
      if (!isUuid(transactionId)) {
        throw new InvalidTransactionIdentifierError();
      }

      const transaction = await this.transactionQuery.findById(transactionId);
      if (!transaction) {
        throw new TransactionNotFoundError();
      }
      return transaction;
    });
  }

  async executeByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionReadModel> {
    return this.read('TRANSACTION_BY_EXTERNAL', async () => {
      if (
        !this.isSafeIdentifier(providerId, 100) ||
        !this.isSafeIdentifier(externalTransactionId, 255)
      ) {
        throw new InvalidTransactionIdentifierError();
      }

      const transaction = await this.transactionQuery.findByProviderExternalId(
        providerId,
        externalTransactionId,
      );
      if (!transaction) {
        throw new TransactionNotFoundError();
      }
      return transaction;
    });
  }

  private isSafeIdentifier(value: string, maxLength: number): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength && SAFE_PROVIDER_TEXT.test(value);
  }

  private async read(
    operation: 'TRANSACTION_BY_ID' | 'TRANSACTION_BY_EXTERNAL',
    action: () => Promise<WagerTransactionReadModel>,
  ): Promise<WagerTransactionReadModel> {
    const startedAt = Date.now();
    let outcome: 'success' | 'not_found' | 'invalid_input' | 'unavailable' = 'success';
    try {
      return await action();
    } catch (error) {
      if (error instanceof TransactionNotFoundError) outcome = 'not_found';
      else if (error instanceof InvalidTransactionIdentifierError) outcome = 'invalid_input';
      else outcome = 'unavailable';
      throw error;
    } finally {
      try {
        this.metrics?.increment('read_queries_total', { operation, outcome });
        this.metrics?.observe?.('read_query_duration_ms', Date.now() - startedAt, { operation, outcome });
      } catch {
        // Observability failures must not change the read result.
      }
    }
  }
}
