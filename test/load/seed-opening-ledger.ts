import { v7 as uuidv7 } from 'uuid';
import { LedgerAccountPolicy } from '../../src/modules/ledger/domain/ledger-policy';
import { Money } from '../../src/shared/domain/money';

export interface LoadPgClient {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface LedgerAccountRow {
  id: string;
  account_type: string;
  currency: string;
  wallet_id: string | null;
}

export interface OpeningLedgerSeed {
  transactionId: string;
  walletId: string;
  currency: string;
  amount: string;
  occurredAt?: Date;
}

export async function seedOpeningLedger(client: LoadPgClient, seed: OpeningLedgerSeed): Promise<void> {
  const occurredAt = seed.occurredAt ?? new Date();
  const plan = LedgerAccountPolicy.createPlan({
    effectType: 'OPENING',
    walletId: seed.walletId,
    currency: seed.currency,
    amount: Money.of(seed.amount, seed.currency),
  });
  const accountIds = new Map<string, string>();

  for (const posting of plan.postings) {
    if (accountIds.has(posting.account.accountKey)) continue;

    await client.query(
      `insert into ledger_accounts
         (id, account_key, account_type, currency, wallet_id, policy_version)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (account_key) do nothing`,
      [
        uuidv7(),
        posting.account.accountKey,
        posting.account.accountType,
        posting.account.currency,
        posting.account.walletId ?? null,
        plan.policyVersion,
      ],
    );

    const account = await client.query<LedgerAccountRow>(
      `select id, account_type, currency, wallet_id
         from ledger_accounts
        where account_key = $1`,
      [posting.account.accountKey],
    );
    const row = account.rows[0];
    if (!row) throw new Error(`load seed could not resolve ledger account ${posting.account.accountKey}`);
    if (
      row.account_type !== posting.account.accountType
      || row.currency !== posting.account.currency
      || row.wallet_id !== (posting.account.walletId ?? null)
    ) {
      throw new Error(`load seed ledger account ${posting.account.accountKey} does not match policy`);
    }
    accountIds.set(posting.account.accountKey, row.id);
  }

  const journalId = uuidv7();
  await client.query(
    `insert into ledger_journal_entries
       (id, transaction_id, effect_type, currency, policy_version, occurred_at, created_at)
     values ($1, $2, 'OPENING', $3, $4, $5, $5)`,
    [journalId, seed.transactionId, seed.currency.toUpperCase(), plan.policyVersion, occurredAt],
  );

  for (const posting of plan.postings) {
    await client.query(
      `insert into ledger_postings
         (id, journal_entry_id, account_id, wallet_id, direction, amount, currency, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv7(),
        journalId,
        accountIds.get(posting.account.accountKey),
        posting.account.walletId ?? null,
        posting.direction,
        posting.money.amount,
        posting.money.currency,
        occurredAt,
      ],
    );
  }
}
