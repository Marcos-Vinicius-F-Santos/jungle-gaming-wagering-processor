export interface ClaimInboxMessageInput {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  claimedBy: string;
  now: Date;
  leaseDurationMs: number;
}

export interface InboxClaimedSnapshot {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  status: 'PROCESSING';
  attempts: number;
  receivedAt: Date;
  processingStartedAt: Date;
  claimedBy: string;
  leaseUntil: Date;
}

export type InboxClaimDecision =
  | { kind: 'CLAIMED'; inbox: InboxClaimedSnapshot }
  | { kind: 'PROCESSED'; processedAt: Date }
  | { kind: 'IN_FLIGHT'; leaseUntil: Date; claimedBy?: string }
  | { kind: 'PAYLOAD_CONFLICT' }
  | { kind: 'FAILED_PERMANENT'; errorCode: string };

import type { InboxRepository } from './inbox-repository.port';

export interface InboxClaimRepository extends InboxRepository {
  claim(input: ClaimInboxMessageInput): Promise<InboxClaimDecision>;
  renewLease(input: {
    consumerName: string;
    messageId: string;
    claimedBy: string;
    now: Date;
    leaseDurationMs: number;
  }): Promise<boolean>;
  releaseLease(input: {
    consumerName: string;
    messageId: string;
    claimedBy: string;
    now: Date;
  }): Promise<boolean>;
}

export const INBOX_CLAIM_REPOSITORY = Symbol('INBOX_CLAIM_REPOSITORY');
