// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { getPrivateFeedbackMessage, submitBotFeedback } from './feedbackSubmit';

vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_EMAIL: { support: 'support@private.example' },
  BRANDING_NAME: 'Private Workspace',
}));
const { submit } = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('@/server/services/market', () => ({
  MarketService: class {
    submitFeedback = submit;
  },
}));

describe('private customer feedback', () => {
  it('never reads identity or sends customer feedback to the upstream market', async () => {
    const findFirst = vi.fn();
    expect(
      await submitBotFeedback({ query: { users: { findFirst } } } as any, {
        body: 'Customer issue',
        platform: 'slack',
        userId: 'user',
      }),
    ).toEqual({ success: false });
    expect(findFirst).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['en-US', 'zh-CN'])('offers only the configured email (%s)', (locale) => {
    const text = getPrivateFeedbackMessage(locale);
    expect(text).toContain('support@private.example');
    expect(text).not.toMatch(/LobeHub|Discord|submitted successfully|已转交/);
  });
});
