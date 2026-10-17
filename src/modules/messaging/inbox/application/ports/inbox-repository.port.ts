import type { InboxMessage } from '../../domain/inbox-message';

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): Promise<void>;
  update(message: InboxMessage): Promise<void>;
}

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
