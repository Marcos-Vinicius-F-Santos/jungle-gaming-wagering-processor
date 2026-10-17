import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';

import type { OutboxPublisherConfig } from '../../../modules/messaging/outbox/application/ports/outbox-publisher-config.port';
import { OUTBOX_PUBLISHER_CONFIG } from '../../../modules/messaging/outbox/application/ports/outbox-publisher-config.port';
import type { SqsConfig } from '../../../modules/messaging/sqs/application/ports/sqs-config.port';
import { SQS_CONFIG } from '../../../modules/messaging/sqs/application/ports/sqs-config.port';
import type { HealthComponent, SqsHealthCheck } from '../application/ports/health.port';

@Injectable()
export class AwsSqsHealthCheck implements SqsHealthCheck, OnModuleDestroy {
  private readonly client: SQSClient;

  constructor(
    @Inject(SQS_CONFIG) private readonly sqsConfig: SqsConfig,
    @Inject(OUTBOX_PUBLISHER_CONFIG) private readonly outboxConfig: OutboxPublisherConfig,
    @Optional() client?: SQSClient,
  ) {
    this.client = client ?? new SQSClient({
      region: sqsConfig.region,
      endpoint: sqsConfig.endpoint,
      credentials: sqsConfig.endpoint
        ? { accessKeyId: 'test', secretAccessKey: 'test' }
        : undefined,
    });
  }

  checkInputQueue(): Promise<HealthComponent> {
    return this.checkQueue('sqsInput', this.sqsConfig.queueUrl);
  }

  checkEventsQueue(): Promise<HealthComponent> {
    if (!this.outboxConfig.enabled) {
      return Promise.resolve({ component: 'sqsEvents', status: 'disabled' });
    }
    return this.checkQueue('sqsEvents', this.outboxConfig.queueUrl);
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private async checkQueue(component: string, queueUrl: string): Promise<HealthComponent> {
    const startedAt = Date.now();
    try {
      await this.client.send(new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }));
      return { component, status: 'up', latencyMs: Date.now() - startedAt };
    } catch {
      return {
        component,
        status: 'down',
        latencyMs: Date.now() - startedAt,
        errorCode: 'SQS_QUEUE_UNAVAILABLE',
      };
    }
  }
}
