export interface ReceivedMessage {
  body: string;
  receiptHandle: string;
  brokerMessageId?: string;
  receiveCount: number;
}

export interface MessageConsumer {
  receive(): Promise<ReceivedMessage[]>;
  delete(message: ReceivedMessage): Promise<void>;
  changeVisibility(message: ReceivedMessage, timeoutSeconds: number): Promise<void>;
}

export const MESSAGE_CONSUMER = Symbol('MESSAGE_CONSUMER');
