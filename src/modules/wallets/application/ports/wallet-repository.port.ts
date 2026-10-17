export interface WalletRepository<TWallet = unknown> {
  findById(walletId: string): Promise<TWallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<TWallet | null>;
  save(wallet: TWallet): Promise<void>;
  updateBalanceIfVersion(
    walletId: string,
    expectedVersion: number,
    nextBalanceAmount: string,
    nextVersion: number,
    updatedAt: Date,
  ): Promise<boolean>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
