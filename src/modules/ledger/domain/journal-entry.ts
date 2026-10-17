import { validate as isUuid, version as uuidVersion, v7 as uuidv7 } from 'uuid';

import { Money } from '../../../shared/domain/money';
import { Posting, type CreatePostingProps, type PostingDirection, type PostingSnapshot } from './posting';

export interface CreateJournalEntryProps {
  id?: string;
  transactionId: string;
  effectType: string;
  currency: string;
  policyVersion: string;
  occurredAt: Date;
  postings: readonly (CreatePostingProps | Posting)[];
  reversalOfJournalEntryId?: string;
}

export interface JournalEntrySnapshot {
  id: string;
  transactionId: string;
  effectType: string;
  currency: string;
  policyVersion: string;
  occurredAt: Date;
  postings: readonly PostingSnapshot[];
  reversalOfJournalEntryId?: string;
}

export class JournalEntry {
  private constructor(private readonly state: JournalEntrySnapshot) {}

  static create(props: CreateJournalEntryProps): JournalEntry {
    const id = props.id ?? uuidv7();
    assertUuidV7(id, 'journal entry id');
    assertUuid(props.transactionId, 'journal transaction id');
    assertNonEmpty(props.effectType, 'journal effect type');
    assertCurrency(props.currency);
    assertPolicyVersion(props.policyVersion);
    assertValidDate(props.occurredAt);
    if (props.reversalOfJournalEntryId) assertUuid(props.reversalOfJournalEntryId, 'reversal journal entry id');

    const postings = props.postings.map((posting) => posting instanceof Posting ? posting : Posting.create(posting));
    if (postings.length < 2) throw new Error('journal entry requires at least two postings');

    for (const posting of postings) {
      if (posting.journalEntryId !== id) throw new Error('posting journal entry id must match journal id');
      if (posting.money.currency !== props.currency.toUpperCase()) throw new Error('journal postings must use one currency');
    }
    if (!postings.some((posting) => posting.direction === 'DEBIT')) throw new Error('journal entry requires a debit');
    if (!postings.some((posting) => posting.direction === 'CREDIT')) throw new Error('journal entry requires a credit');

    const snapshot: JournalEntrySnapshot = {
      id,
      transactionId: props.transactionId,
      effectType: props.effectType,
      currency: props.currency.toUpperCase(),
      policyVersion: props.policyVersion,
      occurredAt: new Date(props.occurredAt.getTime()),
      postings: postings.map((posting) => posting.toSnapshot()),
      reversalOfJournalEntryId: props.reversalOfJournalEntryId,
    };
    const journal = new JournalEntry(snapshot);
    if (!journal.isBalanced()) throw new Error('journal entry debits and credits must balance');
    return journal;
  }

  static rehydrate(snapshot: JournalEntrySnapshot): JournalEntry {
    return JournalEntry.create(snapshot);
  }

  get id(): string { return this.state.id; }
  get transactionId(): string { return this.state.transactionId; }
  get effectType(): string { return this.state.effectType; }
  get currency(): string { return this.state.currency; }
  get policyVersion(): string { return this.state.policyVersion; }
  get occurredAt(): Date { return new Date(this.state.occurredAt.getTime()); }
  get reversalOfJournalEntryId(): string | undefined { return this.state.reversalOfJournalEntryId; }
  get postings(): readonly Posting[] { return this.state.postings.map((posting) => Posting.rehydrate(posting)); }

  isBalanced(): boolean {
    const zero = Money.of('0.00', this.currency);
    const debit = this.state.postings
      .filter((posting) => posting.direction === 'DEBIT')
      .reduce((total, posting) => total.add(posting.money), zero);
    const credit = this.state.postings
      .filter((posting) => posting.direction === 'CREDIT')
      .reduce((total, posting) => total.add(posting.money), zero);
    return debit.equals(credit);
  }

  toSnapshot(): JournalEntrySnapshot {
    return {
      ...this.state,
      occurredAt: new Date(this.state.occurredAt.getTime()),
      postings: this.state.postings.map((posting) => ({ ...posting, createdAt: new Date(posting.createdAt.getTime()) })),
    };
  }
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
}

function assertUuidV7(value: string, label: string): void {
  assertUuid(value, label);
  if (uuidVersion(value) !== 7) throw new Error(`${label} must be UUIDv7`);
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 80) throw new Error(`${label} must be non-empty and bounded`);
}

function assertCurrency(value: string): void {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new Error('journal currency must be an ISO-4217 code');
}

function assertPolicyVersion(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('journal policy version must be safe');
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('journal timestamp must be valid');
}
