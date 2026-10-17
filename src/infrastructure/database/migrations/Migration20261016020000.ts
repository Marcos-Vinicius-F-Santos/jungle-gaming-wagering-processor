import { Migration } from '@mikro-orm/migrations';

export class Migration20261016020000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "outbox_messages"
        add column "claimed_by" varchar(100),
        add column "claimed_until" timestamptz,
        add column "last_error_code" varchar(100),
        add column "last_error_at" timestamptz,
        add column "intervention_required" boolean not null default false,
        add column "dead_lettered_at" timestamptz;
    `);

    this.addSql(`
      create index "outbox_messages_claimable_idx"
      on "outbox_messages" ("next_attempt_at", "event_id")
      where "published_at" is null and "intervention_required" = false;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "outbox_messages_claimable_idx";');
    this.addSql(`
      alter table "outbox_messages"
        drop column if exists "dead_lettered_at",
        drop column if exists "intervention_required",
        drop column if exists "last_error_at",
        drop column if exists "last_error_code",
        drop column if exists "claimed_until",
        drop column if exists "claimed_by";
    `);
  }
}
