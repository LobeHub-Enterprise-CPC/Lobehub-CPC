import { setRemoteTenantId } from '@lobechat/business-tenant/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recentsStorageKey, useSwitcherRecents } from './useSwitcherRecents';

vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: () => undefined,
}));

afterEach(() => {
  setRemoteTenantId(undefined);
  window.localStorage.clear();
});

describe('useSwitcherRecents', () => {
  it('keeps recent ids per tenant on one browser origin', () => {
    setRemoteTenantId('tenant-a');
    const a = renderHook(() => useSwitcherRecents('agent'));
    act(() => a.result.current.touch('agent-a'));
    a.unmount();

    setRemoteTenantId('tenant-b');
    const b = renderHook(() => useSwitcherRecents('agent'));

    expect(b.result.current.ids).toEqual([]);
    expect(recentsStorageKey(undefined, 'agent')).toBe(
      't:tenant-b:lobe-switcher-recent:personal:agent',
    );
  });
});
