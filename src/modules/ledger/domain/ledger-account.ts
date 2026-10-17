import { validate as isUuid, v7 as uuidv7, version as uuidVersion } from 'uuid';

export const LEDGER_ACCOUNT_TYPES = [
  'WALLET',
  'HOUSE_FUNDING',
  'GAME_STAKE',
  'GAME_PAYOUT',
  'REVERSAL_CLEARING',
  'LEGACY_COUNTERPARTY',
] as const;

export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export interface CreateLedgerAccountProps {
  id?: string;
  accountKey: string;
  accountType: LedgerAccountType;
  currency: string;
  walletId?: string;
  policyVersion: string;
  active?: boolean;
  createdAt: Date;
}

export interface LedgerAccountSnapshot {
  id: string;
  accountKey: string;
  accountType: LedgerAccountType;
  currency: string;
  walletId?: string;
  policyVersion: string;
  active: boolean;
  createdAt: Date;
}

export class LedgerAccount {
  private constructor(private readonly state: LedgerAccountSnapshot) {}

  static create(props: CreateLedgerAccountProps): LedgerAccount {
    const id = props.id ?? uuidv7();
    assertUuidV7(id, 'ledger account id');
    assertAccountKey(props.accountKey);
    assertAccountType(props.accountType);
    const currency = typeof props.currency === 'string' ? props.currency.toUpperCase() : '';
    assertCurrency(currency);
    assertPolicyVersion(props.policyVersion);
    assertValidDate(props.createdAt);

    if (props.accountType === 'WALLET' && !props.walletId) {
      throw new Error('wallet ledger account requires walletId');
    }
    if (props.accountType !== 'WALLET' && props.walletId) {
      throw new Error('system ledger account must not have walletId');
    }
    if (props.walletId) assertUuid(props.walletId, 'ledger account wallet id');

    return new LedgerAccount({
      id,
      accountKey: props.accountKey,
      accountType: props.accountType,
      currency,
      walletId: props.walletId,
      policyVersion: props.policyVersion,
      active: props.active ?? true,
      createdAt: new Date(props.createdAt.getTime()),
    });
  }

  static rehydrate(snapshot: LedgerAccountSnapshot): LedgerAccount {
    assertUuid(snapshot.id, 'ledger account id');
    assertAccountKey(snapshot.accountKey);
    assertAccountType(snapshot.accountType);
    const currency = typeof snapshot.currency === 'string' ? snapshot.currency.toUpperCase() : '';
    assertCurrency(currency);
    assertPolicyVersion(snapshot.policyVersion);
    assertValidDate(snapshot.createdAt);
    if (snapshot.accountType === 'WALLET' && !snapshot.walletId) {
      throw new Error('wallet ledger account requires walletId');
    }
    if (snapshot.accountType !== 'WALLET' && snapshot.walletId) {
      throw new Error('system ledger account must not have walletId');
    }
    if (snapshot.walletId) assertUuid(snapshot.walletId, 'ledger account wallet id');

    return new LedgerAccount({
      id: snapshot.id,
      accountKey: snapshot.accountKey,
      accountType: snapshot.accountType,
      currency,
      walletId: snapshot.walletId,
      policyVersion: snapshot.policyVersion,
      active: snapshot.active,
      createdAt: new Date(snapshot.createdAt.getTime()),
    });
  }

  get id(): string { return this.state.id; }
  get accountKey(): string { return this.state.accountKey; }
  get accountType(): LedgerAccountType { return this.state.accountType; }
  get currency(): string { return this.state.currency; }
  get walletId(): string | undefined { return this.state.walletId; }
  get policyVersion(): string { return this.state.policyVersion; }
  get active(): boolean { return this.state.active; }
  get createdAt(): Date { return new Date(this.state.createdAt.getTime()); }

  toSnapshot(): LedgerAccountSnapshot {
    return {
      ...this.state,
      createdAt: new Date(this.state.createdAt.getTime()),
    };
  }
}

function assertAccountKey(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) {
    throw new Error('ledger account key must be a safe bounded identifier');
  }
}

function assertAccountType(value: string): asserts value is LedgerAccountType {
  if (!(LEDGER_ACCOUNT_TYPES as readonly string[]).includes(value)) {
    throw new Error(`unsupported ledger account type: ${value}`);
  }
}

function assertCurrency(value: string): void {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new Error('ledger account currency must be an ISO-4217 code');
  }
}

function assertPolicyVersion(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('ledger policy version must be a safe bounded identifier');
  }
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new Error(`${label} must be a UUID`);
}

function assertUuidV7(value: string, label: string): void {
  assertUuid(value, label);
  if (uuidVersion(value) !== 7) throw new Error(`${label} must be UUIDv7`);
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('ledger account timestamp must be valid');
}
