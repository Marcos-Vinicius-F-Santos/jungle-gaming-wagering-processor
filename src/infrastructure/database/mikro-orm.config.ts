import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { InboxMessageEntity } from '../../modules/messaging/inbox/infrastructure/persistence/entities/inbox-message.entity';
import { OutboxMessageEntity } from '../../modules/messaging/outbox/infrastructure/persistence/entities/outbox-message.entity';
import { WagerTransactionEntity } from '../../modules/wagering/infrastructure/persistence/entities/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../modules/wallets/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WalletEntity } from '../../modules/wallets/infrastructure/persistence/entities/wallet.entity';
import { LedgerAccountEntity } from '../../modules/ledger/infrastructure/persistence/entities/ledger-account.entity';
import { LedgerJournalEntryEntity } from '../../modules/ledger/infrastructure/persistence/entities/ledger-journal-entry.entity';
import { LedgerPostingEntity } from '../../modules/ledger/infrastructure/persistence/entities/ledger-posting.entity';

export default defineConfig({
  driver: PostgreSqlDriver,
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
  entities: [WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity, InboxMessageEntity, OutboxMessageEntity, LedgerAccountEntity, LedgerJournalEntryEntity, LedgerPostingEntity],
  discovery: {
    warnWhenNoEntities: false,
  },
  migrations: {
      path: './dist/infrastructure/database/migrations',
      pathTs: './src/infrastructure/database/migrations',
    glob: '!(*.d).{js,ts}',
  },
});
