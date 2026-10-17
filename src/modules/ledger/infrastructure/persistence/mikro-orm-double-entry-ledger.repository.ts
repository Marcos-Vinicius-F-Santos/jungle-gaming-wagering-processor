import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { Money } from '../../../../shared/domain/money';
import { LedgerAccount } from '../../domain/ledger-account';
import { JournalEntry } from '../../domain/journal-entry';
import { LedgerAccountEntity } from './entities/ledger-account.entity';
import { LedgerJournalEntryEntity } from './entities/ledger-journal-entry.entity';
import { LedgerPostingEntity } from './entities/ledger-posting.entity';
import type { DoubleEntryLedgerRepository } from '../../application/ports/double-entry-ledger-repository.port';

@Injectable()
export class MikroOrmDoubleEntryLedgerRepository implements DoubleEntryLedgerRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async saveAccount(account: LedgerAccount): Promise<void> {
    const snapshot = account.toSnapshot();
    const manager = this.writeManager();
    const entity = manager.create(LedgerAccountEntity, {
      id: snapshot.id,
      accountKey: snapshot.accountKey,
      accountType: snapshot.accountType,
      currency: snapshot.currency,
      walletId: snapshot.walletId,
      policyVersion: snapshot.policyVersion,
      active: snapshot.active,
      createdAt: snapshot.createdAt,
    });
    manager.persist(entity);
    await manager.flush();
  }

  async saveJournal(journal: JournalEntry): Promise<void> {
    const snapshot = journal.toSnapshot();
    const manager = this.writeManager();
    await manager.transactional(async (transactionManager) => {
      const journalEntity = transactionManager.create(LedgerJournalEntryEntity, {
        id: snapshot.id,
        transactionId: snapshot.transactionId,
        effectType: snapshot.effectType,
        currency: snapshot.currency,
        policyVersion: snapshot.policyVersion,
        occurredAt: snapshot.occurredAt,
        reversalOfJournalEntryId: snapshot.reversalOfJournalEntryId,
        createdAt: snapshot.occurredAt,
      });
      transactionManager.persist(journalEntity);
      await transactionManager.flush();

      const postingEntities = snapshot.postings.map((posting) => transactionManager.create(LedgerPostingEntity, {
        id: posting.id,
        journalEntryId: posting.journalEntryId,
        accountId: posting.accountId,
        walletId: posting.walletId,
        direction: posting.direction,
        amount: posting.money.amount,
        currency: posting.money.currency,
        createdAt: posting.createdAt,
      }));
      transactionManager.persist(postingEntities);
      await transactionManager.flush();
    });
  }

  async findAccountByKey(accountKey: string): Promise<LedgerAccount | undefined> {
    const entity = await this.readManager().findOne(LedgerAccountEntity, { accountKey });
    return entity ? this.toDomainAccount(entity) : undefined;
  }

  async findAccountById(accountId: string): Promise<LedgerAccount | undefined> {
    const entity = await this.readManager().findOne(LedgerAccountEntity, { id: accountId });
    return entity ? this.toDomainAccount(entity) : undefined;
  }

  private toDomainAccount(entity: LedgerAccountEntity): LedgerAccount {
    return LedgerAccount.rehydrate({
      id: entity.id,
      accountKey: entity.accountKey,
      accountType: entity.accountType as LedgerAccount['accountType'],
      currency: entity.currency,
      walletId: entity.walletId,
      policyVersion: entity.policyVersion,
      active: entity.active,
      createdAt: entity.createdAt,
    });
  }

  async findJournalById(journalId: string): Promise<JournalEntry | undefined> {
    return this.loadJournal(this.readManager().findOne(LedgerJournalEntryEntity, { id: journalId }));
  }

  async findJournalByTransactionEffect(transactionId: string, effectType: string): Promise<JournalEntry | undefined> {
    return this.loadJournal(this.readManager().findOne(LedgerJournalEntryEntity, { transactionId, effectType }));
  }

  private async loadJournal(entityPromise: Promise<LedgerJournalEntryEntity | null>): Promise<JournalEntry | undefined> {
    const entity = await entityPromise;
    if (!entity) return undefined;
    const postingEntities = await this.readManager().find(LedgerPostingEntity, { journalEntryId: entity.id }, { orderBy: { id: 'asc' } });
    return JournalEntry.rehydrate({
      id: entity.id,
      transactionId: entity.transactionId,
      effectType: entity.effectType,
      currency: entity.currency,
      policyVersion: entity.policyVersion,
      occurredAt: entity.occurredAt,
      reversalOfJournalEntryId: entity.reversalOfJournalEntryId,
      postings: postingEntities.map((posting) => ({
        id: posting.id,
        journalEntryId: posting.journalEntryId,
        accountId: posting.accountId,
        walletId: posting.walletId,
        direction: posting.direction as 'DEBIT' | 'CREDIT',
        money: Money.of(posting.amount, posting.currency),
        createdAt: posting.createdAt,
      })),
    });
  }

  private readManager(): EntityManager {
    const context = this.entityManager.getContext(false);
    return context.global ? context.fork() : context;
  }

  private writeManager(): EntityManager {
    const context = this.entityManager.getContext(false);
    return context.global ? this.entityManager.fork() : context;
  }
}
