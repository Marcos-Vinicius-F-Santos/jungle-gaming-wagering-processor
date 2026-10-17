import { Inject, Injectable } from '@nestjs/common';

import { Money } from '../../../shared/domain/money';
import {
  DOUBLE_ENTRY_LEDGER_REPOSITORY,
} from './ports/double-entry-ledger-repository.port';
import type { DoubleEntryLedgerRepository } from './ports/double-entry-ledger-repository.port';
import { LedgerAccount } from '../domain/ledger-account';
import {
  LedgerAccountPolicy,
  type LedgerEffectReference,
  type LedgerEffectType,
  type LedgerPostingInstruction,
} from '../domain/ledger-policy';
import { JournalEntry } from '../domain/journal-entry';
import { Posting } from '../domain/posting';
import { v7 as uuidv7 } from 'uuid';

export interface RecordLedgerEffectCommand {
  transactionId: string;
  effectType: LedgerEffectType;
  walletId: string;
  currency: string;
  amount: Money;
  occurredAt: Date;
  policyVersion?: string;
  reference?: LedgerEffectReference;
}

export interface RecordLedgerReversalCommand extends Omit<RecordLedgerEffectCommand, 'effectType' | 'reference'> {
  effectType: 'REFUND' | 'ROLLBACK';
  referenceTransactionId: string;
  referenceEffectType: Exclude<LedgerEffectType, 'LOSS' | 'REFUND' | 'ROLLBACK'>;
}

@Injectable()
export class LedgerEffectRecorder {
  constructor(
    @Inject(DOUBLE_ENTRY_LEDGER_REPOSITORY)
    private readonly repository: DoubleEntryLedgerRepository,
  ) {}

  async record(command: RecordLedgerEffectCommand): Promise<JournalEntry | undefined> {
    const plan = LedgerAccountPolicy.createPlan(command);
    if (!plan.patrimonial) return undefined;

    const accountIds = new Map<string, string>();
    for (const instruction of plan.postings) {
      if (accountIds.has(instruction.account.accountKey)) continue;
      const existing = await this.repository.findAccountByKey(instruction.account.accountKey);
      if (existing) {
        if (existing.currency !== instruction.account.currency || existing.accountType !== instruction.account.accountType) {
          throw new Error(`ledger account ${instruction.account.accountKey} does not match policy`);
        }
        accountIds.set(instruction.account.accountKey, existing.id);
        continue;
      }

      const account = LedgerAccount.create({
        id: uuidv7(),
        accountKey: instruction.account.accountKey,
        accountType: instruction.account.accountType,
        currency: instruction.account.currency,
        walletId: instruction.account.walletId,
        policyVersion: plan.policyVersion,
        createdAt: command.occurredAt,
      });
      await this.repository.saveAccount(account);
      accountIds.set(instruction.account.accountKey, account.id);
    }

    const journalId = uuidv7();
    const journal = JournalEntry.create({
      id: journalId,
      transactionId: command.transactionId,
      effectType: command.effectType,
      currency: command.currency.toUpperCase(),
      policyVersion: plan.policyVersion,
      occurredAt: command.occurredAt,
      reversalOfJournalEntryId: plan.reversalOfJournalEntryId,
      postings: plan.postings.map((instruction) => Posting.create({
        id: uuidv7(),
        journalEntryId: journalId,
        accountId: accountIds.get(instruction.account.accountKey)!,
        walletId: instruction.account.walletId,
        direction: instruction.direction,
        money: instruction.money,
        createdAt: command.occurredAt,
      })),
    });
    await this.repository.saveJournal(journal);
    return journal;
  }

  async recordReversal(command: RecordLedgerReversalCommand): Promise<JournalEntry> {
    const original = await this.repository.findJournalByTransactionEffect(
      command.referenceTransactionId,
      command.referenceEffectType,
    );
    if (!original) {
      throw new Error(`ledger journal for referenced transaction ${command.referenceTransactionId} was not found`);
    }

    const references: LedgerPostingInstruction[] = [];
    for (const posting of original.postings) {
      const account = await this.repository.findAccountById(posting.accountId);
      if (!account) throw new Error(`ledger account ${posting.accountId} was not found`);
      references.push({
        account: {
          accountType: account.accountType,
          accountKey: account.accountKey,
          currency: account.currency,
          walletId: account.walletId,
        },
        direction: posting.direction,
        money: posting.money,
      });
    }

    const journal = await this.record({
      transactionId: command.transactionId,
      effectType: command.effectType,
      walletId: command.walletId,
      currency: command.currency,
      amount: command.amount,
      occurredAt: command.occurredAt,
      policyVersion: command.policyVersion,
      reference: {
        effectType: command.referenceEffectType,
        journalEntryId: original.id,
        postings: references,
      },
    });
    if (!journal) throw new Error('patrimonial reversal did not produce a journal');
    return journal;
  }
}
