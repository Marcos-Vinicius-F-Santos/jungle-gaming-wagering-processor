import { validate as isUuid } from 'uuid';

import type { LedgerCursor } from './ports/ledger-query-repository.port';

const MAX_CURSOR_LENGTH = 512;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class InvalidLedgerCursorError extends Error {
  constructor() {
    super('INVALID_CURSOR');
    this.name = 'InvalidLedgerCursorError';
  }
}

export class LedgerCursorCodec {
  encode(cursor: LedgerCursor): string {
    this.assertCursor(cursor);

    const payload = JSON.stringify({
      walletId: cursor.walletId,
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    });

    return Buffer.from(payload, 'utf8').toString('base64url');
  }

  decode(value: unknown, expectedWalletId?: string): LedgerCursor {
    try {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
        throw new InvalidLedgerCursorError();
      }

      if (!BASE64URL_PATTERN.test(value)) {
        throw new InvalidLedgerCursorError();
      }

      const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      const cursor = this.parseCursor(parsed);

      if (expectedWalletId !== undefined && cursor.walletId !== expectedWalletId) {
        throw new InvalidLedgerCursorError();
      }

      if (this.encode(cursor) !== value) {
        throw new InvalidLedgerCursorError();
      }

      return cursor;
    } catch (error) {
      if (error instanceof InvalidLedgerCursorError) {
        throw error;
      }

      throw new InvalidLedgerCursorError();
    }
  }

  private parseCursor(value: unknown): LedgerCursor {
    if (!this.isRecord(value)) {
      throw new InvalidLedgerCursorError();
    }

    const walletId = value.walletId;
    const createdAt = value.createdAt;
    const id = value.id;

    if (
      typeof walletId !== 'string' ||
      typeof createdAt !== 'string' ||
      typeof id !== 'string' ||
      !isUuid(walletId) ||
      !isUuid(id)
    ) {
      throw new InvalidLedgerCursorError();
    }

    const parsedDate = new Date(createdAt);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString() !== createdAt) {
      throw new InvalidLedgerCursorError();
    }

    return { walletId, createdAt: parsedDate, id };
  }

  private assertCursor(cursor: LedgerCursor): void {
    if (
      !cursor ||
      !isUuid(cursor.walletId) ||
      !isUuid(cursor.id) ||
      !(cursor.createdAt instanceof Date) ||
      Number.isNaN(cursor.createdAt.getTime())
    ) {
      throw new InvalidLedgerCursorError();
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
