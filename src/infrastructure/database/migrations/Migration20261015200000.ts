import { Migration } from '@mikro-orm/migrations';

export class Migration20261015200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql('drop index if exists "wager_transactions_idempotency_key_unique";');

    this.addSql(`
      alter table "wager_transactions"
        add column "result_balance_amount" numeric(19, 2),
        add column "result_balance_currency" varchar(3);
    `);

    this.addSql(`
      alter table "wager_transactions"
        add constraint "wager_transactions_provider_id_length"
          check (char_length("provider_id") between 1 and 64),
        add constraint "wager_transactions_external_id_length"
          check (char_length("external_transaction_id") between 1 and 255),
        add constraint "wager_transactions_round_id_length"
          check ("round_id" is null or char_length("round_id") between 1 and 128),
        add constraint "wager_transactions_game_id_length"
          check ("game_id" is null or char_length("game_id") between 1 and 128),
        add constraint "wager_transactions_idempotency_key_length"
          check ("idempotency_key" is null or char_length("idempotency_key") between 1 and 255),
        add constraint "wager_transactions_result_balance_pair"
          check (("result_balance_amount" is null) = ("result_balance_currency" is null)),
        add constraint "wager_transactions_result_balance_non_negative"
          check ("result_balance_amount" is null or "result_balance_amount" >= 0),
        add constraint "wager_transactions_result_currency_shape"
          check ("result_balance_currency" is null or "result_balance_currency" ~ '^[A-Z]{3}$');
    `);

    this.addSql(`
      create unique index "wager_transactions_provider_idempotency_key_unique"
      on "wager_transactions" ("provider_id", "idempotency_key")
      where "idempotency_key" is not null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists "wager_transactions_provider_idempotency_key_unique";');

    this.addSql(`
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_provider_id_length",
        drop constraint if exists "wager_transactions_external_id_length",
        drop constraint if exists "wager_transactions_round_id_length",
        drop constraint if exists "wager_transactions_game_id_length",
        drop constraint if exists "wager_transactions_idempotency_key_length",
        drop constraint if exists "wager_transactions_result_balance_pair",
        drop constraint if exists "wager_transactions_result_balance_non_negative",
        drop constraint if exists "wager_transactions_result_currency_shape",
        drop column if exists "result_balance_amount",
        drop column if exists "result_balance_currency";
    `);

    this.addSql(`
      create unique index "wager_transactions_idempotency_key_unique"
      on "wager_transactions" ("idempotency_key")
      where "idempotency_key" is not null;
    `);
  }
}
