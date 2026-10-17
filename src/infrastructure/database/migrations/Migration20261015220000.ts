import { Migration } from '@mikro-orm/migrations';

export class Migration20261015220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "outbox_messages" (
        "event_id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(80) not null,
        "version" integer not null,
        "payload" jsonb not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null,
        "occurred_at" timestamptz not null,
        "published_at" timestamptz,
        "created_at" timestamptz not null default now(),
        constraint "outbox_messages_pkey" primary key ("event_id"),
        constraint "outbox_messages_version_positive" check ("version" >= 1),
        constraint "outbox_messages_attempts_non_negative" check ("attempts" >= 0)
      );
    `);

    this.addSql(`
      create index "outbox_messages_pending_due_idx"
      on "outbox_messages" ("next_attempt_at", "event_id")
      where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "outbox_messages_pending_due_idx";');
    this.addSql('drop table if exists "outbox_messages";');
  }
}
