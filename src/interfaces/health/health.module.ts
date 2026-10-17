import { Module } from '@nestjs/common';

import { POSTGRES_HEALTH_CHECK, SQS_HEALTH_CHECK } from './application/ports/health.port';
import { HEALTH_CONFIG, readHealthConfig } from './application/ports/health-config.port';
import { HealthService } from './application/health.service';
import { HealthController } from './health.controller';
import { OutboxModule } from '../../modules/messaging/outbox/outbox.module';
import { SqsModule } from '../../modules/messaging/sqs/sqs.module';
import { MikroOrmPostgresHealthCheck } from './infrastructure/mikro-orm-postgres.health-check';
import { AwsSqsHealthCheck } from './infrastructure/sqs.health-check';

@Module({
  imports: [OutboxModule, SqsModule],
  controllers: [HealthController],
  providers: [
    MikroOrmPostgresHealthCheck,
    AwsSqsHealthCheck,
    HealthService,
    { provide: POSTGRES_HEALTH_CHECK, useExisting: MikroOrmPostgresHealthCheck },
    { provide: SQS_HEALTH_CHECK, useExisting: AwsSqsHealthCheck },
    { provide: HEALTH_CONFIG, useFactory: readHealthConfig },
  ],
  exports: [HealthService],
})
export class HealthModule {}
