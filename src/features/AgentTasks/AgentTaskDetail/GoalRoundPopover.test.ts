import type * as BusinessConstModule from '@lobechat/business-const';
import { describe, expect, it, vi } from 'vitest';

import { formatRoundCost, formatTokens } from './GoalRoundPopover';

// These assertions are about dollar amounts. A distribution that charges in its
// own credits overrides this slot, so pin the upstream default.
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConstModule>()),
  USAGE_CREDITS: undefined,
}));

describe('formatRoundCost', () => {
  it('avoids rendering a real sub-cent cost as $0.00', () => {
    expect(formatRoundCost(0.004)).toBe('<$0.01');
  });

  it('keeps three decimals under a dollar and two above', () => {
    expect(formatRoundCost(0.125)).toBe('$0.125');
    expect(formatRoundCost(2.5)).toBe('$2.50');
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(15_400)).toBe('15.4k');
  });
});
