import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { CLOCK } from '../../../shared/application/ports/clock.port';
import { OUTBOX_PUBLISHER_HEALTH } from '../../../interfaces/health/application/ports/health.port';
import { LOGGER } from '../../../shared/application/ports/logger.port';
import { METRICS } from '../../../shared/application/ports/metrics.port';
import { UNIT_OF_WORK } from '../../../shared/application/ports/unit-of-work.port';
import { SystemClock } from '../../../shared/infrastructure/clock/system-clock';
import { StructuredLogger } from '../../../shared/infrastructure/logging/structured-logger';
import { InMemoryMetrics } from '../../../shared/infrastructure/metrics/in-memory-metrics';
import { MikroOrmUnitOfWork } from '../../../shared/infrastructure/database/mikro-orm-unit-of-work';
import { OutboxPublisherWorker } from './application/outbox-publisher.worker';
import { MESSAGE_PUBLISHER } from './application/ports/message-publisher.port';
import {
  OUTBOX_PUBLISHER_CONFIG,
  readOutboxPublisherConfig,
} from './application/ports/outbox-publisher-config.port';
import { OUTBOX_REPOSITORY } from './application/ports/outbox-repository.port';
import { OutboxMessageEntity } from './infrastructure/persistence/entities/outbox-message.entity';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox.repository';
import { SqsMessagePublisherAdapter } from './infrastructure/sqs-message-publisher.adapter';

@Module({
  imports: [MikroOrmModule.forFeature([OutboxMessageEntity])],
  providers: [
    { provide: OUTBOX_PUBLISHER_CONFIG, useFactory: readOutboxPublisherConfig },
    SystemClock,
    StructuredLogger,
    InMemoryMetrics,
    MikroOrmUnitOfWork,
    MikroOrmOutboxRepository,
    SqsMessagePublisherAdapter,
    OutboxPublisherWorker,
    { provide: OUTBOX_PUBLISHER_HEALTH, useExisting: OutboxPublisherWorker },
    { provide: CLOCK, useExisting: SystemClock },
    { provide: LOGGER, useExisting: StructuredLogger },
    { provide: METRICS, useExisting: InMemoryMetrics },
    { provide: UNIT_OF_WORK, useExisting: MikroOrmUnitOfWork },
    { provide: OUTBOX_REPOSITORY, useExisting: MikroOrmOutboxRepository },
    { provide: MESSAGE_PUBLISHER, useExisting: SqsMessagePublisherAdapter },
  ],
  exports: [OUTBOX_REPOSITORY, OUTBOX_PUBLISHER_HEALTH, OUTBOX_PUBLISHER_CONFIG],
})
export class OutboxModule {}
