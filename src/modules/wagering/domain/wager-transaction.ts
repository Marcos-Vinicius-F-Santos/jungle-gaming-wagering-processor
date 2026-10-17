import { validate as isUuid, version as uuidVersion } from 'uuid';

import { Money } from '../../../shared/domain/money';

export type WagerTransactionKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerTransactionStatus =
  | 'PENDING'
  | 'PENDING_REFERENCE'
  | 'PROCESSED'
  | 'REJECTED'
  | 'FAILED';

export type FailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_CONFLICT'
  | 'LOCK_RETRY_EXHAUSTED'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_NOT_COMPATIBLE'
  | 'REVERSAL_NEGATIVE_BALANCE';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, 'OPENING'>;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionSnapshot {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey?: string;
  payloadHash?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  pendingSince?: Date;
  nextAttemptAt?: Date;
  pendingAttempts?: number;
  kind: WagerTransactionKind;
  amount: Money;
  status: WagerTransactionStatus;
  createdAt: Date;
  failureCode?: FailureCode;
  resultBalance?: Money;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(private readonly state: WagerTransactionSnapshot) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertUuidV7(props.id, 'transaction id');
    assertUuid(props.walletId, 'wallet id');
    assertUuid(props.playerId, 'player id');
    assertNonEmpty(props.providerId, 'provider id');
    assertNonEmpty(props.externalTransactionId, 'external transaction id');
    assertNonEmpty(props.idempotencyKey, 'idempotency key');
    assertNonEmpty(props.payloadHash, 'payload hash');
    assertNonEmpty(props.roundId, 'round id');
    assertNonEmpty(props.gameId, 'game id');
    assertValidDate(props.createdAt);
    if (!props.money.isPositive()) {
      throw new Error('wager transaction amount must be positive');
    }
    if ((props.kind === 'REFUND' || props.kind === 'ROLLBACK') && !props.referenceExternalTransactionId) {
      throw new Error('referenceExternalTransactionId is required for reversals');
    }

    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      referenceExternalTransactionId: props.referenceExternalTransactionId,
      referenceTransactionId: props.referenceTransactionId,
      kind: props.kind,
      amount: props.money,
      status: 'PENDING',
      createdAt: new Date(props.createdAt.getTime()),
      pendingAttempts: 0,
    });
  }

  static opening(
    id: string,
    walletId: string,
    playerId: string,
    amount: Money,
    now: Date,
  ): WagerTransaction {
    assertUuidV7(id, 'transaction id');
    assertUuid(walletId, 'wallet id');
    assertUuid(playerId, 'player id');
    assertValidDate(now);
    if (!amount.isPositive()) {
      throw new Error('opening transaction amount must be positive');
    }

    return new WagerTransaction({
      id,
      providerId: 'INTERNAL',
      externalTransactionId: `opening:${walletId}`,
      walletId,
      playerId,
      kind: 'OPENING',
      amount,
      status: 'PROCESSED',
      createdAt: new Date(now.getTime()),
      processedAt: new Date(now.getTime()),
      resultBalance: amount,
      pendingAttempts: 0,
    });
  }

  static rehydrate(snapshot: WagerTransactionSnapshot): WagerTransaction {
    assertUuidV7(snapshot.id, 'transaction id');
    assertUuid(snapshot.walletId, 'wallet id');
    assertUuid(snapshot.playerId, 'player id');
    assertNonEmpty(snapshot.providerId, 'provider id');
    assertNonEmpty(snapshot.externalTransactionId, 'external transaction id');
    assertValidDate(snapshot.createdAt);
    if (snapshot.status === 'PROCESSED' && !snapshot.processedAt) {
      throw new Error('processed transaction must have processedAt');
    }
    if (snapshot.processedAt) {
      assertValidDate(snapshot.processedAt);
    }
    if (snapshot.referenceTransactionId) {
      assertUuid(snapshot.referenceTransactionId, 'reference transaction id');
    }
    if (snapshot.pendingSince) {
      assertValidDate(snapshot.pendingSince);
    }
    if (snapshot.nextAttemptAt) {
      assertValidDate(snapshot.nextAttemptAt);
    }
    if ((snapshot.pendingAttempts ?? 0) < 0) {
      throw new Error('pending attempts must not be negative');
    }

    return new WagerTransaction({
      ...snapshot,
      pendingAttempts: snapshot.pendingAttempts ?? 0,
      createdAt: new Date(snapshot.createdAt.getTime()),
      processedAt: snapshot.processedAt ? new Date(snapshot.processedAt.getTime()) : undefined,
      pendingSince: snapshot.pendingSince ? new Date(snapshot.pendingSince.getTime()) : undefined,
      nextAttemptAt: snapshot.nextAttemptAt ? new Date(snapshot.nextAttemptAt.getTime()) : undefined,
    });
  }

  get id(): string {
    return this.state.id;
  }

  get providerId(): string {
    return this.state.providerId;
  }

  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }

  get idempotencyKey(): string | undefined {
    return this.state.idempotencyKey;
  }

  get payloadHash(): string | undefined {
    return this.state.payloadHash;
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get roundId(): string | undefined {
    return this.state.roundId;
  }

  get gameId(): string | undefined {
    return this.state.gameId;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId;
  }

  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }

  get pendingSince(): Date | undefined {
    return this.state.pendingSince ? new Date(this.state.pendingSince.getTime()) : undefined;
  }

  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt ? new Date(this.state.nextAttemptAt.getTime()) : undefined;
  }

  get pendingAttempts(): number {
    return this.state.pendingAttempts ?? 0;
  }

  get kind(): WagerTransactionKind {
    return this.state.kind;
  }

  get amount(): Money {
    return this.state.amount;
  }

  get money(): Money {
    return this.state.amount;
  }

  get status(): WagerTransactionStatus {
    return this.state.status;
  }

  get failureCode(): FailureCode | undefined {
    return this.state.failureCode;
  }

  get resultBalance(): Money | undefined {
    return this.state.resultBalance;
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt.getTime());
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt ? new Date(this.state.processedAt.getTime()) : undefined;
  }

  markProcessed(at: Date, resultBalance?: Money): void {
    this.assertMutable();
    assertValidDate(at);
    if (resultBalance && resultBalance.currency !== this.amount.currency) {
      throw new Error('result balance currency must match transaction currency');
    }
    this.state.status = 'PROCESSED';
    this.state.processedAt = new Date(at.getTime());
    this.state.resultBalance = resultBalance;
    this.clearPendingReference();
  }

  reject(code: FailureCode, resultBalance?: Money): void {
    this.assertMutable();
    if (resultBalance && resultBalance.currency !== this.amount.currency) {
      throw new Error('result balance currency must match transaction currency');
    }
    this.state.status = 'REJECTED';
    this.state.failureCode = code;
    this.state.resultBalance = resultBalance;
    this.clearPendingReference();
  }

  fail(code: FailureCode): void {
    this.assertMutable();
    this.state.status = 'FAILED';
    this.state.failureCode = code;
    this.clearPendingReference();
  }

  markPendingReference(pendingSince: Date, nextAttemptAt: Date): void {
    this.assertMutable();
    assertValidDate(pendingSince);
    assertValidDate(nextAttemptAt);
    if (nextAttemptAt.getTime() <= pendingSince.getTime()) {
      throw new Error('next reference attempt must be after pendingSince');
    }

    this.state.status = 'PENDING_REFERENCE';
    this.state.pendingSince = new Date(pendingSince.getTime());
    this.state.nextAttemptAt = new Date(nextAttemptAt.getTime());
    this.state.pendingAttempts = 0;
  }

  scheduleReferenceRetry(nextAttemptAt: Date): void {
    this.assertPendingReference();
    assertValidDate(nextAttemptAt);
    if (!this.state.pendingSince || nextAttemptAt.getTime() <= this.state.pendingSince.getTime()) {
      throw new Error('next reference attempt must be after pendingSince');
    }

    this.state.pendingAttempts = (this.state.pendingAttempts ?? 0) + 1;
    this.state.nextAttemptAt = new Date(nextAttemptAt.getTime());
  }

  expirePendingReference(): void {
    this.assertPendingReference();
    this.state.status = 'REJECTED';
    this.state.failureCode = 'REFERENCE_NOT_FOUND';
    this.clearPendingReference();
  }

  isTerminal(): boolean {
    return this.state.status === 'PROCESSED' || this.state.status === 'REJECTED' || this.state.status === 'FAILED';
  }

  affectsBalance(): boolean {
    return this.kind !== 'LOSS' && this.status !== 'REJECTED';
  }

  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }

  linkReference(transactionId: string): void {
    assertUuid(transactionId, 'reference transaction id');
    if (this.kind !== 'WIN' && !this.requiresReference()) {
      throw new Error('only reference-capable transactions can have a reference transaction');
    }
    if (this.referenceTransactionId && this.referenceTransactionId !== transactionId) {
      throw new Error('wager transaction reference cannot be changed');
    }
    this.state.referenceTransactionId = transactionId;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(referenceKind?: WagerTransactionKind): 'DEBIT' | 'CREDIT' | undefined {
    if (this.kind === 'BET') {
      return 'DEBIT';
    }
    if (this.kind === 'WIN' || this.kind === 'REFUND') {
      return 'CREDIT';
    }
    if (this.kind === 'ROLLBACK' && referenceKind) {
      if (referenceKind === 'BET') {
        return 'CREDIT';
      }
      if (referenceKind === 'WIN' || referenceKind === 'REFUND') {
        return 'DEBIT';
      }
    }
    return undefined;
  }

  private assertMutable(): void {
    if (this.isTerminal()) {
      throw new Error('terminal wager transaction cannot change state');
    }
  }

  private assertPendingReference(): void {
    if (this.state.status !== 'PENDING_REFERENCE') {
      throw new Error('wager transaction is not pending a reference');
    }
  }

  private clearPendingReference(): void {
    this.state.pendingSince = undefined;
    this.state.nextAttemptAt = undefined;
    this.state.pendingAttempts = 0;
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

function assertUuidV7(value: string, label: string): void {
  assertUuid(value, label);
  if (uuidVersion(value) !== 7) {
    throw new Error(`${label} must be UUIDv7`);
  }
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('transaction timestamp must be a valid date');
  }
}
