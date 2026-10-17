import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'ledger_accounts' })
@Unique({ properties: ['accountKey'] })
export class LedgerAccountEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'string', fieldName: 'account_key', columnType: 'varchar(160)' })
  accountKey!: string;

  @Property({ type: 'string', fieldName: 'account_type', columnType: 'varchar(32)' })
  accountType!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id', columnType: 'uuid', nullable: true })
  walletId?: string;

  @Property({ type: 'string', fieldName: 'policy_version', columnType: 'varchar(64)' })
  policyVersion!: string;

  @Property({ type: 'boolean', columnType: 'boolean' })
  active = true;

  @Property({ type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
