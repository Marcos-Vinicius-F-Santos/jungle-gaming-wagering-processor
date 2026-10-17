import { describe, expect, test } from 'bun:test';

import {
  InvalidLedgerCursorError,
  LedgerCursorCodec,
} from '../../src/modules/wallets/application/ledger-cursor.codec';

const walletId = '018f0000-0000-7000-8000-000000000001';
const otherWalletId = '018f0000-0000-7000-8000-000000000002';
const entryId = '018f0000-0000-7000-8000-000000000003';

describe('LedgerCursorCodec', () => {
  const codec = new LedgerCursorCodec();

  test('round-trips an opaque, wallet-scoped cursor', () => {
    const cursor = {
      walletId,
      createdAt: new Date('2026-10-16T12:00:00.000Z'),
      id: entryId,
    };

    const encoded = codec.encode(cursor);

    expect(encoded).not.toContain('2026');
    expect(codec.decode(encoded, walletId)).toEqual(cursor);
  });

  test('rejects an altered, non-canonical, malformed or oversized cursor', () => {
    const encoded = codec.encode({
      walletId,
      createdAt: new Date('2026-10-16T12:00:00.000Z'),
      id: entryId,
    });
    const altered = `${encoded.slice(0, -1)}${encoded.endsWith('A') ? 'B' : 'A'}`;
    const nonCanonical = Buffer.from(
      JSON.stringify({ walletId, createdAt: '2026-10-16T12:00:00.000Z', id: entryId, extra: true }),
      'utf8',
    ).toString('base64url');

    for (const invalid of [altered, nonCanonical, 'not base64!', '', 'A'.repeat(513)]) {
      expect(() => codec.decode(invalid)).toThrow(InvalidLedgerCursorError);
    }
  });

  test('rejects a cursor from another wallet and invalid values before encoding', () => {
    const encoded = codec.encode({
      walletId,
      createdAt: new Date('2026-10-16T12:00:00.000Z'),
      id: entryId,
    });

    expect(() => codec.decode(encoded, otherWalletId)).toThrow(InvalidLedgerCursorError);
    expect(() =>
      codec.encode({
        walletId: otherWalletId,
        createdAt: new Date('not-a-date'),
        id: entryId,
      }),
    ).toThrow(InvalidLedgerCursorError);
  });
});
