import { Migration } from '@mikro-orm/migrations';

export class Migration20261016010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(100) not null,
        "message_id" varchar(255) not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null default now(),
        "status" varchar(24) not null,
        "attempts" integer not null default 0,
        "processed_at" timestamptz,
        "last_error_code" varchar(100),
        "last_error_at" timestamptz,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id"),
        constraint "inbox_messages_status_check" check ("status" in ('PROCESSING', 'PROCESSED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')),
        constraint "inbox_messages_attempts_non_negative" check ("attempts" >= 0)
      );
    `);

    this.addSql(`
      create index "inbox_messages_status_received_idx"
      on "inbox_messages" ("status", "received_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "inbox_messages_status_received_idx";');
    this.addSql('drop table if exists "inbox_messages";');
  }
}
