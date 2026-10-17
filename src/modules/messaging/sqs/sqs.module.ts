import { Module } from '@nestjs/common';

import { WageringModule } from '../../wagering/wagering.module';
import { WalletsModule } from '../../wallets/wallets.module';
import { InboxModule } from '../inbox/inbox.module';
import { SqsWagerTransactionConsumer } from './application/sqs-wager-transaction.consumer';
import {
  ConfiguredSqsFaultInjection,
  SQS_FAULT_INJECTION,
} from './application/ports/sqs-fault-injection.port';
import { MESSAGE_CONSUMER } from './application/ports/message-consumer.port';
import { SQS_CONFIG, readSqsConfig } from './application/ports/sqs-config.port';
import { SqsMessageConsumerAdapter } from './infrastructure/sqs-message-consumer.adapter';

@Module({
  imports: [WalletsModule, WageringModule, InboxModule],
  providers: [
    { provide: SQS_CONFIG, useFactory: readSqsConfig },
    SqsMessageConsumerAdapter,
    { provide: MESSAGE_CONSUMER, useExisting: SqsMessageConsumerAdapter },
    ConfiguredSqsFaultInjection,
    { provide: SQS_FAULT_INJECTION, useExisting: ConfiguredSqsFaultInjection },
    SqsWagerTransactionConsumer,
  ],
  exports: [SqsWagerTransactionConsumer, SQS_CONFIG],
})
export class SqsModule {}
