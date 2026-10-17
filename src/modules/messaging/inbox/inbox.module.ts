import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { INBOX_REPOSITORY } from './application/ports/inbox-repository.port';
import { INBOX_CLAIM_REPOSITORY } from './application/ports/inbox-claim.port';
import { InboxMessageEntity } from './infrastructure/persistence/entities/inbox-message.entity';
import { MikroOrmInboxRepository } from './infrastructure/persistence/mikro-orm-inbox.repository';

@Module({
  imports: [MikroOrmModule.forFeature([InboxMessageEntity])],
  providers: [
    MikroOrmInboxRepository,
    { provide: INBOX_REPOSITORY, useExisting: MikroOrmInboxRepository },
    { provide: INBOX_CLAIM_REPOSITORY, useExisting: MikroOrmInboxRepository },
  ],
  exports: [INBOX_REPOSITORY, INBOX_CLAIM_REPOSITORY],
})
export class InboxModule {}
