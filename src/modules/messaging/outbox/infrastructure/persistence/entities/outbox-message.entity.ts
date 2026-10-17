import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid', fieldName: 'event_id', columnType: 'uuid' })
  eventId!: string;

  @Property({ type: 'uuid', fieldName: 'aggregate_id', columnType: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'string', fieldName: 'event_type', columnType: 'varchar(80)' })
  eventType!: string;

  @Property({ type: 'number', columnType: 'integer' })
  version!: number;

  @Property({ type: 'json', columnType: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'number', columnType: 'integer', default: 0 })
  attempts = 0;

  @Property({ type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz' })
  nextAttemptAt!: Date;

  @Property({ type: 'Date', fieldName: 'occurred_at', columnType: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'Date', fieldName: 'published_at', columnType: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Property({ type: 'string', fieldName: 'claimed_by', columnType: 'varchar(100)', nullable: true })
  claimedBy?: string;

  @Property({ type: 'Date', fieldName: 'claimed_until', columnType: 'timestamptz', nullable: true })
  claimedUntil?: Date;

  @Property({ type: 'string', fieldName: 'last_error_code', columnType: 'varchar(100)', nullable: true })
  lastErrorCode?: string;

  @Property({ type: 'Date', fieldName: 'last_error_at', columnType: 'timestamptz', nullable: true })
  lastErrorAt?: Date;

  @Property({ type: 'boolean', fieldName: 'intervention_required', columnType: 'boolean', default: false })
  interventionRequired = false;

  @Property({ type: 'Date', fieldName: 'dead_lettered_at', columnType: 'timestamptz', nullable: true })
  deadLetteredAt?: Date;

  @Property({ type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' })
  createdAt!: Date;
}
