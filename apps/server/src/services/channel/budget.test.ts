import { describe, expect, it } from 'vitest';

import { ChannelBudget } from './budget';

const usage = (apiCalls: number, totalCalls: number) => ({
  llm: { apiCalls, processingTimeMs: 0, tokens: {} as never },
  tools: { byTool: [], totalCalls, totalTimeMs: 0 },
});

describe('Channel execution budgets', () => {
  it('mirrors the runtime usage counters and stops at the call limits', () => {
    const budget = new ChannelBudget(() => 0);
    budget.observe(usage(31, 63));
    expect(budget.checkpoint()).toEqual({ activeMs: 0, modelCalls: 31, toolCalls: 63 });
    expect(() => budget.observe(usage(32, 63))).toThrow('model call limit');
    // Exhaustion is sticky: a later, lower reading does not reopen the run.
    expect(() => budget.observe(usage(0, 0))).toThrow('model call limit');
    expect(() => new ChannelBudget(() => 0).observe(usage(0, 64))).toThrow('tool call limit');
  });

  it('measures wall time from construction and fails at the execution limit', () => {
    let now = 1000;
    const budget = new ChannelBudget(() => now);
    now = 1000 + 599_999;
    budget.assertTime();
    expect(budget.checkpoint().activeMs).toBe(599_999);
    now++;
    expect(() => budget.assertTime()).toThrow('time limit');
    expect(() => budget.observe(usage(0, 0))).toThrow('time limit');
  });

  it('retains observed counters and enforces time limits when usage is missing', () => {
    let now = 0;
    const budget = new ChannelBudget(() => now);
    budget.observe(undefined);
    expect(budget.checkpoint()).toEqual({ activeMs: 0, modelCalls: 0, toolCalls: 0 });
    budget.observe(usage(3, 2));
    budget.observe(undefined);
    expect(budget.checkpoint()).toEqual({ activeMs: 0, modelCalls: 3, toolCalls: 2 });
    now = 600_000;
    expect(() => budget.observe(undefined)).toThrow('time limit');
  });
});
