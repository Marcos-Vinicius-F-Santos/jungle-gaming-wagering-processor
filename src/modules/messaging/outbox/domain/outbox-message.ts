import { validate as isUuid, version as uuidVersion } from 'uuid';

export type IntegrationEventType =
  | 'WagerTransactionProcessed'
  | 'WagerTransactionRejected'
  | 'WagerTransactionPendingReference'
  | 'WalletBalanceChanged';

export interface OutboxEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  eventType: IntegrationEventType;
  version: number;
  data: TPayload;
  occurredAt: Date;
}

export interface OutboxMessageState<TPayload = Record<string, unknown>> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  eventType: IntegrationEventType;
  version: number;
  data: TPayload;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
  claimedBy?: string;
  claimedUntil?: Date;
  lastErrorCode?: string;
  lastErrorAt?: Date;
  interventionRequired?: boolean;
  deadLetteredAt?: Date;
}

export class OutboxMessage<TPayload = Record<string, unknown>> {
  private constructor(
    public readonly eventId: string,
    public readonly aggregateId: string,
    public readonly correlationId: string,
    public readonly causationId: string | undefined,
    public readonly eventType: IntegrationEventType,
    public readonly version: number,
    public readonly data: TPayload,
    public readonly occurredAt: Date,
    private attemptsValue: number,
    private nextAttemptAtValue: Date,
    private publishedAtValue?: Date,
    private claimedByValue?: string,
    private claimedUntilValue?: Date,
    private lastErrorCodeValue?: string,
    private lastErrorAtValue?: Date,
    private interventionRequiredValue = false,
    private deadLetteredAtValue?: Date,
  ) {}

  static enqueue<TPayload>(event: OutboxEvent<TPayload>): OutboxMessage<TPayload> {
    assertUuidV7(event.eventId, 'outbox event id');
    assertUuid(event.aggregateId, 'outbox aggregate id');
    if (event.correlationId.trim().length === 0) {
      throw new Error('outbox correlation id must not be empty');
    }
    if (!Number.isSafeInteger(event.version) || event.version < 1) {
      throw new Error('outbox event version must be a positive integer');
    }
    if (event.data === null || typeof event.data !== 'object') {
      throw new Error('outbox event data must be an object');
    }
    assertValidDate(event.occurredAt);

    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.correlationId,
      event.causationId,
      event.eventType,
      event.version,
      event.data,
      new Date(event.occurredAt.getTime()),
      0,
      new Date(event.occurredAt.getTime()),
    );
  }

  static rehydrate<TPayload>(state: OutboxMessageState<TPayload>): OutboxMessage<TPayload> {
    const message = OutboxMessage.enqueue({
      eventId: state.eventId,
      aggregateId: state.aggregateId,
      correlationId: state.correlationId,
      causationId: state.causationId,
      eventType: state.eventType,
      version: state.version,
      data: state.data,
      occurredAt: state.occurredAt,
    });
    if (!Number.isSafeInteger(state.attempts) || state.attempts < 0) {
      throw new Error('outbox attempts must be a non-negative integer');
    }
    assertValidDate(state.nextAttemptAt);
    if (state.publishedAt) assertValidDate(state.publishedAt);
    if (state.claimedUntil) assertValidDate(state.claimedUntil);
    if (state.lastErrorAt) assertValidDate(state.lastErrorAt);
    if (state.deadLetteredAt) assertValidDate(state.deadLetteredAt);

    message.attemptsValue = state.attempts;
    message.nextAttemptAtValue = new Date(state.nextAttemptAt.getTime());
    message.publishedAtValue = state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined;
    message.claimedByValue = state.claimedBy;
    message.claimedUntilValue = state.claimedUntil ? new Date(state.claimedUntil.getTime()) : undefined;
    message.lastErrorCodeValue = state.lastErrorCode;
    message.lastErrorAtValue = state.lastErrorAt ? new Date(state.lastErrorAt.getTime()) : undefined;
    message.interventionRequiredValue = state.interventionRequired ?? false;
    message.deadLetteredAtValue = state.deadLetteredAt ? new Date(state.deadLetteredAt.getTime()) : undefined;
    return message;
  }

  get attempts(): number {
    return this.attemptsValue;
  }

  get nextAttemptAt(): Date {
    return new Date(this.nextAttemptAtValue.getTime());
  }

  get publishedAt(): Date | undefined {
    return this.publishedAtValue ? new Date(this.publishedAtValue.getTime()) : undefined;
  }

  get claimedBy(): string | undefined {
    return this.claimedByValue;
  }

  get claimedUntil(): Date | undefined {
    return this.claimedUntilValue ? new Date(this.claimedUntilValue.getTime()) : undefined;
  }

  get lastErrorCode(): string | undefined {
    return this.lastErrorCodeValue;
  }

  get lastErrorAt(): Date | undefined {
    return this.lastErrorAtValue ? new Date(this.lastErrorAtValue.getTime()) : undefined;
  }

  get interventionRequired(): boolean {
    return this.interventionRequiredValue;
  }

  get deadLetteredAt(): Date | undefined {
    return this.deadLetteredAtValue ? new Date(this.deadLetteredAtValue.getTime()) : undefined;
  }

  isDue(now: Date): boolean {
    assertValidDate(now);
    return !this.publishedAtValue
      && !this.interventionRequiredValue
      && this.nextAttemptAtValue.getTime() <= now.getTime()
      && (!this.claimedUntilValue || this.claimedUntilValue.getTime() <= now.getTime());
  }

  claim(publisherName: string, claimedUntil: Date): void {
    if (!publisherName.trim()) throw new Error('outbox publisher name must not be empty');
    assertValidDate(claimedUntil);
    if (this.publishedAtValue || this.interventionRequiredValue) {
      throw new Error('published or intervention-required outbox message cannot be claimed');
    }
    this.claimedByValue = publisherName;
    this.claimedUntilValue = new Date(claimedUntil.getTime());
  }

  markPublished(publishedAt: Date): void {
    assertValidDate(publishedAt);
    if (this.interventionRequiredValue) throw new Error('intervention-required outbox message cannot be published');
    this.publishedAtValue = new Date(publishedAt.getTime());
    this.claimedByValue = undefined;
    this.claimedUntilValue = undefined;
  }

  scheduleRetry(now: Date, backoffSeconds: readonly number[], errorCode: string): void {
    assertValidDate(now);
    if (this.publishedAtValue || this.interventionRequiredValue) return;
    const delay = backoffSeconds[Math.min(this.attemptsValue, backoffSeconds.length - 1)] ?? 300;
    this.attemptsValue += 1;
    this.nextAttemptAtValue = new Date(now.getTime() + delay * 1000);
    this.lastErrorCodeValue = errorCode.slice(0, 100);
    this.lastErrorAtValue = new Date(now.getTime());
    this.claimedByValue = undefined;
    this.claimedUntilValue = undefined;
  }

  markIntervention(deadLetteredAt: Date, errorCode: string): void {
    assertValidDate(deadLetteredAt);
    if (this.publishedAtValue) throw new Error('published outbox message cannot require intervention');
    this.interventionRequiredValue = true;
    this.deadLetteredAtValue = new Date(deadLetteredAt.getTime());
    this.lastErrorCodeValue = errorCode.slice(0, 100);
    this.lastErrorAtValue = new Date(deadLetteredAt.getTime());
    this.claimedByValue = undefined;
    this.claimedUntilValue = undefined;
  }

  toJSON(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
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
    throw new Error('outbox event timestamp must be a valid date');
  }
}
