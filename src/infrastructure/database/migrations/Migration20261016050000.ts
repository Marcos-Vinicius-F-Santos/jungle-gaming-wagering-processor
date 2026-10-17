import { Migration } from '@mikro-orm/migrations';

export class Migration20261016050000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "ledger_accounts" (
        "id" uuid not null,
        "account_key" varchar(160) not null,
        "account_type" varchar(32) not null,
        "currency" varchar(3) not null,
        "wallet_id" uuid,
        "policy_version" varchar(64) not null,
        "active" boolean not null default true,
        "created_at" timestamptz not null default now(),
        constraint "ledger_accounts_pkey" primary key ("id"),
        constraint "ledger_accounts_key_unique" unique ("account_key"),
        constraint "ledger_accounts_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "ledger_accounts_type_check" check ("account_type" in ('WALLET', 'HOUSE_FUNDING', 'GAME_STAKE', 'GAME_PAYOUT', 'REVERSAL_CLEARING', 'LEGACY_COUNTERPARTY')),
        constraint "ledger_accounts_wallet_shape" check (("account_type" = 'WALLET' and "wallet_id" is not null) or ("account_type" <> 'WALLET' and "wallet_id" is null)),
        constraint "ledger_accounts_currency_shape" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      create unique index "ledger_accounts_wallet_currency_unique"
      on "ledger_accounts" ("wallet_id", "currency")
      where "account_type" = 'WALLET' and "wallet_id" is not null;
    `);

    this.addSql(`
      create table "ledger_journal_entries" (
        "id" uuid not null,
        "transaction_id" uuid not null,
        "effect_type" varchar(20) not null,
        "currency" varchar(3) not null,
        "policy_version" varchar(64) not null,
        "occurred_at" timestamptz not null,
        "reversal_of_journal_entry_id" uuid,
        "created_at" timestamptz not null default now(),
        constraint "ledger_journal_entries_pkey" primary key ("id"),
        constraint "ledger_journal_entries_transaction_fk" foreign key ("transaction_id") references "wager_transactions" ("id") on update cascade on delete restrict,
        constraint "ledger_journal_entries_reversal_fk" foreign key ("reversal_of_journal_entry_id") references "ledger_journal_entries" ("id") on update cascade on delete restrict,
        constraint "ledger_journal_entries_transaction_effect_unique" unique ("transaction_id", "effect_type"),
        constraint "ledger_journal_entries_effect_check" check ("effect_type" in ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK')),
        constraint "ledger_journal_entries_currency_shape" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      create index "ledger_journal_entries_reversal_idx"
      on "ledger_journal_entries" ("reversal_of_journal_entry_id")
      where "reversal_of_journal_entry_id" is not null;
    `);

    this.addSql(`
      create table "ledger_postings" (
        "id" uuid not null,
        "journal_entry_id" uuid not null,
        "account_id" uuid not null,
        "wallet_id" uuid,
        "direction" varchar(6) not null,
        "amount" numeric(19, 2) not null,
        "currency" varchar(3) not null,
        "created_at" timestamptz not null default now(),
        constraint "ledger_postings_pkey" primary key ("id"),
        constraint "ledger_postings_journal_fk" foreign key ("journal_entry_id") references "ledger_journal_entries" ("id") on update cascade on delete restrict,
        constraint "ledger_postings_account_fk" foreign key ("account_id") references "ledger_accounts" ("id") on update cascade on delete restrict,
        constraint "ledger_postings_wallet_fk" foreign key ("wallet_id") references "wallets" ("id") on update cascade on delete restrict,
        constraint "ledger_postings_direction_check" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "ledger_postings_amount_positive" check ("amount" > 0),
        constraint "ledger_postings_currency_shape" check ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql('create index "ledger_postings_journal_idx" on "ledger_postings" ("journal_entry_id");');
    this.addSql('create index "ledger_postings_account_idx" on "ledger_postings" ("account_id", "created_at");');
    this.addSql('create index "ledger_postings_wallet_idx" on "ledger_postings" ("wallet_id", "created_at") where "wallet_id" is not null;');
    this.addSql('create index "ledger_postings_currency_direction_idx" on "ledger_postings" ("currency", "direction");');

    this.addSql(`
      create or replace function prevent_ledger_mutation() returns trigger as $$
      begin
        raise exception 'double-entry ledger records are immutable';
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create trigger ledger_accounts_immutable
      before update or delete on "ledger_accounts"
      for each row execute function prevent_ledger_mutation();
    `);
    this.addSql(`
      create trigger ledger_journal_entries_immutable
      before update or delete on "ledger_journal_entries"
      for each row execute function prevent_ledger_mutation();
    `);
    this.addSql(`
      create trigger ledger_postings_immutable
      before update or delete on "ledger_postings"
      for each row execute function prevent_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists ledger_postings_immutable on "ledger_postings";');
    this.addSql('drop trigger if exists ledger_journal_entries_immutable on "ledger_journal_entries";');
    this.addSql('drop trigger if exists ledger_accounts_immutable on "ledger_accounts";');
    this.addSql('drop function if exists prevent_ledger_mutation();');
    this.addSql('drop index if exists "ledger_postings_currency_direction_idx";');
    this.addSql('drop index if exists "ledger_postings_wallet_idx";');
    this.addSql('drop index if exists "ledger_postings_account_idx";');
    this.addSql('drop index if exists "ledger_postings_journal_idx";');
    this.addSql('drop table if exists "ledger_postings";');
    this.addSql('drop index if exists "ledger_journal_entries_reversal_idx";');
    this.addSql('drop table if exists "ledger_journal_entries";');
    this.addSql('drop index if exists "ledger_accounts_wallet_currency_unique";');
    this.addSql('drop table if exists "ledger_accounts";');
  }
}
