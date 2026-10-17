import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { CLOCK } from '../../../shared/application/ports/clock.port';
import type { Clock } from '../../../shared/application/ports/clock.port';
import { ID_GENERATOR } from '../../../shared/application/ports/id-generator.port';
import type { IdGenerator } from '../../../shared/application/ports/id-generator.port';
import { LOGGER } from '../../../shared/application/ports/logger.port';
import type { AppLogger } from '../../../shared/application/ports/logger.port';
import { METRICS } from '../../../shared/application/ports/metrics.port';
import type { Metrics } from '../../../shared/application/ports/metrics.port';
import { UNIT_OF_WORK } from '../../../shared/application/ports/unit-of-work.port';
import type { UnitOfWork } from '../../../shared/application/ports/unit-of-work.port';
import { Money } from '../../../shared/domain/money';
import { WalletNotFoundError } from '../../wallets/application/errors/wallet-not-found.error';
import { LEDGER_REPOSITORY } from '../../wallets/application/ports/ledger-repository.port';
import type { LedgerRepository } from '../../wallets/application/ports/ledger-repository.port';
import { WALLET_REPOSITORY } from '../../wallets/application/ports/wallet-repository.port';
import type { WalletRepository } from '../../wallets/application/ports/wallet-repository.port';
import { InsufficientWalletBalanceError } from '../../wallets/domain/errors/insufficient-wallet-balance.error';
import { Wallet } from '../../wallets/domain/wallet';
import { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import { ExternalTransactionConflictError } from './errors/external-transaction-conflict.error';
import { IdempotencyConflictError } from './errors/idempotency-conflict.error';
import { OptimisticLockRetryExhaustedError } from './errors/optimistic-lock-retry-exhausted.error';
import { ReversalConflictError } from './errors/reversal-conflict.error';
import { PAYLOAD_HASHER } from './ports/payload-hasher.port';
import type { PayloadHasher, WagerBusinessPayload } from './ports/payload-hasher.port';
import {
  WAGER_TRANSACTION_REPOSITORY,
} from './ports/wager-transaction-repository.port';
import type {
  WagerTransactionRecord,
  WagerTransactionRepository,
} from './ports/wager-transaction-repository.port';
import { WagerReferenceValidator } from './wager-reference.validator';
import { ReferencePendingPolicy } from './reference-pending-policy';
import { OUTBOX_REPOSITORY } from '../../messaging/outbox/application/ports/outbox-repository.port';
import type { OutboxRepository } from '../../messaging/outbox/application/ports/outbox-repository.port';
import { OutboxMessage } from '../../messaging/outbox/domain/outbox-message';
import { LedgerEffectRecorder } from '../../ledger/application/ledger-effect-recorder';
import {
  FailureCode,
  WagerTransaction,
} from '../domain/wager-transaction';

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  referenceExternalTransactionId?: string;
  money: {
    amount: string;
    currency: string;
  };
}

export interface ProcessedWagerTransactionResult {
  transactionId: string;
  status: 'PROCESSED';
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

export interface RejectedWagerTransactionResult {
  transactionId: string;
  status: 'REJECTED';
  balance?: { amount: string; currency: string };
  failureCode:
    | 'INSUFFICIENT_FUNDS'
    | 'WALLET_MISMATCH'
    | 'REFERENCE_NOT_FOUND'
    | 'REFERENCE_NOT_COMPATIBLE'
    | 'REVERSAL_NEGATIVE_BALANCE';
  idempotentReplay: boolean;
}

export interface PendingReferenceWagerTransactionResult {
  transactionId: string;
  status: 'PENDING_REFERENCE';
  nextAttemptAt: string;
  idempotentReplay: boolean;
}

export type ProcessWagerTransactionResult =
  | ProcessedWagerTransactionResult
  | RejectedWagerTransactionResult
  | PendingReferenceWagerTransactionResult;

export type WagerProcessingSource = 'HTTP' | 'SQS' | 'REFERENCE_WORKER';

@Injectable()
export class ProcessWagerTransactionUseCase {
  private readonly referenceValidator = new WagerReferenceValidator();
  private readonly referencePendingPolicy = new ReferencePendingPolicy();

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly walletRepository: WalletRepository<Wallet>,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactionRepository: WagerTransactionRepository<WagerTransaction>,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRepository: LedgerRepository<WalletLedgerEntry>,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(PAYLOAD_HASHER) private readonly payloadHasher: PayloadHasher,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Optional() @Inject(OUTBOX_REPOSITORY) private readonly outboxRepository?: OutboxRepository,
    @Optional() @Inject(METRICS) private readonly metrics?: Metrics,
    @Optional() private readonly ledgerEffectRecorder?: LedgerEffectRecorder,
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
    source: WagerProcessingSource = 'HTTP',
  ): Promise<ProcessWagerTransactionResult> {
    const startedAt = Date.now();
    try {
      return await this.executeWithMetrics(command, source);
    } finally {
      this.metrics?.observe?.('processing_duration_ms', Date.now() - startedAt, {
        operation: `WAGER_${command.kind}`,
        source,
      });
    }
  }

