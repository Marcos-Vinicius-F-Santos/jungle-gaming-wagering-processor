import {
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

import type { MessagePublisher } from '../application/ports/message-publisher.port';
import { OUTBOX_PUBLISHER_CONFIG } from '../application/ports/outbox-publisher-config.port';
import type { OutboxPublisherConfig } from '../application/ports/outbox-publisher-config.port';
import type { OutboxMessage } from '../domain/outbox-message';

@Injectable()
export class SqsMessagePublisherAdapter implements MessagePublisher, OnModuleDestroy {
  private readonly client: SQSClient;

  constructor(@Inject(OUTBOX_PUBLISHER_CONFIG) private readonly config: OutboxPublisherConfig) {
    this.client = new SQSClient({
      region: config.region,
      endpoint: config.endpoint,
      credentials: config.endpoint
        ? { accessKeyId: 'test', secretAccessKey: 'test' }
        : undefined,
    });
  }

  async publish(message: OutboxMessage): Promise<void> {
    await this.send(this.config.queueUrl, message);
  }

  async publishToDeadLetter(message: OutboxMessage): Promise<void> {
    await this.send(this.config.dlqUrl, message);
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private async send(queueUrl: string, message: OutboxMessage): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message.toJSON()),
      MessageDeduplicationId: message.eventId,
      MessageGroupId: message.aggregateId,
      MessageAttributes: {
        eventId: { DataType: 'String', StringValue: message.eventId },
        eventType: { DataType: 'String', StringValue: message.eventType },
        eventVersion: { DataType: 'Number', StringValue: String(message.version) },
      },
    }));
  }
}
