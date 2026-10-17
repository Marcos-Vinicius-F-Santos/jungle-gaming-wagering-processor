import { Money } from '../../../shared/domain/money';
import { LEDGER_ACCOUNT_TYPES, type LedgerAccountType } from './ledger-account';
import { POSTING_DIRECTIONS, type PostingDirection } from './posting';

export const LEDGER_EFFECT_TYPES = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type LedgerEffectType = (typeof LEDGER_EFFECT_TYPES)[number];

export const DEFAULT_LEDGER_POLICY_VERSION = 'ledger-v1';

export interface LedgerAccountReference {
  readonly accountType: LedgerAccountType;
  readonly accountKey: string;
  readonly currency: string;
  readonly walletId?: string;
}

export interface LedgerPostingInstruction {
  readonly account: LedgerAccountReference;
  readonly direction: PostingDirection;
  readonly money: Money;
}

export interface LedgerEffectReference {
  readonly effectType: Exclude<LedgerEffectType, 'LOSS'>;
  readonly journalEntryId?: string;
  readonly postings: readonly LedgerPostingInstruction[];
}

export interface CreateLedgerEffectPlanProps {
  readonly effectType: LedgerEffectType;
  readonly walletId: string;
  readonly currency: string;
  readonly amount: Money;
  readonly policyVersion?: string;
  readonly reference?: LedgerEffectReference;
}

export interface LedgerEffectPlan {
  readonly effectType: LedgerEffectType;
  readonly policyVersion: string;
  readonly patrimonial: boolean;
  readonly postings: readonly LedgerPostingInstruction[];
  readonly reversalOfJournalEntryId?: string;
}

export class LedgerAccountPolicy {
  static createPlan(props: CreateLedgerEffectPlanProps): LedgerEffectPlan {
    const currency = normalizeCurrency(props.currency);
    const policyVersion = props.policyVersion ?? DEFAULT_LEDGER_POLICY_VERSION;
    assertPolicyVersion(policyVersion);
    assertWalletId(props.walletId);
    assertMoney(props.amount, currency);

    if (props.effectType === 'LOSS') {
      return {
        effectType: props.effectType,
        policyVersion,
        patrimonial: false,
        postings: [],
      };
    }

    if (props.effectType === 'REFUND' || props.effectType === 'ROLLBACK') {
      return this.createReversalPlan(props, currency, policyVersion);
    }

    const wallet = this.walletAccount(props.walletId, currency);
    const counterpartyType = props.effectType === 'OPENING'
      ? 'HOUSE_FUNDING'
      : props.effectType === 'BET'
        ? 'GAME_STAKE'
        : 'GAME_PAYOUT';
    const counterparty = this.systemAccount(counterpartyType, currency);
    const walletDirection = props.effectType === 'BET' ? 'DEBIT' : 'CREDIT';
    const counterpartyDirection = walletDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT';

    return {
      effectType: props.effectType,
      policyVersion,
      patrimonial: true,
      postings: [
        instruction(counterparty, counterpartyDirection, props.amount),
        instruction(wallet, walletDirection, props.amount),
      ],
    };
  }

  static accountKey(accountType: LedgerAccountType, currency: string, walletId?: string): string {
    const normalizedCurrency = normalizeCurrency(currency);
    if (accountType === 'WALLET') {
      assertWalletId(walletId);
      return `wallet:${normalizedCurrency}:${walletId}`;
    }
    if (walletId) throw new Error('system ledger account cannot have wallet id');
    return `${accountType.toLowerCase()}:${normalizedCurrency}`;
  }

  private static createReversalPlan(
    props: CreateLedgerEffectPlanProps,
    currency: string,
    policyVersion: string,
  ): LedgerEffectPlan {
    if (!props.reference) throw new Error(`${props.effectType} requires a referenced journal`);
    if (props.effectType === 'REFUND' && props.reference.effectType !== 'BET') {
      throw new Error('REFUND requires a BET reference');
    }
    if (props.reference.postings.length < 2) throw new Error('referenced journal must have postings');

    const referencedAmount = totalForDirection(props.reference.postings, 'DEBIT');
    if (!referencedAmount.equals(props.amount)) throw new Error('reversal amount must match referenced journal');
    for (const posting of props.reference.postings) {
      if (posting.money.currency !== currency) throw new Error('reversal postings must use one currency');
    }

    return {
      effectType: props.effectType,
      policyVersion,
      patrimonial: true,
      reversalOfJournalEntryId: props.reference.journalEntryId,
      postings: props.reference.postings.map((posting) => ({
        account: { ...posting.account },
        direction: invertDirection(posting.direction),
        money: posting.money,
      })),
    };
  }

  private static walletAccount(walletId: string, currency: string): LedgerAccountReference {
    return {
      accountType: 'WALLET',
      accountKey: this.accountKey('WALLET', currency, walletId),
      currency,
      walletId,
    };
  }

  private static systemAccount(accountType: Exclude<LedgerAccountType, 'WALLET'>, currency: string): LedgerAccountReference {
    return {
      accountType,
      accountKey: this.accountKey(accountType, currency),
      currency,
    };
  }
}

function instruction(account: LedgerAccountReference, direction: PostingDirection, money: Money): LedgerPostingInstruction {
  return { account: { ...account }, direction, money };
}

function invertDirection(direction: PostingDirection): PostingDirection {
  return direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}

function totalForDirection(postings: readonly LedgerPostingInstruction[], direction: PostingDirection): Money {
  const first = postings.find((posting) => posting.direction === direction);
  if (!first) throw new Error(`referenced journal requires a ${direction.toLowerCase()}`);
  return postings
    .filter((posting) => posting.direction === direction)
    .reduce((total, posting) => total.add(posting.money), Money.of('0.00', first.money.currency));
}

function normalizeCurrency(currency: string): string {
  const normalized = typeof currency === 'string' ? currency.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(normalized)) throw new Error('ledger currency must be an ISO-4217 code');
  return normalized;
}

function assertMoney(money: Money, currency: string): void {
  if (!(money instanceof Money) || !money.isPositive()) throw new Error('ledger effect amount must be positive');
  if (money.currency !== currency) throw new Error('ledger effect amount currency must match plan currency');
}

function assertWalletId(walletId: string | undefined): asserts walletId is string {
  if (typeof walletId !== 'string' || walletId.trim().length === 0) throw new Error('ledger wallet id is required');
}

function assertPolicyVersion(policyVersion: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(policyVersion)) throw new Error('ledger policy version must be safe');
}

void LEDGER_ACCOUNT_TYPES;
void POSTING_DIRECTIONS;
