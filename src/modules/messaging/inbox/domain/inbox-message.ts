export type InboxMessageStatus =
  | 'PROCESSING'
  | 'PROCESSED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT';

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  status: InboxMessageStatus;
  attempts: number;
  processedAt?: Date;
  lastErrorCode?: string;
  lastErrorAt?: Date;
  processingStartedAt?: Date;
  claimedBy?: string;
  leaseUntil?: Date;
}

export interface ReceiveInboxMessageProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  static receive(props: ReceiveInboxMessageProps): InboxMessage {
    assertText(props.consumerName, 'consumerName');
    assertText(props.messageId, 'messageId');
    assertText(props.payloadHash, 'payloadHash');

    return new InboxMessage({
      consumerName: props.consumerName,
      messageId: props.messageId,
      payloadHash: props.payloadHash,
      receivedAt: props.receivedAt,
      status: 'PROCESSING',
      attempts: 1,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    assertText(state.consumerName, 'consumerName');
    assertText(state.messageId, 'messageId');
    assertText(state.payloadHash, 'payloadHash');
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new Error('Inbox attempts must be a non-negative integer');
    }
    return new InboxMessage({ ...state });
  }

  get consumerName(): string { return this.state.consumerName; }
  get messageId(): string { return this.state.messageId; }
  get payloadHash(): string { return this.state.payloadHash; }
  get receivedAt(): Date { return this.state.receivedAt; }
  get status(): InboxMessageStatus { return this.state.status; }
  get attempts(): number { return this.state.attempts; }
  get processedAt(): Date | undefined { return this.state.processedAt; }
  get lastErrorCode(): string | undefined { return this.state.lastErrorCode; }
  get lastErrorAt(): Date | undefined { return this.state.lastErrorAt; }
  get processingStartedAt(): Date | undefined { return this.state.processingStartedAt; }
  get claimedBy(): string | undefined { return this.state.claimedBy; }
  get leaseUntil(): Date | undefined { return this.state.leaseUntil; }

  hasPayloadHash(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  startProcessing(at: Date): void {
    if (this.status === 'PROCESSED') {
      return;
    }
    if (this.status === 'FAILED_PERMANENT') {
      throw new Error(`Inbox message ${this.messageId} is permanently failed`);
    }
    this.state.status = 'PROCESSING';
    this.state.attempts += 1;
    this.state.lastErrorCode = undefined;
    this.state.lastErrorAt = undefined;
    this.state.processedAt = undefined;
    this.state.receivedAt = this.state.receivedAt ?? at;
  }

  claim(claimedBy: string, now: Date, leaseDurationMs: number): void {
    assertText(claimedBy, 'claimedBy');
    assertLeaseDuration(leaseDurationMs);
    if (this.status === 'PROCESSED') {
      throw new Error(`Inbox message ${this.messageId} is already processed`);
    }
    if (this.status === 'FAILED_PERMANENT') {
      throw new Error(`Inbox message ${this.messageId} is permanently failed`);
    }
    if (this.leaseUntil && this.leaseUntil.getTime() > now.getTime() && this.claimedBy !== claimedBy) {
      throw new Error(`Inbox message ${this.messageId} has an active lease`);
    }

    this.state.status = 'PROCESSING';
    this.state.attempts = Math.max(this.state.attempts, 0) + 1;
    this.state.processingStartedAt = now;
    this.state.claimedBy = claimedBy;
    this.state.leaseUntil = new Date(now.getTime() + leaseDurationMs);
    this.state.lastErrorCode = undefined;
    this.state.lastErrorAt = undefined;
    this.state.processedAt = undefined;
  }

  renewLease(claimedBy: string, now: Date, leaseDurationMs: number): void {
    assertText(claimedBy, 'claimedBy');
    assertLeaseDuration(leaseDurationMs);
    if (this.status !== 'PROCESSING' || this.claimedBy !== claimedBy) {
      throw new Error(`Inbox message ${this.messageId} cannot renew this lease`);
    }
    if (!this.leaseUntil || this.leaseUntil.getTime() <= now.getTime()) {
      throw new Error(`Inbox message ${this.messageId} lease has expired`);
    }
    this.state.leaseUntil = new Date(now.getTime() + leaseDurationMs);
  }

  releaseLease(claimedBy: string): void {
    assertText(claimedBy, 'claimedBy');
    if (this.status !== 'PROCESSING' || this.claimedBy !== claimedBy) {
      throw new Error(`Inbox message ${this.messageId} cannot release this lease`);
    }
    this.state.claimedBy = undefined;
    this.state.leaseUntil = undefined;
  }

  markProcessed(at: Date): void {
    this.state.status = 'PROCESSED';
    this.state.processedAt = at;
    this.state.lastErrorCode = undefined;
    this.state.lastErrorAt = undefined;
    this.state.claimedBy = undefined;
    this.state.leaseUntil = undefined;
  }

  markRetryable(errorCode: string, at: Date): void {
    assertText(errorCode, 'errorCode');
    this.state.status = 'FAILED_RETRYABLE';
    this.state.lastErrorCode = errorCode;
    this.state.lastErrorAt = at;
    this.state.processedAt = undefined;
    this.state.claimedBy = undefined;
    this.state.leaseUntil = undefined;
  }

  markPermanent(errorCode: string, at: Date): void {
    assertText(errorCode, 'errorCode');
    this.state.status = 'FAILED_PERMANENT';
    this.state.lastErrorCode = errorCode;
    this.state.lastErrorAt = at;
    this.state.processedAt = undefined;
    this.state.claimedBy = undefined;
    this.state.leaseUntil = undefined;
  }

  toState(): InboxMessageState {
    return { ...this.state };
  }
}

function assertText(value: string, name: string): void {
  if (!value || !value.trim()) {
    throw new Error(`Inbox ${name} must not be empty`);
  }
}

function assertLeaseDuration(value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Inbox lease duration must be a positive integer');
  }
}
