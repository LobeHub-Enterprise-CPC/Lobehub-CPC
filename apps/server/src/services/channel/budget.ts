import { CHANNEL_LIMITS } from '@lobechat/types';

export interface ChannelBudgetSnapshot {
  activeMs: number;
  modelCalls: number;
  toolCalls: number;
}

/** Persist the snapshot with each runtime checkpoint; approval time is accounted separately. */
export class ChannelBudget {
  private activeSince: number | undefined;
  private approvalSince: number | undefined;
  private exhausted?: Error;

  constructor(
    readonly snapshot: ChannelBudgetSnapshot = { activeMs: 0, modelCalls: 0, toolCalls: 0 },
    private readonly now: () => number = Date.now,
  ) {}

  resume() {
    if (
      this.approvalSince !== undefined &&
      this.now() - this.approvalSince >= CHANNEL_LIMITS.approvalMs
    )
      throw new Error('Channel approval expired');
    this.approvalSince = undefined;
    this.activeSince ??= this.now();
    this.assertTime();
  }

  pauseForApproval() {
    this.checkpoint();
    this.activeSince = undefined;
    this.approvalSince ??= this.now();
  }

  checkpoint() {
    if (this.activeSince !== undefined) {
      const now = this.now();
      this.snapshot.activeMs += now - this.activeSince;
      this.activeSince = now;
    }
    return { ...this.snapshot };
  }

  assertTime() {
    if (this.exhausted) throw this.exhausted;
    if (this.checkpoint().activeMs >= CHANNEL_LIMITS.executionMs)
      throw new Error('Channel execution time limit reached');
  }

  modelCall() {
    this.assertTime();
    if (this.snapshot.modelCalls >= CHANNEL_LIMITS.modelCalls)
      throw (this.exhausted = new Error('Channel model call limit reached'));
    this.snapshot.modelCalls++;
  }

  toolCall() {
    this.assertTime();
    if (this.snapshot.toolCalls >= CHANNEL_LIMITS.toolCalls)
      throw (this.exhausted = new Error('Channel tool call limit reached'));
    this.snapshot.toolCalls++;
  }
}
