import { validate as isUuid, version as uuidVersion } from 'uuid';

import { Money } from '../../../shared/domain/money';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly amount: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly createdAtValue: Date,
  ) {}

  static credit(
    id: string,
    walletId: string,
    transactionId: string,
    amount: Money,
    balanceBefore: Money,
    now: Date,
  ): WalletLedgerEntry {
    return WalletLedgerEntry.create(
      id,
      walletId,
      transactionId,
      'CREDIT',
      amount,
      balanceBefore,
      balanceBefore.add(amount),
      now,
    );
  }

  static debit(
    id: string,
    walletId: string,
    transactionId: string,
    amount: Money,
    balanceBefore: Money,
    now: Date,
  ): WalletLedgerEntry {
    return WalletLedgerEntry.create(
      id,
      walletId,
      transactionId,
      'DEBIT',
      amount,
      balanceBefore,
      balanceBefore.subtract(amount),
      now,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtValue.getTime());
  }

  private static create(
    id: string,
    walletId: string,
    transactionId: string,
    direction: LedgerDirection,
    amount: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    now: Date,
  ): WalletLedgerEntry {
    assertUuidV7(id, 'ledger entry id');
    assertUuid(walletId, 'wallet id');
    assertUuid(transactionId, 'transaction id');
    assertValidDate(now);
    if (!amount.isPositive()) {
      throw new Error('ledger entry amount must be positive');
    }
    if (amount.currency !== balanceBefore.currency || amount.currency !== balanceAfter.currency) {
      throw new Error('ledger entry currencies must match');
    }

    return new WalletLedgerEntry(
      id,
      walletId,
      transactionId,
      direction,
      amount,
      balanceBefore,
      balanceAfter,
      new Date(now.getTime()),
    );
  }
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new Error(`${label} must be a UUID`);
  }
}

function assertUuidV7(value: string, label: string): void {
  assertUuid(value, label);
  if (uuidVersion(value) !== 7) {
    throw new Error(`${label} must be UUIDv7`);
  }
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('ledger timestamp must be a valid date');
  }
}
