import { describe, expect, it } from 'vitest';

import { ChannelBudget } from './budget';

describe('Channel execution budgets', () => {
  it('does not count an approval wait as execution time but expires an old approval', () => {
    let now = 0;
    const budget = new ChannelBudget(undefined, () => now);
    budget.resume();
    now = 1000;
    budget.pauseForApproval();
    now = 600000;
    budget.resume();
    expect(budget.checkpoint().activeMs).toBe(1000);
    budget.pauseForApproval();
    now += 86400000;
    expect(() => budget.resume()).toThrow('approval expired');
  });
  it('rejects a new model or tool operation at the boundary, before it runs', () => {
    const budget = new ChannelBudget({ activeMs: 0, modelCalls: 31, toolCalls: 63 }, () => 0);
    budget.resume();
    budget.modelCall();
    budget.toolCall();
    expect(() => budget.modelCall()).toThrow('model call limit');
    expect(() => budget.toolCall()).toThrow('model call limit');
    const toolBudget = new ChannelBudget({ activeMs: 0, modelCalls: 0, toolCalls: 64 });
    expect(() => toolBudget.toolCall()).toThrow('tool call limit');
    expect(() => toolBudget.modelCall()).toThrow('tool call limit');
  });
  it('counts total active time across pauses and restarts', () => {
    let now = 0;
    const first = new ChannelBudget(undefined, () => now);
    first.resume();
    now = 599999;
    const next = new ChannelBudget(first.checkpoint(), () => now);
    next.resume();
    now++;
    expect(() => next.assertTime()).toThrow('time limit');
  });
});
