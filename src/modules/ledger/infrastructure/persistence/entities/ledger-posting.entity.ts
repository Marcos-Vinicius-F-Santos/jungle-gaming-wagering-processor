import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'ledger_postings' })
export class LedgerPostingEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'journal_entry_id', columnType: 'uuid' })
  journalEntryId!: string;

  @Property({ type: 'uuid', fieldName: 'account_id', columnType: 'uuid' })
  accountId!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id', columnType: 'uuid', nullable: true })
  walletId?: string;

  @Property({ type: 'string', columnType: 'varchar(6)' })
  direction!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
