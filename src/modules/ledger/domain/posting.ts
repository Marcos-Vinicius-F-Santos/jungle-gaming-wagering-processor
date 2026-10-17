import { validate as isUuid, version as uuidVersion } from 'uuid';

import { Money } from '../../../shared/domain/money';

export const POSTING_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type PostingDirection = (typeof POSTING_DIRECTIONS)[number];

export interface CreatePostingProps {
  id: string;
  journalEntryId: string;
  accountId: string;
  walletId?: string;
  direction: PostingDirection;
  money: Money;
  createdAt: Date;
}

export interface PostingSnapshot {
  id: string;
  journalEntryId: string;
  accountId: string;
  walletId?: string;
  direction: PostingDirection;
  money: Money;
  createdAt: Date;
}

export class Posting {
  private constructor(private readonly state: PostingSnapshot) {}

  static create(props: CreatePostingProps): Posting {
    assertUuidV7(props.id, 'posting id');
    assertUuidV7(props.journalEntryId, 'posting journal entry id');
    assertUuid(props.accountId, 'posting account id');
    if (!POSTING_DIRECTIONS.includes(props.direction)) throw new Error('unsupported posting direction');
    if (!props.money.isPositive()) throw new Error('posting amount must be positive');
    assertValidDate(props.createdAt);
    if (props.walletId) assertUuid(props.walletId, 'posting wallet id');

    return new Posting({
      id: props.id,
      journalEntryId: props.journalEntryId,
      accountId: props.accountId,
      walletId: props.walletId,
      direction: props.direction,
      money: props.money,
      createdAt: new Date(props.createdAt.getTime()),
    });
  }

  static rehydrate(snapshot: PostingSnapshot): Posting {
    return Posting.create(snapshot);
  }

  get id(): string { return this.state.id; }
  get journalEntryId(): string { return this.state.journalEntryId; }
  get accountId(): string { return this.state.accountId; }
  get walletId(): string | undefined { return this.state.walletId; }
  get direction(): PostingDirection { return this.state.direction; }
  get money(): Money { return this.state.money; }
  get createdAt(): Date { return new Date(this.state.createdAt.getTime()); }

  toSnapshot(): PostingSnapshot {
    return { ...this.state, createdAt: new Date(this.state.createdAt.getTime()) };
  }
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
}

function assertUuidV7(value: string, label: string): void {
  assertUuid(value, label);
  if (uuidVersion(value) !== 7) throw new Error(`${label} must be UUIDv7`);
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('posting timestamp must be valid');
}
