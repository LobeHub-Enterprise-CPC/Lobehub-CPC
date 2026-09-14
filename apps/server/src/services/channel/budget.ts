import type { Usage } from '@lobechat/agent-runtime';
import { CHANNEL_LIMITS } from '@lobechat/types';

export interface ChannelBudgetSnapshot {
  activeMs: number;
  modelCalls: number;
  toolCalls: number;
}

/**
 * Per-run limits for a Channel native member. Call counts are read off the
 * runtime's own `state.usage` after each step rather than counted here, so
 * the receipt matches what `agent_operations` billed.
 */
export class ChannelBudget {
  private readonly startedAt: number;
  private modelCalls = 0;
  private toolCalls = 0;
  private exhausted?: Error;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  checkpoint(): ChannelBudgetSnapshot {
    return {
      activeMs: this.now() - this.startedAt,
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
    };
  }

  assertTime() {
    if (this.exhausted) throw this.exhausted;
    if (this.checkpoint().activeMs >= CHANNEL_LIMITS.executionMs)
      throw (this.exhausted = new Error('Channel execution time limit reached'));
  }

  /**
   * Record cumulative usage after a step. Throws once a call limit is reached
   * so the host stops the run before it spends the next step; the step that
   * reached the limit has already run, so the caller skips this for a run
   * that just finished.
   */
  observe(usage: Pick<Usage, 'llm' | 'tools'>) {
    this.modelCalls = usage.llm.apiCalls;
    this.toolCalls = usage.tools.totalCalls;
    this.assertTime();
    if (this.modelCalls >= CHANNEL_LIMITS.modelCalls)
      throw (this.exhausted = new Error('Channel model call limit reached'));
    if (this.toolCalls >= CHANNEL_LIMITS.toolCalls)
      throw (this.exhausted = new Error('Channel tool call limit reached'));
  }
}
