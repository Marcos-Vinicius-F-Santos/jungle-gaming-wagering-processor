import { validate as isUuid, version as uuidVersion } from 'uuid';
import Decimal from 'decimal.js';

import { Money } from '../../../shared/domain/money';
import { InsufficientWalletBalanceError } from './errors/insufficient-wallet-balance.error';

export interface WalletSnapshot {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletDebitResult {
  balanceBefore: Money;
  balanceAfter: Money;
  versionBefore: number;
  versionAfter: number;
}

export type WalletCreditResult = WalletDebitResult;

export class Wallet {
  private constructor(private readonly state: WalletSnapshot) {}

  static open(id: string, playerId: string, initialBalance: Money, now: Date): Wallet {
    assertUuidV7(id, 'wallet id');
    assertUuid(playerId, 'player id');
    assertValidDate(now);

    return new Wallet({
      id,
      playerId,
      balance: initialBalance,
      version: 1,
      createdAt: new Date(now.getTime()),
      updatedAt: new Date(now.getTime()),
    });
  }

  static rehydrate(snapshot: WalletSnapshot): Wallet {
    assertUuidV7(snapshot.id, 'wallet id');
    assertUuid(snapshot.playerId, 'player id');
    if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
      throw new Error('wallet version must be a positive integer');
    }
    assertValidDate(snapshot.createdAt);
    assertValidDate(snapshot.updatedAt);

    return new Wallet({
      ...snapshot,
      createdAt: new Date(snapshot.createdAt.getTime()),
      updatedAt: new Date(snapshot.updatedAt.getTime()),
    });
  }

  get id(): string {
    return this.state.id;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get balance(): Money {
    return this.state.balance;
  }

  get currency(): string {
    return this.state.balance.currency;
  }

  get version(): number {
    return this.state.version;
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this.state.updatedAt.getTime());
  }

  debit(amount: Money, now: Date): WalletDebitResult {
    if (!amount.isPositive()) {
      throw new Error('wallet debit amount must be positive');
    }
    if (amount.currency !== this.currency) {
      throw new Error('wallet debit currency must match wallet currency');
    }
    assertValidDate(now);

    const balanceBefore = this.state.balance;
    if (new Decimal(amount.amount).greaterThan(balanceBefore.amount)) {
      throw new InsufficientWalletBalanceError();
    }
    const versionBefore = this.state.version;
    const balanceAfter = balanceBefore.subtract(amount);
    this.state.balance = balanceAfter;
    this.state.version += 1;
    this.state.updatedAt = new Date(now.getTime());

    return {
      balanceBefore,
      balanceAfter,
      versionBefore,
      versionAfter: this.state.version,
    };
  }

  credit(amount: Money, now: Date): WalletCreditResult {
    if (!amount.isPositive()) {
      throw new Error('wallet credit amount must be positive');
    }
    if (amount.currency !== this.currency) {
      throw new Error('wallet credit currency must match wallet currency');
    }
    assertValidDate(now);

    const balanceBefore = this.state.balance;
    const versionBefore = this.state.version;
    const balanceAfter = balanceBefore.add(amount);
    this.state.balance = balanceAfter;
    this.state.version += 1;
    this.state.updatedAt = new Date(now.getTime());

    return {
      balanceBefore,
      balanceAfter,
      versionBefore,
      versionAfter: this.state.version,
    };
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
    throw new Error('wallet timestamps must be valid dates');
  }
}
