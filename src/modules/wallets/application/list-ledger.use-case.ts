import { Inject, Injectable, Optional } from '@nestjs/common';

import { InvalidLedgerCursorError, LedgerCursorCodec } from './ledger-cursor.codec';
import { InvalidLedgerLimitError } from './errors/invalid-ledger-limit.error';
import {
  DEFAULT_LEDGER_LIMIT,
  MAX_LEDGER_LIMIT,
} from '../http/dto/ledger-query.dto';
import { WalletNotFoundError } from './errors/wallet-not-found.error';
import {
  LEDGER_QUERY_REPOSITORY,
} from './ports/ledger-query-repository.port';
import type {
  LedgerEntryReadModel,
  LedgerQueryRepository,
} from './ports/ledger-query-repository.port';
import { WALLET_REPOSITORY } from './ports/wallet-repository.port';
import type { WalletRepository } from './ports/wallet-repository.port';
import type { Wallet } from '../domain/wallet';
import { METRICS } from '../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../shared/application/ports/metrics.port';

export interface ListLedgerQuery {
  readonly walletId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListLedgerResult {
  readonly walletId: string;
  readonly items: readonly LedgerEntryReadModel[];
  readonly nextCursor: string | null;
}

@Injectable()
export class ListLedgerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepository: WalletRepository<Wallet>,
    @Inject(LEDGER_QUERY_REPOSITORY) private readonly ledgerRepository: LedgerQueryRepository,
    private readonly cursorCodec: LedgerCursorCodec,
    @Optional() @Inject(METRICS) private readonly metrics?: Metrics,
  ) {}

  async execute(query: ListLedgerQuery): Promise<ListLedgerResult> {
    const startedAt = Date.now();
    let outcome: 'success' | 'not_found' | 'invalid_cursor' | 'invalid_input' | 'unavailable' = 'success';
    try {
      const limit = this.validateLimit(query.limit);
      const wallet = await this.walletRepository.findById(query.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(query.walletId);
      }

      let cursor;
      if (query.cursor !== undefined) {
        cursor = this.cursorCodec.decode(query.cursor, query.walletId);
      }

      const page = await this.ledgerRepository.findPage(query.walletId, cursor, limit);
      const lastItem = page.items[page.items.length - 1];
      const nextCursor = page.hasNextPage && lastItem
        ? this.cursorCodec.encode({
            walletId: query.walletId,
            createdAt: lastItem.createdAt,
            id: lastItem.id,
          })
        : null;

      return {
        walletId: query.walletId,
        items: page.items,
        nextCursor,
      };
    } catch (error) {
      outcome = this.readOutcome(error);
      throw error;
    } finally {
      this.recordRead('LEDGER_LIST', outcome, Date.now() - startedAt);
    }
  }

  private validateLimit(limit: number | undefined): number {
    const value = limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(value) || value < 1 || value > MAX_LEDGER_LIMIT) {
      throw new InvalidLedgerLimitError();
    }
    return value;
  }

  private readOutcome(error: unknown): 'not_found' | 'invalid_cursor' | 'invalid_input' | 'unavailable' {
    if (error instanceof WalletNotFoundError) return 'not_found';
    if (error instanceof InvalidLedgerCursorError) return 'invalid_cursor';
    if (error instanceof InvalidLedgerLimitError) return 'invalid_input';
    return 'unavailable';
  }

  private recordRead(operation: string, outcome: string, durationMs: number): void {
    try {
      this.metrics?.increment('read_queries_total', { operation, outcome });
      this.metrics?.observe?.('read_query_duration_ms', durationMs, { operation, outcome });
    } catch {
      // Observability failures must not change the read result.
    }
  }
}

export { InvalidLedgerCursorError };
