import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

import type { MessageConsumer, ReceivedMessage } from '../application/ports/message-consumer.port';
import { SQS_CONFIG } from '../application/ports/sqs-config.port';
import type { SqsConfig } from '../application/ports/sqs-config.port';

@Injectable()
export class SqsMessageConsumerAdapter implements MessageConsumer, OnModuleDestroy {
  private readonly client: SQSClient;

  constructor(@Inject(SQS_CONFIG) private readonly config: SqsConfig) {
    this.client = new SQSClient({
      region: config.region,
      endpoint: config.endpoint,
      credentials: config.endpoint
        ? { accessKeyId: 'test', secretAccessKey: 'test' }
        : undefined,
    });
  }

  async receive(): Promise<ReceivedMessage[]> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.config.queueUrl,
      MaxNumberOfMessages: this.config.maxNumberOfMessages,
      WaitTimeSeconds: this.config.waitTimeSeconds,
      VisibilityTimeout: this.config.visibilityTimeoutSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));

    return (response.Messages ?? [])
      .filter((message): message is typeof message & { Body: string; ReceiptHandle: string } => Boolean(message.Body && message.ReceiptHandle))
      .map((message) => ({
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
        brokerMessageId: message.MessageId,
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      }));
  }

  async delete(message: ReceivedMessage): Promise<void> {
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.config.queueUrl,
      ReceiptHandle: message.receiptHandle,
    }));
  }

  async changeVisibility(message: ReceivedMessage, timeoutSeconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.config.queueUrl,
      ReceiptHandle: message.receiptHandle,
      VisibilityTimeout: timeoutSeconds,
    }));
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
