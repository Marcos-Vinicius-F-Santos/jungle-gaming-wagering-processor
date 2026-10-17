import { Migration } from '@mikro-orm/migrations';

export class Migration20261016060000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function assert_ledger_journal_balanced() returns trigger as $$
      declare
        journal_currency varchar(3);
        debit_total numeric(19, 2);
        credit_total numeric(19, 2);
        posting_count integer;
        invalid_currency boolean;
        journal_id uuid;
      begin
        if tg_table_name = 'ledger_postings' then
          journal_id := new.journal_entry_id;
        else
          journal_id := new.id;
        end if;

        select currency into journal_currency
          from "ledger_journal_entries"
         where id = journal_id;

        select count(*)::integer,
               coalesce(sum(case when direction = 'DEBIT' then amount else 0 end), 0),
               coalesce(sum(case when direction = 'CREDIT' then amount else 0 end), 0),
               coalesce(bool_or(currency <> journal_currency), false)
          into posting_count, debit_total, credit_total, invalid_currency
          from "ledger_postings"
         where journal_entry_id = journal_id;

        if posting_count < 2 then
          raise exception 'ledger journal % requires at least two postings', journal_id;
        end if;
        if invalid_currency then
          raise exception 'ledger journal % has mixed currencies', journal_id;
        end if;
        if debit_total = 0 or credit_total = 0 or debit_total <> credit_total then
          raise exception 'ledger journal % is not balanced', journal_id;
        end if;

        return null;
      end;
      $$ language plpgsql;
    `);

    this.addSql(`
      create constraint trigger ledger_journal_entries_balance
      after insert on "ledger_journal_entries"
      deferrable initially deferred
      for each row execute function assert_ledger_journal_balanced();
    `);
    this.addSql(`
      create constraint trigger ledger_postings_balance
      after insert on "ledger_postings"
      deferrable initially deferred
      for each row execute function assert_ledger_journal_balanced();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists ledger_postings_balance on "ledger_postings";');
    this.addSql('drop trigger if exists ledger_journal_entries_balance on "ledger_journal_entries";');
    this.addSql('drop function if exists assert_ledger_journal_balanced();');
  }
}
