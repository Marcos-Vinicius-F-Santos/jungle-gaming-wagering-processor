import { Migration } from '@mikro-orm/migrations';

export class Migration20261016000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_transaction_id" uuid;
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_reference_transaction_fk"
          foreign key ("reference_transaction_id")
          references "wager_transactions" ("id")
          on update cascade on delete restrict;
    `);

    this.addSql(`
      create unique index "wager_transactions_direct_reversal_unique"
      on "wager_transactions" ("reference_transaction_id")
      where "kind" in ('REFUND', 'ROLLBACK') and "reference_transaction_id" is not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "wager_transactions_direct_reversal_unique";');
    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_transaction_fk",
        drop column if exists "reference_transaction_id";
    `);
  }
}
