import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', fieldName: 'consumer_name', columnType: 'varchar(100)' })
  consumerName!: string;

  @PrimaryKey({ type: 'string', fieldName: 'message_id', columnType: 'varchar(255)' })
  messageId!: string;

  @Property({ type: 'string', fieldName: 'payload_hash', columnType: 'varchar(64)' })
  payloadHash!: string;

  @Property({ type: 'Date', fieldName: 'received_at', columnType: 'timestamptz' })
  receivedAt!: Date;

  @Property({ type: 'string', columnType: 'varchar(24)' })
  status!: 'PROCESSING' | 'PROCESSED' | 'FAILED_RETRYABLE' | 'FAILED_PERMANENT';

  @Property({ type: 'number', columnType: 'integer', default: 0 })
  attempts = 0;

  @Property({ type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true })
  processedAt?: Date;

  @Property({ type: 'string', fieldName: 'last_error_code', columnType: 'varchar(100)', nullable: true })
  lastErrorCode?: string;

  @Property({ type: 'Date', fieldName: 'last_error_at', columnType: 'timestamptz', nullable: true })
  lastErrorAt?: Date;

  @Property({ type: 'string', fieldName: 'claimed_by', columnType: 'varchar(100)', nullable: true })
  claimedBy?: string;

  @Property({ type: 'Date', fieldName: 'lease_until', columnType: 'timestamptz', nullable: true })
  leaseUntil?: Date;

  @Property({ type: 'Date', fieldName: 'processing_started_at', columnType: 'timestamptz', nullable: true })
  processingStartedAt?: Date;
}
