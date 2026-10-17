import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid', columnType: 'uuid' })
  id!: string;

  @Property({ type: 'string', fieldName: 'provider_id', columnType: 'varchar(100)' })
  providerId!: string;

  @Property({ type: 'string', fieldName: 'external_transaction_id', columnType: 'varchar(255)' })
  externalTransactionId!: string;

  @Property({ type: 'string', fieldName: 'idempotency_key', columnType: 'varchar(255)', nullable: true })
  idempotencyKey?: string;

  @Property({ type: 'string', fieldName: 'payload_hash', columnType: 'varchar(64)', nullable: true })
  payloadHash?: string;

  @Property({ type: 'uuid', fieldName: 'wallet_id', columnType: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid', fieldName: 'player_id', columnType: 'uuid' })
  playerId!: string;

  @Property({ type: 'string', fieldName: 'round_id', columnType: 'varchar(255)', nullable: true })
  roundId?: string;

  @Property({ type: 'string', fieldName: 'game_id', columnType: 'varchar(255)', nullable: true })
  gameId?: string;

  @Property({ type: 'string', fieldName: 'reference_external_transaction_id', columnType: 'varchar(255)', nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'uuid', fieldName: 'reference_transaction_id', columnType: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ type: 'Date', fieldName: 'pending_since', columnType: 'timestamptz', nullable: true })
  pendingSince?: Date;

  @Property({ type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'number', fieldName: 'pending_attempts', columnType: 'integer', default: 0 })
  pendingAttempts = 0;

  @Property({ type: 'string', fieldName: 'result_balance_amount', columnType: 'numeric(19,2)', nullable: true })
  resultBalanceAmount?: string;

  @Property({ type: 'string', fieldName: 'result_balance_currency', columnType: 'varchar(3)', nullable: true })
  resultBalanceCurrency?: string;

  @Property({ type: 'string', columnType: 'varchar(20)' })
  kind!: string;

  @Property({ type: 'string', columnType: 'numeric(19,2)' })
  amount!: string;

  @Property({ type: 'string', columnType: 'varchar(3)' })
  currency!: string;

  @Property({ type: 'string', columnType: 'varchar(24)' })
  status!: string;

  @Property({ type: 'string', fieldName: 'failure_code', columnType: 'varchar(100)', nullable: true })
  failureCode?: string;

  @Property({ type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt?: Date;
}
