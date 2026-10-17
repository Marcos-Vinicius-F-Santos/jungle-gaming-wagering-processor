export type ConsumerLifecycleState = 'RUNNING' | 'DRAINING' | 'STOPPED';

export interface ConsumerLifecycleSnapshot {
  state: ConsumerLifecycleState;
  inFlight: number;
}

export class ConsumerLifecycle {
  private state: ConsumerLifecycleState = 'RUNNING';
  private inFlight = 0;

  canReceive(): boolean {
    return this.state === 'RUNNING';
  }

  beginMessage(): boolean {
    if (!this.canReceive()) return false;
    this.inFlight += 1;
    return true;
  }

  completeMessage(): void {
    if (this.inFlight === 0) {
      throw new Error('Cannot complete a message when none is in flight');
    }
    this.inFlight -= 1;
    if (this.state === 'DRAINING' && this.inFlight === 0) {
      this.state = 'STOPPED';
    }
  }

  requestShutdown(): void {
    if (this.state === 'STOPPED') return;
    this.state = 'DRAINING';
    if (this.inFlight === 0) {
      this.state = 'STOPPED';
    }
  }

  snapshot(): ConsumerLifecycleSnapshot {
    return { state: this.state, inFlight: this.inFlight };
  }
}
