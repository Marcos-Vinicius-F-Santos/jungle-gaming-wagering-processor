import { Migration } from '@mikro-orm/migrations';

export class Migration20261016040000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "inbox_messages"
        add column "claimed_by" varchar(100),
        add column "lease_until" timestamptz,
        add column "processing_started_at" timestamptz;
    `);

    this.addSql(`
      create index "inbox_messages_lease_recovery_idx"
      on "inbox_messages" ("status", "lease_until")
      where "status" = 'PROCESSING';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "inbox_messages_lease_recovery_idx";');
    this.addSql(`
      alter table "inbox_messages"
        drop column if exists "processing_started_at",
        drop column if exists "lease_until",
        drop column if exists "claimed_by";
    `);
  }
}
