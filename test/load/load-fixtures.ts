import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { LoadScenario } from './load-config';

export interface LoadWalletSeed {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: 'BRL';
  readonly initialBalance: string;
}

export interface LoadOperationSeed {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: 'BET' | 'WIN' | 'LOSS';
  readonly money: { readonly amount: string; readonly currency: 'BRL' };
}

export interface LoadMessageSeed {
  readonly messageId: string;
  readonly correlationId: string;
  readonly operation: LoadOperationSeed;
}

export class LoadDataCatalog {
  private sequence = 0;

  constructor(
    readonly runId: string,
    readonly scenarioId: Exclude<LoadScenario, 'all'>,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
      throw new Error('load catalog runId must be safe and bounded');
    }
  }

  providerId(): string {
    const runKey = createHash('sha256').update(this.runId).digest('hex').slice(0, 16);
    return `load-${runKey}-${this.scenarioId}`;
  }

  wallet(initialBalance = '100000.00'): LoadWalletSeed {
    this.nextIndex();
    return {
      walletId: uuidv7(),
      playerId: uuidv7(),
      currency: 'BRL',
      initialBalance,
    };
  }

  operation(wallet: LoadWalletSeed, kind: LoadOperationSeed['kind'] = 'BET', amount = '1.00'): LoadOperationSeed {
    const index = this.nextIndex();
    return {
      providerId: this.providerId(),
      externalTransactionId: this.scope(`external-${index}`),
      idempotencyKey: this.scope(`idempotency-${index}`),
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: this.scope(`round-${index}`),
      gameId: this.scope('load-test'),
      kind,
      money: { amount, currency: wallet.currency },
    };
  }

  message(operation: LoadOperationSeed): LoadMessageSeed {
    const index = this.nextIndex();
    return {
      messageId: this.scope(`message-${index}`),
      correlationId: this.scope(`correlation-${index}`),
      operation,
    };
  }

  replay(operation: LoadOperationSeed): LoadOperationSeed {
    return { ...operation, money: { ...operation.money } };
  }

  private nextIndex(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private scope(value: string): string {
    return `load-${this.runId}-${this.scenarioId}-${value}`;
  }
}
