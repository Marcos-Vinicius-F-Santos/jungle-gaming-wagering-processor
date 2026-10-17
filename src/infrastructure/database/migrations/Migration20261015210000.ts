import { Migration } from '@mikro-orm/migrations';

export class Migration20261015210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_external_transaction_id" varchar(255),
        add column "pending_since" timestamptz,
        add column "next_attempt_at" timestamptz,
        add column "pending_attempts" integer not null default 0;
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_reference_external_id_length"
          check ("reference_external_transaction_id" is null or char_length("reference_external_transaction_id") between 1 and 255),
        add constraint "wager_transactions_pending_attempts_non_negative"
          check ("pending_attempts" >= 0),
        add constraint "wager_transactions_pending_fields_consistent"
          check (
            ("status" = 'PENDING_REFERENCE'
              and "pending_since" is not null
              and "next_attempt_at" is not null)
            or ("status" <> 'PENDING_REFERENCE'
              and "pending_since" is null
              and "next_attempt_at" is null
              and "pending_attempts" = 0)
          );
    `);

    this.addSql(`
      create index "wager_transactions_pending_reference_due_idx"
      on "wager_transactions" ("next_attempt_at", "id")
      where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "wager_transactions_pending_reference_due_idx";');

    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_external_id_length",
        drop constraint if exists "wager_transactions_pending_attempts_non_negative",
        drop constraint if exists "wager_transactions_pending_fields_consistent",
        drop column if exists "reference_external_transaction_id",
        drop column if exists "pending_since",
        drop column if exists "next_attempt_at",
        drop column if exists "pending_attempts";
    `);
  }
}
