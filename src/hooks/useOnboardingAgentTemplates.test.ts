import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ enabled: true, fetch: vi.fn(async () => []) }));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get ONBOARDING_AGENT_PICKER_ENABLED() {
    return mocks.enabled;
  },
}));
vi.mock('@/services/agentMarketplace', () => ({ fetchOnboardingAgentTemplates: mocks.fetch }));

const { useOnboardingAgentTemplates } = await import('./useOnboardingAgentTemplates');

describe('useOnboardingAgentTemplates', () => {
  it('never calls the hosted marketplace when the deployment has no agent picker', async () => {
    mocks.enabled = false;
    renderHook(() => useOnboardingAgentTemplates(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('fetches when the picker is enabled', async () => {
    mocks.enabled = true;
    renderHook(() => useOnboardingAgentTemplates(true));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  });
});
