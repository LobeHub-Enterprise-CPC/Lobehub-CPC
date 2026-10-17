import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSsoProviderDetails } from './useSsoProviderDetails';

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
);

describe('useSsoProviderDetails', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keys the public provider list by provider id', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        managed: false,
        providers: [
          { displayName: 'Clerk SSO', id: 'clerk', logoUrl: 'https://img.clerk.com/a.png' },
          { displayName: 'GitHub', id: 'github', logoUrl: null },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSsoProviderDetails(), { wrapper });

    await waitFor(() =>
      expect(result.current).toEqual({
        clerk: { displayName: 'Clerk SSO', logoUrl: 'https://img.clerk.com/a.png' },
        github: { displayName: 'GitHub', logoUrl: null },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith('/webapi/auth/sso-providers', { cache: 'no-store' });
  });

  it('stays empty when the list cannot be read', async () => {
    const fetchMock = vi.fn(async () => Response.json({ code: 'X' }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useSsoProviderDetails(), { wrapper });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toEqual({});
  });
});
