import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

import { LOGGER } from '../../../shared/application/ports/logger.port';
import type { AppLogger } from '../../../shared/application/ports/logger.port';
import { METRICS } from '../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../shared/application/ports/metrics.port';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private activeRun?: Promise<void>;
  private running = false;
  private stopping = false;

  constructor(
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    @Optional() @Inject(METRICS) private readonly metrics?: Metrics,
    @Optional() @Inject(LOGGER) private readonly logger?: AppLogger,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.scheduleRun();
    }, this.pollIntervalMs());
    this.scheduleRun();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activeRun;
  }

  async runOnce(limit = DEFAULT_BATCH_SIZE): Promise<void> {
    if (this.running) {
      return;
    }
    this.metrics?.increment('wager.pending_reference.scan');
    this.running = true;
    const startedAt = Date.now();
    try {
      for (let processed = 0; processed < limit; processed += 1) {
        let result;
        try {
          result = await this.processWagerTransaction.reprocessNextPendingReference();
        } catch (error) {
          this.metrics?.increment('wager.pending_reference.error');
          this.logger?.error('wager.pending_reference.scan_failed', { errorCode: failureCode(error) });
          break;
        }
        if (!result) {
          break;
        }
        this.metrics?.increment(`wager.pending_reference.${result.status.toLowerCase()}`, {
          failureCode: 'failureCode' in result ? result.failureCode : 'none',
        });
        this.metrics?.increment('reference_pending_total', {
          outcome: result.status.toLowerCase(),
        });
      }
    } finally {
      this.running = false;
      this.metrics?.observe?.('processing_duration_ms', Date.now() - startedAt, {
        operation: 'REFERENCE_REPROCESS',
        source: 'REFERENCE_WORKER',
      });
    }
  }

  private scheduleRun(): void {
    if (this.stopping || this.activeRun) {
      return;
    }

    const run = this.runSafely();
    this.activeRun = run;
    void run.finally(() => {
      if (this.activeRun === run) {
        this.activeRun = undefined;
      }
    });
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.metrics?.increment('wager.pending_reference.error');
      this.logger?.error('wager.pending_reference.scan_failed', { errorCode: failureCode(error) });
    }
  }

  private pollIntervalMs(): number {
    const configured = Number(process.env.WAGER_REFERENCE_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_INTERVAL_MS;
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error && error.name && error.name !== 'Error') return error.name.slice(0, 100);
  if (error instanceof Error && error.message) return error.message.slice(0, 100).replaceAll(/\s+/g, '_').toUpperCase();
  return 'PENDING_REFERENCE_SCAN_FAILED';
}
