import type { OutboxMessage } from '../../domain/outbox-message';

export interface MessagePublisher {
  publish(message: OutboxMessage): Promise<void>;
  publishToDeadLetter(message: OutboxMessage): Promise<void>;
}

export const MESSAGE_PUBLISHER = Symbol('MESSAGE_PUBLISHER');
