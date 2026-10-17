import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './infrastructure/database/mikro-orm.config';
import { SqsModule } from './modules/messaging/sqs/sqs.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { HealthModule } from './interfaces/health/health.module';
import { CorrelationModule } from './shared/infrastructure/correlation/correlation.module';
import { HttpCorrelationMiddleware } from './shared/infrastructure/correlation/http-correlation.middleware';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), CorrelationModule, WalletsModule, ReconciliationModule, SqsModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpCorrelationMiddleware).forRoutes('*');
  }
}
