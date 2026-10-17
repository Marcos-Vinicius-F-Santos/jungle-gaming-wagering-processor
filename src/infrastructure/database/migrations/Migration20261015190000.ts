import { Migration } from '@mikro-orm/migrations';

export class Migration20261015190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" uuid not null,
        "player_id" uuid not null,
        "currency" varchar(3) not null,
        "balance_amount" numeric(19, 2) not null default 0,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency"),
        constraint "wallets_balance_non_negative" check ("balance_amount" >= 0),
        constraint "wallets_version_positive" check ("version" >= 1),
        constraint "wallets_currency_shape" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" uuid not null,
        "provider_id" varchar(100) not null,
        "external_transaction_id" varchar(255) not null,
        "idempotency_key" varchar(255),
        "payload_hash" varchar(64),
        "wallet_id" uuid not null,
        "player_id" uuid not null,
        "round_id" varchar(255),
        "game_id" varchar(255),
        "kind" varchar(20) not null,
        "amount" numeric(19, 2) not null,
        "currency" varchar(3) not null,
        "status" varchar(24) not null,
        "failure_code" varchar(100),
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "wager_transactions_amount_positive" check ("amount" > 0),
        constraint "wager_transactions_currency_shape" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
      );
    `);

    this.addSql(`
      create unique index "wager_transactions_idempotency_key_unique"
      on "wager_transactions" ("idempotency_key")
      where "idempotency_key" is not null;
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" uuid not null,
        "wallet_id" uuid not null,
        "transaction_id" uuid not null,
        "direction" varchar(6) not null,
        "amount" numeric(19, 2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(19, 2) not null,
        "balance_after" numeric(19, 2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_entries_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "wallet_ledger_entries_transaction_fk" foreign key ("transaction_id") references "wager_transactions" ("id") on update cascade on delete restrict,
        constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_entries_currency_shape" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallet_ledger_entries_balance_check" check (
          ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
          or ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
        ),
        constraint "wallet_ledger_entries_balance_non_negative" check ("balance_after" >= 0)
      );
    `);

    this.addSql(`
      create or replace function prevent_wallet_ledger_mutation() returns trigger as $$
      begin
        raise exception 'wallet ledger entries are immutable';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger wallet_ledger_entries_immutable
      before update or delete on "wallet_ledger_entries"
      for each row execute function prevent_wallet_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists wallet_ledger_entries_immutable on "wallet_ledger_entries";');
    this.addSql('drop function if exists prevent_wallet_ledger_mutation();');
    this.addSql('drop table if exists "wallet_ledger_entries";');
    this.addSql('drop index if exists "wager_transactions_idempotency_key_unique";');
    this.addSql('drop table if exists "wager_transactions";');
    this.addSql('drop table if exists "wallets";');
  }
}
