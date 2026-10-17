import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['walletId', 'transactionId'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id', columnType: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'transaction_id', columnType: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', columnType: 'varchar(6)' })
  direction!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'string', fieldName: 'balance_before', columnType: 'numeric(19,2)' })
  balanceBefore!: string;

  @Property({ type: 'string', fieldName: 'balance_after', columnType: 'numeric(19,2)' })
  balanceAfter!: string;

  @Property({ type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
