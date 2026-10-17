import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { LedgerEffectRecorder } from './application/ledger-effect-recorder';
import { LedgerBackfillService } from './application/ledger-backfill.service';
import { LedgerReconciliationService } from './application/ledger-reconciliation.service';
import { DOUBLE_ENTRY_LEDGER_REPOSITORY } from './application/ports/double-entry-ledger-repository.port';
import { LedgerAccountEntity } from './infrastructure/persistence/entities/ledger-account.entity';
import { LedgerJournalEntryEntity } from './infrastructure/persistence/entities/ledger-journal-entry.entity';
import { LedgerPostingEntity } from './infrastructure/persistence/entities/ledger-posting.entity';
import { MikroOrmDoubleEntryLedgerRepository } from './infrastructure/persistence/mikro-orm-double-entry-ledger.repository';

@Module({
  imports: [MikroOrmModule.forFeature([LedgerAccountEntity, LedgerJournalEntryEntity, LedgerPostingEntity])],
  providers: [
    LedgerEffectRecorder,
    LedgerBackfillService,
    LedgerReconciliationService,
    MikroOrmDoubleEntryLedgerRepository,
    { provide: DOUBLE_ENTRY_LEDGER_REPOSITORY, useExisting: MikroOrmDoubleEntryLedgerRepository },
  ],
  exports: [LedgerEffectRecorder, LedgerBackfillService, LedgerReconciliationService, DOUBLE_ENTRY_LEDGER_REPOSITORY],
})
export class LedgerModule {}
