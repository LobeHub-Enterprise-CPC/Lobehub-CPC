import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserDetail } from './useUserDetail';

const { confirmModal, deprecateAgent, deprecateAgentGroup, toast } = vi.hoisted(() => {
  const close = vi.fn();
  return {
    confirmModal: vi.fn((options: { onOk: () => Promise<void> }) => options.onOk()),
    deprecateAgent: vi.fn(),
    deprecateAgentGroup: vi.fn(),
    toast: { error: vi.fn(), loading: vi.fn(() => ({ close })), success: vi.fn() },
  };
});

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confirmModal,
  toast,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/layout/AuthProvider/MarketAuth', () => ({
  useMarketAuth: () => ({ session: { accessToken: 'token' } }),
}));
vi.mock('@/services/marketApi', () => ({
  marketApiService: { deprecateAgent, deprecateAgentGroup },
}));
vi.mock('@/store/serverConfig', () => ({
  serverConfigSelectors: { enableMarketTrustedClient: () => true },
  useServerConfigStore: (selector: (state: unknown) => unknown) => selector({}),
}));

const run = async (onMutate: () => void, type?: 'agent' | 'group') => {
  const { result } = renderHook(() => useUserDetail({ onMutate }));
  await act(async () => {
    await result.current.handleStatusChange('item-1', 'deprecate', type);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  deprecateAgent.mockResolvedValue(undefined);
  deprecateAgentGroup.mockResolvedValue(undefined);
});

describe('useUserDetail handleStatusChange', () => {
  it('shows success and reloads the list once Market accepted the change', async () => {
    const onMutate = vi.fn();

    await run(onMutate);

    expect(deprecateAgent).toHaveBeenCalledWith('item-1');
    expect(toast.success).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(onMutate).toHaveBeenCalledTimes(1);
  });

  it('acts on the group when the item is one', async () => {
    await run(vi.fn(), 'group');

    expect(deprecateAgentGroup).toHaveBeenCalledWith('item-1');
    expect(deprecateAgent).not.toHaveBeenCalled();
  });

  // A refusal means what the user may do with the item changed. Success is not
  // shown, the reason is, and the list is read again so the buttons follow.
  it.each(['Forbidden', 'Not Found', 'Service Unavailable'])(
    'shows the failure, no success, and reloads the list when Market says: %s',
    async (message) => {
      deprecateAgent.mockRejectedValue(new Error(message));
      const onMutate = vi.fn();

      await run(onMutate);

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(onMutate).toHaveBeenCalledTimes(1);
    },
  );
});
