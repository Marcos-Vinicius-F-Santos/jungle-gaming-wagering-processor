import { describe, expect, test } from 'bun:test';

import { CanonicalPayloadHasher } from '../../src/modules/wagering/application/canonical-payload-hasher';
import type { WagerBusinessPayload } from '../../src/modules/wagering/application/ports/payload-hasher.port';

describe('CanonicalPayloadHasher', () => {
  const hasher = new CanonicalPayloadHasher();

  test('returns the same hash when object keys arrive in a different order', () => {
    const first = hasher.hash({
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      playerId: 'player-a',
      walletId: 'wallet-a',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    } satisfies WagerBusinessPayload);
    const second = hasher.hash({
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'game-a',
      roundId: 'round-a',
      walletId: 'wallet-a',
      playerId: 'player-a',
      externalTransactionId: 'external-a',
      providerId: 'provider-a',
    } satisfies WagerBusinessPayload);

    expect(first).toBe(second);
  });

  test('changes when a business value changes and returns a SHA-256 hex digest', () => {
    const original = hasher.hash({
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      playerId: 'player-a',
      walletId: 'wallet-a',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const changed = hasher.hash({
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      playerId: 'player-a',
      walletId: 'wallet-a',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(original).not.toBe(changed);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
  });

  test('includes an optional reference only when it is part of the business payload', () => {
    const withoutReference = hasher.hash({
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      playerId: 'player-a',
      walletId: 'wallet-a',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'WIN',
      money: { amount: '25.00', currency: 'BRL' },
    });
    const withReference = hasher.hash({
      providerId: 'provider-a',
      externalTransactionId: 'external-a',
      playerId: 'player-a',
      walletId: 'wallet-a',
      roundId: 'round-a',
      gameId: 'game-a',
      kind: 'WIN',
      referenceExternalTransactionId: 'bet-a',
      money: { amount: '25.00', currency: 'BRL' },
    });

    expect(withReference).not.toBe(withoutReference);
  });
});
