import type { LoadInvariantReport } from './load-report';

export interface WalletInvariantSnapshot {
  walletId: string;
  balance: string;
  reconstructedBalance: string;
  financialEffectDuplicates: number;
}

export interface LoadInvariantSnapshot {
  wallets: readonly WalletInvariantSnapshot[];
  inboxConflicts: number;
  outboxFinancialDuplicates: number;
  unexpectedDeadLetters: number;
  queueDrained: boolean;
}

export interface DrainSnapshot {
  pendingMessages: number;
  pendingOutbox: number;
  deadLetterMessages: number;
}

export function validateLoadInvariants(snapshot: LoadInvariantSnapshot): LoadInvariantReport {
  const details: string[] = [];
  let balanceLedgerMismatches = 0;
  let negativeBalances = 0;
  let duplicateFinancialEffects = 0;

  for (const wallet of snapshot.wallets) {
    if (!sameDecimal(wallet.balance, wallet.reconstructedBalance)) {
      balanceLedgerMismatches += 1;
      details.push(`wallet ${wallet.walletId} balance differs from ledger reconstruction`);
    }
    if (isNegative(wallet.balance)) {
      negativeBalances += 1;
      details.push(`wallet ${wallet.walletId} has a negative balance`);
    }
    if (wallet.financialEffectDuplicates > 0) {
      duplicateFinancialEffects += wallet.financialEffectDuplicates;
      details.push(`wallet ${wallet.walletId} has duplicated financial effects`);
    }
  }

  if (snapshot.inboxConflicts > 0) details.push('Inbox payload conflicts were detected');
  if (snapshot.outboxFinancialDuplicates > 0) details.push('financial Outbox duplicates were detected');
  if (snapshot.unexpectedDeadLetters > 0) details.push('unexpected messages reached the DLQ');
  if (!snapshot.queueDrained) details.push('the workload queue did not drain');

  return {
    passed: details.length === 0,
    walletsChecked: snapshot.wallets.length,
    balanceLedgerMismatches,
    duplicateFinancialEffects,
    negativeBalances,
    inboxConflicts: snapshot.inboxConflicts,
    outboxFinancialDuplicates: snapshot.outboxFinancialDuplicates,
    unexpectedDeadLetters: snapshot.unexpectedDeadLetters,
    queueDrained: snapshot.queueDrained,
    details,
  };
}

export async function waitForDrain(
  readSnapshot: () => Promise<DrainSnapshot>,
  timeoutMs: number,
  pollIntervalMs = 250,
): Promise<DrainSnapshot> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('drain timeout must be a positive integer');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('drain poll interval must be a positive integer');

  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = await readSnapshot();
  while (Date.now() <= deadline) {
    if (lastSnapshot.pendingMessages === 0 && lastSnapshot.pendingOutbox === 0) return lastSnapshot;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    lastSnapshot = await readSnapshot();
  }
  throw new Error(`load drain timed out: ${JSON.stringify(lastSnapshot)}`);
}

function sameDecimal(left: string, right: string): boolean {
  return normalizeDecimal(left) === normalizeDecimal(right);
}

function normalizeDecimal(value: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(`invalid decimal snapshot: ${value}`);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

function isNegative(value: string): boolean {
  return /^-0*(?:\.0*)?$/.test(value) ? false : value.startsWith('-');
}
