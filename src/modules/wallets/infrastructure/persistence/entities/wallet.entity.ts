import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'player_id', columnType: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'string', fieldName: 'balance_amount', columnType: 'numeric(19,2)' })
  balanceAmount!: string;

  @Property({ type: 'number', columnType: 'integer' })
  version!: number;

  @Property({ type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'Date', fieldName: 'updated_at', columnType: 'timestamptz' })
  updatedAt!: Date;
}
