import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'ledger_journal_entries' })
@Unique({ properties: ['transactionId', 'effectType'] })
export class LedgerJournalEntryEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'transaction_id', columnType: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', fieldName: 'effect_type', columnType: 'varchar(20)' })
  effectType!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'string', fieldName: 'policy_version', columnType: 'varchar(64)' })
  policyVersion!: string;

  @Property({ type: 'Date', fieldName: 'occurred_at', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'uuid', fieldName: 'reversal_of_journal_entry_id', columnType: 'uuid', nullable: true })
  reversalOfJournalEntryId?: string;

  @Property({ type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