  private async executeWithMetrics(
    command: ProcessWagerTransactionCommand,
    source: WagerProcessingSource,
  ): Promise<ProcessWagerTransactionResult> {
    const money = Money.of(command.money.amount, command.money.currency);
    const normalizedPayload = this.toBusinessPayload(command, money);
    const payloadHash = this.payloadHasher.hash(normalizedPayload);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.unitOfWork.execute(() => this.executeWithinTransaction(command, money, payloadHash));
        this.recordOutcome(result, command.kind, source);
        return result;
      } catch (error) {
        if (this.isUniqueConstraintViolation(error)) {
          const result = await this.unitOfWork.execute(() => this.resolveExisting(command, payloadHash));
          this.recordOutcome(result, command.kind, source);
          return result;
        }
        if (!(error instanceof OptimisticLockRetryExhaustedError)) {
          throw error;
        }
        if (attempt === 3) {
          this.metrics?.increment('lock_conflicts_total', { aggregate: 'wallet' });
          this.logger.error('wager.bet.retry_exhausted', {
            walletId: command.walletId,
            providerId: command.providerId,
            attempt,
            maxAttempts: 3,
          });
          throw new OptimisticLockRetryExhaustedError(command.walletId, 3);
        }
        this.metrics?.increment('wager_retries_total', {
          kind: command.kind,
          source,
          reason: 'optimistic_lock',
        });
        this.logger.warn('wager.bet.retry', {
          walletId: command.walletId,
          providerId: command.providerId,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: 3,
        });
      }
    }

    throw new OptimisticLockRetryExhaustedError(command.walletId, 3);
  }

  async reprocessPendingReference(record: WagerTransactionRecord): Promise<ProcessWagerTransactionResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.unitOfWork.execute(async () => {
          const current = this.transactionRepository.findPendingReferenceForUpdate
            ? await this.transactionRepository.findPendingReferenceForUpdate(record.id, this.clock.now())
            : record;
          if (!current) {
            throw new Error(`pending transaction ${record.id} is no longer due`);
          }
          return this.reprocessPendingReferenceWithinTransaction(current);
        });
        this.recordOutcome(result, record.kind, 'REFERENCE_WORKER');
        return result;
      } catch (error) {
        if (!(error instanceof OptimisticLockRetryExhaustedError) || attempt === 3) {
          throw error;
        }
        this.metrics?.increment('wager_retries_total', {
          kind: record.kind,
          source: 'REFERENCE_WORKER',
          reason: 'optimistic_lock',
        });
        this.logger.warn('wager.pending_reference.retry', {
          transactionId: record.id,
          walletId: record.walletId,
          providerId: record.providerId,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: 3,
        });
      }
    }

    throw new OptimisticLockRetryExhaustedError(record.walletId, 3);
  }

  async reprocessNextPendingReference(limit = 1): Promise<ProcessWagerTransactionResult | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        let processedKind: string | undefined;
        const result = await this.unitOfWork.execute(async () => {
          const records = await this.transactionRepository.findPendingReferenceDueForUpdate(
            this.clock.now(),
            limit,
          );
          const record = records[0];
          processedKind = record?.kind;
          return record ? this.reprocessPendingReferenceWithinTransaction(record) : null;
        });
        if (result && processedKind) this.recordOutcome(result, processedKind, 'REFERENCE_WORKER');
        return result;
      } catch (error) {
        if (!(error instanceof OptimisticLockRetryExhaustedError) || attempt === 3) {
          throw error;
        }
        this.metrics?.increment('wager_retries_total', {
          source: 'REFERENCE_WORKER',
          reason: 'optimistic_lock',
        });
        this.logger.warn('wager.pending_reference.retry', {
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: 3,
        });
      }
    }

    return null;
  }

  private recordOutcome(
    result: ProcessWagerTransactionResult,
    kind: ProcessWagerTransactionCommand['kind'] | string,
    source: WagerProcessingSource,
  ): void {
    this.metrics?.increment('wager_transactions_total', {
      status: result.status,
      kind,
      source,
    });
    if (result.idempotentReplay) {
      this.metrics?.increment('wager_replays_total', { kind, source });
    }
  }

  private async reprocessPendingReferenceWithinTransaction(
    record: WagerTransactionRecord,
  ): Promise<ProcessWagerTransactionResult> {
    if (record.status !== 'PENDING_REFERENCE') {
      throw new Error(`transaction ${record.id} is not pending a reference`);
    }

    const transaction = WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey ?? undefined,
      payloadHash: record.payloadHash ?? undefined,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId ?? undefined,
      gameId: record.gameId ?? undefined,
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      kind: record.kind as 'WIN' | 'REFUND' | 'ROLLBACK',
      amount: Money.of(record.amount, record.currency),
      status: 'PENDING_REFERENCE',
      pendingSince: record.pendingSince ?? undefined,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      pendingAttempts: record.pendingAttempts ?? 0,
      createdAt: record.createdAt,
      failureCode: undefined,
      resultBalance: record.resultBalanceAmount && record.resultBalanceCurrency
        ? Money.of(record.resultBalanceAmount, record.resultBalanceCurrency)
        : undefined,
      processedAt: record.processedAt ?? undefined,
    });
    const pendingSince = transaction.pendingSince ?? transaction.createdAt;
    const now = this.clock.now();
    this.logger.info('wager.pending_reference.attempt', {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      pendingAttempts: transaction.pendingAttempts,
      pendingAgeSeconds: Math.max(0, Math.floor((now.getTime() - pendingSince.getTime()) / 1_000)),
    });
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (!referenceExternalTransactionId) {
      throw new Error(`pending transaction ${transaction.id} is missing its reference`);
    }

    const reference = await this.transactionRepository.findByExternalTransactionId(
      transaction.providerId,
      referenceExternalTransactionId,
    );
    const validation = this.referenceValidator.validate(reference, {
      providerId: transaction.providerId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      currency: transaction.amount.currency,
      roundId: transaction.roundId ?? '',
      kind: transaction.kind === 'WIN' || transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK'
        ? transaction.kind
        : undefined,
      amount: transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK'
        ? transaction.amount.amount
        : undefined,
    });

    if (validation.status === 'NOT_FOUND' || validation.status === 'PENDING') {
      const schedule = this.referencePendingPolicy.scheduleRetry(
        pendingSince,
        transaction.pendingAttempts,
        now,
      );
      if (!schedule || this.referencePendingPolicy.isExpired(pendingSince, now)) {
        transaction.expirePendingReference();
        await this.transactionRepository.update(transaction);
        await this.enqueueEvent(transaction, 'WagerTransactionRejected', {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          kind: transaction.kind,
          failureCode: 'REFERENCE_NOT_FOUND',
        });
        this.logger.warn('wager.pending_reference.expired', {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          failureCode: 'REFERENCE_NOT_FOUND',
        });
        return {
          transactionId: transaction.id,
          status: 'REJECTED',
          failureCode: 'REFERENCE_NOT_FOUND',
          idempotentReplay: false,
        };
      }

      transaction.scheduleReferenceRetry(schedule.nextAttemptAt);
      await this.transactionRepository.update(transaction);
      this.logger.info('wager.pending_reference.rescheduled', {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        pendingAttempts: transaction.pendingAttempts,
        nextAttemptAt: schedule.nextAttemptAt.toISOString(),
      });
      return {
        transactionId: transaction.id,
        status: 'PENDING_REFERENCE',
        nextAttemptAt: schedule.nextAttemptAt.toISOString(),
        idempotentReplay: false,
      };
    }

    if (validation.status === 'INCOMPATIBLE') {
      transaction.reject('REFERENCE_NOT_COMPATIBLE');
      await this.transactionRepository.update(transaction);
      await this.enqueueEvent(transaction, 'WagerTransactionRejected', {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        failureCode: 'REFERENCE_NOT_COMPATIBLE',
      });
      this.logger.warn('wager.pending_reference.incompatible', {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        failureCode: 'REFERENCE_NOT_COMPATIBLE',
      });
      return {
        transactionId: transaction.id,
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_COMPATIBLE',
        idempotentReplay: false,
      };
    }

    const wallet = await this.walletRepository.findById(transaction.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(transaction.walletId);
    }
    if (transaction.kind === 'WIN') {
      if (!validation.transaction) {
        throw new Error(`transaction ${transaction.id} resolved without a reference`);
      }
      transaction.linkReference(validation.transaction.id);
      const result = await this.processCreditTransaction(transaction, wallet, now);
      this.logger.info('wager.pending_reference.resolved', {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        status: result.status,
      });
      return result;
    }

    if (!validation.transaction) {
      throw new Error(`transaction ${transaction.id} resolved without a reference`);
    }
    transaction.linkReference(validation.transaction.id);
    const result = await this.processReversalEffect(transaction, validation.transaction, wallet, now);
    this.logger.info('wager.pending_reference.resolved', {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      status: result.status,
    });
    return result;
  }

  private async executeWithinTransaction(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const byKey = await this.transactionRepository.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (byKey) {
      return this.resolveRecord(byKey, payloadHash, 'idempotency');
    }

    const byExternal = await this.transactionRepository.findByExternalTransactionId(
      command.providerId,
      command.externalTransactionId,
    );
    if (byExternal) {
      return this.resolveRecord(byExternal, payloadHash, 'external');
    }

    const transaction = WagerTransaction.create({
      id: this.idGenerator.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      money,
      createdAt: this.clock.now(),
    });

    const wallet = await this.walletRepository.findById(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    if (wallet.playerId !== command.playerId || wallet.currency !== money.currency) {
      transaction.reject('WALLET_MISMATCH', wallet.balance);
      await this.transactionRepository.save(transaction);
      await this.enqueueEvent(transaction, 'WagerTransactionRejected', {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        failureCode: 'WALLET_MISMATCH',
      });
      this.logger.warn('wager.bet.rejected', {
        transactionId: transaction.id,
        walletId: wallet.id,
        providerId: command.providerId,
        failureCode: 'WALLET_MISMATCH',
      });
      return {
        transactionId: transaction.id,
        status: 'REJECTED',
        balance: wallet.balance.toJSON(),
        failureCode: 'WALLET_MISMATCH',
        idempotentReplay: false,
      };
    }

    if (command.kind === 'LOSS') {
      return this.processLoss(command, transaction, wallet);
    }

    if (command.kind === 'WIN') {
      return this.processWin(command, money, transaction, wallet);
    }

    if (command.kind === 'REFUND' || command.kind === 'ROLLBACK') {
      return this.processReversal(command, money, transaction, wallet);
    }

    let debit;
    try {
      debit = wallet.debit(money, this.clock.now());
    } catch (error) {
      if (!(error instanceof InsufficientWalletBalanceError)) {
        throw error;
      }
      transaction.reject('INSUFFICIENT_FUNDS', wallet.balance);
      await this.transactionRepository.save(transaction);
      await this.enqueueEvent(transaction, 'WagerTransactionRejected', {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      this.logger.warn('wager.bet.rejected', {
        transactionId: transaction.id,
        walletId: wallet.id,
        providerId: command.providerId,
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      return {
        transactionId: transaction.id,
        status: 'REJECTED',
        balance: wallet.balance.toJSON(),
        failureCode: 'INSUFFICIENT_FUNDS',
        idempotentReplay: false,
      };
    }

    transaction.markProcessed(this.clock.now(), debit.balanceAfter);
    await this.transactionRepository.save(transaction);

    const updated = await this.walletRepository.updateBalanceIfVersion(
      wallet.id,
      debit.versionBefore,
      debit.balanceAfter.amount,
      debit.versionAfter,
      wallet.updatedAt,
    );
    if (!updated) {
      throw new OptimisticLockRetryExhaustedError(wallet.id, 1);
    }

    const ledgerEntry = WalletLedgerEntry.debit(
      this.idGenerator.next(),
      wallet.id,
      transaction.id,
      money,
      debit.balanceBefore,
      this.clock.now(),
    );
    await this.ledgerRepository.save(ledgerEntry);
    await this.ledgerEffectRecorder?.record({
      transactionId: transaction.id,
      effectType: 'BET',
      walletId: wallet.id,
      currency: money.currency,
      amount: money,
      occurredAt: this.clock.now(),
    });
    await this.enqueueProcessedAndBalanceChanged(transaction, ledgerEntry, debit.versionAfter);

    this.logger.info('wager.bet.processed', {
      transactionId: transaction.id,
      walletId: wallet.id,
      providerId: command.providerId,
      version: debit.versionAfter,
    });

    return {
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: debit.balanceAfter.toJSON(),
      idempotentReplay: false,
    };
  }

  private async processWin(
    command: ProcessWagerTransactionCommand,
    money: Money,
    transaction: WagerTransaction,
    wallet: Wallet,
  ): Promise<ProcessWagerTransactionResult> {
    if (command.referenceExternalTransactionId) {
      const reference = await this.transactionRepository.findByExternalTransactionId(
        command.providerId,
        command.referenceExternalTransactionId,
      );
      const validation = this.referenceValidator.validate(reference, {
        providerId: command.providerId,
        playerId: command.playerId,
        walletId: command.walletId,
        currency: money.currency,
        roundId: command.roundId,
        kind: 'WIN',
      });

      if (validation.status === 'NOT_FOUND' || validation.status === 'PENDING') {
        const now = this.clock.now();
        const schedule = this.referencePendingPolicy.scheduleInitial(now);
        transaction.markPendingReference(schedule.pendingSince, schedule.nextAttemptAt);
        await this.transactionRepository.save(transaction);
        await this.enqueueEvent(transaction, 'WagerTransactionPendingReference', {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          pendingSince: schedule.pendingSince.toISOString(),
          nextAttemptAt: schedule.nextAttemptAt.toISOString(),
        });
        return {
          transactionId: transaction.id,
          status: 'PENDING_REFERENCE',
          nextAttemptAt: schedule.nextAttemptAt.toISOString(),
          idempotentReplay: false,
        };
      }
      if (validation.status === 'INCOMPATIBLE') {
        transaction.reject('REFERENCE_NOT_COMPATIBLE', wallet.balance);
        await this.transactionRepository.save(transaction);
        await this.enqueueEvent(transaction, 'WagerTransactionRejected', {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          kind: transaction.kind,
          failureCode: 'REFERENCE_NOT_COMPATIBLE',
        });
        return {
          transactionId: transaction.id,
          status: 'REJECTED',
          balance: wallet.balance.toJSON(),
          failureCode: 'REFERENCE_NOT_COMPATIBLE',
          idempotentReplay: false,
        };
      }

      transaction.linkReference(validation.transaction.id);
    }

    const credit = wallet.credit(money, this.clock.now());
    transaction.markProcessed(this.clock.now(), credit.balanceAfter);
    await this.transactionRepository.save(transaction);

    const updated = await this.walletRepository.updateBalanceIfVersion(
      wallet.id,
      credit.versionBefore,
      credit.balanceAfter.amount,
      credit.versionAfter,
      wallet.updatedAt,
    );
    if (!updated) {
      throw new OptimisticLockRetryExhaustedError(wallet.id, 1);
    }

    const ledgerEntry = WalletLedgerEntry.credit(
      this.idGenerator.next(),
      wallet.id,
      transaction.id,
      money,
      credit.balanceBefore,
      this.clock.now(),
    );
    await this.ledgerRepository.save(ledgerEntry);
    await this.ledgerEffectRecorder?.record({
      transactionId: transaction.id,
      effectType: 'WIN',
      walletId: wallet.id,
      currency: money.currency,
      amount: money,
      occurredAt: this.clock.now(),
    });
    await this.enqueueProcessedAndBalanceChanged(transaction, ledgerEntry, credit.versionAfter);

    this.logger.info('wager.win.processed', {
      transactionId: transaction.id,
      walletId: command.walletId,
      providerId: command.providerId,
      version: credit.versionAfter,
    });

    return {
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: credit.balanceAfter.toJSON(),
      idempotentReplay: false,
    };
  }

  private async processReversal(
    command: ProcessWagerTransactionCommand,
    money: Money,
    transaction: WagerTransaction,
    wallet: Wallet,
  ): Promise<ProcessWagerTransactionResult> {
    if (!command.referenceExternalTransactionId) {
      throw new Error('referenceExternalTransactionId is required for reversals');
    }

    const reference = await this.transactionRepository.findByExternalTransactionId(
      command.providerId,
      command.referenceExternalTransactionId,
    );
    const validation = this.referenceValidator.validate(reference, {
      providerId: command.providerId,
      playerId: command.playerId,
      walletId: command.walletId,
      currency: money.currency,
      roundId: command.roundId,
      kind: command.kind as 'REFUND' | 'ROLLBACK',
      amount: money.amount,
    });

    if (validation.status === 'NOT_FOUND' || validation.status === 'PENDING') {
      const now = this.clock.now();
      const schedule = this.referencePendingPolicy.scheduleInitial(now);
      transaction.markPendingReference(schedule.pendingSince, schedule.nextAttemptAt);
      await this.transactionRepository.save(transaction);
      await this.enqueueEvent(transaction, 'WagerTransactionPendingReference', {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        pendingSince: schedule.pendingSince.toISOString(),
        nextAttemptAt: schedule.nextAttemptAt.toISOString(),
      });
      return {
        transactionId: transaction.id,
        status: 'PENDING_REFERENCE',
        nextAttemptAt: schedule.nextAttemptAt.toISOString(),
        idempotentReplay: false,
      };
    }

    if (validation.status === 'INCOMPATIBLE') {
      return this.rejectReference(transaction, wallet, validation.reason);
    }

    const existing = await this.transactionRepository.findDirectReversal(validation.transaction.id);
    if (existing) {
      throw new ReversalConflictError(validation.transaction.id);
    }
    transaction.linkReference(validation.transaction.id);
    return this.processReversalEffect(transaction, validation.transaction, wallet, this.clock.now());
  }

  private async processReversalEffect(
    transaction: WagerTransaction,
    reference: WagerTransactionRecord,
    wallet: Wallet,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const direction = reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    const alreadyPersisted = transaction.status === 'PENDING_REFERENCE';
    try {
      const result = direction === 'CREDIT'
        ? wallet.credit(transaction.amount, now)
        : wallet.debit(transaction.amount, now);

      transaction.markProcessed(now, result.balanceAfter);
      if (alreadyPersisted) {
        await this.transactionRepository.update(transaction);
      } else {
        await this.transactionRepository.save(transaction);
      }

      const updated = await this.walletRepository.updateBalanceIfVersion(
        wallet.id,
        result.versionBefore,
        result.balanceAfter.amount,
        result.versionAfter,
        wallet.updatedAt,
      );
      if (!updated) {
        throw new OptimisticLockRetryExhaustedError(wallet.id, 1);
      }

      const ledgerEntry = direction === 'CREDIT'
        ? WalletLedgerEntry.credit(this.idGenerator.next(), wallet.id, transaction.id, transaction.amount, result.balanceBefore, now)
        : WalletLedgerEntry.debit(this.idGenerator.next(), wallet.id, transaction.id, transaction.amount, result.balanceBefore, now);
      await this.ledgerRepository.save(ledgerEntry);
      if (reference.kind !== 'BET' && reference.kind !== 'WIN') {
        throw new Error(`unsupported reversal reference kind ${reference.kind}`);
      }
      await this.ledgerEffectRecorder?.recordReversal({
        transactionId: transaction.id,
        effectType: transaction.kind as 'REFUND' | 'ROLLBACK',
        walletId: wallet.id,
        currency: transaction.amount.currency,
        amount: transaction.amount,
        occurredAt: now,
        referenceTransactionId: reference.id,
        referenceEffectType: reference.kind,
      });
      await this.enqueueProcessedAndBalanceChanged(transaction, ledgerEntry, result.versionAfter);

      this.logger.info('wager.reversal.processed', {
        transactionId: transaction.id,
        referenceTransactionId: reference.id,
        walletId: wallet.id,
        providerId: transaction.providerId,
        direction,
        version: result.versionAfter,
      });

      return {
        transactionId: transaction.id,
        status: 'PROCESSED',
        balance: result.balanceAfter.toJSON(),
        idempotentReplay: false,
      };
    } catch (error) {
      if (!(error instanceof InsufficientWalletBalanceError)) {
        throw error;
      }
      transaction.reject('REVERSAL_NEGATIVE_BALANCE', wallet.balance);
      if (alreadyPersisted) {
        await this.transactionRepository.update(transaction);
      } else {
        await this.transactionRepository.save(transaction);
      }
      await this.enqueueEvent(transaction, 'WagerTransactionRejected', {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        kind: transaction.kind,
        failureCode: 'REVERSAL_NEGATIVE_BALANCE',
      });
      return {
        transactionId: transaction.id,
        status: 'REJECTED',
        balance: wallet.balance.toJSON(),
        failureCode: 'REVERSAL_NEGATIVE_BALANCE',
        idempotentReplay: false,
      };
    }
  }

  private async processCreditTransaction(
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<ProcessedWagerTransactionResult> {
    const credit = wallet.credit(transaction.amount, now);
    transaction.markProcessed(now, credit.balanceAfter);
    await this.transactionRepository.update(transaction);

    const updated = await this.walletRepository.updateBalanceIfVersion(
      wallet.id,
      credit.versionBefore,
      credit.balanceAfter.amount,
      credit.versionAfter,
      wallet.updatedAt,
    );
    if (!updated) {
      throw new OptimisticLockRetryExhaustedError(wallet.id, 1);
    }

    const ledgerEntry = WalletLedgerEntry.credit(
      this.idGenerator.next(),
      wallet.id,
      transaction.id,
      transaction.amount,
      credit.balanceBefore,
      now,
    );
    await this.ledgerRepository.save(ledgerEntry);
      await this.ledgerEffectRecorder?.record({
        transactionId: transaction.id,
        effectType: 'WIN',
        walletId: wallet.id,
        currency: transaction.amount.currency,
        amount: transaction.amount,
        occurredAt: now,
      });
    await this.enqueueProcessedAndBalanceChanged(transaction, ledgerEntry, credit.versionAfter);

    return {
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: credit.balanceAfter.toJSON(),
      idempotentReplay: false,
    };
  }

  private async rejectReference(
    transaction: WagerTransaction,
    wallet: Wallet,
    reason: 'NOT_PROCESSED_BET' | 'NOT_ALLOWED_KIND' | 'CONTEXT_MISMATCH' | 'AMOUNT_MISMATCH',
  ): Promise<RejectedWagerTransactionResult> {
    transaction.reject('REFERENCE_NOT_COMPATIBLE', wallet.balance);
    await this.transactionRepository.save(transaction);
    await this.enqueueEvent(transaction, 'WagerTransactionRejected', {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      failureCode: 'REFERENCE_NOT_COMPATIBLE',
      reason,
    });
    return {
      transactionId: transaction.id,
      status: 'REJECTED',
      balance: wallet.balance.toJSON(),
      failureCode: 'REFERENCE_NOT_COMPATIBLE',
      idempotentReplay: false,
    };
  }

  private async processLoss(
    command: ProcessWagerTransactionCommand,
    transaction: WagerTransaction,
    wallet: Wallet,
  ): Promise<ProcessedWagerTransactionResult> {
    transaction.markProcessed(this.clock.now(), wallet.balance);
    await this.transactionRepository.save(transaction);
    await this.enqueueEvent(transaction, 'WagerTransactionProcessed', {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      kind: transaction.kind,
      status: transaction.status,
    });

    this.logger.info('wager.loss.processed', {
      transactionId: transaction.id,
      walletId: command.walletId,
      providerId: command.providerId,
      version: wallet.version,
    });

    return {
      transactionId: transaction.id,
      status: 'PROCESSED',
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async enqueueProcessedAndBalanceChanged(
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry,
    walletVersion: number,
  ): Promise<void> {
    await this.enqueueEvent(transaction, 'WagerTransactionProcessed', {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      kind: transaction.kind,
      status: transaction.status,
    });
    await this.enqueueEvent(transaction, 'WalletBalanceChanged', {
      walletId: ledgerEntry.walletId,
      transactionId: ledgerEntry.transactionId,
      direction: ledgerEntry.direction,
      money: ledgerEntry.amount.toJSON(),
      balanceBefore: ledgerEntry.balanceBefore.toJSON(),
      balanceAfter: ledgerEntry.balanceAfter.toJSON(),
      walletVersion,
    });
  }

  private async enqueueEvent(
    transaction: WagerTransaction,
    eventType: 'WagerTransactionProcessed' | 'WagerTransactionRejected' | 'WalletBalanceChanged' | 'WagerTransactionPendingReference',
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.outboxRepository) {
      return;
    }

    const message = OutboxMessage.enqueue({
      eventId: this.idGenerator.next(),
      aggregateId: transaction.id,
      correlationId: transaction.id,
      eventType,
      version: 1,
      data,
      occurredAt: this.clock.now(),
    });
    await this.outboxRepository.enqueue(message);
    this.logger.info('wager.outbox.enqueued', {
      eventId: message.eventId,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      eventType,
    });
  }

  private async resolveExisting(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const byKey = await this.transactionRepository.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (byKey) {
      return this.resolveRecord(byKey, payloadHash, 'idempotency');
    }
    const byExternal = await this.transactionRepository.findByExternalTransactionId(
      command.providerId,
      command.externalTransactionId,
    );
    if (byExternal) {
      return this.resolveRecord(byExternal, payloadHash, 'external');
    }
    if ((command.kind === 'REFUND' || command.kind === 'ROLLBACK') && command.referenceExternalTransactionId) {
      const reference = await this.transactionRepository.findByExternalTransactionId(
        command.providerId,
        command.referenceExternalTransactionId,
      );
      if (reference) {
        const reversal = await this.transactionRepository.findDirectReversal(reference.id);
        if (reversal) {
          throw new ReversalConflictError(reference.id);
        }
      }
    }
    throw new Error('unique transaction constraint conflicted before the existing record became readable');
  }

  private resolveRecord(
    record: WagerTransactionRecord,
    payloadHash: string,
    conflictKind: 'idempotency' | 'external',
  ): ProcessWagerTransactionResult {
    if (record.payloadHash !== payloadHash) {
      this.logger.warn('wager.bet.conflict', {
        transactionId: record.id,
        walletId: record.walletId,
        providerId: record.providerId,
        conflictKind,
      });
      if (conflictKind === 'idempotency') {
        throw new IdempotencyConflictError(record.providerId, record.idempotencyKey ?? '');
      }
      throw new ExternalTransactionConflictError(record.providerId, record.externalTransactionId);
    }

    if (record.status === 'PROCESSED') {
      if (!record.resultBalanceAmount || !record.resultBalanceCurrency) {
        throw new Error('processed transaction is missing replay balance');
      }
      this.logger.info('wager.bet.replay', {
        transactionId: record.id,
        walletId: record.walletId,
        providerId: record.providerId,
        replayKind: conflictKind,
        status: record.status,
      });
      return {
        transactionId: record.id,
        status: 'PROCESSED',
        balance: { amount: record.resultBalanceAmount, currency: record.resultBalanceCurrency },
        idempotentReplay: true,
      };
    }

    if (record.status === 'PENDING_REFERENCE') {
      if (!record.nextAttemptAt) {
        throw new Error('pending reference transaction is missing nextAttemptAt');
      }
      return {
        transactionId: record.id,
        status: 'PENDING_REFERENCE',
        nextAttemptAt: record.nextAttemptAt.toISOString(),
        idempotentReplay: true,
      };
    }

    if (record.status === 'REJECTED' && this.isReplayFailureCode(record.failureCode)) {
      this.logger.info('wager.bet.replay', {
        transactionId: record.id,
        walletId: record.walletId,
        providerId: record.providerId,
        replayKind: conflictKind,
        status: record.status,
        failureCode: record.failureCode,
      });
      return {
        transactionId: record.id,
        status: 'REJECTED',
        balance: record.resultBalanceAmount && record.resultBalanceCurrency
          ? { amount: record.resultBalanceAmount, currency: record.resultBalanceCurrency }
          : undefined,
        failureCode: record.failureCode,
        idempotentReplay: true,
      };
    }

    throw new Error(`transaction ${record.id} is not replayable in the BET flow`);
  }

  private toBusinessPayload(
    command: ProcessWagerTransactionCommand,
    money: Money,
  ): WagerBusinessPayload {
    const payload: WagerBusinessPayload = {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
    };

    if (command.referenceExternalTransactionId !== undefined) {
      payload.referenceExternalTransactionId = command.referenceExternalTransactionId;
    }

    return payload;
  }

  private isReplayFailureCode(value: string | null): value is RejectedWagerTransactionResult['failureCode'] {
    return value === 'INSUFFICIENT_FUNDS'
      || value === 'WALLET_MISMATCH'
      || value === 'REFERENCE_NOT_FOUND'
      || value === 'REFERENCE_NOT_COMPATIBLE'
      || value === 'REVERSAL_NEGATIVE_BALANCE';
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    if (error instanceof UniqueConstraintViolationException) {
      return true;
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code?: string }).code === '23505';
    }
    return false;
  }
}
