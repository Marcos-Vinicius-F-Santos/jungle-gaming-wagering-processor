import type { WagerTransactionRecord } from './ports/wager-transaction-repository.port';

export interface WagerReferenceContext {
  providerId: string;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string;
  kind?: 'WIN' | 'REFUND' | 'ROLLBACK';
  amount?: string;
}

export type WagerReferenceValidationResult =
  | { status: 'NOT_FOUND' }
  | { status: 'PENDING'; transaction: WagerTransactionRecord }
  | { status: 'INCOMPATIBLE'; reason: 'NOT_PROCESSED_BET' | 'NOT_ALLOWED_KIND' | 'CONTEXT_MISMATCH' | 'AMOUNT_MISMATCH' }
  | { status: 'VALID'; transaction: WagerTransactionRecord };

export class WagerReferenceValidator {
  validate(
    reference: WagerTransactionRecord | null,
    context: WagerReferenceContext,
  ): WagerReferenceValidationResult {
    if (!reference) {
      return { status: 'NOT_FOUND' };
    }

    const allowedKinds = context.kind === 'REFUND'
      ? ['BET']
      : context.kind === 'ROLLBACK'
        ? ['BET', 'WIN', 'REFUND']
        : ['BET'];
    if (!allowedKinds.includes(reference.kind)) {
      return {
        status: 'INCOMPATIBLE',
        reason: context.kind === 'REFUND' || context.kind === 'ROLLBACK' ? 'NOT_ALLOWED_KIND' : 'NOT_PROCESSED_BET',
      };
    }

    const matchesContext = reference.providerId === context.providerId
      && reference.playerId === context.playerId
      && reference.walletId === context.walletId
      && reference.currency === context.currency
      && reference.roundId === context.roundId;

    if (!matchesContext) {
      return { status: 'INCOMPATIBLE', reason: 'CONTEXT_MISMATCH' };
    }

    if (context.amount !== undefined && reference.amount !== context.amount) {
      return { status: 'INCOMPATIBLE', reason: 'AMOUNT_MISMATCH' };
    }

    if (reference.status === 'PENDING' || reference.status === 'PENDING_REFERENCE') {
      return { status: 'PENDING', transaction: reference };
    }

    if (reference.status !== 'PROCESSED') {
      return { status: 'INCOMPATIBLE', reason: 'NOT_PROCESSED_BET' };
    }

    return { status: 'VALID', transaction: reference };
  }
}
